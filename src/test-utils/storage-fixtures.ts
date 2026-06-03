import type { ClassifiedSlice, Slice, Storage } from '../storages/types.ts'

export function fakeClassifiedSlice(overrides: Partial<ClassifiedSlice> = {}): ClassifiedSlice {
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
		...overrides,
	}
}

export function fakeSliceStorage(slices: Slice[], prdId: string | null = 'p1', overrides: Partial<Storage> = {}): Storage {
	const sliceById = new Map(slices.map((s) => [s.id, s]))
	return {
		createPrd: async () => ({ id: 'x', branch: 'x' }),
		findPrd: async (id) => ({ id, branch: 'b', title: 't', state: 'OPEN' }),
		listPrds: async () => [],
		closePrd: async () => {},
		createSlice: async () => { throw new Error('not used') },
		findSlices: async () => slices,
		findSlice: async (sliceId) => {
			if (prdId === null) return null
			const slice = sliceById.get(sliceId)
			return slice ? { prdId, slice } : null
		},
		updateSlice: async () => {},
		createFix: async () => ({ id: 'x', branch: 'x' }),
		findFix: async () => null,
		listFixes: async () => [],
		updateFix: async () => {},
		closeFix: async () => {},
		...overrides,
	}
}
