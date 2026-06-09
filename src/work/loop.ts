import { classify } from './classify.ts'
import { createEffectiveSliceReader } from './effective-slices.ts'
import { processSlice } from './process-slice.ts'
import type { ClassifiedSlice } from './slice-types.ts'
import type { ClassifySliceConfig } from './types.ts'
import type { TurnIn, TurnOut } from './verdict.ts'
import type { Role } from '../prompts/load.ts'
import type { Slice, Storage } from '../storages/types.ts'
import type { GhOps } from '../utils/gh-ops.ts'
import type { GitOps } from '../utils/git-ops.ts'
import { classifySlices } from '../utils/slice-state.ts'

export type LoopConfig = {
	pr: boolean
	audit: boolean
	perSliceBranches: boolean
	maxConcurrent: number | null
	mergeNoVerify: boolean
	needsRevisionLabel?: string
}

export type LoopDeps = {
	storage: Storage
	git: GitOps
	gh: GhOps
	changeBranch: string
	spawnTurn: (args: { role: Role; slice: ClassifiedSlice; branch: string; turnIn: TurnIn }) => Promise<TurnOut>
	log: (msg: string) => void
	config: LoopConfig
	projectRoot?: string
}

/**
 * The numeric worker cap comes from config.turn.maxConcurrent. Branch safety is enforced
 * separately by the scheduler: no two running Slices may share the same stored Slice branch.
 */
function effectiveConcurrency(configCap: number | null): number {
	const cap = configCap ?? Number.POSITIVE_INFINITY
	return Math.max(1, Math.floor(cap))
}

async function findNextActionableSlice(
	fetchEnriched: () => Promise<ClassifiedSlice[]>,
	failed: Set<string>,
	running: Map<string, Promise<void>>,
	runningBranches: Set<string>,
	claimedThisFill: Set<string>,
	claimedBranchesThisFill: Set<string>,
	config: ClassifySliceConfig,
	changeBranch: string,
): Promise<ClassifiedSlice | null> {
	const slices = classifySlices(await fetchEnriched())
	return (
		slices.find((slice) => {
			const branchKey = schedulerBranchKey(slice, { perSliceBranches: config.perSliceBranches, changeBranch })
			if (failed.has(slice.id)) return false
			if (running.has(slice.id)) return false
			if (branchKey !== null && runningBranches.has(branchKey)) return false
			if (claimedThisFill.has(slice.id)) return false
			if (branchKey !== null && claimedBranchesThisFill.has(branchKey)) return false
			const resume = classify(slice, config, changeBranch)
			return resume !== 'done' && resume !== 'blocked'
		}) ?? null
	)
}

function schedulerBranchKey(slice: Pick<Slice, 'sliceBranch'>, opts: { perSliceBranches: boolean; changeBranch: string }): string | null {
	if (slice.sliceBranch !== null) return slice.sliceBranch
	return opts.perSliceBranches ? null : opts.changeBranch
}

function launchClaim(
	changeId: string,
	slice: ClassifiedSlice,
	deps: LoopDeps,
	failed: Set<string>,
	running: Map<string, Promise<void>>,
	runningBranches: Set<string>,
): void {
	const branchKey = schedulerBranchKey(slice, { perSliceBranches: deps.config.perSliceBranches, changeBranch: deps.changeBranch })
	if (branchKey !== null) runningBranches.add(branchKey)
	const task = processClaim(changeId, slice, deps, failed).finally(() => {
		running.delete(slice.id)
		if (branchKey !== null) runningBranches.delete(branchKey)
	})
	running.set(slice.id, task)
}

async function processClaim(changeId: string, slice: ClassifiedSlice, deps: LoopDeps, failed: Set<string>): Promise<void> {
	try {
		const outcome = await processSlice(changeId, slice, deps)
		if (outcome === 'partial') {
			deps.log(`[work change-${changeId} slice-${slice.id}] partial; skipping for the rest of this run`)
			failed.add(slice.id)
		}
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error)
		deps.log(`[work change-${changeId} slice-${slice.id}] error: ${msg}; skipping for the rest of this run`)
		failed.add(slice.id)
	}
}

export async function runLoop(changeId: string, deps: LoopDeps): Promise<void> {
	const state = loopState(changeId, deps)
	while (true) {
		await fillClaimSlots(state)
		if (await stopIfIdle(state)) return
		if (state.running.size === 0) continue
		await Promise.race(state.running.values())
	}
}

