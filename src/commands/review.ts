import { buildLoopWiring } from './_loop-wiring.ts'
import type { HarnessKind } from '../harnesses/registry.ts'
import type { StorageKind } from '../storages/registry.ts'
import type { ClassifiedSlice, Slice, Storage } from '../storages/types.ts'
import { classifySlices } from '../utils/bucket.ts'

export async function review(sliceId: string, opts: { storage?: StorageKind; harness?: HarnessKind }): Promise<void> {
	try {
		const wiring = await buildLoopWiring({ storage: opts.storage, harness: opts.harness })
		await runReview(sliceId, {
			storage: wiring.storage,
			runOnePhase: (prdId, slice) => wiring.runOnePhase(prdId, slice, 'review'),
			stderr: (s) => process.stderr.write(s),
		})
	} catch (e) {
		process.stderr.write(`trowel review: ${(e as Error).message}\n`)
		process.exit(1)
	}
}

type ReviewRuntime = {
	storage: Storage
	runOnePhase: (prdId: string, slice: Slice) => Promise<void>
	stderr: (s: string) => void
}

async function runReview(sliceId: string, rt: ReviewRuntime): Promise<void> {
	const hit = await rt.storage.findSlice(sliceId)
	if (!hit) throw new Error(`slice '${sliceId}' not found`)
	const { prdId } = hit
	const slice = classifySlices(await rt.storage.findSlices(prdId)).find((s) => s.id === sliceId)
	if (!slice) throw new Error(`slice '${sliceId}' disappeared between findSlice and findSlices`)
	if (slice.bucket !== 'in-flight') {
		throw new Error(
			`slice '${sliceId}' is in bucket '${slice.bucket}', not 'in-flight'. ` +
				`Reviewer only runs against slices with an open draft PR.`,
		)
	}
	await rt.runOnePhase(prdId, slice)
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
			...overrides,
		}
	}

	function makeStorage(slices: Slice[]): Storage {
		const sliceById = new Map(slices.map((s) => [s.id, s]))
		return {
			createPrd: async () => ({ id: 'x', branch: 'x' }),
			findPrd: async (id) => ({ id, branch: 'b', title: 't', state: 'OPEN' }),
			listPrds: async () => [],
			closePrd: async () => {},
			createSlice: async () => {
				throw new Error('not used')
			},
			findSlices: async () => slices,
			findSlice: async (sliceId) => {
				const s = sliceById.get(sliceId)
				return s ? { prdId: 'p1', slice: s } : null
			},
			updateSlice: async () => {},
		}
	}

	describe('runReview', () => {
		test('on an in-flight slice (issue storage): calls runOnePhase exactly once', async () => {
			const slice = makeSlice({ id: 's1', bucket: 'in-flight' })
			const storage = makeStorage([slice])
			const calls: Slice[] = []
			await runReview('s1', {
				storage,
				runOnePhase: async (_prdId, s) => {
					calls.push(s)
				},
				stderr: () => {},
			})
			expect(calls).toHaveLength(1)
		})

		test('refuses when slice bucket is not "in-flight"', async () => {
			const slice = makeSlice({ id: 's1', prState: null }) // no PR → bucket 'ready'
			const storage = makeStorage([slice])
			await expect(runReview('s1', { storage, runOnePhase: async () => {}, stderr: () => {} })).rejects.toThrow(
				/bucket 'ready'/,
			)
		})
	})
}
