import { classify } from './classify.ts'
import type { Role } from './prompts.ts'
import { reconcileSlices } from './reconcile.ts'
import type { SandboxIn, SandboxOut } from './verdict.ts'
import type { ClassifiedSlice, Storage, PhaseOutcome, ResumeState, Slice } from '../storages/types.ts'
import { classifySlices } from '../utils/bucket.ts'
import type { GhRunner } from '../utils/gh-runner.ts'

export type LoopConfig = {
	usePrs: boolean
	review: boolean
	maxIterations: number
	sliceStepCap: number
	maxConcurrent: number | null
}

export type LoopDeps = {
	storage: Storage
	gh: GhRunner
	integrationBranch: string
	spawnSandbox: (args: { role: Role; slice: Slice; branch: string; sandboxIn: SandboxIn }) => Promise<SandboxOut>
	log: (msg: string) => void
	config: LoopConfig
}

export type ProcessOutcome = 'done' | 'partial' | 'no-work'

const SANDBOX_ROLES = new Set<ResumeState>(['implement', 'review', 'address'])

function effectiveConcurrency(storage: Storage, configCap: number | null): number {
	const a = configCap ?? Number.POSITIVE_INFINITY
	const b = storage.maxConcurrent ?? Number.POSITIVE_INFINITY
	return Math.max(1, Math.floor(Math.min(a, b)))
}

export async function runLoop(prdId: string, deps: LoopDeps): Promise<void> {
	const tag = `[work prd-${prdId}]`
	const { storage, config } = deps
	const failed = new Set<string>()
	const ctxOf = (): { prdId: string; integrationBranch: string; config: { usePrs: boolean; review: boolean } } => ({
		prdId,
		integrationBranch: deps.integrationBranch,
		config: { usePrs: config.usePrs, review: config.review },
	})

	for (let iter = 0; iter < config.maxIterations; iter++) {
		const before = await storage.findSlices(prdId)
		await reconcileSlices(deps.gh, before, ctxOf())
		const slices = classifySlices(await storage.findSlices(prdId))
		const actionable = slices.filter((s) => !failed.has(s.id) && classify(s, ctxOf().config) !== 'done')
		if (actionable.length === 0) {
			deps.log(`${tag} no actionable slices; exiting after ${iter} iteration(s)`)
			return
		}
		deps.log(`${tag} iter ${iter + 1}/${config.maxIterations}: ${actionable.length} actionable slice(s) [${actionable.map((s) => s.id).join(', ')}]`)
		const limit = effectiveConcurrency(storage, config.maxConcurrent)
		for (let start = 0; start < actionable.length; start += limit) {
			const batch = actionable.slice(start, start + limit)
			const results = await Promise.allSettled(batch.map((s) => processSlice(prdId, s, deps)))
			results.forEach((r, i) => {
				if (r.status === 'rejected') {
					const slice = batch[i]!
					const msg = r.reason instanceof Error ? r.reason.message : String(r.reason)
					deps.log(`[work prd-${prdId} slice-${slice.id}] error: ${msg}; skipping for the rest of this run`)
					failed.add(slice.id)
				}
			})
		}
	}
	deps.log(`${tag} hit maxIterations (${config.maxIterations}); leaving remaining slices for next invocation`)
}

export async function processSlice(prdId: string, initial: ClassifiedSlice, deps: LoopDeps): Promise<ProcessOutcome> {
	const { storage, config } = deps
	const ctx = {
		prdId,
		integrationBranch: deps.integrationBranch,
		config: { usePrs: config.usePrs, review: config.review },
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

		const prep = await callPrepare(storage, role, slice, ctx)
		deps.log(`${tag} spawning ${role} sandbox on ${prep.branch}`)
		const verdict = await deps.spawnSandbox({ role, slice, branch: prep.branch, sandboxIn: prep.sandboxIn })
		deps.log(`${tag} ${role} verdict: ${verdict.verdict}, ${verdict.commits} commit(s)`)
		const outcome: PhaseOutcome = await callLand(storage, role, slice, verdict, ctx)
		if (outcome === 'done') return 'done'
		if (outcome === 'no-work') return 'no-work'
		if (outcome === 'partial') return 'partial'
		// outcome === 'progress': refetch and continue
		const refreshed = classifySlices(await storage.findSlices(prdId)).find((s) => s.id === slice.id)
		if (!refreshed) return 'partial'
		slice = refreshed
	}
	deps.log(`${tag} step-cap reached after ${config.sliceStepCap} step(s); returning partial`)
	return 'partial'
}

