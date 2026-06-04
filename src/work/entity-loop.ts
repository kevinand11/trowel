import { runCloseOut } from './close-out.ts'
import { runFixEntity } from './fix-entity-loop.ts'
import { runLoop, type LoopConfig, type LoopDeps } from './loop.ts'
import { reconcileEntity, type LoopEntityRef } from './reconcile.ts'
import type { TurnIn, TurnOut } from './verdict.ts'
import type { Role } from '../prompts/load.ts'
import type { PrdRecord, Slice, Storage } from '../storages/types.ts'
import type { GhOps } from '../utils/gh-ops.ts'
import type { GitOps } from '../utils/git-ops.ts'

/**
 * The unit of work `trowel work` operates on. PRDs have slices (the legacy loop); Fixes are
 * single-blob entities that go through the same Turn machinery but with their own branch off
 * targetBranch. See ADR `2026-05-17-fix-entity-unified-close-out.md` and
 * `2026-06-03-entity-target-branch-captured-from-invocation.md`.
 */
export type LoopEntity =
	| { kind: 'prd'; id: string; integrationBranch: string; targetBranch?: string; title: string }
	| { kind: 'fix'; id: string; branch: string; targetBranch?: string; title: string }

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
	const prd = await openPrdOrStop(entity, deps)
	if (!prd) return
	await runLoop(entity.id, loopDepsForPrd(entity, deps))
	await closeOutPrdIfReady(entity, prd, deps)
}

async function openPrdOrStop(entity: Extract<LoopEntity, { kind: 'prd' }>, deps: EntityLoopDeps): Promise<PrdRecord | null> {
	const prd = await deps.storage.findPrd(entity.id)
	if (!prd) throw new Error(`PRD '${entity.id}' not found`)
	if (prd.state !== 'CLOSED') return prd
	deps.log(`[work prd-${entity.id}] already CLOSED; nothing to do`)
	return null
}

function loopDepsForPrd(entity: Extract<LoopEntity, { kind: 'prd' }>, deps: EntityLoopDeps): LoopDeps {
	return {
		storage: deps.storage,
		git: deps.git,
		gh: deps.gh,
		integrationBranch: entity.integrationBranch,
		spawnTurn: deps.spawnTurn,
		log: deps.log,
		config: deps.config,
		projectRoot: deps.projectRoot,
	}
}

async function closeOutPrdIfReady(entity: Extract<LoopEntity, { kind: 'prd' }>, prd: PrdRecord, deps: EntityLoopDeps): Promise<void> {
	const slices = await deps.storage.findSlices(entity.id)
	if (!prdReadyForCloseOut(entity, slices, deps)) return
	deps.log(`[work prd-${entity.id}] all slices CLOSED → running Close-out`)
	await runCloseOut(
		{ kind: 'prd', id: entity.id, branch: entity.integrationBranch, targetBranch: prd.targetBranch, title: entity.title },
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

function prdReadyForCloseOut(entity: Extract<LoopEntity, { kind: 'prd' }>, slices: Slice[], deps: EntityLoopDeps): boolean {
	if (slices.length === 0) deps.log(`[work prd-${entity.id}] no slices; skipping Close-out`)
	return slices.length > 0 && slices.every((s) => s.state === 'CLOSED')
}

if (import.meta.vitest) {
	const { describe, test, expect } = import.meta.vitest
	const { recordingGhOps } = await import('../test-utils/gh-ops-recorder.ts')
	const { noopGitOps } = await import('../test-utils/git-ops-fixtures.ts')
	const { fakeSliceStorage } = await import('../test-utils/storage-fixtures.ts')

	function makeStorage(overrides: Partial<Storage>): Storage {
		return fakeSliceStorage([], null, { findPrd: async () => null, ...overrides })
	}

	function noopGit(): GitOps {
		return noopGitOps({ currentBranch: async () => 'main', baseBranch: async () => 'main' })
	}

	const baseConfig: LoopConfig = {
		usePrs: false, review: false, perSliceBranches: true, maxConcurrent: null, mergeNoVerify: false,
	}

	async function prdClosedAfterLoop(slices: Awaited<ReturnType<Storage['findSlices']>>, config: LoopConfig): Promise<boolean> {
		let prdClosed = false
		const storage = makeStorage({
			findPrd: async (id) => ({ id, branch: 'b', title: 'F', state: 'OPEN' }),
			findSlices: async () => slices,
			closePrd: async () => { prdClosed = true },
		})
		const { gh } = recordingGhOps()
		await runEntityLoop(
			{ kind: 'prd', id: '3', integrationBranch: '3-feat', title: 'Feat' },
			{ storage, git: noopGit(), gh, spawnTurn: async () => ({ verdict: 'partial', commits: 0 }), log: () => {}, config },
		)
		return prdClosed
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
			expect(await prdClosedAfterLoop([
				{ id: 's1', title: 'a', body: '', state: 'CLOSED', readyForAgent: false, needsRevision: false, blockedBy: [], prState: null },
			], { ...baseConfig, usePrs: false })).toBe(true)
		})

		test('empty slices → skips Close-out (nothing to ship)', async () => {
			expect(await prdClosedAfterLoop([], baseConfig)).toBe(false)
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