type WorkerLoopState = {
	changeId: string
	tag: string
	deps: LoopDeps
	failed: Set<string>
	running: Map<string, Promise<void>>
	runningBranches: Set<string>
	fetchEnriched: () => Promise<ClassifiedSlice[]>
	config: ClassifySliceConfig
	limit: number
	claims: number
}

function loopState(changeId: string, deps: LoopDeps): WorkerLoopState {
	const { storage, config } = deps
	const effectiveSlices = createEffectiveSliceReader({
		storage,
		gh: deps.gh,
		pr: config.pr,
		needsRevisionLabel: config.needsRevisionLabel,
	})
	return {
		changeId,
		tag: `[work change-${changeId}]`,
		deps,
		failed: new Set<string>(),
		running: new Map<string, Promise<void>>(),
		runningBranches: new Set<string>(),
		fetchEnriched: () => effectiveSlices.findSlices(changeId),
		config: { pr: config.pr, audit: config.audit, perSliceBranches: config.perSliceBranches },
		limit: effectiveConcurrency(config.maxConcurrent),
		claims: 0,
	}
}

async function fillClaimSlots(state: WorkerLoopState): Promise<void> {
	const claimedThisFill = new Set<string>()
	const claimedBranchesThisFill = new Set<string>()
	while (state.running.size < state.limit) {
		const slice = await findNextActionableSlice(
			state.fetchEnriched,
			state.failed,
			state.running,
			state.runningBranches,
			claimedThisFill,
			claimedBranchesThisFill,
			state.config,
			state.deps.changeBranch,
		)
		if (!slice) return
		claimedThisFill.add(slice.id)
		const branchKey = schedulerBranchKey(slice, { perSliceBranches: state.config.perSliceBranches, changeBranch: state.deps.changeBranch })
		if (branchKey !== null) claimedBranchesThisFill.add(branchKey)
		state.claims += 1
		state.deps.log(`${state.tag} claim ${state.claims}: slice ${slice.id}`)
		launchClaim(state.changeId, slice, state.deps, state.failed, state.running, state.runningBranches)
	}
}

async function stopIfIdle(state: WorkerLoopState): Promise<boolean> {
	if (state.running.size > 0) return false
	const remaining = await findNextActionableSlice(
		state.fetchEnriched,
		state.failed,
		state.running,
		state.runningBranches,
		new Set(),
		new Set(),
		state.config,
		state.deps.changeBranch,
	)
	if (remaining) return false
	state.deps.log(`${state.tag} no actionable slices; exiting after ${state.claims} claim(s)`)
	return true
}

