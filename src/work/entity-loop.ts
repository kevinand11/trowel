import { runCloseOut } from './close-out.ts'
import { callFixLand, callFixPrepare, classifyFix, type FixPhaseConfig, type FixPhaseDeps } from './fix-phases.ts'
import { runLoop, type LoopConfig, type LoopDeps } from './loop.ts'
import { reconcileEntity, type LoopEntityRef } from './reconcile.ts'
import type { TurnIn, TurnOut } from './verdict.ts'
import type { Role } from '../prompts/load.ts'
import type { Slice, Storage } from '../storages/types.ts'
import type { GhOps } from '../utils/gh-ops.ts'
import type { GitOps } from '../utils/git-ops.ts'

/**
 * The unit of work `trowel work` operates on. PRDs have slices (the legacy loop); Fixes are
 * single-blob entities that go through the same Turn machinery but with their own branch off
 * `baseBranch`. See ADR `2026-05-17-fix-entity-unified-close-out.md`.
 */
export type LoopEntity =
	| { kind: 'prd'; id: string; integrationBranch: string; title: string }
	| { kind: 'fix'; id: string; branch: string; title: string }

export type EntityLoopDeps = {
	storage: Storage
	git: GitOps
	gh: GhOps
	spawnTurn: (args: { role: Role; slice: Slice; branch: string; turnIn: TurnIn }) => Promise<TurnOut>
	log: (msg: string) => void
	config: LoopConfig
	projectRoot?: string
}

/**
 * Top-level dispatch entry for `trowel work`. Runs Reconciliation, then per-entity processing,
 * then Close-out when the entity converges. Idempotent: re-running on a shipped entity is a
 * Reconciliation-only pass.
 */
export async function runEntityLoop(entity: LoopEntity, deps: EntityLoopDeps): Promise<void> {
	const ref: LoopEntityRef = entity.kind === 'prd'
		? { kind: 'prd', id: entity.id, branch: entity.integrationBranch }
		: { kind: 'fix', id: entity.id, branch: entity.branch }
	await reconcileEntity(ref, { storage: deps.storage, gh: deps.gh, log: deps.log })

	if (entity.kind === 'prd') {
		await runPrdEntity(entity, deps)
		return
	}
	await runFixEntity(entity, deps)
}

async function runPrdEntity(entity: Extract<LoopEntity, { kind: 'prd' }>, deps: EntityLoopDeps): Promise<void> {
	const prd = await deps.storage.findPrd(entity.id)
	if (!prd) throw new Error(`PRD '${entity.id}' not found`)
	if (prd.state === 'CLOSED') {
		deps.log(`[work prd-${entity.id}] already CLOSED; nothing to do`)
		return
	}

	const loopDeps: LoopDeps = {
		storage: deps.storage,
		git: deps.git,
		gh: deps.gh,
		integrationBranch: entity.integrationBranch,
		spawnTurn: deps.spawnTurn,
		log: deps.log,
		config: deps.config,
		projectRoot: deps.projectRoot,
	}
	await runLoop(entity.id, loopDeps)

	const slices = await deps.storage.findSlices(entity.id)
	const allClosed = slices.length > 0 && slices.every((s) => s.state === 'CLOSED')
	if (!allClosed) {
		if (slices.length === 0) deps.log(`[work prd-${entity.id}] no slices; skipping Close-out`)
		return
	}
	deps.log(`[work prd-${entity.id}] all slices CLOSED → running Close-out`)
	await runCloseOut(
		{ kind: 'prd', id: entity.id, branch: entity.integrationBranch, title: entity.title },
		{
			storage: deps.storage,
			git: deps.git,
			gh: deps.gh,
			log: deps.log,
			config: { usePrs: deps.config.usePrs, deleteBranch: 'prompt', mergeNoVerify: deps.config.mergeNoVerify },
			projectRoot: deps.projectRoot,
		},
	)
}