function callPrepare(storage: Storage, role: Role, slice: Slice, ctx: { prdId: string; integrationBranch: string; config: { usePrs: boolean; review: boolean } }) {
	if (role === 'implement') return storage.prepareImplement(slice, ctx)
	if (role === 'review') return storage.prepareReview(slice, ctx)
	return storage.prepareAddress(slice, ctx)
}

function callLand(storage: Storage, role: Role, slice: Slice, verdict: SandboxOut, ctx: { prdId: string; integrationBranch: string; config: { usePrs: boolean; review: boolean } }) {
	if (role === 'implement') return storage.landImplement(slice, verdict, ctx)
	if (role === 'review') return storage.landReview(slice, verdict, ctx)
	return storage.landAddress(slice, verdict, ctx)
}

if (import.meta.vitest) {
	const { describe, test, expect } = import.meta.vitest

	type FakeState = {
		slices: Slice[]
	}

	function makeStorage(state: FakeState, overrides: Partial<Storage> = {}): Storage {
		return {
			name: 'fake',
			defaultBranchPrefix: '',
			maxConcurrent: null,
			capabilities: { prFlow: false },
			createPrd: async () => ({ id: 'x', branch: 'x' }),
			branchForExisting: async () => 'x',
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
			prepareImplement: async (s, ctx) => ({ branch: ctx.integrationBranch, sandboxIn: { slice: { id: s.id, title: s.title, body: s.body } } }),
			landImplement: async (s, v, _c) => {
				if (v.verdict === 'ready') {
					s.state = 'CLOSED'
					const real = state.slices.find((x) => x.id === s.id)
					if (real) real.state = 'CLOSED'
					return 'done'
				}
				if (v.verdict === 'no-work-needed') {
					const real = state.slices.find((x) => x.id === s.id)
					if (real) real.readyForAgent = false
					return 'no-work'
				}
				return 'partial'
			},
			prepareReview: async () => {
				throw new Error('review unsupported')
			},
			landReview: async () => 'done',
			prepareAddress: async () => {
				throw new Error('address unsupported')
			},
			landAddress: async () => 'done',
			...overrides,
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
		return {
			storage,
			gh: async () => ({ ok: true, stdout: '', stderr: '' }),
			integrationBranch: 'integration',
			spawnSandbox: async () => ({ verdict: 'ready', commits: 1 }),
			log: () => {},
			config: { usePrs: false, review: false, maxIterations: 10, sliceStepCap: 5, maxConcurrent: null },
			...overrides,
		}
	}

	describe('runLoop', () => {
		test('blocked slice → no sandbox spawn; outcome no-work', async () => {
			const blocked = makeSlice({ id: 'b1', bucket: 'blocked', blockedBy: ['a'] })
			const storage = makeStorage({ slices: [blocked] })
			let sandboxCalls = 0
			await runLoop('p1', makeDeps(storage, {
				spawnSandbox: async () => {
					sandboxCalls++
					return { verdict: 'ready', commits: 1 }
				},
			}))
			expect(sandboxCalls).toBe(0)
		})

		test('ready slice: runs implementer, lands done, exits with empty actionable queue', async () => {
			const slice = makeSlice({ id: 's1' })
			const storage = makeStorage({ slices: [slice] })
			const roles: Role[] = []
			await runLoop('p1', makeDeps(storage, {
				spawnSandbox: async ({ role }) => {
					roles.push(role)
					return { verdict: 'ready', commits: 1 }
				},
			}))
			expect(roles).toEqual(['implement'])
			const after = await storage.findSlices('p1')
			expect(after[0]!.state).toBe('CLOSED')
		})

		test('partial verdict: returns partial, leaves slice OPEN, exits this run', async () => {
			const slice = makeSlice({ id: 's1' })
			const storage = makeStorage({ slices: [slice] })
			let outerIters = 0
			await runLoop('p1', makeDeps(storage, {
				spawnSandbox: async () => ({ verdict: 'partial', commits: 0 }),
				log: (m) => {
					if (/iter \d+\//.test(m)) outerIters++
				},
				config: { usePrs: false, review: false, maxIterations: 5, sliceStepCap: 1, maxConcurrent: null },
			}))
			// step-cap=1 → one inner attempt, outer loop sees slice still actionable, retries until maxIterations
			expect(outerIters).toBe(5)
			const after = await storage.findSlices('p1')
			expect(after[0]!.state).toBe('OPEN')
		})

		test('stuck slice (always partial) does not block sibling ready slices in subsequent iterations', async () => {
			const stuck = makeSlice({ id: 'stuck' })
			const fine = makeSlice({ id: 'fine' })
			const storage = makeStorage({ slices: [stuck, fine] })
			const calls: string[] = []
			await runLoop('p1', makeDeps(storage, {
				spawnSandbox: async ({ slice: s }) => {
					calls.push(s.id)
					return s.id === 'stuck' ? { verdict: 'partial', commits: 0 } : { verdict: 'ready', commits: 1 }
				},
				config: { usePrs: false, review: false, maxIterations: 5, sliceStepCap: 1, maxConcurrent: null },
			}))
			expect(calls).toContain('fine')
			const after = await storage.findSlices('p1')
			expect(after.find((s) => s.id === 'fine')!.state).toBe('CLOSED')
		})

		test('hitting maxIterations exits with a log message', async () => {
			const slice = makeSlice({ id: 's1' })
			const storage = makeStorage({ slices: [slice] })
			const logs: string[] = []
			await runLoop('p1', makeDeps(storage, {
				spawnSandbox: async () => ({ verdict: 'partial', commits: 0 }),
				log: (m) => logs.push(m),
				config: { usePrs: false, review: false, maxIterations: 2, sliceStepCap: 1, maxConcurrent: null },
			}))
			expect(logs.some((m) => /maxIterations \(2\)/.test(m))).toBe(true)
		})

		test('a rejected slice (storage throws) is logged, added to skip set, not retried', async () => {
			const a = makeSlice({ id: 'a' })
			const b = makeSlice({ id: 'b' })
			const storage = makeStorage({ slices: [a, b] }, {
				prepareImplement: async (s) => {
					if (s.id === 'a') throw new Error('docker unreachable')
					return { branch: 'integration', sandboxIn: { slice: { id: s.id, title: s.title, body: s.body } } }
				},
			})
			const calls: string[] = []
			const logs: string[] = []
			await runLoop('p1', makeDeps(storage, {
				spawnSandbox: async ({ slice: s }) => {
					calls.push(s.id)
					return { verdict: 'partial', commits: 0 }
				},
				log: (m) => logs.push(m),
				config: { usePrs: false, review: false, maxIterations: 3, sliceStepCap: 1, maxConcurrent: null },
			}))
			// a fails in prepareImplement (no sandbox spawn); b spawns each iter, never reaches done because step-cap=1+partial
			expect(calls.filter((id) => id === 'a')).toHaveLength(0)
			expect(calls.filter((id) => id === 'b').length).toBeGreaterThan(0)
			expect(logs.some((m) => /slice-a\] error: docker unreachable/.test(m))).toBe(true)
		})

		test('respects min(config.maxConcurrent, storage.maxConcurrent): file storage semantics serialize even when config allows 3', async () => {
			const slices = ['1', '2', '3', '4'].map((id) => makeSlice({ id }))
			const storage = makeStorage({ slices }, { maxConcurrent: 1 })
			let live = 0
			let peak = 0
			await runLoop('p1', makeDeps(storage, {
				spawnSandbox: async () => {
					live++
					peak = Math.max(peak, live)
					await new Promise((r) => setTimeout(r, 5))
					live--
					return { verdict: 'partial', commits: 0 }
				},
				config: { usePrs: false, review: false, maxIterations: 1, sliceStepCap: 1, maxConcurrent: 3 },
			}))
			expect(peak).toBe(1)
		})

		test('respects config.maxConcurrent when storage.maxConcurrent is null: issue-storage semantics parallelize up to 2', async () => {
			const slices = ['1', '2', '3', '4'].map((id) => makeSlice({ id }))
			const storage = makeStorage({ slices }, { maxConcurrent: null })
			let live = 0
			let peak = 0
			await runLoop('p1', makeDeps(storage, {
				spawnSandbox: async () => {
					live++
					peak = Math.max(peak, live)
					await new Promise((r) => setTimeout(r, 5))
					live--
					return { verdict: 'partial', commits: 0 }
				},
				config: { usePrs: false, review: false, maxIterations: 1, sliceStepCap: 1, maxConcurrent: 2 },
			}))
			expect(peak).toBeLessThanOrEqual(2)
			expect(peak).toBeGreaterThan(1)
		})
	})

	describe('processSlice', () => {
		test('progress outcome refetches slice, continues inner step-cap loop, sees updated classification', async () => {
			const slice = makeSlice({ id: 's1' })
			const state = { slices: [slice] }
			let landCalls = 0
			const storage = makeStorage(state, {
				landImplement: async (s) => {
					landCalls++
					// First land returns 'progress' after mutating the slice to CLOSED so the refetch
					// classifies as 'done' and the inner loop exits cleanly.
					const real = state.slices.find((x) => x.id === s.id)
					if (real) real.state = 'CLOSED'
					return 'progress'
				},
			})
			const outcome = await processSlice('p1', slice, makeDeps(storage, {
				spawnSandbox: async () => ({ verdict: 'ready', commits: 1 }),
			}))
			expect(outcome).toBe('done')
			expect(landCalls).toBe(1)
		})
	})
}
