import { runCloseOut } from './close-out.ts'
import { createEffectiveSliceReader } from './effective-slices.ts'
import { runLoop, type LoopConfig, type LoopDeps } from './loop.ts'
import { reconcileEntity, type LoopEntityRef } from './reconcile.ts'
import type { TurnIn, TurnOut } from './verdict.ts'
import type { Role } from '../prompts/load.ts'
import type { ChangeRecord, Slice, Storage } from '../storages/types.ts'
import type { GhOps } from '../utils/gh-ops.ts'
import type { GitOps } from '../utils/git-ops.ts'

/**
 * The unit of work `trowel change work` operates on.
 */
export type LoopEntity = { kind: 'change'; id: string; integrationBranch: string; targetBranch?: string; title: string }

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
	const ref: LoopEntityRef = { kind: 'change', id: entity.id, branch: entity.integrationBranch }
	await reconcileEntity(ref, { storage: deps.storage, gh: deps.gh, log: deps.log })
	await runChangeEntity(entity, deps)
}

async function runChangeEntity(entity: Extract<LoopEntity, { kind: 'change' }>, deps: EntityLoopDeps): Promise<void> {
	const change = await openChangeOrStop(entity, deps)
	if (!change) return
	await runLoop(entity.id, loopDepsForChange(entity, deps))
	await closeOutChangeIfReady(entity, change, deps)
}

async function openChangeOrStop(entity: Extract<LoopEntity, { kind: 'change' }>, deps: EntityLoopDeps): Promise<ChangeRecord | null> {
	const change = await deps.storage.findChange(entity.id)
	if (!change) throw new Error(`Change '${entity.id}' not found`)
	if (change.state !== 'CLOSED') return change
	deps.log(`[work change-${entity.id}] already CLOSED; nothing to do`)
	return null
}

function loopDepsForChange(entity: Extract<LoopEntity, { kind: 'change' }>, deps: EntityLoopDeps): LoopDeps {
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

async function closeOutChangeIfReady(entity: Extract<LoopEntity, { kind: 'change' }>, change: ChangeRecord, deps: EntityLoopDeps): Promise<void> {
	const reader = createEffectiveSliceReader({ storage: deps.storage, gh: deps.gh, usePrs: deps.config.usePrs })
	const slices = await reader.findSlices(entity.id)
	if (!changeReadyForCloseOut(entity, slices, deps)) return
	deps.log(`[work change-${entity.id}] all slices CLOSED → running Close-out`)
	await runCloseOut(
		{ kind: 'change', id: entity.id, branch: entity.integrationBranch, targetBranch: change.targetBranch, title: entity.title },
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

function changeReadyForCloseOut(entity: Extract<LoopEntity, { kind: 'change' }>, slices: Slice[], deps: EntityLoopDeps): boolean {
	if (slices.length === 0) deps.log(`[work change-${entity.id}] no slices; skipping Close-out`)
	return slices.length > 0 && slices.every((s) => s.state === 'CLOSED')
}

if (import.meta.vitest) {
	const { describe, test, expect } = import.meta.vitest
	const { recordingGhOps } = await import('../test-utils/gh-ops-recorder.ts')
	const { noopGitOps } = await import('../test-utils/git-ops-fixtures.ts')
	const { fakeSliceStorage } = await import('../test-utils/storage-fixtures.ts')

	function makeStorage(overrides: Partial<Storage>): Storage {
		return fakeSliceStorage([], null, { findChange: async () => null, ...overrides })
	}

	function noopGit(): GitOps {
		return noopGitOps({ currentBranch: async () => 'main', baseBranch: async () => 'main' })
	}

	const baseConfig: LoopConfig = {
		usePrs: false, review: false, perSliceBranches: true, maxConcurrent: null, mergeNoVerify: false,
	}

	async function changeClosedAfterLoop(slices: Awaited<ReturnType<Storage['findSlices']>>, config: LoopConfig): Promise<boolean> {
		let changeClosed = false
		const storage = makeStorage({
			findChange: async (id) => ({ id, branch: 'b', title: 'F', state: 'OPEN' }),
			findSlices: async () => slices,
			closeChange: async () => { changeClosed = true },
		})
		const { gh } = recordingGhOps()
		await runEntityLoop(
			{ kind: 'change', id: '3', integrationBranch: '3-feat', title: 'Feat' },
			{ storage, git: noopGit(), gh, spawnTurn: async () => ({ verdict: 'partial', commits: 0 }), log: () => {}, config },
		)
		return changeClosed
	}

	describe('runEntityLoop: change', () => {
		test('all slices already CLOSED + usePrs:false → Close-out fires, Change CLOSED', async () => {
			expect(await changeClosedAfterLoop([
				{ id: 's1', title: 'a', body: '', state: 'CLOSED', readyForAgent: false, needsRevision: false, blockedBy: [], prState: null },
			], { ...baseConfig, usePrs: false })).toBe(true)
		})

		test('empty slices → skips Close-out (nothing to ship)', async () => {
			expect(await changeClosedAfterLoop([], baseConfig)).toBe(false)
		})

		test('Change already CLOSED → no loop, no Close-out', async () => {
			let spawned = 0
			const storage = makeStorage({
				findChange: async (id) => ({ id, branch: 'b', title: 'F', state: 'CLOSED' }),
			})
			const { gh } = recordingGhOps()
			await runEntityLoop(
				{ kind: 'change', id: '3', integrationBranch: '3-feat', title: 'Feat' },
				{ storage, git: noopGit(), gh, spawnTurn: async () => { spawned++; return { verdict: 'ready', commits: 1 } }, log: () => {}, config: baseConfig },
			)
			expect(spawned).toBe(0)
		})
	})
}