async function runFixEntity(entity: Extract<LoopEntity, { kind: 'fix' }>, deps: EntityLoopDeps): Promise<void> {
	const fixPhaseDeps: FixPhaseDeps = {
		storage: deps.storage,
		git: deps.git,
		gh: deps.gh,
		log: deps.log,
		projectRoot: deps.projectRoot,
		config: fixPhaseConfig(deps.config),
	}

	for (let step = 0; step < deps.config.sliceStepCap; step++) {
		const fix = await deps.storage.findFix(entity.id)
		if (!fix) throw new Error(`Fix '${entity.id}' not found`)
		if (fix.state === 'CLOSED') {
			deps.log(`[work fix-${entity.id}] CLOSED`)
			return
		}
		// Enrich prState by peeking at any open PR for the fix branch.
		const enriched = deps.config.usePrs ? await enrichFixPrState(deps.gh, fix) : fix
		const resume = classifyFix(enriched, { usePrs: deps.config.usePrs, review: deps.config.review })
		if (resume === 'done') {
			// Fix has no actionable phase right now. Under usePrs:true that typically means the PR is
			// open awaiting human review/merge. Try Close-out to mark it ready (idempotent), then exit.
			if (deps.config.usePrs) {
				deps.log(`[work fix-${entity.id}] no agent action; running Close-out to ensure PR ready`)
				await runCloseOut(
					{ kind: 'fix', id: entity.id, branch: entity.branch, title: entity.title },
					{
						storage: deps.storage,
						git: deps.git,
						gh: deps.gh,
						log: deps.log,
						config: { usePrs: true, deleteBranch: deps.config.usePrs ? 'never' : 'prompt', mergeNoVerify: deps.config.mergeNoVerify },
						projectRoot: deps.projectRoot,
					},
				)
			}
			return
		}
		const role = resume as Role
		deps.log(`[work fix-${entity.id}] state=${role}: "${fix.title}"`)
		const prep = await callFixPrepare(role, fixPhaseDeps, enriched)
		const slice: Slice = {
			id: enriched.id,
			title: enriched.title,
			body: enriched.body,
			state: enriched.state,
			readyForAgent: enriched.readyForAgent,
			needsRevision: enriched.needsRevision,
			blockedBy: enriched.blockedBy,
			prState: enriched.prState,
		}
		const verdict = await deps.spawnTurn({ role, slice, branch: prep.branch, turnIn: prep.turnIn })
		deps.log(`[work fix-${entity.id}] ${role} verdict: ${verdict.verdict}, ${verdict.commits} commit(s)`)
		const outcome = await callFixLand(role, fixPhaseDeps, enriched, verdict)
		if (outcome === 'done') return
		if (outcome === 'no-work') return
		if (outcome === 'partial') {
			deps.log(`[work fix-${entity.id}] partial; stopping for this run`)
			return
		}
		// 'progress' → loop and re-evaluate state
	}
	deps.log(`[work fix-${entity.id}] step-cap reached after ${deps.config.sliceStepCap} step(s); stopping`)
}

async function enrichFixPrState(gh: GhOps, fix: import('../storages/types.ts').FixRecord): Promise<import('../storages/types.ts').FixRecord> {
	try {
		const open = await gh.listOpenPrs()
		const found = open.find((p) => p.headRefName === fix.branch)
		return { ...fix, prState: found ? 'draft' : null }
	} catch {
		return fix
	}
}

function fixPhaseConfig(c: LoopConfig): FixPhaseConfig {
	return {
		usePrs: c.usePrs,
		review: c.review,
		mergeNoVerify: c.mergeNoVerify,
		// deleteBranch policy is overridden by Close-out's auto-coercion ('prompt' → 'never') — pass
		// 'prompt' through here; the inline Close-out call inside landFixImplement will respect it.
		deleteBranch: 'prompt',
	}
}

