import type { ChangeRecord, Slice, Storage } from '../storages/types.ts'
import type { ClassifiedSlice } from '../work/slice-types.ts'

export function fakeClassifiedSlice(overrides: Partial<ClassifiedSlice> = {}): ClassifiedSlice {
	return {
		id: 's1',
		title: 'Implement A',
		body: 'spec',
		state: 'open',
		closedAt: null,
		implementedAt: null,
		auditedAt: null,
		readyForAgent: true,
		needsRevision: false,
		blockedBy: [],
		sliceBranch: `change-p1/slice-${overrides.id ?? 's1'}-implement-a`,
		prState: null,
		...overrides,
	}
}

const noop = async (): Promise<void> => {}
const noopSetReadyForAgent = async (): Promise<void> => {}
const noopSetBlockers = async (): Promise<void> => {}
const noopMarkImplemented = async (): Promise<void> => {}
const noopMarkAudited = async (): Promise<void> => {}
const noopFinalizeSlice = async (): Promise<void> => {}
const noopAbortSlice = async (): Promise<void> => {}
const defaultCreatedEntity = async (): Promise<{ id: string; title: string }> => ({ id: 'x', title: 'x' })
const emptyChangeSummaries = async (): Promise<Awaited<ReturnType<Storage['listChanges']>>> => []

export function fakeSliceStorage(slices: Slice[], _changeId: string | null = 'p1', overrides: Partial<Storage> = {}): Storage {
	return {
		createChange: defaultCreatedEntity,
		findChange: defaultFindChange,
		listChanges: emptyChangeSummaries,
		closeChange: noop,
		createSlice: unusedCreateSlice,
		findSlices: async () => slices,
		updateChangeMetadata: noop,
		setSliceReadyForAgent: noopSetReadyForAgent,
		setSliceBlockers: noopSetBlockers,
		markSliceImplemented: noopMarkImplemented,
		markSliceAudited: noopMarkAudited,
		finalizeSlice: noopFinalizeSlice,
		abortSlice: noopAbortSlice,
		updateSliceMetadata: noop,
		...overrides,
	}
}

async function defaultFindChange(id: string): Promise<ChangeRecord> {
	return { id, changeBranch: 'b', targetBranch: 'main', title: 't', closedAt: null }
}

async function unusedCreateSlice(): Promise<Slice> {
	throw new Error('not used')
}

