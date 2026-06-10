import { runCloseOutReview } from './change-review.ts'
import type { ChangeState } from './change-types.ts'
import { createEffectiveSliceReader } from './effective-slices.ts'
import { runLoop, type LoopConfig, type LoopDeps } from './loop.ts'
import type { ClassifiedSlice } from './slice-types.ts'
import type { TurnIn, TurnOut } from './verdict.ts'
import type { Role } from '../prompts/load.ts'
import type { Change, Slice, Storage } from '../storages/types.ts'
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
	spawnTurn: (args: { role: Role; slice?: ClassifiedSlice; change?: Pick<Change, 'id' | 'title' | 'body'>; branch: string; turnIn: TurnIn }) => Promise<TurnOut>
	log: (msg: string) => void
	config: LoopConfig
	projectRoot?: string
}

export type EntityLoopOptions = {
	loop?: boolean
	sleep?: (ms: number) => Promise<void>
}

type ChangeLoopMemory = {
	closeOutReviewAttempted: boolean
	idlePolls: number
}

/**
 * Top-level dispatch entry for `trowel change work`. Work never runs Close-out,
 * Change finalization, or Cleanup; it runs open Change Slice work/finalization
 * and Change-level Reviewer work for Close-out PR feedback, then reports the next explicit action.
 */
export async function runEntityLoop(entity: LoopEntity, deps: EntityLoopDeps, opts: EntityLoopOptions = {}): Promise<void> {
	await runChangeEntity(entity, deps, opts)
}

async function runChangeEntity(entity: Extract<LoopEntity, { kind: 'change' }>, deps: EntityLoopDeps, opts: EntityLoopOptions): Promise<void> {
	const memory: ChangeLoopMemory = { closeOutReviewAttempted: false, idlePolls: 0 }
	while (true) {
		const current = await readChangeWorkState(entity, deps)
		if (current.state === 'open') {
			await runOpenSliceLoop(entity, deps, opts)
			if (!opts.loop) return await reportAfterOpenLoop(entity, deps)
			continue
		}
		if (current.state === 'needs-revision') {
			if (!memory.closeOutReviewAttempted) {
				memory.closeOutReviewAttempted = true
				await runCloseOutReviewForChange(current.change, deps)
				if (!opts.loop) return await reportAfterCloseOutReview(entity, deps)
				continue
			}
			if (await pollNonActionableChangeState(entity, current.state, deps, opts, memory)) continue
			reportIfNotOpen(current, deps)
			return
		}
		if (current.state === 'awaiting-review' && await pollNonActionableChangeState(entity, current.state, deps, opts, memory)) continue
		reportIfNotOpen(current, deps)
		return
	}
}

async function runOpenSliceLoop(entity: Extract<LoopEntity, { kind: 'change' }>, deps: EntityLoopDeps, opts: EntityLoopOptions): Promise<void> {
	await runLoop(entity.id, loopDepsForChange(entity, deps, opts))
}

async function reportAfterOpenLoop(entity: Extract<LoopEntity, { kind: 'change' }>, deps: EntityLoopDeps): Promise<void> {
	const after = await readChangeWorkState(entity, deps)
	if (reportIfNotOpen(after, deps)) return
	if (after.slices.length === 0) deps.log(`[work change-${entity.id}] no slices; nothing to ship`)
}

async function reportAfterCloseOutReview(entity: Extract<LoopEntity, { kind: 'change' }>, deps: EntityLoopDeps): Promise<void> {
	const after = await readChangeWorkState(entity, deps)
	reportIfNotOpen(after, deps)
}

async function runCloseOutReviewForChange(change: Change, deps: EntityLoopDeps): Promise<void> {
	const outcome = await runCloseOutReview(change, {
		git: deps.git,
		gh: deps.gh,
		spawnTurn: deps.spawnTurn,
		log: deps.log,
		needsRevisionLabel: deps.config.needsRevisionLabel,
		projectRoot: deps.projectRoot,
	})
	if (outcome === 'partial') deps.log(`[work change-${change.id}] partial; skipping Close-out PR revision for the rest of this run`)
}

async function pollNonActionableChangeState(
	entity: Extract<LoopEntity, { kind: 'change' }>,
	state: ChangeState,
	deps: EntityLoopDeps,
	opts: EntityLoopOptions,
	memory: ChangeLoopMemory,
): Promise<boolean> {
	if (!opts.loop) return false
	memory.idlePolls += 1
	logChangeIdlePoll(entity.id, state, deps, deps.config.loopPollSeconds, memory.idlePolls)
	await (opts.sleep ?? sleep)(deps.config.loopPollSeconds * 1000)
	return true
}

function logChangeIdlePoll(changeId: string, state: ChangeState, deps: EntityLoopDeps, pollSeconds: number, polls: number): void {
	if (polls === 1) deps.log(`[work change-${changeId}] state=${state}; polling every ${pollSeconds}s`)
	else if (polls % 10 === 0) deps.log(`[work change-${changeId}] still state=${state} after ${polls} polls`)
}

type ChangeWorkState = { change: Change; slices: ClassifiedSlice[]; state: ChangeState }

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
	const state = await classifyChange(change, slices, { gh: deps.gh, git: deps.git, needsRevisionLabel: deps.config.needsRevisionLabel })
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
		case 'needs-revision':
			return `[work change-${changeId}] state=needs-revision; Close-out PR needs revision; running Reviewer is required before shipping`
		case 'awaiting-review':
			return `[work change-${changeId}] state=awaiting-review; Close-out PR awaiting review or merge; run: ${ship}`
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

