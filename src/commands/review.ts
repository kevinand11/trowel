import { buildLoopWiring } from './_loop-wiring.ts'
import type { Storage, Slice, ClassifiedSlice } from '../storages/types.ts'
import { classifySlices } from '../utils/bucket.ts'


export async function review(prdId: string, sliceId: string): Promise<void> {
	try {
		const wiring = await buildLoopWiring({})
		await runReview(prdId, sliceId, {
			storage: wiring.storage,
			runOnePhase: (slice) => wiring.runOnePhase(prdId, slice, 'review'),
			stderr: (s) => process.stderr.write(s),
		})
	} catch (e) {
		process.stderr.write(`trowel review: ${(e as Error).message}\n`)
		process.exit(1)
	}
}

type ReviewRuntime = {
	storage: Storage
	runOnePhase: (slice: Slice) => Promise<void>
	stderr: (s: string) => void
}

async function runReview(prdId: string, sliceId: string, rt: ReviewRuntime): Promise<void> {
	if (rt.storage.name !== 'issue') {
		throw new Error(`'${rt.storage.name}' storage does not support review. PR-driven review is an issue-storage feature.`)
	}
	const prd = await rt.storage.findPrd(prdId)
	if (!prd) throw new Error(`PRD '${prdId}' not found`)
	const slice = classifySlices(await rt.storage.findSlices(prdId)).find((s) => s.id === sliceId)
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

	function makeSlice(overrides: Partial<ClassifiedSlice> = {}): ClassifiedSlice {
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

	function makeStorage(name: string, slices: Slice[]): Storage {
		return {
			name,
			defaultBranchPrefix: '',
			maxConcurrent: null,
			capabilities: { prFlow: false },
			createPrd: async () => ({ id: 'x', branch: 'x' }),
			branchForExisting: async () => 'x',
			findPrd: async (id) => ({ id, branch: 'b', title: 't', state: 'OPEN' }),
			listPrds: async () => [],
			closePrd: async () => {},
			createSlice: async () => {
				throw new Error('not used')
			},
			findSlices: async () => slices,
			updateSlice: async () => {},
		}
	}

	describe('runReview', () => {
		test('on an in-flight slice (issue storage): calls runOnePhase exactly once', async () => {
			const slice = makeSlice({ id: 's1', bucket: 'in-flight' })
			const storage = makeStorage('issue', [slice])
			const calls: Slice[] = []
			await runReview('p1', 's1', {
				storage,
				runOnePhase: async (s) => {
					calls.push(s)
				},
				stderr: () => {},
			})
			expect(calls).toHaveLength(1)
		})

		test('refuses on the file storage with a storage-aware message', async () => {
			const slice = makeSlice({ id: 's1', bucket: 'in-flight' })
			const storage = makeStorage('file', [slice])
			await expect(
				runReview('p1', 's1', { storage, runOnePhase: async () => {}, stderr: () => {} }),
			).rejects.toThrow(/file.*storage.*does not support.*review/i)
		})

		test('refuses when slice bucket is not "in-flight"', async () => {
			const slice = makeSlice({ id: 's1', prState: null }) // no PR → bucket 'ready'
			const storage = makeStorage('issue', [slice])
			await expect(
				runReview('p1', 's1', { storage, runOnePhase: async () => {}, stderr: () => {} }),
			).rejects.toThrow(/bucket 'ready'/)
		})
	})
}
