import { enrichSlicesFromOpenPrs } from './pr-flow.ts'
import type { Slice, Storage } from '../storages/types.ts'
import type { GhOps } from '../utils/gh-ops.ts'
import { classifySlices } from '../utils/slice-state.ts'

export type EffectiveSliceReader = {
	findSlices(changeId: string): Promise<Slice[]>
	findSlice(changeId: string, sliceId: string): Promise<Slice | null>
}

export function createEffectiveSliceReader(deps: {
	storage: Storage
	gh: GhOps
	pr: boolean
	needsRevisionLabel?: string
}): EffectiveSliceReader {
	return {
		async findSlices(changeId) {
			const raw = await deps.storage.findSlices(changeId)
			const enriched = deps.pr
				? await enrichSlicesFromOpenPrs(deps.gh, changeId, raw, { needsRevisionLabel: deps.needsRevisionLabel })
				: raw
			return classifySlices(enriched)
		},
		async findSlice(changeId, sliceId) {
			const slices = await this.findSlices(changeId)
			return slices.find((s) => s.id === sliceId) ?? null
		},
	}
}

if (import.meta.vitest) {
	const { describe, expect, test } = import.meta.vitest
	const { fakeClassifiedSlice, fakeSliceStorage } = await import('../test-utils/storage-fixtures.ts')
	const { recordingGhOps } = await import('../test-utils/gh-ops-recorder.ts')

	describe('createEffectiveSliceReader', () => {
		test('returns raw storage slices when pr is false', async () => {
			const slice = fakeClassifiedSlice({ id: '125', prState: null, needsRevision: false })
			const { gh, calls } = recordingGhOps({
				listOpenPrs: async () => [
					{
						number: 1,
						headRefName: 'change-123/slice-125-filter-only-count-terminal',
						isDraft: false,
						labels: [{ name: 'needs-revision' }],
					},
				],
			})
			const reader = createEffectiveSliceReader({ storage: fakeSliceStorage([slice]), gh, pr: false })
			expect(await reader.findSlices('123')).toEqual([slice])
			expect(calls.find((c) => c[0] === 'listOpenPrs')).toBeUndefined()
		})

		test('enriches open PR state and needs-revision PR labels when pr is true', async () => {
			const slice = fakeClassifiedSlice({
				id: '125',
				title: 'Filter-only count terminal',
				sliceBranch: 'change-123/slice-125-filter-only-count-terminal',
				prState: null,
				needsRevision: false,
			})
			const { gh } = recordingGhOps({
				listOpenPrs: async () => [
					{
						number: 1,
						headRefName: 'change-123/slice-125-filter-only-count-terminal',
						isDraft: false,
						labels: [{ name: 'needs-revision' }],
					},
				],
			})
			const reader = createEffectiveSliceReader({ storage: fakeSliceStorage([slice]), gh, pr: true })
			expect(await reader.findSlice('123', '125')).toMatchObject({
				id: '125',
				prState: 'ready',
				needsRevision: true,
				state: 'needs-revision',
			})
		})

		test('surfaces gh enrichment failures when pr is true', async () => {
			const slice = fakeClassifiedSlice({ id: '125' })
			const { gh } = recordingGhOps({
				listOpenPrs: async () => {
					throw new Error('gh unavailable')
				},
			})
			const reader = createEffectiveSliceReader({ storage: fakeSliceStorage([slice]), gh, pr: true })
			await expect(reader.findSlices('123')).rejects.toThrow(/gh unavailable/)
		})
	})
}