function loopDepsForChange(entity: Extract<LoopEntity, { kind: 'change' }>, deps: EntityLoopDeps, opts: EntityLoopOptions): LoopDeps {
	return {
		storage: deps.storage,
		git: deps.git,
		gh: deps.gh,
		changeBranch: entity.changeBranch,
		spawnTurn: deps.spawnTurn,
		log: deps.log,
		config: deps.config,
		projectRoot: deps.projectRoot,
		idlePolling: opts.loop ? idlePollingFor(entity, deps, opts) : undefined,
	}
}

function idlePollingFor(entity: Extract<LoopEntity, { kind: 'change' }>, deps: EntityLoopDeps, opts: EntityLoopOptions): NonNullable<LoopDeps['idlePolling']> {
	return {
		pollSeconds: deps.config.loopPollSeconds,
		sleep: opts.sleep ?? sleep,
		shouldContinue: async () => (await readChangeWorkState(entity, deps)).state === 'open',
	}
}

async function sleep(ms: number): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, ms))
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
		loopPollSeconds: 30,
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
		change?: Change
		slices?: Slice[]
		config?: LoopConfig
		git?: GitOps
		gh?: GhOps
		spawnTurn?: EntityLoopDeps['spawnTurn']
		finalizeSlice?: Storage['finalizeSlice']
		options?: EntityLoopOptions
	}

	async function runLoopFixture(opts: LoopFixtureOpts = {}): Promise<{ changeClosed: boolean; logs: string[]; spawned: number }> {
		let changeClosed = false
		let spawned = 0
		const logs: string[] = []
		const change = opts.change ?? {
			id: '3',
			title: 'Feat',
			body: '',
			createdAt: '2026-01-01T00:00:00.000Z',
			closedAt: null,
			targetBranch: 'main',
			changeBranch: '3-feat',
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
			opts.options,
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

		test('awaiting-review Change → reports Close-out PR review guidance and runs no Slice work', async () => {
			const { gh } = recordingGhOps({ findAnyPrByHead: async (head) => (head === '3-feat' ? { number: 12, state: 'OPEN' } : null) })
			const result = await runLoopFixture({ slices: [doneSlice], gh, config: { ...baseConfig, pr: true } })
			expect(result.spawned).toBe(0)
			expect(result.logs.join('\n')).toContain('state=awaiting-review')
			expect(result.logs.join('\n')).toContain('Close-out PR awaiting review or merge')
		})

		test('needs-revision Change runs one Close-out Reviewer Turn and clears needs-revision label', async () => {
			let labels = [{ name: 'needs-revision' }]
			const gitCalls: string[] = []
			const { gh, calls } = recordingGhOps({
				findAnyPrByHead: async (head) => (head === '3-feat' ? { number: 12, state: 'OPEN', labels } : null),
				findPrNumberByHead: async () => 12,
				fetchPrReviews: async () => [{ author: { login: 'human' }, submittedAt: '2026-06-09T00:00:00.000Z', body: 'Fix it', state: 'CHANGES_REQUESTED' }],
				editIssueLabels: async (_n, opts) => { labels = labels.filter((label) => !opts.remove?.includes(label.name)) },
			})
			const result = await runLoopFixture({
				slices: [doneSlice],
				gh,
				git: unmergedGit({ push: async (branch) => { gitCalls.push(`push(${branch})`) } }),
				config: { ...baseConfig, pr: true },
				spawnTurn: async (args) => {
					expect(args.change).toMatchObject({ id: '3', title: 'Feat' })
					expect(args.slice).toBeUndefined()
					expect(args.branch).toBe('3-feat')
					expect(args.turnIn).toMatchObject({ change: { id: '3', title: 'Feat' }, pr: { number: 12, branch: '3-feat' } })
					return { verdict: 'ready', commits: 1 }
				},
			})
			expect(result.spawned).toBe(1)
			expect(gitCalls).toEqual(['push(3-feat)'])
			expect(calls).toContainEqual(['editIssueLabels', 12, { remove: ['needs-revision'] }])
			expect(result.logs.join('\n')).toContain('state=awaiting-review')
		})

		test('polling mode does not rerun Close-out Reviewer after one attempted revision', async () => {
			let open = true
			const { gh } = recordingGhOps({
				findAnyPrByHead: async (head) => (head === '3-feat' && open ? { number: 12, state: 'OPEN', labels: [{ name: 'needs-revision' }] } : null),
				findPrNumberByHead: async () => 12,
				fetchPrThread: async () => [{ author: { login: 'reviewer' }, createdAt: '2026-01-01T00:00:00.000Z', body: 'please revise' }],
			})
			let sleeps = 0
			const result = await runLoopFixture({
				slices: [doneSlice],
				gh,
				config: { ...baseConfig, pr: true, loopPollSeconds: 1 },
				spawnTurn: async () => ({ verdict: 'ready', commits: 0 }),
				options: {
					loop: true,
					sleep: async () => {
						sleeps += 1
						open = false
					},
				},
			})
			expect(result.spawned).toBe(1)
			expect(sleeps).toBe(1)
			expect(result.logs.join('\n')).toContain('state=needs-revision; polling every 1s')
			expect(result.logs.join('\n')).toContain('state=ready')
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
					title: 'Feat',
					body: '',
					createdAt: '2026-01-01T00:00:00.000Z',
					closedAt: '2026-06-04T00:00:00.000Z',
					targetBranch: 'main',
					changeBranch: '3-feat',
				},
				slices: [doneSlice],
				gh,
			})
			const aborted = await runLoopFixture({
				change: {
					id: '3',
					title: 'Feat',
					body: '',
					createdAt: '2026-01-01T00:00:00.000Z',
					closedAt: '2026-06-04T00:00:00.000Z',
					targetBranch: 'main',
					changeBranch: '3-feat',
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
