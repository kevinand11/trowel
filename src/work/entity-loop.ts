import type { ChangeState } from './change-types.ts'
import { createEffectiveSliceReader } from './effective-slices.ts'
import { runLoop, type LoopConfig, type LoopDeps } from './loop.ts'
import type { ClassifiedSlice } from './slice-types.ts'
import type { TurnIn, TurnOut } from './verdict.ts'
import type { Role } from '../prompts/load.ts'
import type { ChangeRecord, Slice, Storage } from '../storages/types.ts'
import { classifyChange } from '../utils/change-state.ts'
import type { GhOps } from '../utils/gh-ops.ts'
import type { GitOps } from '../utils/git-ops.ts'

/**
 * The unit of work `trowel change work` operates on.
 */
export type LoopEntity = { kind: 'change'; id: string; changeBranch: string; targetBranch: string; title: string }

export type EntityLoopDeps = {
	storage: Storage
	git: GitOps
	gh: GhOps
	spawnTurn: (args: { role: Role; slice: ClassifiedSlice; branch: string; turnIn: TurnIn }) => Promise<TurnOut>
	log: (msg: string) => void
	config: LoopConfig
	projectRoot?: string
}

/**
 * Top-level dispatch entry for `trowel change work`. Work never runs Close-out,
 * Change finalization, or Cleanup; it only runs open Change Slice work/finalization
 * and reports the next explicit Change-level action for non-open computed states.
 */
export async function runEntityLoop(entity: LoopEntity, deps: EntityLoopDeps): Promise<void> {
	await runChangeEntity(entity, deps)
}

async function runChangeEntity(entity: Extract<LoopEntity, { kind: 'change' }>, deps: EntityLoopDeps): Promise<void> {
	const initial = await readChangeWorkState(entity, deps)
	if (reportIfNotOpen(initial, deps)) return
	await runLoop(entity.id, loopDepsForChange(entity, deps))
	const after = await readChangeWorkState(entity, deps)
	if (reportIfNotOpen(after, deps)) return
	if (after.slices.length === 0) deps.log(`[work change-${entity.id}] no slices; nothing to ship`)
}

type ChangeWorkState = { change: ChangeRecord; slices: ClassifiedSlice[]; state: ChangeState }

async function readChangeWorkState(entity: Extract<LoopEntity, { kind: 'change' }>, deps: EntityLoopDeps): Promise<ChangeWorkState> {
	const change = await deps.storage.findChange(entity.id)
	if (!change) throw new Error(`Change '${entity.id}' not found`)
	const reader = createEffectiveSliceReader({
		storage: deps.storage,
		gh: deps.gh,
		pr: deps.config.pr,
		needsRevisionLabel: deps.config.needsRevisionLabel,
	})
	const slices = await reader.findSlices(entity.id)
	const state = await classifyChange(change, slices, { gh: deps.gh, git: deps.git })
	return { change, slices, state }
}

function reportIfNotOpen(workState: ChangeWorkState, deps: EntityLoopDeps): boolean {
	if (workState.state === 'open') return false
	deps.log(nonOpenChangeMessage(workState.change.id, workState.state))
	return true
}

function nonOpenChangeMessage(changeId: string, state: ChangeState): string {
	const ship = `trowel change ship ${changeId}`
	switch (state) {
		case 'ready':
			return `[work change-${changeId}] state=ready; all Slices are done; run: ${ship}`
		case 'in-flight':
			return `[work change-${changeId}] state=in-flight; awaiting shipping PR merge; after it merges, run: ${ship}`
		case 'landed':
			return `[work change-${changeId}] non-work state=landed; merged to Target branch but not finalized; run: ${ship}`
		case 'done':
			return `[work change-${changeId}] non-work state=done; shipped and finalized; no Slice work to run`
		case 'aborted':
			return `[work change-${changeId}] non-work state=aborted; Change is aborted; no Slice work to run`
		case 'open':
			return `[work change-${changeId}] state=open; work remains`
	}
}

