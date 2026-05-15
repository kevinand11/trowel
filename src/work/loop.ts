import { classify } from './classify.ts'
import { landAddress, landImplement, landReview, prepareAddress, prepareImplement, prepareReview, type PhaseDeps } from './phases.ts'
import { enrichSlicePrStates } from './pr-flow.ts'
import type { Role } from './prompts.ts'
import { reconcileSlices } from './reconcile.ts'
import type { TurnIn, TurnOut } from './verdict.ts'
import type { ClassifiedSlice, ClassifySliceConfig, Storage, PhaseOutcome, ResumeState, Slice } from '../storages/types.ts'
import { classifySlices } from '../utils/bucket.ts'
import type { GhOps } from '../utils/gh-ops.ts'
import type { GitOps } from '../utils/git-ops.ts'

export type LoopConfig = {
	usePrs: boolean
	review: boolean
	perSliceBranches: boolean
	sliceStepCap: number
	maxConcurrent: number | null
}

export type LoopDeps = {
	storage: Storage
	git: GitOps
	gh: GhOps
	integrationBranch: string
	spawnTurn: (args: { role: Role; slice: Slice; branch: string; turnIn: TurnIn }) => Promise<TurnOut>
	log: (msg: string) => void
	config: LoopConfig
}

export type ProcessOutcome = 'done' | 'partial' | 'no-work'

const SANDBOX_ROLES = new Set<ResumeState>(['implement', 'review', 'address'])

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

export async function runLoop(prdId: string, deps: LoopDeps): Promise<void> {
	const tag = `[work prd-${prdId}]`
	const { storage, config } = deps
	const failed = new Set<string>()
	const ctxOf = (): { prdId: string; integrationBranch: string; config: ClassifySliceConfig } => ({
		prdId,
		integrationBranch: deps.integrationBranch,
		config: { usePrs: config.usePrs, review: config.review, perSliceBranches: config.perSliceBranches },
	})

	const fetchEnriched = async (): Promise<Slice[]> => {
		const raw = await storage.findSlices(prdId)
		if (!config.usePrs) return raw
		return enrichSlicePrStates(deps.gh, prdId, raw)
	}

	let iter = 0
	while (true) {
		const before = await fetchEnriched()
		await reconcileSlices(deps.gh, before, ctxOf())
		const slices = classifySlices(await fetchEnriched())
		const actionable = slices.filter((s) => {
			if (failed.has(s.id)) return false
			const state = classify(s, ctxOf().config)
			// 'done' and 'blocked' both mean "nothing to do this iteration":
			// done = terminal; blocked = waiting on another slice (which, if it closes mid-run,
			// flips this slice back to 'ready' on the next iter's classify and re-enters actionable).
			return state !== 'done' && state !== 'blocked'
		})
		if (actionable.length === 0) {
			deps.log(`${tag} no actionable slices; exiting after ${iter} iteration(s)`)
			return
		}
		iter += 1
		deps.log(`${tag} iter ${iter}: ${actionable.length} actionable slice(s) [${actionable.map((s) => s.id).join(', ')}]`)
		const limit = effectiveConcurrency(config.perSliceBranches, config.maxConcurrent)
		for (let start = 0; start < actionable.length; start += limit) {
			const batch = actionable.slice(start, start + limit)
			const results = await Promise.allSettled(batch.map((s) => processSlice(prdId, s, deps)))
			results.forEach((r, i) => {
				const slice = batch[i]!
				if (r.status === 'rejected') {
					const msg = r.reason instanceof Error ? r.reason.message : String(r.reason)
					deps.log(`[work prd-${prdId} slice-${slice.id}] error: ${msg}; skipping for the rest of this run`)
					failed.add(slice.id)
				} else if (r.value === 'partial') {
					// A slice that returns `partial` doesn't transition state and would re-enter
					// the actionable set forever. Skip it for the rest of this run.
					deps.log(`[work prd-${prdId} slice-${slice.id}] partial; skipping for the rest of this run`)
					failed.add(slice.id)
				}
			})
		}
	}
}

