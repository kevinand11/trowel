import type { ClassifiedSlice, ChangeRecord, Slice, Storage } from '../storages/types.ts'

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

const noop = async (): Promise<void> => {}
const defaultCreatedEntity = async (): Promise<{ id: string; branch: string }> => ({ id: 'x', branch: 'x' })
const emptyChangeSummaries = async (): Promise<Awaited<ReturnType<Storage['listChanges']>>> => []
const emptyFixSummaries = async (): Promise<Awaited<ReturnType<Storage['listFixes']>>> => []
const nullFix = async (): Promise<Awaited<ReturnType<Storage['findFix']>>> => null

export function fakeSliceStorage(slices: Slice[], changeId: string | null = 'p1', overrides: Partial<Storage> = {}): Storage {
	const sliceById = new Map(slices.map((s) => [s.id, s]))
	return {
		createChange: defaultCreatedEntity,
		findChange: defaultFindChange,
		listChanges: emptyChangeSummaries,
		closeChange: noop,
		createSlice: unusedCreateSlice,
		findSlices: async () => slices,
		findSlice: async (sliceId) => findFakeSlice(changeId, sliceById, sliceId),
		updateSlice: noop,
		createFix: defaultCreatedEntity,
		findFix: nullFix,
		listFixes: emptyFixSummaries,
		updateFix: noop,
		closeFix: noop,
		...overrides,
	}
}

async function defaultFindChange(id: string): Promise<ChangeRecord> {
	return { id, branch: 'b', title: 't', state: 'OPEN' }
}

async function unusedCreateSlice(): Promise<Slice> {
	throw new Error('not used')
}

function findFakeSlice(changeId: string | null, sliceById: Map<string, Slice>, sliceId: string): { changeId: string; slice: Slice } | null {
	if (changeId === null) return null
	const slice = sliceById.get(sliceId)
	return slice ? { changeId, slice } : null
}
