import { createEffectiveSliceReader } from './effective-slices.ts'
import type { Slice, Storage } from '../storages/types.ts'
import type { GhOps } from '../utils/gh-ops.ts'

export async function classifySlicesForChange(args: {
	storage: Storage
	gh: GhOps
	changeId: string
	usePrs: boolean
}): Promise<Slice[]> {
	const reader = createEffectiveSliceReader({ storage: args.storage, gh: args.gh, usePrs: args.usePrs })
	return reader.findSlices(args.changeId)
}

if (import.meta.vitest) {
	const { describe, test, expect } = import.meta.vitest
	const { recordingGhOps } = await import('../test-utils/gh-ops-recorder.ts')
	const { fakeClassifiedSlice, fakeSliceStorage } = await import('../test-utils/storage-fixtures.ts')

	describe('classifySlicesForChange', () => {
		function storageWithSlice(prState: null = null): Storage {
			return fakeSliceStorage([fakeClassifiedSlice({ id: '124', title: 'Read Query Shape', prState })])
		}

		test('usePrs:false classifies raw storage slices without gh enrichment', async () => {
			const { gh, calls } = recordingGhOps()
			const out = await classifySlicesForChange({ storage: storageWithSlice(), gh, changeId: '123', usePrs: false })
			expect(out[0]!.state).toBe('open')
			expect(calls).toEqual([])
		})

		test('usePrs:true classifies a slice with an open PR as in-flight', async () => {
			const { gh } = recordingGhOps({
				listOpenPrs: async () => [{ number: 130, headRefName: 'change-123/slice-124-read-query-shape', isDraft: false }],
			})
			const out = await classifySlicesForChange({ storage: storageWithSlice(), gh, changeId: '123', usePrs: true })
			expect(out[0]!.state).toBe('in-flight')
		})

		test('usePrs:true surfaces gh enrichment errors', async () => {
			const { gh } = recordingGhOps({ listOpenPrs: async () => { throw new Error('gh unavailable') } })
			await expect(classifySlicesForChange({ storage: storageWithSlice(), gh, changeId: '123', usePrs: true })).rejects.toThrow(/gh unavailable/)
		})
	})
}
