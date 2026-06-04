import { createEffectiveSliceReader } from './effective-slices.ts'
import type { ClassifiedSlice, Storage } from '../storages/types.ts'
import { classifySlices } from '../utils/bucket.ts'
import type { GhOps } from '../utils/gh-ops.ts'

export async function classifySlicesForPrd(args: {
	storage: Storage
	gh: GhOps
	prdId: string
	usePrs: boolean
}): Promise<ClassifiedSlice[]> {
	const reader = createEffectiveSliceReader({ storage: args.storage, gh: args.gh, usePrs: args.usePrs })
	return classifySlices(await reader.findSlices(args.prdId))
}

if (import.meta.vitest) {
	const { describe, test, expect } = import.meta.vitest
	const { recordingGhOps } = await import('../test-utils/gh-ops-recorder.ts')
	const { fakeClassifiedSlice, fakeSliceStorage } = await import('../test-utils/storage-fixtures.ts')

	describe('classifySlicesForPrd', () => {
		function storageWithSlice(prState: null = null): Storage {
			return fakeSliceStorage([fakeClassifiedSlice({ id: '124', title: 'Read Query Shape', prState })])
		}

		test('usePrs:false classifies raw storage slices without gh enrichment', async () => {
			const { gh, calls } = recordingGhOps()
			const out = await classifySlicesForPrd({ storage: storageWithSlice(), gh, prdId: '123', usePrs: false })
			expect(out[0]!.bucket).toBe('ready')
			expect(calls).toEqual([])
		})

		test('usePrs:true classifies a slice with an open PR as in-flight', async () => {
			const { gh } = recordingGhOps({
				listOpenPrs: async () => [{ number: 130, headRefName: 'prd-123/slice-124-read-query-shape', isDraft: false }],
			})
			const out = await classifySlicesForPrd({ storage: storageWithSlice(), gh, prdId: '123', usePrs: true })
			expect(out[0]!.bucket).toBe('in-flight')
		})

		test('usePrs:true surfaces gh enrichment errors', async () => {
			const { gh } = recordingGhOps({ listOpenPrs: async () => { throw new Error('gh unavailable') } })
			await expect(classifySlicesForPrd({ storage: storageWithSlice(), gh, prdId: '123', usePrs: true })).rejects.toThrow(/gh unavailable/)
		})
	})
}