function loopDepsForChange(entity: Extract<LoopEntity, { kind: 'change' }>, deps: EntityLoopDeps): LoopDeps {
	return {
		storage: deps.storage,
		git: deps.git,
		gh: deps.gh,
		changeBranch: entity.changeBranch,
		spawnTurn: deps.spawnTurn,
		log: deps.log,
		config: deps.config,
		projectRoot: deps.projectRoot,
	}
}

if (import.meta.vitest) {
	const { describe, test, expect } = import.meta.vitest
	const { recordingGhOps } = await import('../test-utils/gh-ops-recorder.ts')
	const { noopGitOps } = await import('../test-utils/git-ops-fixtures.ts')
	const { setupLocalSliceMergeFixture } = await import('../test-utils/local-merge-fixtures.ts')
	const { fakeSliceStorage } = await import('../test-utils/storage-fixtures.ts')

	function makeStorage(overrides: Partial<Storage>): Storage {
		return fakeSliceStorage([], null, { findChange: async () => null, ...overrides })
	}

	function unmergedGit(overrides: Partial<GitOps> = {}): GitOps {
		return noopGitOps({
			currentBranch: async () => 'main',
			baseBranch: async () => 'main',
			remoteBranchExists: async () => false,
			branchExists: async () => false,
			...overrides,
		})
	}

	const baseConfig: LoopConfig = {
		pr: false,
		audit: false,
		perSliceBranches: true,
		maxConcurrent: null,
		mergeNoVerify: false,
	}

	const doneSlice: ClassifiedSlice = {
		id: 's1',
		title: 'a',
		body: '',
		state: 'done',
		closedAt: '2026-06-04T00:00:00.000Z',
		implementedAt: null,
		auditedAt: null,
		readyForAgent: false,
		needsRevision: false,
		blockedBy: [],
		sliceBranch: 'change-3/slice-s1-a',
		prState: null,
	}

	type LoopFixtureOpts = {
		change?: ChangeRecord
		slices?: Slice[]
		config?: LoopConfig
		git?: GitOps
		gh?: GhOps
		spawnTurn?: EntityLoopDeps['spawnTurn']
		finalizeSlice?: Storage['finalizeSlice']
	}

	async function runLoopFixture(opts: LoopFixtureOpts = {}): Promise<{ changeClosed: boolean; logs: string[]; spawned: number }> {
		let changeClosed = false
		let spawned = 0
		const logs: string[] = []
		const change = opts.change ?? {
			id: '3',
			changeBranch: '3-feat',
			targetBranch: 'main',
			title: 'Feat',
			closedAt: null,
		}
		const slices = opts.slices ?? []
		const storage = makeStorage({
			findChange: async (id) => (id === change.id ? change : null),
			findSlices: async () => slices,
			finalizeSlice: opts.finalizeSlice ?? (async () => {}),
			abortChange: async () => {
				changeClosed = true
			},
		})
		const { gh: defaultGh } = recordingGhOps()
		await runEntityLoop(
			{ kind: 'change', id: change.id, changeBranch: change.changeBranch, targetBranch: change.targetBranch, title: change.title },
			{
				storage,
				git: opts.git ?? unmergedGit(),
				gh: opts.gh ?? defaultGh,
				spawnTurn: async (args) => {
					spawned++
					return opts.spawnTurn ? opts.spawnTurn(args) : { verdict: 'partial', commits: 0 }
				},
				log: (msg) => logs.push(msg),
				config: opts.config ?? baseConfig,
			},
		)
		return { changeClosed, logs, spawned }
	}

	describe('runEntityLoop: change', () => {
		test('ready Change → reports ship guidance and runs no Slice work', async () => {
			const result = await runLoopFixture({ slices: [doneSlice] })
			expect(result.changeClosed).toBe(false)
			expect(result.spawned).toBe(0)
			expect(result.logs.join('\n')).toContain('state=ready')
			expect(result.logs.join('\n')).toContain('trowel change ship 3')
		})

		test('in-flight Change → reports awaiting shipping PR merge and runs no Slice work', async () => {
			const { gh } = recordingGhOps({ findAnyPrByHead: async (head) => (head === '3-feat' ? { number: 12, state: 'OPEN' } : null) })
			const result = await runLoopFixture({ slices: [doneSlice], gh, config: { ...baseConfig, pr: true } })
			expect(result.spawned).toBe(0)
			expect(result.logs.join('\n')).toContain('state=in-flight')
			expect(result.logs.join('\n')).toContain('awaiting shipping PR merge')
		})

		test('landed Change → reports non-work state and does not finalize the Change', async () => {
			const { gh } = recordingGhOps({ findAnyPrByHead: async (head) => (head === '3-feat' ? { number: 12, state: 'MERGED' } : null) })
			const result = await runLoopFixture({ slices: [doneSlice], gh })
			expect(result.changeClosed).toBe(false)
			expect(result.spawned).toBe(0)
			expect(result.logs.join('\n')).toContain('non-work state=landed')
			expect(result.logs.join('\n')).toContain('trowel change ship 3')
		})

		test('done and aborted Changes → report non-work states and run no Slice work', async () => {
			const { gh } = recordingGhOps({ findAnyPrByHead: async (head) => (head === '3-feat' ? { number: 12, state: 'MERGED' } : null) })
			const done = await runLoopFixture({
				change: {
					id: '3',
					changeBranch: '3-feat',
					targetBranch: 'main',
					title: 'Feat',
					closedAt: '2026-06-04T00:00:00.000Z',
				},
				slices: [doneSlice],
				gh,
			})
			const aborted = await runLoopFixture({
				change: {
					id: '3',
					changeBranch: '3-feat',
					targetBranch: 'main',
					title: 'Feat',
					closedAt: '2026-06-04T00:00:00.000Z',
				},
				slices: [doneSlice],
			})
			expect(done.spawned).toBe(0)
			expect(done.logs.join('\n')).toContain('non-work state=done')
			expect(aborted.spawned).toBe(0)
			expect(aborted.logs.join('\n')).toContain('non-work state=aborted')
		})

		test('landed Slice finalization still runs and can report the parent Change ready afterward', async () => {
			const landed: ClassifiedSlice = { ...doneSlice, state: 'landed', closedAt: null, prState: 'merged' }
			const result = await runLoopFixture({
				slices: [landed],
				finalizeSlice: async (_changeId, sliceId) => {
					if (sliceId === landed.id) landed.closedAt = new Date().toISOString()
				},
			})
			expect(result.spawned).toBe(0)
			expect(result.logs.join('\n')).toContain('finalized landed slice')
			expect(result.logs.join('\n')).toContain('state=ready')
		})

		test('empty slices → no ship guidance', async () => {
			const result = await runLoopFixture()
			expect(result.changeClosed).toBe(false)
			expect(result.logs.join('\n')).toContain('no slices; nothing to ship')
		})

		test("trowel change work keeps the user's main checkout on the starting branch during local slice host merges", async () => {
			const fixture = await setupLocalSliceMergeFixture()
			try {
				const { gh } = recordingGhOps()
				const logs: string[] = []

				await runEntityLoop(
					{
						kind: 'change',
						id: fixture.state.change.id,
						changeBranch: fixture.state.change.changeBranch,
						targetBranch: fixture.state.change.targetBranch,
						title: fixture.state.change.title,
					},
					{
						storage: fixture.storage,
						git: fixture.git,
						gh,
						spawnTurn: async ({ branch }) => {
							await fixture.commitOnBranch(branch, 'work.txt', 'work\n')
							return { verdict: 'ready', commits: 1 }
						},
						log: (msg) => logs.push(msg),
						config: { ...baseConfig, maxConcurrent: 1 },
						projectRoot: fixture.projectRoot,
					},
				)

				expect(await fixture.currentBranch()).toBe('main')
				expect(fixture.state.slice.closedAt).not.toBeNull()
				expect(logs.join('\n')).toContain(`merged ${fixture.state.slice.sliceBranch} into ${fixture.state.change.changeBranch}`)
			} finally {
				await fixture.cleanup()
			}
		})
	})
}
