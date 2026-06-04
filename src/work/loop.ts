import { classify } from './classify.ts'
import { createEffectiveSliceReader } from './effective-slices.ts'
import { processSlice } from './process-slice.ts'
import type { TurnIn, TurnOut } from './verdict.ts'
import type { Role } from '../prompts/load.ts'
import type { ClassifiedSlice, ClassifySliceConfig, Storage, Slice, SlicePatch } from '../storages/types.ts'
import type { GhOps } from '../utils/gh-ops.ts'
import type { GitOps } from '../utils/git-ops.ts'
import { classifySlices } from '../utils/slice-state.ts'

export type LoopConfig = {
	usePrs: boolean
	review: boolean
	perSliceBranches: boolean
	maxConcurrent: number | null
	mergeNoVerify: boolean
}

export type LoopDeps = {
	storage: Storage
	git: GitOps
	gh: GhOps
	integrationBranch: string
	spawnTurn: (args: { role: Role; slice: Slice; branch: string; turnIn: TurnIn }) => Promise<TurnOut>
	log: (msg: string) => void
	config: LoopConfig
	/**
	 * Project root used by the phase primitives' land step to acquire the **Mutation lock** around
	 * their git+storage mutations. Optional only so existing test fixtures don't have to thread it
	 * through; production wiring always supplies it.
	 */
	projectRoot?: string
}

/**
 * Concurrency derives from `config.work.perSliceBranches`:
 *
 * - `perSliceBranches: true` — slices land on their own branches, so parallel implementers
 *   are safe; the user's `config.turn.maxConcurrent` is the only cap.
 * - `perSliceBranches: false` — implementers commit directly on the integration branch, so
 *   any concurrency would race; force a cap of 1 regardless of user config.
 */
function effectiveConcurrency(perSliceBranches: boolean, configCap: number | null): number {
	const cap = configCap ?? Number.POSITIVE_INFINITY
	const storageCap = perSliceBranches ? Number.POSITIVE_INFINITY : 1
	return Math.max(1, Math.floor(Math.min(cap, storageCap)))
}

async function findNextActionableSlice(
	fetchEnriched: () => Promise<Slice[]>,
	failed: Set<string>,
	running: Map<string, Promise<void>>,
	claimedThisFill: Set<string>,
	config: ClassifySliceConfig,
): Promise<ClassifiedSlice | null> {
	const slices = classifySlices(await fetchEnriched())
	return slices.find((slice) => {
		if (failed.has(slice.id)) return false
		if (running.has(slice.id)) return false
		if (claimedThisFill.has(slice.id)) return false
		const resume = classify(slice, config)
		return resume !== 'done' && resume !== 'blocked'
	}) ?? null
}

function launchClaim(changeId: string, slice: ClassifiedSlice, deps: LoopDeps, failed: Set<string>, running: Map<string, Promise<void>>): void {
	const task = processClaim(changeId, slice, deps, failed).finally(() => running.delete(slice.id))
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
	fetchEnriched: () => Promise<Slice[]>
	config: ClassifySliceConfig
	limit: number
	claims: number
}

function loopState(changeId: string, deps: LoopDeps): WorkerLoopState {
	const { storage, config } = deps
	const effectiveSlices = createEffectiveSliceReader({ storage, gh: deps.gh, usePrs: config.usePrs })
	return {
		changeId,
		tag: `[work change-${changeId}]`,
		deps,
		failed: new Set<string>(),
		running: new Map<string, Promise<void>>(),
		fetchEnriched: () => effectiveSlices.findSlices(changeId),
		config: { usePrs: config.usePrs, review: config.review, perSliceBranches: config.perSliceBranches },
		limit: effectiveConcurrency(config.perSliceBranches, config.maxConcurrent),
		claims: 0,
	}
}

async function fillClaimSlots(state: WorkerLoopState): Promise<void> {
	const claimedThisFill = new Set<string>()
	while (state.running.size < state.limit) {
		const slice = await findNextActionableSlice(state.fetchEnriched, state.failed, state.running, claimedThisFill, state.config)
		if (!slice) return
		claimedThisFill.add(slice.id)
		state.claims += 1
		state.deps.log(`${state.tag} claim ${state.claims}: slice ${slice.id}`)
		launchClaim(state.changeId, slice, state.deps, state.failed, state.running)
	}
}

