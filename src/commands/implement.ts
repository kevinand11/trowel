import { buildLoopWiring } from './_loop-wiring.ts'
import type { Backend, Slice } from '../backends/types.ts'


export type ImplementRuntime = {
	backend: Backend
	runOnePhase: (slice: Slice) => Promise<void>
	stderr: (s: string) => void
}

export async function implement(prdId: string, sliceId: string): Promise<void> {
	try {
		const wiring = await buildLoopWiring({})
		await runImplement(prdId, sliceId, {
			backend: wiring.backend,
			runOnePhase: (slice) => wiring.runOnePhase(prdId, slice),
			stderr: (s) => process.stderr.write(s),
		})
	} catch (e) {
		process.stderr.write(`trowel implement: ${(e as Error).message}\n`)
		process.exit(1)
	}
}

export async function runImplement(prdId: string, sliceId: string, rt: ImplementRuntime): Promise<void> {
	const prd = await rt.backend.findPrd(prdId)
	if (!prd) throw new Error(`PRD '${prdId}' not found`)
	const slice = (await rt.backend.findSlices(prdId)).find((s) => s.id === sliceId)
	if (!slice) throw new Error(`slice '${sliceId}' not found in PRD '${prdId}'`)
	if (slice.bucket !== 'ready') {
		throw new Error(
			`slice '${sliceId}' is in bucket '${slice.bucket}', not 'ready'. ` +
				`Run \`trowel work ${prdId}\` to drive it through the loop, or address it manually.`,
		)
	}
	await rt.runOnePhase(slice)
}

if (import.meta.vitest) {
	const { describe, test, expect } = import.meta.vitest

	function makeSlice(overrides: Partial<Slice> = {}): Slice {
		return {
			id: 's1',
			title: 'Implement A',
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

	function makeBackend(name: string, slices: Slice[], hasPrd = true): Backend {
		return {
			name,
			defaultBranchPrefix: '',
			createPrd: async () => ({ id: 'x', branch: 'x' }),
			branchForExisting: async () => 'x',
			findPrd: async (id) => (hasPrd ? { id, branch: 'b', title: 't', state: 'OPEN' } : null),
			listOpen: async () => [],
			close: async () => {},
			createSlice: async () => {
				throw new Error('not used')
			},
			findSlices: async () => slices,
			updateSlice: async () => {},
		}
	}

	describe('runImplement', () => {
		test('on a ready slice: calls runOnePhase exactly once with that slice', async () => {
			const slice = makeSlice({ id: 's1', bucket: 'ready' })
			const backend = makeBackend('file', [slice])
			const calls: Slice[] = []
			await runImplement('p1', 's1', {
				backend,
				runOnePhase: async (s) => {
					calls.push(s)
				},
				stderr: () => {},
			})
			expect(calls).toHaveLength(1)
			expect(calls[0]!.id).toBe('s1')
		})

		test('throws when PRD is not found', async () => {
			const backend = makeBackend('file', [], false)
			await expect(
				runImplement('zzz', 's1', { backend, runOnePhase: async () => {}, stderr: () => {} }),
			).rejects.toThrow(/PRD 'zzz' not found/)
		})

		test('throws when slice id is not in the PRD', async () => {
			const backend = makeBackend('file', [makeSlice({ id: 'other' })])
			await expect(
				runImplement('p1', 's1', { backend, runOnePhase: async () => {}, stderr: () => {} }),
			).rejects.toThrow(/slice 's1' not found/)
		})

		test('refuses when slice bucket is not "ready", naming the actual bucket', async () => {
			const slice = makeSlice({ id: 's1', bucket: 'draft', readyForAgent: false })
			const backend = makeBackend('file', [slice])
			let phaseCalled = false
			await expect(
				runImplement('p1', 's1', {
					backend,
					runOnePhase: async () => {
						phaseCalled = true
					},
					stderr: () => {},
				}),
			).rejects.toThrow(/bucket 'draft'/)
			expect(phaseCalled).toBe(false)
		})
	})
}