export async function processSlice(prdId: string, initial: ClassifiedSlice, deps: LoopDeps): Promise<ProcessOutcome> {
	const { storage, config } = deps
	const ctx: { prdId: string; integrationBranch: string; config: ClassifySliceConfig } = {
		prdId,
		integrationBranch: deps.integrationBranch,
		config: { usePrs: config.usePrs, review: config.review, perSliceBranches: config.perSliceBranches },
	}
	const tag = `[work prd-${prdId} slice-${initial.id}]`

	if (classify(initial, ctx.config) === 'blocked') {
		deps.log(`${tag} blocked by [${initial.blockedBy.join(', ')}]; skipping`)
		return 'no-work'
	}

	let slice: ClassifiedSlice = initial
	for (let step = 0; step < config.sliceStepCap; step++) {
		const state = classify(slice, ctx.config)
		if (state === 'done') return 'done'
		if (state === 'blocked') return 'no-work'
		if (!SANDBOX_ROLES.has(state)) {
			deps.log(`${tag} unexpected state ${state}; treating as partial`)
			return 'partial'
		}
		const role = state as Role
		deps.log(`${tag} state=${role}: "${slice.title}"`)

		const phaseDeps: PhaseDeps = { storage, git: deps.git, gh: deps.gh, log: deps.log }
		const prep = await callPrepare(phaseDeps, role, slice, ctx)
		deps.log(`${tag} spawning ${role} sandbox on ${prep.branch}`)
		const verdict = await deps.spawnTurn({ role, slice, branch: prep.branch, turnIn: prep.turnIn })
		deps.log(`${tag} ${role} verdict: ${verdict.verdict}, ${verdict.commits} commit(s)`)
		const outcome: PhaseOutcome = await callLand(phaseDeps, role, slice, verdict, ctx)
		if (outcome === 'done') return 'done'
		if (outcome === 'no-work') return 'no-work'
		if (outcome === 'partial') return 'partial'
		// outcome === 'progress': refetch (with PR-state enrichment when usePrs is on) and continue
		const raw = await storage.findSlices(prdId)
		const enriched = config.usePrs ? await enrichSlicePrStates(deps.gh, prdId, raw) : raw
		const refreshed = classifySlices(enriched).find((s) => s.id === slice.id)
		if (!refreshed) return 'partial'
		slice = refreshed
	}
	deps.log(`${tag} step-cap reached after ${config.sliceStepCap} step(s); returning partial`)
	return 'partial'
}

function callPrepare(phaseDeps: PhaseDeps, role: Role, slice: Slice, ctx: { prdId: string; integrationBranch: string; config: ClassifySliceConfig }) {
	if (role === 'implement') return prepareImplement(phaseDeps, slice, ctx)
	if (role === 'review') return prepareReview(phaseDeps, slice, ctx)
	return prepareAddress(phaseDeps, slice, ctx)
}

function callLand(phaseDeps: PhaseDeps, role: Role, slice: Slice, verdict: TurnOut, ctx: { prdId: string; integrationBranch: string; config: ClassifySliceConfig }) {
	if (role === 'implement') return landImplement(phaseDeps, slice, verdict, ctx)
	if (role === 'review') return landReview(phaseDeps, slice, verdict, ctx)
	return landAddress(phaseDeps, slice, verdict, ctx)
}

