import { buildLoopWiring } from './_loop-wiring.ts'
import type { Backend, Slice } from '../backends/types.ts'


export async function review(prdId: string, sliceId: string): Promise<void> {
	try {
		const wiring = await buildLoopWiring({})
		await runReview(prdId, sliceId, {
			backend: wiring.backend,
			runOnePhase: (slice) => wiring.runOnePhase(prdId, slice, 'review'),
			stderr: (s) => process.stderr.write(s),
		})
	} catch (e) {
		process.stderr.write(`trowel review: ${(e as Error).message}\n`)
		process.exit(1)
	}
}

type ReviewRuntime = {
	backend: Backend
	runOnePhase: (slice: Slice) => Promise<void>
	stderr: (s: string) => void
}

async function runReview(prdId: string, sliceId: string, rt: ReviewRuntime): Promise<void> {
	if (rt.backend.name !== 'issue') {
		throw new Error(`'${rt.backend.name}' backend does not support review. PR-driven review is an issue-backend feature.`)
	}
	const prd = await rt.backend.findPrd(prdId)
	if (!prd) throw new Error(`PRD '${prdId}' not found`)
	const slice = (await rt.backend.findSlices(prdId)).find((s) => s.id === sliceId)
	if (!slice) throw new Error(`slice '${sliceId}' not found in PRD '${prdId}'`)
	if (slice.bucket !== 'in-flight') {
		throw new Error(
			`slice '${sliceId}' is in bucket '${slice.bucket}', not 'in-flight'. ` +
				`Reviewer only runs against slices with an open draft PR.`,
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
			bucket: 'in-flight',
			blockedBy: [],
			prState: 'draft',
			branchAhead: false,
			...overrides,
		}
	}

	function makeBackend(name: string, slices: Slice[]): Backend {
		return {
			name,
			defaultBranchPrefix: '',
			maxConcurrent: null,
			classifySlice: () => 'done',
			reconcileSlices: async () => {},
			prepareImplement: async () => { throw new Error('not used in test') },
			landImplement: async () => 'done' as const,
			prepareReview: async () => { throw new Error('not used in test') },
			landReview: async () => 'done' as const,
			prepareAddress: async () => { throw new Error('not used in test') },
			landAddress: async () => 'done' as const,
			createPrd: async () => ({ id: 'x', branch: 'x' }),
			branchForExisting: async () => 'x',
			findPrd: async (id) => ({ id, branch: 'b', title: 't', state: 'OPEN' }),
			listPrds: async () => [],
			close: async () => {},
			createSlice: async () => {
				throw new Error('not used')
			},
			findSlices: async () => slices,
			updateSlice: async () => {},
		}
	}

	describe('runReview', () => {
		test('on an in-flight slice (issue backend): calls runOnePhase exactly once', async () => {
			const slice = makeSlice({ id: 's1', bucket: 'in-flight' })
			const backend = makeBackend('issue', [slice])
			const calls: Slice[] = []
			await runReview('p1', 's1', {
				backend,
				runOnePhase: async (s) => {
					calls.push(s)
				},
				stderr: () => {},
			})
			expect(calls).toHaveLength(1)
		})

		test('refuses on the file backend with a backend-aware message', async () => {
			const slice = makeSlice({ id: 's1', bucket: 'in-flight' })
			const backend = makeBackend('file', [slice])
			await expect(
				runReview('p1', 's1', { backend, runOnePhase: async () => {}, stderr: () => {} }),
			).rejects.toThrow(/file.*backend.*does not support.*review/i)
		})

		test('refuses when slice bucket is not "in-flight"', async () => {
			const slice = makeSlice({ id: 's1', bucket: 'ready' })
			const backend = makeBackend('issue', [slice])
			await expect(
				runReview('p1', 's1', { backend, runOnePhase: async () => {}, stderr: () => {} }),
			).rejects.toThrow(/bucket 'ready'/)
		})
	})
}
