import type { Config } from '../config'
import type { GhOps } from '../utils/gh-ops'
import type { GitOps } from '../utils/git-ops'

export type CreateChange = {
	title: string
	body: string
	targetBranch?: string
}

export type CreateSlice = {
	title: string
	body: string
}

export type Change = {
	id: string
	title: string
	body: string
	createdAt: string
	closedAt: string | null
	targetBranch: string
	changeBranch: string
}

export type Slice = {
	id: string
	title: string
	body: string
	closedAt: string | null
	implementedAt: string | null
	auditedAt: string | null
	readyForAgent: boolean
	blockedBy: string[]
	sliceBranch: string | null
}

type CreatedChange = Pick<Change, 'id' | 'title'>
type CreatedSlice = Pick<Slice, 'id' | 'title'>
export type ChangeMetadataPatch = Partial<Pick<Change, 'targetBranch' | 'changeBranch'>>
export type SliceMetadataPatch = Partial<Pick<Slice, 'sliceBranch'>>

export type DeleteBranchPolicy = 'always' | 'never' | 'prompt'
export type ShipMergeMethod = 'merge' | 'squash' | 'rebase'

export type StorageDeps = {
	gh: GhOps
	changesDir: string
	labels: Config['labels']
	git: GitOps
}

type AbortOptions = { comment?: string }

export type StorageFactory = (deps: StorageDeps) => Storage

export interface Storage {
	// Change lifecycle
	createChange(spec: CreateChange): Promise<CreatedChange>
	findChange(id: string): Promise<Change | null>
	listChanges(): Promise<Change[]>
	finalizeChange(changeId: string): Promise<void>
	abortChange(changeId: string, opts?: AbortOptions): Promise<void>
	updateChangeMetadata(changeId: string, patch: ChangeMetadataPatch): Promise<void>

	// Slice lifecycle
	createSlice(changeId: string, spec: CreateSlice): Promise<CreatedSlice>
	findSlices(changeId: string): Promise<Slice[]>
	setSliceReadyForAgent(changeId: string, sliceId: string, ready: boolean): Promise<void>
	setSliceBlockers(changeId: string, sliceId: string, blockedBy: string[]): Promise<void>
	markSliceImplemented(changeId: string, sliceId: string, at: string): Promise<void>
	markSliceAudited(changeId: string, sliceId: string, at: string): Promise<void>
	finalizeSlice(changeId: string, sliceId: string): Promise<void>
	abortSlice(changeId: string, sliceId: string, opts?: AbortOptions): Promise<void>
	updateSliceMetadata(changeId: string, sliceId: string, patch: SliceMetadataPatch): Promise<void>
}