if (import.meta.vitest) {
	const { describe, test, expect } = import.meta.vitest
	const { recordingGhOps } = await import('../test-utils/gh-ops-recorder.ts')

	type FakeState = {
		slices: Slice[]
	}

	function makeStorage(state: FakeState, overrides: Partial<Storage> = {}): Storage {
		return {
			createPrd: async () => ({ id: 'x', branch: 'x' }),
			findPrd: async () => null,
			listPrds: async () => [],
			closePrd: async () => {},
			createSlice: async () => {
				throw new Error('unused')
			},
			findSlices: async () => state.slices.map((s) => ({ ...s })),
			updateSlice: async (_p, sliceId, patch) => {
				const s = state.slices.find((x) => x.id === sliceId)
				if (!s) return
				if (patch.state !== undefined) s.state = patch.state
				if (patch.readyForAgent !== undefined) s.readyForAgent = patch.readyForAgent
				if (patch.needsRevision !== undefined) s.needsRevision = patch.needsRevision
			},
			...overrides,
		}
	}

	function noopGit(): GitOps {
		return {
			currentBranch: async () => 'fake-current',
			baseBranch: async () => 'fake-base',
			branchExists: async () => true,
			isMerged: async () => false,
			checkout: async () => {},
			deleteBranch: async () => {},
			fetch: async () => {},
			push: async () => {},
			mergeNoFf: async () => {},
			deleteRemoteBranch: async () => {},
			createRemoteBranch: async () => {},
			createLocalBranch: async () => {},
			pushSetUpstream: async () => {},
			worktreeAdd: async () => {},
			worktreeRemove: async () => {},
			worktreeList: async () => [],
			restoreAll: async () => {},
			cleanUntracked: async () => {},
		}
	}

	function makeSlice(overrides: Partial<ClassifiedSlice> = {}): ClassifiedSlice {
		return {
			id: 's1',
			title: 'A',
			body: 'spec',
			state: 'OPEN',
			readyForAgent: true,
			needsRevision: false,
			bucket: 'ready',
			blockedBy: [],
			prState: null,
			branchAhead: false,
			...overrides,
		}
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
			config: { usePrs: false, review: false, perSliceBranches: false, sliceStepCap: 5, maxConcurrent: null },
			...overrides,
		}
	}

	describe('runLoop', () => {
		test('blocked slice → no sandbox spawn; outcome no-work', async () => {
			const blocked = makeSlice({ id: 'b1', bucket: 'blocked', blockedBy: ['a'] })
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
			const { gh, calls } = recordingGhOps()
			await runLoop('p1', makeDeps(storage, {
				gh,
				spawnTurn: async () => ({ verdict: 'ready', commits: 1 }),
				config: { usePrs: true, review: false, perSliceBranches: true, sliceStepCap: 5, maxConcurrent: null },
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
			expect(after[0]!.state).toBe('CLOSED')
		})

		test('partial verdict: slice added to skip set; outer loop exits after one iteration', async () => {
			const slice = makeSlice({ id: 's1' })
			const storage = makeStorage({ slices: [slice] })
			let outerIters = 0
			await runLoop('p1', makeDeps(storage, {
				spawnTurn: async () => ({ verdict: 'partial', commits: 0 }),
				log: (m) => {
					if (/^\[work prd-p1\] iter \d+:/.test(m)) outerIters++
				},
				config: { usePrs: false, review: false, perSliceBranches: false, sliceStepCap: 1, maxConcurrent: null },
			}))
			// One outer iteration: slice tried once, returned partial, added to skip set.
			// Next iteration sees no actionable slices and exits.
			expect(outerIters).toBe(1)
			const after = await storage.findSlices('p1')
			expect(after[0]!.state).toBe('OPEN')
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
				config: { usePrs: false, review: false, perSliceBranches: false, sliceStepCap: 1, maxConcurrent: null },
			}))
			expect(calls).toContain('fine')
			const after = await storage.findSlices('p1')
			expect(after.find((s) => s.id === 'fine')!.state).toBe('CLOSED')
		})

		test('a rejected slice (storage throws) is logged, added to skip set, not retried', async () => {
			const a = makeSlice({ id: 'a' })
			const b = makeSlice({ id: 'b' })
			// usePrs:true + perSliceBranches:true → prepareImplement calls git.createRemoteBranch,
			// an injection seam for per-slice failure.
			const storage = makeStorage({ slices: [a, b] })
			const git = noopGit()
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
				config: { usePrs: true, review: false, perSliceBranches: true, sliceStepCap: 1, maxConcurrent: null },
			}))
			// a fails in prepareImplement (no sandbox spawn); b spawns each iter, never reaches done because step-cap=1+partial
			expect(calls.filter((id) => id === 'a')).toHaveLength(0)
			expect(calls.filter((id) => id === 'b').length).toBeGreaterThan(0)
			expect(logs.some((m) => /slice-a\] error: docker unreachable/.test(m))).toBe(true)
		})

		test('perSliceBranches:false forces serial implementers even when config allows 3 (parallel implementers on integration would race)', async () => {
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
				config: { usePrs: false, review: false, perSliceBranches: false, sliceStepCap: 1, maxConcurrent: 3 },
			}))
			expect(peak).toBe(1)
		})

		test('perSliceBranches:true honors config.maxConcurrent (slice-branches are parallel-safe)', async () => {
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
				config: { usePrs: false, review: false, perSliceBranches: true, sliceStepCap: 1, maxConcurrent: 2 },
			}))
			expect(peak).toBeLessThanOrEqual(2)
			expect(peak).toBeGreaterThan(1)
		})
	})

	describe('processSlice', () => {
		test('progress outcome refetches slice, continues inner step-cap loop, sees updated classification', async () => {
			// On usePrs=true, landImplement returns 'progress' after opening the draft PR. The gh stub
			// mutates the slice to CLOSED on that pr-create call so the loop's refetch classifies as
			// 'done' and the inner step-cap loop exits cleanly.
			const slice = makeSlice({ id: 's1' })
			const state = { slices: [slice] }
			const storage = makeStorage(state)
			let prCreateCount = 0
			const { gh } = recordingGhOps({
				createDraftPr: async () => {
					prCreateCount++
					const real = state.slices.find((x) => x.id === slice.id)
					if (real) real.state = 'CLOSED'
				},
			})
			const outcome = await processSlice('p1', slice, makeDeps(storage, {
				spawnTurn: async () => ({ verdict: 'ready', commits: 1 }),
				gh,
				config: { usePrs: true, review: false, perSliceBranches: true, sliceStepCap: 5, maxConcurrent: null },
			}))
			expect(outcome).toBe('done')
			expect(prCreateCount).toBe(1)
		})
	})
}
