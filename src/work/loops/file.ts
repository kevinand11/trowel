import type { Backend, Slice } from '../../backends/types.ts'
import type { Bucket } from '../../utils/bucket.ts'
import type { SandboxIn, SandboxOut } from '../verdict.ts'

export type FileLoopDeps = {
	backend: Backend
	integrationBranch: string
	spawnSandbox: (args: { role: 'implement'; slice: Slice; sandboxIn: SandboxIn }) => Promise<SandboxOut>
	gitPush: (branch: string) => Promise<void>
	log: (msg: string) => void
	config: { maxIterations: number; sliceStepCap: number }
}

export type FileSliceOutcome = 'done' | 'partial' | 'no-work'

export type ProcessFileSliceDeps = Omit<FileLoopDeps, 'config'>

/**
 * Run one implementer phase on one slice (single-pass; caller filters bucket and decides cadence).
 * Used by both `runFileLoop` (in its serial outer loop) and by the per-phase `trowel implement` command.
 */
export async function processFileSlice(prdId: string, slice: Slice, deps: ProcessFileSliceDeps): Promise<FileSliceOutcome> {
	const sandboxIn: SandboxIn = { slice: { id: slice.id, title: slice.title, body: slice.body } }
	const verdict = await deps.spawnSandbox({ role: 'implement', slice, sandboxIn })
	if (verdict.verdict === 'ready') {
		await deps.gitPush(deps.integrationBranch)
		await deps.backend.updateSlice(prdId, slice.id, { state: 'CLOSED' })
		return 'done'
	}
	if (verdict.verdict === 'no-work-needed') {
		await deps.backend.updateSlice(prdId, slice.id, { readyForAgent: false })
		return 'no-work'
	}
	return 'partial'
}

export async function runFileLoop(prdId: string, deps: FileLoopDeps): Promise<void> {
	const stepCounts = new Map<string, number>()
	for (let iter = 0; iter < deps.config.maxIterations; iter++) {
		const slices = await deps.backend.findSlices(prdId)
		const next = slices.find((s) => s.bucket === 'ready' && (stepCounts.get(s.id) ?? 0) < deps.config.sliceStepCap)
		if (!next) return
		stepCounts.set(next.id, (stepCounts.get(next.id) ?? 0) + 1)
		await processFileSlice(prdId, next, deps)
		// On 'partial' (or invalid verdicts coerced to partial), the slice
		// remains 'ready'; stepCounts prevents reselecting it past sliceStepCap.
	}
	deps.log(`file loop hit maxIterations (${deps.config.maxIterations}); leaving remaining slices for next invocation`)
}

