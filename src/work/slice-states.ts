import { createEffectiveSliceReader } from './effective-slices.ts'
import type { Storage } from '../storages/types.ts'
import type { ClassifiedSlice } from './slice-types.ts'
import type { GhOps } from '../utils/gh-ops.ts'

export async function classifySlicesForChange(args: {
	storage: Storage
	gh: GhOps
	changeId: string
	pr: boolean
	needsRevisionLabel?: string
}): Promise<ClassifiedSlice[]> {
	const reader = createEffectiveSliceReader({
		storage: args.storage,
		gh: args.gh,
		pr: args.pr,
		needsRevisionLabel: args.needsRevisionLabel,
	})
	return reader.findSlices(args.changeId)
}

if (import.meta.vitest) {
	const { describe, test, expect } = import.meta.vitest
	const { recordingGhOps } = await import('../test-utils/gh-ops-recorder.ts')
	const { fakeClassifiedSlice, fakeSliceStorage } = await import('../test-utils/storage-fixtures.ts')

	describe('classifySlicesForChange', () => {
		function storageWithSlice(prState: null = null): Storage {
			return fakeSliceStorage([
				fakeClassifiedSlice({
					id: '124',
					title: 'Read Query Shape',
					sliceBranch: 'change-123/slice-124-read-query-shape',
					prState,
				}),
			])
		}

		test('pr:false classifies raw storage slices without gh enrichment', async () => {
			const { gh, calls } = recordingGhOps()
			const out = await classifySlicesForChange({ storage: storageWithSlice(), gh, changeId: '123', pr: false })
			expect(out[0]!.state).toBe('open')
			expect(calls).toEqual([])
		})

		test('pr:true classifies a slice with an open non-draft PR as awaiting-review', async () => {
			const { gh } = recordingGhOps({
				listOpenPrs: async () => [{ number: 130, headRefName: 'change-123/slice-124-read-query-shape', isDraft: false }],
			})
			const out = await classifySlicesForChange({ storage: storageWithSlice(), gh, changeId: '123', pr: true })
			expect(out[0]!.state).toBe('awaiting-review')
		})

		test('pr:true surfaces gh enrichment errors', async () => {
			const { gh } = recordingGhOps({
				listOpenPrs: async () => {
					throw new Error('gh unavailable')
				},
			})
			await expect(classifySlicesForChange({ storage: storageWithSlice(), gh, changeId: '123', pr: true })).rejects.toThrow(
				/gh unavailable/,
			)
		})
	})
}
