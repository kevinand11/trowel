import type { GhOps } from '../utils/gh-ops.ts'
import type { GitOps } from '../utils/git-ops.ts'
import type { TurnIn } from '../work/verdict.ts'

export type { GitOps }

export type ChangeSpec = {
	title: string
	body: string
	targetBranch?: string
}

export type SliceSpec = {
	title: string
	body: string
	blockedBy: string[]
}

export type ChangeSummary = {
	id: string
	title: string
	changeBranch: string
	/**
	 * ISO 8601 creation timestamp. Issue storage uses the underlying GitHub issue's `createdAt`;
	 * file storage uses the Change's `store.json:createdAt`. Consumers sort by this (e.g. `trowel
	 * list` shows newest first); storages return unsorted.
	 */
	createdAt: string
}

export type RawChangeState = 'OPEN' | 'CLOSED'
export type ChangeState = 'open' | 'ready' | 'in-flight' | 'landed' | 'done' | 'aborted'

export type ChangeRecord = {
	id: string
	changeBranch: string
	targetBranch: string
	title: string
	/** Legacy raw issue/storage lifecycle, retained for command paths that have not moved to closedAt yet. */
	state: RawChangeState
	/** Raw terminal timestamp. `null` means the Change has not been finalized/aborted. */
	closedAt?: string | null
}

/**
 * The state of the slice's PR on the Change branch.
 *
 * - `'draft'`: an open draft PR exists (the reviewer phase fires).
 * - `'ready'`: an open non-draft PR exists, awaiting merge.
 * - `'merged'`: the PR is merged; the computed Slice state is `landed` until Finalization sets `closedAt`.
 * - `null`: no PR exists, or the storage has no PR concept (file storage always emits `null`).
 *
 * Populated by PR-state enrichment after storage reads raw Slice records.
 */
export type SlicePrState = 'draft' | 'ready' | 'merged' | null
export type SliceState = 'draft' | 'open' | 'blocked' | 'in-flight' | 'implemented' | 'audited' | 'needs-revision' | 'landed' | 'done'

export type Slice = {
	id: string
	title: string
	body: string
	/** Computed lowercase lifecycle state. */
	state: SliceState
	/** Raw terminal timestamp. `null` means the Slice has not been finalized. */
	closedAt: string | null
	/** Implementer success milestone. `null` means the Implementer has not declared ready. */
	implementedAt: string | null
	/** Auditor success milestone. `null` means Auditing has not passed. */
	auditedAt: string | null
	readyForAgent: boolean
	needsRevision: boolean
	/** Ids of slices that block this one. See ADR `storage-native-blocker-storage`. */
	blockedBy: string[]
	/** Stored branch this Slice's Turns run on. Null until first implementation preparation assigns it. */
	sliceBranch: string | null
	/** Current PR pipeline state for this slice, or null when no PR / no PR concept. Always null on the file storage. */
	prState: SlicePrState
}

export type ClassifiedSlice = Slice

export type SlicePatch = Partial<Pick<Slice, 'readyForAgent' | 'needsRevision' | 'closedAt' | 'implementedAt' | 'auditedAt' | 'blockedBy'>>
export type CreatedChange = Pick<ChangeRecord, 'id' | 'title'>
export type CreatedSlice = Pick<Slice, 'id' | 'title'>
export type ChangeMetadataPatch = Partial<Pick<ChangeRecord, 'targetBranch' | 'changeBranch'>>
export type SliceMetadataPatch = Partial<Pick<Slice, 'sliceBranch'>>

export type DeleteBranchPolicy = 'always' | 'never' | 'prompt'
export type ShipMergeMethod = 'merge' | 'squash' | 'rebase'

/**
 * Outcome of a single per-slice phase invocation (one `prepare<Role>` + sandbox + `land<Role>`).
 *
 * - `'done'` — slice has reached terminal state in this run; loop drops it.
 * - `'progress'` — phase moved forward; loop refetches and continues the inner step-cap loop.
 * - `'partial'` — agent reported partial / coerced from invalid verdict; loop stops here for this run.
 * - `'no-work'` — agent reported nothing to do; loop drops it (slice mutation already applied).
 */
export type PhaseOutcome = 'done' | 'progress' | 'partial' | 'no-work'

/**
 * Returned by `prepare<Role>` — the branch the sandbox should run on, and the `TurnIn` payload.
 */
export type PreparedPhase = {
	branch: string
	turnIn: TurnIn
}

/**
 * Loop dispatch state for one slice. Computed by `classify` in `src/work/classify.ts`.
 *
 * - `'done'` — slice has nothing more for the loop to do (done, draft, or PR ready). The loop skips it.
 * - `'blocked'` — at least one unfinished blocker exists. Loop skips; will reconsider once a blocker closes.
 * - `'finalize'` — record `closedAt` for a landed Slice.
 * - `'implement'` — run the Implementer Turn next.
 * - `'audit'` — run the Auditor Turn next for an implemented distinct Slice branch.
 * - `'integrate'` — host-integrate an implemented/audited Slice.
 * - `'review'` — legacy draft-PR reviewer path.
 * - `'address'` — run the addresser sandbox next for PR review feedback.
 */
export type ResumeState = 'done' | 'blocked' | 'finalize' | 'implement' | 'audit' | 'integrate' | 'review' | 'address'

export type ClassifySliceConfig = { usePrs: boolean; audit: boolean; perSliceBranches: boolean }

/**
 * Per-loop-invocation context passed to storage methods that need to act against a specific Change's
 * Change branch. Same shape across all phase methods so the call sites stay uniform.
 */
export type PhaseCtx = {
	changeId: string
	changeBranch: string
	config: ClassifySliceConfig
}

export type StorageDeps = {
	gh: GhOps
	repoRoot: string
	projectRoot: string
	changesDir: string
	labels: { change: string; readyForAgent: string; needsRevision: string }
	abortOptions: { comment: string | null; deleteBranch: DeleteBranchPolicy }
	/**
	 * Optional runtime channels. Read-only call paths (status, list) construct a storage
	 * without these wired; phase methods and `Storage.close` (which prompts) throw at
	 * the top if invoked without their channel. See ADR `unified-gitops-via-module-factory`.
	 */
	confirm?: (msg: string) => Promise<boolean>
	git: GitOps
	log?: (msg: string) => void
}

export type StorageFactory = (deps: StorageDeps) => Storage

export interface Storage {
	// Change lifecycle
	createChange(spec: ChangeSpec): Promise<CreatedChange>
	findChange(id: string): Promise<ChangeRecord | null>
	listChanges(opts: { state: 'open' | 'closed' | 'all' }): Promise<ChangeSummary[]>
	closeChange(id: string): Promise<void>
	updateChangeMetadata(changeId: string, patch: ChangeMetadataPatch): Promise<void>

	// Slice lifecycle
	createSlice(changeId: string, spec: SliceSpec): Promise<CreatedSlice>
	findSlices(changeId: string): Promise<Slice[]>
	/**
	 * Look up a slice by its global id without knowing the parent Change. Returns the slice plus its
	 * parent Change id, or null if no slice with that id exists. Powers `trowel status slice <id>`
	 * and the slice phase commands (`slice implement`/`slice address`/`slice review`).
	 */
	findSlice(sliceId: string): Promise<{ changeId: string; slice: Slice } | null>
	updateSlice(changeId: string, sliceId: string, patch: SlicePatch): Promise<void>
	updateSliceMetadata(changeId: string, sliceId: string, patch: SliceMetadataPatch): Promise<void>
}
