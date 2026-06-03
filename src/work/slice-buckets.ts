import { enrichSlicePrStates } from './pr-flow.ts'
import type { ClassifiedSlice, Storage } from '../storages/types.ts'
import { classifySlices } from '../utils/bucket.ts'
import type { GhOps } from '../utils/gh-ops.ts'

export async function classifySlicesForPrd(args: {
	storage: Storage
	gh: GhOps
	prdId: string
	usePrs: boolean
}): Promise<ClassifiedSlice[]> {
	const raw = await args.storage.findSlices(args.prdId)
	const enriched = args.usePrs ? await enrichSlicePrStates(args.gh, args.prdId, raw) : raw
	return classifySlices(enriched)
}

if (import.meta.vitest) {
	const { describe, test, expect } = import.meta.vitest
	const { recordingGhOps } = await import('../test-utils/gh-ops-recorder.ts')

	describe('classifySlicesForPrd', () => {
		function storageWithSlice(prState: null = null): Storage {
			return {
				createPrd: async () => ({ id: 'p', branch: 'p' }),
				findPrd: async () => null,
				listPrds: async () => [],
				closePrd: async () => {},
				createSlice: async () => { throw new Error('not used') },
				findSlices: async () => [{ id: '124', title: 'Read Query Shape', body: '', state: 'OPEN', readyForAgent: true, needsRevision: false, blockedBy: [], prState }],
				findSlice: async () => null,
				updateSlice: async () => {},
				createFix: async () => ({ id: 'f', branch: 'f' }),
				findFix: async () => null,
				listFixes: async () => [],
				updateFix: async () => {},
				closeFix: async () => {},
			}
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