if (import.meta.vitest) {
	const { describe, test, expect } = import.meta.vitest
	const { recordingGhOps } = await import('../test-utils/gh-ops-recorder.ts')

	function makeStorage(overrides: Partial<Storage>): Storage {
		return {
			createPrd: async () => ({ id: 'x', branch: 'x' }),
			findPrd: async () => null,
			listPrds: async () => [],
			closePrd: async () => {},
			createSlice: async () => { throw new Error('nyi') },
			findSlices: async () => [],
			findSlice: async () => null,
			updateSlice: async () => {},
			createFix: async () => ({ id: 'x', branch: 'x' }),
			findFix: async () => null,
			listFixes: async () => [],
			updateFix: async () => {},
			closeFix: async () => {},
			...overrides,
		}
	}

	function noopGit(): GitOps {
		return {
			currentBranch: async () => 'main',
			baseBranch: async () => 'main',
			branchExists: async () => true,
			isMerged: async () => false,
			checkout: async () => {},
			deleteBranch: async () => {},
			deleteRemoteBranch: async () => {},
			fetch: async () => {},
			push: async () => {},
			mergeNoFf: async () => {},
			mergeAbort: async () => {},
			createRemoteBranch: async () => {},
			createLocalBranch: async () => {},
			pushSetUpstream: async () => {},
			worktreeAdd: async () => {},
			worktreeRemove: async () => {},
			worktreeList: async () => [],
			restoreAll: async () => {},
			cleanUntracked: async () => {},
			isWorkingTreeClean: async () => true,
			stashPush: async () => {},
			stashPop: async () => {},
			commitsAhead: async () => 0,
			detectVersion: async () => ({ installed: true, version: '0.0.0' }),
		}
	}

	const baseConfig: LoopConfig = {
		usePrs: false, review: false, perSliceBranches: true, sliceStepCap: 5, maxConcurrent: null, mergeNoVerify: false,
	}

	describe('runEntityLoop: fix', () => {
		test('ready implementer + usePrs:false → host-merges fix → base + closes Fix', async () => {
			let closedFix: string | null = null
			const storage = makeStorage({
				findFix: async (id) => ({ id, branch: 'fix/5-x', title: 'X', body: '', state: 'OPEN', readyForAgent: true, needsRevision: false, blockedBy: [], prState: null }),
				closeFix: async (id) => { closedFix = id },
			})
			const { gh } = recordingGhOps()
			const verdicts: TurnOut[] = [{ verdict: 'ready', commits: 1 }]
			let i = 0
			await runEntityLoop(
				{ kind: 'fix', id: '5', branch: 'fix/5-x', title: 'X' },
				{ storage, git: noopGit(), gh, spawnTurn: async () => verdicts[i++]!, log: () => {}, config: baseConfig },
			)
			expect(closedFix).toBe('5')
		})

		test('CLOSED Fix → no-op', async () => {
			const storage = makeStorage({
				findFix: async (id) => ({ id, branch: 'fix/5-x', title: 'X', body: '', state: 'CLOSED', readyForAgent: false, needsRevision: false, blockedBy: [], prState: null }),
			})
			const { gh } = recordingGhOps()
			let spawned = 0
			await runEntityLoop(
				{ kind: 'fix', id: '5', branch: 'fix/5-x', title: 'X' },
				{ storage, git: noopGit(), gh, spawnTurn: async () => { spawned++; return { verdict: 'partial', commits: 0 } }, log: () => {}, config: baseConfig },
			)
			expect(spawned).toBe(0)
		})

		test('reconciliation runs before loop body (merged PR → CLOSED before spawn)', async () => {
			let state: 'OPEN' | 'CLOSED' = 'OPEN'
			let spawned = 0
			const storage = makeStorage({
				findFix: async (id) => ({ id, branch: 'fix/5-x', title: 'X', body: '', state, readyForAgent: true, needsRevision: false, blockedBy: [], prState: null }),
				closeFix: async () => { state = 'CLOSED' },
			})
			const { gh } = recordingGhOps({ findAnyPrByHead: async () => ({ number: 7, state: 'MERGED' }) })
			await runEntityLoop(
				{ kind: 'fix', id: '5', branch: 'fix/5-x', title: 'X' },
				{ storage, git: noopGit(), gh, spawnTurn: async () => { spawned++; return { verdict: 'ready', commits: 1 } }, log: () => {}, config: baseConfig },
			)
			expect(spawned).toBe(0)
			expect(state).toBe('CLOSED')
		})
	})

	describe('runEntityLoop: prd', () => {
		test('all slices already CLOSED + usePrs:false → Close-out fires, PRD CLOSED', async () => {
			let prdClosed = false
			const storage = makeStorage({
				findPrd: async (id) => ({ id, branch: 'b', title: 'F', state: 'OPEN' }),
				findSlices: async () => [
					{ id: 's1', title: 'a', body: '', state: 'CLOSED', readyForAgent: false, needsRevision: false, blockedBy: [], prState: null },
				],
				closePrd: async () => { prdClosed = true },
			})
			const { gh } = recordingGhOps()
			await runEntityLoop(
				{ kind: 'prd', id: '3', integrationBranch: '3-feat', title: 'Feat' },
				{ storage, git: noopGit(), gh, spawnTurn: async () => ({ verdict: 'partial', commits: 0 }), log: () => {}, config: { ...baseConfig, usePrs: false } },
			)
			expect(prdClosed).toBe(true)
		})

		test('empty slices → skips Close-out (nothing to ship)', async () => {
			let prdClosed = false
			const storage = makeStorage({
				findPrd: async (id) => ({ id, branch: 'b', title: 'F', state: 'OPEN' }),
				findSlices: async () => [],
				closePrd: async () => { prdClosed = true },
			})
			const { gh } = recordingGhOps()
			await runEntityLoop(
				{ kind: 'prd', id: '3', integrationBranch: '3-feat', title: 'Feat' },
				{ storage, git: noopGit(), gh, spawnTurn: async () => ({ verdict: 'partial', commits: 0 }), log: () => {}, config: baseConfig },
			)
			expect(prdClosed).toBe(false)
		})

		test('PRD already CLOSED → no loop, no Close-out', async () => {
			let spawned = 0
			const storage = makeStorage({
				findPrd: async (id) => ({ id, branch: 'b', title: 'F', state: 'CLOSED' }),
			})
			const { gh } = recordingGhOps()
			await runEntityLoop(
				{ kind: 'prd', id: '3', integrationBranch: '3-feat', title: 'Feat' },
				{ storage, git: noopGit(), gh, spawnTurn: async () => { spawned++; return { verdict: 'ready', commits: 1 } }, log: () => {}, config: baseConfig },
			)
			expect(spawned).toBe(0)
		})
	})
}