if (import.meta.vitest) {
	const { describe, test, expect } = import.meta.vitest
	const { recordingGhOps } = await import('../test-utils/gh-ops-recorder.ts')

	type FakeState = {
		slices: Slice[]
	}

	function makeStorage(state: FakeState, overrides: Partial<Storage> = {}): Storage {
		return {
			createChange: async () => ({ id: 'x', title: 'x' }),
			findChange: async () => null,
			listChanges: async () => [],
			finalizeChange: async () => {},
			abortChange: async () => {},
			createSlice: async () => {
				throw new Error('unused')
			},
			findSlices: async () => state.slices.map((s) => ({ ...s })),
			updateChangeMetadata: async () => {},
			setSliceReadyForAgent: async (_changeId, sliceId, ready) => {
				setTestReadyForAgent(state.slices.find((x) => x.id === sliceId), ready)
			},
			setSliceBlockers: async (_changeId, sliceId, blockedBy) => {
				const slice = state.slices.find((x) => x.id === sliceId)
				if (slice) slice.blockedBy = blockedBy
			},
			markSliceImplemented: async (_changeId, sliceId, at) => {
				const slice = state.slices.find((x) => x.id === sliceId)
				if (slice) slice.implementedAt = at
			},
			markSliceAudited: async (_changeId, sliceId, at) => {
				const slice = state.slices.find((x) => x.id === sliceId)
				if (slice) slice.auditedAt = at
			},
			finalizeSlice: async (_changeId, sliceId) => {
				setTestSliceClosedAt(state.slices.find((x) => x.id === sliceId))
			},
			abortSlice: async (_changeId, sliceId) => {
				setTestSliceClosedAt(state.slices.find((x) => x.id === sliceId))
			},
			updateSliceMetadata: async (_changeId, sliceId, patch) => {
				const slice = state.slices.find((x) => x.id === sliceId)
				if (slice && patch.sliceBranch !== undefined) slice.sliceBranch = patch.sliceBranch
			},
			...overrides,
		}
	}

	function setTestSliceClosedAt(slice: Slice | undefined): void {
		if (slice) slice.closedAt = new Date().toISOString()
	}

	function setTestReadyForAgent(slice: Slice | undefined, value: boolean): void {
		if (slice) slice.readyForAgent = value
	}

	const { noopGitOps } = await import('../test-utils/git-ops-fixtures.ts')
	const noopGit = noopGitOps

	function makeSlice(overrides: Partial<ClassifiedSlice> = {}): ClassifiedSlice {
		return {
			id: 's1',
			title: 'A',
			body: 'spec',
			state: 'open',
			closedAt: null,
			implementedAt: null,
			auditedAt: null,
			readyForAgent: true,
			needsRevision: false,
			blockedBy: [],
			sliceBranch: `change-p1/slice-${overrides.id ?? 's1'}-a`,
			prState: null,
			...overrides,
		}
	}

	function workerPoolSpawnTurn(events: string[], slowGate: Promise<void>, releaseSlow: () => void): LoopDeps['spawnTurn'] {
		return async ({ role, slice }) => {
			events.push(`${role}:${slice.id}:start`)
			await waitForSlowSlice(slice, slowGate)
			if (events.includes('audit:fast:start')) releaseSlow()
			events.push(`${role}:${slice.id}:finish`)
			return workerPoolVerdict(role, slice)
		}
	}

	function waitForSlowSlice(slice: ClassifiedSlice, slowGate: Promise<void>): Promise<void> | undefined {
		return slice.id === 'slow' ? slowGate : undefined
	}

	function workerPoolVerdict(role: Role, slice: ClassifiedSlice): TurnOut {
		return slice.id === 'slow' ? { verdict: 'partial', commits: 0 } : { verdict: 'ready', commits: role === 'implement' ? 1 : 0 }
	}

	function prSummaryForSlice(s: ClassifiedSlice): import('../utils/gh-ops.ts').PrSummary | null {
		const draftByState = new Map<ClassifiedSlice['prState'], boolean>([
			['draft', true],
			['ready', false],
		])
		const isDraft = draftByState.get(s.prState)
		return isDraft === undefined
			? null
			: { number: prNumberForSlice(s), headRefName: `change-p1/slice-${s.id}-${s.title.toLowerCase()}`, isDraft }
	}

	function prNumberForSlice(s: ClassifiedSlice): number {
		return Number(new Map([['fast', 1]]).get(s.id) ?? 2)
	}

	function openPrsForSlices(slices: ClassifiedSlice[]): import('../utils/gh-ops.ts').PrSummary[] {
		return slices.map(prSummaryForSlice).filter((s): s is import('../utils/gh-ops.ts').PrSummary => s !== null)
	}

	function makeDeps(storage: Storage, overrides: Partial<LoopDeps> = {}): LoopDeps {
		// Default GhOps: listOpenPrs returns [] so PR-state enrichment is a clean no-op on
		// pr=true tests. Per-test gh overrides handle create / list-with-results cases.
		const { gh } = recordingGhOps()
		return {
			storage,
			git: noopGit(),
			gh,
			changeBranch: 'change-branch',
			spawnTurn: async () => ({ verdict: 'ready', commits: 1 }),
			log: () => {},
			config: { pr: false, audit: false, perSliceBranches: false, maxConcurrent: null, mergeNoVerify: false },
			...overrides,
		}
	}

	async function peakConcurrentImplementers(slices: ClassifiedSlice[], maxConcurrent: number, perSliceBranches = true): Promise<number> {
		const storage = makeStorage({ slices })
		let live = 0
		let peak = 0
		await runLoop(
			'p1',
			makeDeps(storage, {
				spawnTurn: async () => {
					live++
					peak = Math.max(peak, live)
					await new Promise((r) => setTimeout(r, 5))
					live--
					return { verdict: 'partial', commits: 0 }
				},
				config: { pr: false, audit: false, perSliceBranches, maxConcurrent, mergeNoVerify: false },
			}),
		)
		return peak
	}

	describe('runLoop', () => {
		test('blocked slice → no sandbox spawn; outcome no-work', async () => {
			const blocked = makeSlice({ id: 'b1', state: 'blocked', blockedBy: ['a'] })
			const storage = makeStorage({ slices: [blocked] })
			let sandboxCalls = 0
			await runLoop(
				'p1',
				makeDeps(storage, {
					spawnTurn: async () => {
						sandboxCalls++
						return { verdict: 'ready', commits: 1 }
					},
				}),
			)
			expect(sandboxCalls).toBe(0)
		})

		test('fetchEnriched runs gh listOpenPrs whenever config.pr is true, regardless of storage capability', async () => {
			const slice = makeSlice({ id: 's1' })
			const storage = makeStorage({ slices: [slice] })
			const { gh, calls } = recordingGhOps({
				createDraftPr: async ({ head }) => {
					slice.prState = 'draft'
					return { number: 1, headRefName: head, isDraft: true, url: '#1' }
				},
				listOpenPrs: async () => [{ number: 1, headRefName: 'change-p1/slice-s1-a', isDraft: true }],
			})
			await runLoop(
				'p1',
				makeDeps(storage, {
					gh,
					spawnTurn: async () => ({ verdict: 'ready', commits: 1 }),
					config: { pr: true, audit: false, perSliceBranches: true, maxConcurrent: null, mergeNoVerify: false },
				}),
			)
			expect(calls.find((c) => c[0] === 'listOpenPrs')).toBeDefined()
		})

		test('ready slice: runs implementer, lands done, exits with empty actionable queue', async () => {
			const slice = makeSlice({ id: 's1' })
			const storage = makeStorage({ slices: [slice] })
			const roles: Role[] = []
			await runLoop(
				'p1',
				makeDeps(storage, {
					spawnTurn: async ({ role }) => {
						roles.push(role)
						return { verdict: 'ready', commits: 1 }
					},
				}),
			)
			expect(roles).toEqual(['implement'])
			const after = classifySlices(await storage.findSlices('p1'))
			expect(after[0]!.state).toBe('done')
		})

		test('needs-revision PR feedback runs the Reviewer and clears the PR signal', async () => {
			const slice = makeSlice({
				id: 's1',
				state: 'awaiting-review',
				readyForAgent: false,
				implementedAt: '2026-06-04T00:00:00.000Z',
				auditedAt: '2026-06-04T00:01:00.000Z',
			})
			const storage = makeStorage({ slices: [slice] })
			let needsRevision = true
			const { gh, calls } = recordingGhOps({
				listOpenPrs: async () => [
					{
						number: 5,
						headRefName: 'change-p1/slice-s1-a',
						isDraft: false,
						labels: needsRevision ? [{ name: 'needs-revision' }] : [],
					},
				],
				findPrNumberByHead: async () => 5,
				editIssueLabels: async (_id, patch) => {
					if (patch.remove?.includes('needs-revision')) needsRevision = false
				},
			})
			const roles: Role[] = []
			await runLoop(
				'p1',
				makeDeps(storage, {
					gh,
					spawnTurn: async ({ role, turnIn }) => {
						roles.push(role)
						expect(turnIn.feedback).toEqual([])
						return { verdict: 'no-work-needed', commits: 0 }
					},
					config: { pr: true, audit: true, perSliceBranches: true, maxConcurrent: null, mergeNoVerify: false },
				}),
			)
			expect(roles).toEqual(['review'])
			expect(calls).toContainEqual(['editIssueLabels', 5, { remove: ['needs-revision'] }])
			expect(needsRevision).toBe(false)
		})

		test('spawnTurn throws → loop catches, logs the error, returns partial (one bad slice does not abort the batch)', async () => {
			const stuck = makeSlice({ id: 'stuck' })
			const fine = makeSlice({ id: 'fine' })
			const storage = makeStorage({ slices: [stuck, fine] })
			const logs: string[] = []
			let spawnCalls = 0
			await runLoop(
				'p1',
				makeDeps(storage, {
					spawnTurn: async ({ slice }) => {
						spawnCalls++
						if (slice.id === 'stuck') throw new Error('verdict file missing (.trowel/turn-out.json)')
						return { verdict: 'ready', commits: 1 }
					},
					log: (m) => {
						logs.push(m)
					},
					config: { pr: false, audit: false, perSliceBranches: false, maxConcurrent: null, mergeNoVerify: false },
				}),
			)
			expect(spawnCalls).toBeGreaterThanOrEqual(2) // both slices were attempted
			expect(logs.some((m) => /verdict file missing/.test(m))).toBe(true)
			const after = classifySlices(await storage.findSlices('p1'))
			expect(after.find((s) => s.id === 'fine')!.state).toBe('done')
			expect(after.find((s) => s.id === 'stuck')!.state).toBe('open')
		})

		test('partial verdict: slice added to skip set; worker pool exits after one claim', async () => {
			const slice = makeSlice({ id: 's1' })
			const storage = makeStorage({ slices: [slice] })
			let claims = 0
			await runLoop(
				'p1',
				makeDeps(storage, {
					spawnTurn: async () => ({ verdict: 'partial', commits: 0 }),
					log: (m) => {
						if (/^\[work change-p1\] claim \d+:/.test(m)) claims++
					},
					config: { pr: false, audit: false, perSliceBranches: false, maxConcurrent: null, mergeNoVerify: false },
				}),
			)
			// One claim: slice tried once, returned partial, added to skip set.
			expect(claims).toBe(1)
			const after = classifySlices(await storage.findSlices('p1'))
			expect(after[0]!.state).toBe('open')
		})

		test('stuck slice (always partial) does not block sibling ready slices in subsequent iterations', async () => {
			const stuck = makeSlice({ id: 'stuck' })
			const fine = makeSlice({ id: 'fine' })
			const storage = makeStorage({ slices: [stuck, fine] })
			const calls: string[] = []
			await runLoop(
				'p1',
				makeDeps(storage, {
					spawnTurn: async ({ slice: s }) => {
						calls.push(s.id)
						return s.id === 'stuck' ? { verdict: 'partial', commits: 0 } : { verdict: 'ready', commits: 1 }
					},
					config: { pr: false, audit: false, perSliceBranches: false, maxConcurrent: null, mergeNoVerify: false },
				}),
			)
			expect(calls).toContain('fine')
			const after = classifySlices(await storage.findSlices('p1'))
			expect(after.find((s) => s.id === 'fine')!.state).toBe('done')
		})

		test('a rejected slice (stored branch verify throws) is logged, added to skip set, not retried', async () => {
			const a = makeSlice({ id: 'a' })
			const b = makeSlice({ id: 'b' })
			const storage = makeStorage({ slices: [a, b] })
			const git = noopGit()
			git.remoteBranchExists = async (branch) => {
				if (branch.includes('slice-a')) throw new Error('docker unreachable')
				return true
			}
			const calls: string[] = []
			const logs: string[] = []
			await runLoop(
				'p1',
				makeDeps(storage, {
					git,
					spawnTurn: async ({ slice: s }) => {
						calls.push(s.id)
						return { verdict: 'partial', commits: 0 }
					},
					log: (m) => logs.push(m),
					config: { pr: true, audit: false, perSliceBranches: true, maxConcurrent: null, mergeNoVerify: false },
				}),
			)
			// a fails in prepareImplement (no sandbox spawn); b spawns once and is skipped after partial.
			expect(calls.filter((id) => id === 'a')).toHaveLength(0)
			expect(calls.filter((id) => id === 'b').length).toBeGreaterThan(0)
			expect(logs.some((m) => /slice-a\] error: docker unreachable/.test(m))).toBe(true)
		})

		test('scheduler serializes Slices that share the same stored Slice branch even when config allows 3', async () => {
			const slices = ['1', '2', '3', '4'].map((id) => makeSlice({ id, sliceBranch: 'change-p1-shared' }))
			expect(await peakConcurrentImplementers(slices, 3, false)).toBe(1)
		})

		test('scheduler treats unassigned Slices as the Change branch in shared-branch mode', async () => {
			const assigned = makeSlice({ id: 'assigned', sliceBranch: 'change-branch' })
			const unassigned = makeSlice({ id: 'unassigned', sliceBranch: null })
			const storage = makeStorage({ slices: [assigned, unassigned] })
			let live = 0
			let peak = 0
			await runLoop(
				'p1',
				makeDeps(storage, {
					spawnTurn: async () => {
						live += 1
						peak = Math.max(peak, live)
						await new Promise((resolve) => setTimeout(resolve, 5))
						live -= 1
						return { verdict: 'ready', commits: 1 }
					},
					config: { pr: false, audit: false, perSliceBranches: false, maxConcurrent: 2, mergeNoVerify: false },
				}),
			)
			expect(peak).toBe(1)
		})

		test('scheduler parallelizes unassigned Slices in per-Slice branch mode', async () => {
			const slices = ['1', '2', '3'].map((id) => makeSlice({ id, sliceBranch: null }))
			expect(await peakConcurrentImplementers(slices, 2, true)).toBe(2)
		})

		test('scheduler honors config.maxConcurrent for distinct stored Slice branches', async () => {
			const slices = ['1', '2', '3', '4'].map((id) => makeSlice({ id }))
			const peak = await peakConcurrentImplementers(slices, 2)
			expect(peak).toBeLessThanOrEqual(2)
			expect(peak).toBeGreaterThan(1)
		})

		test('worker pool schedules a finished slice again without waiting for a slower sibling', async () => {
			const fast = makeSlice({ id: 'fast' })
			const slow = makeSlice({ id: 'slow' })
			const state = { slices: [fast, slow] }
			const storage = makeStorage(state)
			const events: string[] = []
			let releaseSlow!: () => void
			const slowGate = new Promise<void>((resolve) => {
				releaseSlow = resolve
			})
			const { gh } = recordingGhOps({
				createDraftPr: async ({ head }) => {
					const id = head.includes('fast') ? 'fast' : 'slow'
					const slice = state.slices.find((s) => s.id === id)
					if (slice) slice.prState = 'draft'
					return { number: 1, headRefName: head, isDraft: true, url: '#1' }
				},
				findPrNumberByHead: async () => 1,
				markPrReady: async () => {
					state.slices.find((s) => s.id === 'fast')!.prState = 'ready'
				},
				listOpenPrs: async () => openPrsForSlices(state.slices),
			})
			await runLoop(
				'p1',
				makeDeps(storage, {
					gh,
					spawnTurn: workerPoolSpawnTurn(events, slowGate, releaseSlow),
					config: { pr: true, audit: true, perSliceBranches: true, maxConcurrent: 2, mergeNoVerify: false },
				}),
			)
			expect(events.indexOf('audit:fast:start')).toBeGreaterThan(events.indexOf('implement:fast:finish'))
			expect(events.indexOf('audit:fast:start')).toBeLessThan(events.indexOf('implement:slow:finish'))
			expect(events).toContain('implement:slow:start')
		})
	})

	describe('processSlice', () => {
		test('draft PR without process milestones is not auto-reviewed by the loop', async () => {
			const raw = makeSlice({ id: 's1', prState: null })
			const initial = makeSlice({ id: 's1', prState: 'draft', state: 'in-flight' })
			const storage = makeStorage({ slices: [raw] })
			const roles: Role[] = []
			const { gh } = recordingGhOps()

			const outcome = await processSlice(
				'p1',
				initial,
				makeDeps(storage, {
					spawnTurn: async ({ role }) => {
						roles.push(role)
						return { verdict: 'ready', commits: 0 }
					},
					gh,
					config: { pr: true, audit: true, perSliceBranches: true, maxConcurrent: null, mergeNoVerify: false },
				}),
			)

			expect(outcome).toBe('done')
			expect(roles).toEqual([])
		})

		test('progress outcome releases the claim; scheduler owns the next refetch', async () => {
			// landImplement returns 'progress' after recording implementedAt. processSlice runs exactly
			// one phase step, so the outer worker-pool scheduler owns the next state refetch.
			const slice = makeSlice({ id: 's1' })
			const state = { slices: [slice] }
			const storage = makeStorage(state)
			const { gh } = recordingGhOps()
			const outcome = await processSlice(
				'p1',
				slice,
				makeDeps(storage, {
					spawnTurn: async () => ({ verdict: 'ready', commits: 1 }),
					gh,
					config: { pr: true, audit: false, perSliceBranches: true, maxConcurrent: null, mergeNoVerify: false },
				}),
			)
			expect(outcome).toBe('no-work')
			expect(state.slices[0]!.implementedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
		})
	})
}
