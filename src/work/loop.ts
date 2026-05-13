import type { Role } from './prompts.ts'
import type { SandboxIn, SandboxOut } from './verdict.ts'
import type { Backend, PhaseOutcome, ResumeState, Slice } from '../backends/types.ts'

export type LoopConfig = {
	usePrs: boolean
	review: boolean
	maxIterations: number
	sliceStepCap: number
	maxConcurrent: number | null
}

export type LoopDeps = {
	backend: Backend
	integrationBranch: string
	spawnSandbox: (args: { role: Role; slice: Slice; branch: string; sandboxIn: SandboxIn }) => Promise<SandboxOut>
	log: (msg: string) => void
	config: LoopConfig
}

export type ProcessOutcome = 'done' | 'partial' | 'no-work'

const SANDBOX_ROLES = new Set<ResumeState>(['implement', 'review', 'address'])

function effectiveConcurrency(backend: Backend, configCap: number | null): number {
	const a = configCap ?? Number.POSITIVE_INFINITY
	const b = backend.maxConcurrent ?? Number.POSITIVE_INFINITY
	return Math.max(1, Math.floor(Math.min(a, b)))
}

export async function runLoop(prdId: string, deps: LoopDeps): Promise<void> {
	const tag = `[work prd-${prdId}]`
	const { backend, config } = deps
	const failed = new Set<string>()
	const ctxOf = (): { prdId: string; integrationBranch: string; config: { usePrs: boolean; review: boolean } } => ({
		prdId,
		integrationBranch: deps.integrationBranch,
		config: { usePrs: config.usePrs, review: config.review },
	})

	for (let iter = 0; iter < config.maxIterations; iter++) {
		const before = await backend.findSlices(prdId)
		await backend.reconcileSlices(before, ctxOf())
		const slices = await backend.findSlices(prdId)
		const actionable = slices.filter((s) => !failed.has(s.id) && backend.classifySlice(s, ctxOf().config) !== 'done')
		if (actionable.length === 0) {
			deps.log(`${tag} no actionable slices; exiting after ${iter} iteration(s)`)
			return
		}
		deps.log(`${tag} iter ${iter + 1}/${config.maxIterations}: ${actionable.length} actionable slice(s) [${actionable.map((s) => s.id).join(', ')}]`)
		const limit = effectiveConcurrency(backend, config.maxConcurrent)
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

export async function processSlice(prdId: string, initial: Slice, deps: LoopDeps): Promise<ProcessOutcome> {
	const { backend, config } = deps
	const ctx = {
		prdId,
		integrationBranch: deps.integrationBranch,
		config: { usePrs: config.usePrs, review: config.review },
	}
	const tag = `[work prd-${prdId} slice-${initial.id}]`

	if (backend.classifySlice(initial, ctx.config) === 'blocked') {
		deps.log(`${tag} blocked by [${initial.blockedBy.join(', ')}]; skipping`)
		return 'no-work'
	}

	let slice = initial
	for (let step = 0; step < config.sliceStepCap; step++) {
		const state = backend.classifySlice(slice, ctx.config)
		if (state === 'done') return 'done'
		if (state === 'blocked') return 'no-work'
		if (!SANDBOX_ROLES.has(state)) {
			deps.log(`${tag} unexpected state ${state}; treating as partial`)
			return 'partial'
		}
		const role = state as Role
		deps.log(`${tag} state=${role}: "${slice.title}"`)

		const prep = await callPrepare(backend, role, slice, ctx)
		deps.log(`${tag} spawning ${role} sandbox on ${prep.branch}`)
		const verdict = await deps.spawnSandbox({ role, slice, branch: prep.branch, sandboxIn: prep.sandboxIn })
		deps.log(`${tag} ${role} verdict: ${verdict.verdict}, ${verdict.commits} commit(s)`)
		const outcome: PhaseOutcome = await callLand(backend, role, slice, verdict, ctx)
		if (outcome === 'done') return 'done'
		if (outcome === 'no-work') return 'no-work'
		if (outcome === 'partial') return 'partial'
		// outcome === 'progress': refetch and continue
		const refreshed = (await backend.findSlices(prdId)).find((s) => s.id === slice.id)
		if (!refreshed) return 'partial'
		slice = refreshed
	}
	deps.log(`${tag} step-cap reached after ${config.sliceStepCap} step(s); returning partial`)
	return 'partial'
}

function callPrepare(backend: Backend, role: Role, slice: Slice, ctx: { prdId: string; integrationBranch: string; config: { usePrs: boolean; review: boolean } }) {
	if (role === 'implement') return backend.prepareImplement(slice, ctx)
	if (role === 'review') return backend.prepareReview(slice, ctx)
	return backend.prepareAddress(slice, ctx)
}

function callLand(backend: Backend, role: Role, slice: Slice, verdict: SandboxOut, ctx: { prdId: string; integrationBranch: string; config: { usePrs: boolean; review: boolean } }) {
	if (role === 'implement') return backend.landImplement(slice, verdict, ctx)
	if (role === 'review') return backend.landReview(slice, verdict, ctx)
	return backend.landAddress(slice, verdict, ctx)
}

if (import.meta.vitest) {
	const { describe, test, expect } = import.meta.vitest

	type FakeState = {
		slices: Slice[]
		classify?: (s: Slice, c: { usePrs: boolean; review: boolean }) => ResumeState
	}

	function makeBackend(state: FakeState, overrides: Partial<Backend> = {}): Backend {
		const defaultClassify = (s: Slice): ResumeState => {
			if (s.state === 'CLOSED') return 'done'
			if (!s.readyForAgent) return 'done'
			if (s.bucket === 'blocked') return 'blocked'
			return 'implement'
		}
		return {
			name: 'fake',
			defaultBranchPrefix: '',
			maxConcurrent: null,
			createPrd: async () => ({ id: 'x', branch: 'x' }),
			branchForExisting: async () => 'x',
			findPrd: async () => null,
			listPrds: async () => [],
			close: async () => {},
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
			classifySlice: state.classify ?? defaultClassify,
			reconcileSlices: async () => {},
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

	function makeSlice(overrides: Partial<Slice> = {}): Slice {
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

	function makeDeps(backend: Backend, overrides: Partial<LoopDeps> = {}): LoopDeps {
		return {
			backend,
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
			const backend = makeBackend({ slices: [blocked] })
			let sandboxCalls = 0
			await runLoop('p1', makeDeps(backend, {
				spawnSandbox: async () => {
					sandboxCalls++
					return { verdict: 'ready', commits: 1 }
				},
			}))
			expect(sandboxCalls).toBe(0)
		})

		test('ready slice: runs implementer, lands done, exits with empty actionable queue', async () => {
			const slice = makeSlice({ id: 's1' })
			const backend = makeBackend({ slices: [slice] })
			const roles: Role[] = []
			await runLoop('p1', makeDeps(backend, {
				spawnSandbox: async ({ role }) => {
					roles.push(role)
					return { verdict: 'ready', commits: 1 }
				},
			}))
			expect(roles).toEqual(['implement'])
			const after = await backend.findSlices('p1')
			expect(after[0]!.state).toBe('CLOSED')
		})

		test('partial verdict: returns partial, leaves slice OPEN, exits this run', async () => {
			const slice = makeSlice({ id: 's1' })
			const backend = makeBackend({ slices: [slice] })
			let outerIters = 0
			await runLoop('p1', makeDeps(backend, {
				spawnSandbox: async () => ({ verdict: 'partial', commits: 0 }),
				log: (m) => {
					if (/iter \d+\//.test(m)) outerIters++
				},
				config: { usePrs: false, review: false, maxIterations: 5, sliceStepCap: 1, maxConcurrent: null },
			}))
			// step-cap=1 → one inner attempt, outer loop sees slice still actionable, retries until maxIterations
			expect(outerIters).toBe(5)
			const after = await backend.findSlices('p1')
			expect(after[0]!.state).toBe('OPEN')
		})

		test('stuck slice (always partial) does not block sibling ready slices in subsequent iterations', async () => {
			const stuck = makeSlice({ id: 'stuck' })
			const fine = makeSlice({ id: 'fine' })
			const backend = makeBackend({ slices: [stuck, fine] })
			const calls: string[] = []
			await runLoop('p1', makeDeps(backend, {
				spawnSandbox: async ({ slice: s }) => {
					calls.push(s.id)
					return s.id === 'stuck' ? { verdict: 'partial', commits: 0 } : { verdict: 'ready', commits: 1 }
				},
				config: { usePrs: false, review: false, maxIterations: 5, sliceStepCap: 1, maxConcurrent: null },
			}))
			expect(calls).toContain('fine')
			const after = await backend.findSlices('p1')
			expect(after.find((s) => s.id === 'fine')!.state).toBe('CLOSED')
		})

		test('hitting maxIterations exits with a log message', async () => {
			const slice = makeSlice({ id: 's1' })
			const backend = makeBackend({ slices: [slice] })
			const logs: string[] = []
			await runLoop('p1', makeDeps(backend, {
				spawnSandbox: async () => ({ verdict: 'partial', commits: 0 }),
				log: (m) => logs.push(m),
				config: { usePrs: false, review: false, maxIterations: 2, sliceStepCap: 1, maxConcurrent: null },
			}))
			expect(logs.some((m) => /maxIterations \(2\)/.test(m))).toBe(true)
		})

		test('a rejected slice (backend throws) is logged, added to skip set, not retried', async () => {
			const a = makeSlice({ id: 'a' })
			const b = makeSlice({ id: 'b' })
			const backend = makeBackend({ slices: [a, b] }, {
				prepareImplement: async (s) => {
					if (s.id === 'a') throw new Error('docker unreachable')
					return { branch: 'integration', sandboxIn: { slice: { id: s.id, title: s.title, body: s.body } } }
				},
			})
			const calls: string[] = []
			const logs: string[] = []
			await runLoop('p1', makeDeps(backend, {
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

		test('respects min(config.maxConcurrent, backend.maxConcurrent): file backend semantics serialize even when config allows 3', async () => {
			const slices = ['1', '2', '3', '4'].map((id) => makeSlice({ id }))
			const backend = makeBackend({ slices }, { maxConcurrent: 1 })
			let live = 0
			let peak = 0
			await runLoop('p1', makeDeps(backend, {
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

		test('respects config.maxConcurrent when backend.maxConcurrent is null: issue-backend semantics parallelize up to 2', async () => {
			const slices = ['1', '2', '3', '4'].map((id) => makeSlice({ id }))
			const backend = makeBackend({ slices }, { maxConcurrent: null })
			let live = 0
			let peak = 0
			await runLoop('p1', makeDeps(backend, {
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
			const backend = makeBackend({ slices: [slice] }, {
				landImplement: async () => 'progress',
			})
			let classifyCount = 0
			backend.classifySlice = () => {
				classifyCount++
				return classifyCount === 1 ? 'implement' : 'done'
			}
			const outcome = await processSlice('p1', slice, makeDeps(backend, {
				spawnSandbox: async () => ({ verdict: 'ready', commits: 1 }),
			}))
			expect(outcome).toBe('done')
			expect(classifyCount).toBeGreaterThanOrEqual(2)
		})
	})
}