if (import.meta.vitest) {
	const { describe, test, expect } = import.meta.vitest

	type FakeBackendState = { slices: Slice[] }

	function makeFakeBackend(state: FakeBackendState): Backend {
		return {
			name: 'file',
			defaultBranchPrefix: 'prd/',
			createPrd: async () => ({ id: 'x', branch: 'x' }),
			branchForExisting: async () => 'x',
			findPrd: async () => null,
			listOpen: async () => [],
			close: async () => {},
			createSlice: async () => {
				throw new Error('not used')
			},
			findSlices: async () => {
				const doneIds = new Set(state.slices.filter((s) => s.state === 'CLOSED').map((s) => s.id))
				return state.slices.map((s): Slice => {
					const unmet = s.blockedBy.filter((id) => !doneIds.has(id))
					const bucket: Bucket =
						s.state === 'CLOSED'
							? 'done'
							: s.needsRevision
								? 'needs-revision'
								: unmet.length > 0
									? 'blocked'
									: s.readyForAgent
										? 'ready'
										: 'draft'
					return { ...s, bucket }
				})
			},
			updateSlice: async (_prdId, sliceId, patch) => {
				const s = state.slices.find((x) => x.id === sliceId)
				if (!s) throw new Error(`no slice ${sliceId}`)
				if (patch.state !== undefined) s.state = patch.state
				if (patch.readyForAgent !== undefined) s.readyForAgent = patch.readyForAgent
				if (patch.needsRevision !== undefined) s.needsRevision = patch.needsRevision
				if (patch.state === 'CLOSED') s.bucket = 'done'
			},
		}
	}

	function makeReadySlice(overrides: Partial<Slice> = {}): Slice {
		return {
			id: 's1',
			title: 'A slice',
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

	describe('runFileLoop', () => {
		test('runs implementer once on a single ready slice, pushes integration, and closes the slice on a ready verdict', async () => {
			const slice = makeReadySlice({ id: 's1', title: 'Implement A' })
			const backend = makeFakeBackend({ slices: [slice] })
			const sandboxCalls: Array<{ role: string; sliceId: string }> = []
			const pushedBranches: string[] = []

			await runFileLoop('p1', {
				backend,
				integrationBranch: 'integration',
				spawnSandbox: async ({ role, slice: s }) => {
					sandboxCalls.push({ role, sliceId: s.id })
					return { verdict: 'ready', commits: 1 }
				},
				gitPush: async (branch) => {
					pushedBranches.push(branch)
				},
				log: () => {},
				config: { maxIterations: 50, sliceStepCap: 5 },
			})

			expect(sandboxCalls).toEqual([{ role: 'implement', sliceId: 's1' }])
			expect(pushedBranches).toEqual(['integration'])
			const after = await backend.findSlices('p1')
			expect(after[0]!.state).toBe('CLOSED')
		})

		test('picks up newly-unblocked slices after their dependency closes (queue-drain semantics)', async () => {
			const s1 = makeReadySlice({ id: 's1' })
			// s2 starts blocked on s1; bucket is computed by the fake on each findSlices.
			const s2 = makeReadySlice({ id: 's2', blockedBy: ['s1'] })
			const backend = makeFakeBackend({ slices: [s1, s2] })
			const sandboxCalls: string[] = []

			await runFileLoop('p1', {
				backend,
				integrationBranch: 'integration',
				spawnSandbox: async ({ slice: s }) => {
					sandboxCalls.push(s.id)
					return { verdict: 'ready', commits: 1 }
				},
				gitPush: async () => {},
				log: () => {},
				config: { maxIterations: 50, sliceStepCap: 5 },
			})

			expect(sandboxCalls).toEqual(['s1', 's2'])
			const after = await backend.findSlices('p1')
			expect(after.every((s) => s.state === 'CLOSED')).toBe(true)
		})

		test('processes multiple ready slices serially in one invocation', async () => {
			const s1 = makeReadySlice({ id: 's1' })
			const s2 = makeReadySlice({ id: 's2' })
			const backend = makeFakeBackend({ slices: [s1, s2] })
			const sandboxCalls: string[] = []
			const pushedBranches: string[] = []

			await runFileLoop('p1', {
				backend,
				integrationBranch: 'integration',
				spawnSandbox: async ({ slice: s }) => {
					sandboxCalls.push(s.id)
					return { verdict: 'ready', commits: 1 }
				},
				gitPush: async (b) => {
					pushedBranches.push(b)
				},
				log: () => {},
				config: { maxIterations: 50, sliceStepCap: 5 },
			})

			expect(sandboxCalls).toEqual(['s1', 's2'])
			expect(pushedBranches).toEqual(['integration', 'integration'])
			const after = await backend.findSlices('p1')
			expect(after.every((s) => s.state === 'CLOSED')).toBe(true)
		})

		test('does not invoke the sandbox for slices outside the `ready` bucket', async () => {
			const draft = makeReadySlice({ id: 'd1', readyForAgent: false, bucket: 'draft' })
			const blocked = makeReadySlice({ id: 'b1', bucket: 'blocked', blockedBy: ['x'] })
			const done = makeReadySlice({ id: 'done1', state: 'CLOSED', bucket: 'done' })
			const backend = makeFakeBackend({ slices: [draft, blocked, done] })
			const sandboxCalls: string[] = []

			await runFileLoop('p1', {
				backend,
				integrationBranch: 'integration',
				spawnSandbox: async ({ slice: s }) => {
					sandboxCalls.push(s.id)
					return { verdict: 'ready', commits: 1 }
				},
				gitPush: async () => {},
				log: () => {},
				config: { maxIterations: 50, sliceStepCap: 5 },
			})

			expect(sandboxCalls).toEqual([])
		})

		test('a stuck slice (sliceStepCap reached on partial) does not block other ready slices', async () => {
			const stuck = makeReadySlice({ id: 'stuck' })
			const fine = makeReadySlice({ id: 'fine' })
			const backend = makeFakeBackend({ slices: [stuck, fine] })
			const sandboxCalls: string[] = []

			await runFileLoop('p1', {
				backend,
				integrationBranch: 'integration',
				spawnSandbox: async ({ slice: s }) => {
					sandboxCalls.push(s.id)
					return s.id === 'stuck' ? { verdict: 'partial', notes: 'stuck', commits: 0 } : { verdict: 'ready', commits: 1 }
				},
				gitPush: async () => {},
				log: () => {},
				config: { maxIterations: 100, sliceStepCap: 2 },
			})

			// stuck retried 2× (sliceStepCap), then fine processed once.
			expect(sandboxCalls.filter((id) => id === 'stuck')).toHaveLength(2)
			expect(sandboxCalls.filter((id) => id === 'fine')).toHaveLength(1)
			const after = await backend.findSlices('p1')
			expect(after.find((s) => s.id === 'fine')!.state).toBe('CLOSED')
			expect(after.find((s) => s.id === 'stuck')!.state).toBe('OPEN')
		})

		test('a slice that keeps reporting partial is retried at most sliceStepCap times in one invocation', async () => {
			const slice = makeReadySlice({ id: 's-stuck' })
			const backend = makeFakeBackend({ slices: [slice] })
			let calls = 0

			await runFileLoop('p1', {
				backend,
				integrationBranch: 'integration',
				spawnSandbox: async () => {
					calls += 1
					return { verdict: 'partial', notes: 'stuck', commits: 0 }
				},
				gitPush: async () => {},
				log: () => {},
				config: { maxIterations: 100, sliceStepCap: 3 },
			})

			expect(calls).toBe(3)
		})

		test('on a partial verdict, takes no host action (no push, no slice mutation)', async () => {
			const slice = makeReadySlice({ id: 's1' })
			const backend = makeFakeBackend({ slices: [slice] })
			const pushedBranches: string[] = []

			await runFileLoop('p1', {
				backend,
				integrationBranch: 'integration',
				spawnSandbox: async () => ({ verdict: 'partial', notes: 'hit cap', commits: 0 }),
				gitPush: async (b) => {
					pushedBranches.push(b)
				},
				log: () => {},
				config: { maxIterations: 50, sliceStepCap: 5 },
			})

			expect(pushedBranches).toEqual([])
			const after = await backend.findSlices('p1')
			expect(after[0]!.state).toBe('OPEN')
			expect(after[0]!.readyForAgent).toBe(true)
		})

		test('on a no-work-needed verdict, clears readyForAgent and does not push or close the slice', async () => {
			const slice = makeReadySlice({ id: 's1' })
			const backend = makeFakeBackend({ slices: [slice] })
			const pushedBranches: string[] = []

			await runFileLoop('p1', {
				backend,
				integrationBranch: 'integration',
				spawnSandbox: async () => ({ verdict: 'no-work-needed', notes: 'spec already satisfied', commits: 0 }),
				gitPush: async (branch) => {
					pushedBranches.push(branch)
				},
				log: () => {},
				config: { maxIterations: 50, sliceStepCap: 5 },
			})

			expect(pushedBranches).toEqual([])
			const after = await backend.findSlices('p1')
			expect(after[0]!.state).toBe('OPEN')
			expect(after[0]!.readyForAgent).toBe(false)
		})
	})
}
