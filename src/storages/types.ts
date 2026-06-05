import type { GhOps } from '../utils/gh-ops.ts'
import type { GitOps } from '../utils/git-ops.ts'

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
	/**
	 * ISO 8601 creation timestamp. Issue storage uses the underlying GitHub issue's `createdAt`;
	 * file storage uses the Change's `store.json:createdAt`. Consumers sort by this (e.g. `trowel
	 * list` shows newest first); storages return unsorted.
	 */
	createdAt: string
	/** Raw terminal timestamp. `null` means the Change has not been finalized/aborted. */
	closedAt: string | null
	targetBranch: string
	changeBranch: string
}

/**
 * The state of the slice's PR on the Change branch.
 *
 * - `'draft'`: an open draft PR exists; process milestones remain agent-processable.
 * - `'ready'`: an open non-draft PR exists, awaiting human review/merge.
 * - `'merged'`: the PR is merged; the computed Slice state is `landed` until Finalization sets `closedAt`.
 * - `null`: no PR exists, or the storage has no PR concept (file storage always emits `null`).
 *
 * Populated by PR-state enrichment after storage reads raw Slice records.
 */
export type Slice = {
	id: string
	title: string
	body: string
	/** Raw terminal timestamp. `null` means the Slice has not been finalized. */
	closedAt: string | null
	/** Implementer success milestone. `null` means the Implementer has not declared ready. */
	implementedAt: string | null
	/** Auditor success milestone. `null` means Auditing has not passed. */
	auditedAt: string | null
	readyForAgent: boolean
	/** Ids of slices that block this one. See ADR `storage-native-blocker-storage`. */
	blockedBy: string[]
	/** Stored branch this Slice's Turns run on. Null until first implementation preparation assigns it. */
	sliceBranch: string | null
}

export type SlicePatch = Partial<Pick<Slice, 'readyForAgent' | 'closedAt' | 'implementedAt' | 'auditedAt' | 'blockedBy'>>
export type CreatedChange = Pick<Change, 'id' | 'title'>
export type CreatedSlice = Pick<Slice, 'id' | 'title'>
export type ChangeMetadataPatch = Partial<Pick<Change, 'targetBranch' | 'changeBranch'>>
export type SliceMetadataPatch = Partial<Pick<Slice, 'sliceBranch'>>

export type DeleteBranchPolicy = 'always' | 'never' | 'prompt'
export type ShipMergeMethod = 'merge' | 'squash' | 'rebase'

export type StorageDeps = {
	gh: GhOps
	repoRoot: string
	projectRoot: string
	changesDir: string
	labels: { change: string; readyForAgent: string; needsRevision: string }
	abortOptions: { comment: string | null; deleteBranch: DeleteBranchPolicy }
	/**
	 * Optional runtime channel retained for command/runtime wiring. Storage implementations should
	 * remain pure persistence; orchestration owns prompts, git side effects, and Mutation locking.
	 */
	confirm?: (msg: string) => Promise<boolean>
	git: GitOps
	log?: (msg: string) => void
}

export type StorageFactory = (deps: StorageDeps) => Storage

export interface Storage {
	// Change lifecycle
	createChange(spec: CreateChange): Promise<CreatedChange>
	findChange(id: string): Promise<Change | null>
	listChanges(): Promise<Change[]>
	finalizeChange(changeId: string): Promise<void>
	abortChange(changeId: string): Promise<void>
	updateChangeMetadata(changeId: string, patch: ChangeMetadataPatch): Promise<void>

	// Slice lifecycle
	createSlice(changeId: string, spec: CreateSlice): Promise<CreatedSlice>
	findSlices(changeId: string): Promise<Slice[]>
	setSliceReadyForAgent(changeId: string, sliceId: string, ready: boolean): Promise<void>
	setSliceBlockers(changeId: string, sliceId: string, blockedBy: string[]): Promise<void>
	markSliceImplemented(changeId: string, sliceId: string, at: string): Promise<void>
	markSliceAudited(changeId: string, sliceId: string, at: string): Promise<void>
	finalizeSlice(changeId: string, sliceId: string): Promise<void>
	abortSlice(changeId: string, sliceId: string): Promise<void>
	updateSliceMetadata(changeId: string, sliceId: string, patch: SliceMetadataPatch): Promise<void>
}