async function stopIfIdle(state: WorkerLoopState): Promise<boolean> {
	if (state.running.size > 0) return false
	const remaining = await findNextActionableSlice(state.fetchEnriched, state.failed, state.running, new Set(), state.config)
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
			createChange: async () => ({ id: 'x', branch: 'x' }),
			findChange: async () => null,
			listChanges: async () => [],
			closeChange: async () => {},
			createSlice: async () => {
				throw new Error('unused')
			},
			findSlices: async () => state.slices.map((s) => ({ ...s })),
			findSlice: async () => null,
			updateSlice: async (_p, sliceId, patch) => {
				applyTestSlicePatch(state.slices.find((x) => x.id === sliceId), patch)
			},
			...overrides,
		}
	}

	function applyTestSlicePatch(slice: Slice | undefined, patch: SlicePatch): void {
		if (!slice) return
		setTestSliceClosedAt(slice, patch.closedAt)
		setTestReadyForAgent(slice, patch.readyForAgent)
		setTestNeedsRevision(slice, patch.needsRevision)
	}

	function setTestSliceClosedAt(slice: Slice, closedAt: SlicePatch['closedAt']): void {
		if (closedAt === undefined) return
		slice.closedAt = closedAt
		slice.state = closedAt === null ? 'open' : 'done'
	}

	function setTestReadyForAgent(slice: Slice, value: boolean | undefined): void {
		if (value !== undefined) slice.readyForAgent = value
	}

	function setTestNeedsRevision(slice: Slice, value: boolean | undefined): void {
		if (value !== undefined) slice.needsRevision = value
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
			readyForAgent: true,
			needsRevision: false,
			blockedBy: [],
			prState: null,
			...overrides,
		}
	}

	function workerPoolSpawnTurn(events: string[], slowGate: Promise<void>, releaseSlow: () => void): LoopDeps['spawnTurn'] {
		return async ({ role, slice }) => {
			events.push(`${role}:${slice.id}:start`)
			await waitForSlowSlice(slice, slowGate)
			if (events.includes('review:fast:start')) releaseSlow()
			events.push(`${role}:${slice.id}:finish`)
			return workerPoolVerdict(role, slice)
		}
	}

	function waitForSlowSlice(slice: Slice, slowGate: Promise<void>): Promise<void> | undefined {
		return slice.id === 'slow' ? slowGate : undefined
	}

	function workerPoolVerdict(role: Role, slice: Slice): TurnOut {
		return slice.id === 'slow' ? { verdict: 'partial', commits: 0 } : { verdict: 'ready', commits: role === 'implement' ? 1 : 0 }
	}

	function prSummaryForSlice(s: Slice): import('../utils/gh-ops.ts').PrSummary | null {
		const draftByState = new Map<Slice['prState'], boolean>([['draft', true], ['ready', false]])
		const isDraft = draftByState.get(s.prState)
		return isDraft === undefined ? null : { number: prNumberForSlice(s), headRefName: `change-p1/slice-${s.id}-${s.title.toLowerCase()}`, isDraft }
	}

	function prNumberForSlice(s: Slice): number {
		return Number(new Map([['fast', 1]]).get(s.id) ?? 2)
	}

	function openPrsForSlices(slices: Slice[]): import('../utils/gh-ops.ts').PrSummary[] {
		return slices.map(prSummaryForSlice).filter((s): s is import('../utils/gh-ops.ts').PrSummary => s !== null)
	}

	function makeDeps(storage: Storage, overrides: Partial<LoopDeps> = {}): LoopDeps {
		// Default GhOps: listOpenPrs returns [] so PR-state enrichment is a clean no-op on
		// usePrs=true tests. Per-test gh overrides handle create / list-with-results cases.
		const { gh } = recordingGhOps()
		return {
			storage,
			git: noopGit(),
			gh,
			integrationBranch: 'integration',
			spawnTurn: async () => ({ verdict: 'ready', commits: 1 }),
			log: () => {},
			config: { usePrs: false, review: false, perSliceBranches: false, maxConcurrent: null, mergeNoVerify: false },
			...overrides,
		}
	}

	async function peakConcurrentImplementers(perSliceBranches: boolean, maxConcurrent: number): Promise<number> {
		const slices = ['1', '2', '3', '4'].map((id) => makeSlice({ id }))
		const storage = makeStorage({ slices })
		let live = 0
		let peak = 0
		await runLoop('p1', makeDeps(storage, {
			spawnTurn: async () => {
				live++
				peak = Math.max(peak, live)
				await new Promise((r) => setTimeout(r, 5))
				live--
				return { verdict: 'partial', commits: 0 }
			},
			config: { usePrs: false, review: false, perSliceBranches, maxConcurrent, mergeNoVerify: false },
		}))
		return peak
	}

	describe('runLoop', () => {
		test('blocked slice → no sandbox spawn; outcome no-work', async () => {
			const blocked = makeSlice({ id: 'b1', state: 'blocked', blockedBy: ['a'] })
			const storage = makeStorage({ slices: [blocked] })
			let sandboxCalls = 0
			await runLoop('p1', makeDeps(storage, {
				spawnTurn: async () => {
					sandboxCalls++
					return { verdict: 'ready', commits: 1 }
				},
			}))
			expect(sandboxCalls).toBe(0)
		})

		test('fetchEnriched runs gh listOpenPrs whenever config.usePrs is true, regardless of storage capability', async () => {
			const slice = makeSlice({ id: 's1' })
			const storage = makeStorage({ slices: [slice] })
			const { gh, calls } = recordingGhOps({ createDraftPr: async () => { slice.prState = 'draft' }, listOpenPrs: async () => [{ number: 1, headRefName: 'change-p1/slice-s1-a', isDraft: true }] })
			await runLoop('p1', makeDeps(storage, {
				gh,
				spawnTurn: async () => ({ verdict: 'ready', commits: 1 }),
				config: { usePrs: true, review: false, perSliceBranches: true, maxConcurrent: null, mergeNoVerify: false },
			}))
			expect(calls.find((c) => c[0] === 'listOpenPrs')).toBeDefined()
		})

		test('ready slice: runs implementer, lands done, exits with empty actionable queue', async () => {
			const slice = makeSlice({ id: 's1' })
			const storage = makeStorage({ slices: [slice] })
			const roles: Role[] = []
			await runLoop('p1', makeDeps(storage, {
				spawnTurn: async ({ role }) => {
					roles.push(role)
					return { verdict: 'ready', commits: 1 }
				},
			}))
			expect(roles).toEqual(['implement'])
			const after = await storage.findSlices('p1')
			expect(after[0]!.state).toBe('done')
		})

		test('spawnTurn throws → loop catches, logs the error, returns partial (one bad slice does not abort the batch)', async () => {
			const stuck = makeSlice({ id: 'stuck' })
			const fine = makeSlice({ id: 'fine' })
			const storage = makeStorage({ slices: [stuck, fine] })
			const logs: string[] = []
			let spawnCalls = 0
			await runLoop('p1', makeDeps(storage, {
				spawnTurn: async ({ slice }) => {
					spawnCalls++
					if (slice.id === 'stuck') throw new Error('verdict file missing (.trowel/turn-out.json)')
					return { verdict: 'ready', commits: 1 }
				},
				log: (m) => { logs.push(m) },
				config: { usePrs: false, review: false, perSliceBranches: false, maxConcurrent: null, mergeNoVerify: false },
			}))
			expect(spawnCalls).toBeGreaterThanOrEqual(2) // both slices were attempted
			expect(logs.some((m) => /verdict file missing/.test(m))).toBe(true)
			const after = await storage.findSlices('p1')
			expect(after.find((s) => s.id === 'fine')!.state).toBe('done')
			expect(after.find((s) => s.id === 'stuck')!.state).toBe('open')
		})

		test('partial verdict: slice added to skip set; worker pool exits after one claim', async () => {
			const slice = makeSlice({ id: 's1' })
			const storage = makeStorage({ slices: [slice] })
			let claims = 0
			await runLoop('p1', makeDeps(storage, {
				spawnTurn: async () => ({ verdict: 'partial', commits: 0 }),
				log: (m) => {
					if (/^\[work change-p1\] claim \d+:/.test(m)) claims++
				},
				config: { usePrs: false, review: false, perSliceBranches: false, maxConcurrent: null, mergeNoVerify: false },
			}))
			// One claim: slice tried once, returned partial, added to skip set.
			expect(claims).toBe(1)
			const after = await storage.findSlices('p1')
			expect(after[0]!.state).toBe('open')
		})

		test('stuck slice (always partial) does not block sibling ready slices in subsequent iterations', async () => {
			const stuck = makeSlice({ id: 'stuck' })
			const fine = makeSlice({ id: 'fine' })
			const storage = makeStorage({ slices: [stuck, fine] })
			const calls: string[] = []
			await runLoop('p1', makeDeps(storage, {
				spawnTurn: async ({ slice: s }) => {
					calls.push(s.id)
					return s.id === 'stuck' ? { verdict: 'partial', commits: 0 } : { verdict: 'ready', commits: 1 }
				},
				config: { usePrs: false, review: false, perSliceBranches: false, maxConcurrent: null, mergeNoVerify: false },
			}))
			expect(calls).toContain('fine')
			const after = await storage.findSlices('p1')
			expect(after.find((s) => s.id === 'fine')!.state).toBe('done')
		})

		test('a rejected slice (storage throws) is logged, added to skip set, not retried', async () => {
			const a = makeSlice({ id: 'a' })
			const b = makeSlice({ id: 'b' })
			// usePrs:true + perSliceBranches:true → prepareImplement calls git.createRemoteBranch,
			// an injection seam for per-slice failure.
			const storage = makeStorage({ slices: [a, b] })
			const git = noopGit()
			// Branch does not exist yet → prepareImplement attempts createRemoteBranch.
			git.branchExists = async () => false
			git.createRemoteBranch = async (newBranch) => {
				if (newBranch.includes('slice-a')) throw new Error('docker unreachable')
			}
			const calls: string[] = []
			const logs: string[] = []
			await runLoop('p1', makeDeps(storage, {
				git,
				spawnTurn: async ({ slice: s }) => {
					calls.push(s.id)
					return { verdict: 'partial', commits: 0 }
				},
				log: (m) => logs.push(m),
				config: { usePrs: true, review: false, perSliceBranches: true, maxConcurrent: null, mergeNoVerify: false },
			}))
			// a fails in prepareImplement (no sandbox spawn); b spawns once and is skipped after partial.
			expect(calls.filter((id) => id === 'a')).toHaveLength(0)
			expect(calls.filter((id) => id === 'b').length).toBeGreaterThan(0)
			expect(logs.some((m) => /slice-a\] error: docker unreachable/.test(m))).toBe(true)
		})

		test('perSliceBranches:false forces serial implementers even when config allows 3 (parallel implementers on integration would race)', async () => {
			expect(await peakConcurrentImplementers(false, 3)).toBe(1)
		})

		test('perSliceBranches:true honors config.maxConcurrent (slice-branches are parallel-safe)', async () => {
			const peak = await peakConcurrentImplementers(true, 2)
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
			const slowGate = new Promise<void>((resolve) => { releaseSlow = resolve })
			const { gh } = recordingGhOps({
				createDraftPr: async ({ head }) => {
					const id = head.includes('fast') ? 'fast' : 'slow'
					const slice = state.slices.find((s) => s.id === id)
					if (slice) slice.prState = 'draft'
				},
				findPrNumberByHead: async () => 1,
				markPrReady: async () => {
					state.slices.find((s) => s.id === 'fast')!.prState = 'ready'
				},
				listOpenPrs: async () => openPrsForSlices(state.slices),
			})
			await runLoop('p1', makeDeps(storage, {
				gh,
				spawnTurn: workerPoolSpawnTurn(events, slowGate, releaseSlow),
				config: { usePrs: true, review: true, perSliceBranches: true, maxConcurrent: 2, mergeNoVerify: false },
			}))
			expect(events.indexOf('review:fast:start')).toBeGreaterThan(events.indexOf('implement:fast:finish'))
			expect(events.indexOf('review:fast:start')).toBeLessThan(events.indexOf('implement:slow:finish'))
			expect(events).toContain('implement:slow:start')
		})
	})

	describe('processSlice', () => {
		test('review ready stops after markPrReady makes the open PR non-draft', async () => {
			const raw = makeSlice({ id: 's1', prState: null })
			const initial = makeSlice({ id: 's1', prState: 'draft', state: 'in-flight' })
			const storage = makeStorage({ slices: [raw] })
			const roles: Role[] = []
			const { gh } = recordingGhOps({
				findPrNumberByHead: async () => 130,
				markPrReady: async () => {},
				listOpenPrs: async () => [{ number: 130, headRefName: 'change-p1/slice-s1-a', isDraft: false }],
			})

			const outcome = await processSlice('p1', initial, makeDeps(storage, {
				spawnTurn: async ({ role }) => {
					roles.push(role)
					return { verdict: 'ready', commits: 0 }
				},
				gh,
				config: { usePrs: true, review: true, perSliceBranches: true, maxConcurrent: null, mergeNoVerify: false },
			}))

			expect(outcome).toBe('no-work')
			expect(roles).toEqual(['review'])
		})

		test('progress outcome releases the claim; scheduler owns the next refetch', async () => {
			// On usePrs=true, landImplement returns 'progress' after opening the draft PR. processSlice now
			// runs exactly one phase step, so the outer worker-pool scheduler owns the next state refetch.
			const slice = makeSlice({ id: 's1' })
			const state = { slices: [slice] }
			const storage = makeStorage(state)
			let prCreateCount = 0
			const { gh } = recordingGhOps({
				createDraftPr: async () => {
					prCreateCount++
					const real = state.slices.find((x) => x.id === slice.id)
					if (real) {
						real.state = 'done'
						real.closedAt = '2026-06-04T00:00:00.000Z'
					}
				},
			})
			const outcome = await processSlice('p1', slice, makeDeps(storage, {
				spawnTurn: async () => ({ verdict: 'ready', commits: 1 }),
				gh,
				config: { usePrs: true, review: false, perSliceBranches: true, maxConcurrent: null, mergeNoVerify: false },
			}))
			expect(outcome).toBe('no-work')
			expect(prCreateCount).toBe(1)
		})
	})
}
