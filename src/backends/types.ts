import type { Bucket } from '../utils/bucket.ts'
import type { GhRunner } from '../utils/gh-runner.ts'

export type PrdSpec = {
	title: string
	body: string
}

export type SliceSpec = {
	title: string
	body: string
	blockedBy: string[]
}

export type PrdSummary = {
	id: string
	title: string
	branch: string
}

export type PrdState = 'OPEN' | 'CLOSED'

export type PrdRecord = {
	id: string
	branch: string
	title: string
	state: PrdState
}

/**
 * The state of the slice's PR on the integration branch.
 *
 * - `'draft'`: an open draft PR exists (the reviewer phase fires).
 * - `'ready'`: an open non-draft PR exists, awaiting merge.
 * - `'merged'`: the PR is merged (the slice's `state` should also be `'CLOSED'` in most cases).
 * - `null`: no PR exists, or the backend has no PR concept (file backend always emits `null`).
 *
 * Populated by `findSlices`. See ADR `afk-loop-asymmetric-across-backends`.
 */
export type SlicePrState = 'draft' | 'ready' | 'merged' | null

export type Slice = {
	id: string
	title: string
	body: string
	state: 'OPEN' | 'CLOSED'
	readyForAgent: boolean
	needsRevision: boolean
	/** Lifecycle bucket computed by the backend at findSlices time. See ADR `backend-owns-slice-bucket-classification`. */
	bucket: Bucket
	/** Ids of slices that block this one. See ADR `backend-native-blocker-storage`. */
	blockedBy: string[]
	/** Current PR pipeline state for this slice, or null when no PR / no PR concept. */
	prState: SlicePrState
	/** True when the slice's local branch is ahead of the integration branch with no PR open (a self-heal case). Always false on the file backend. */
	branchAhead: boolean
}

export type SlicePatch = Partial<Pick<Slice, 'readyForAgent' | 'needsRevision' | 'state' | 'blockedBy'>>

export type DeleteBranchPolicy = 'always' | 'never' | 'prompt'

export type BackendDeps = {
	gh: GhRunner
	repoRoot: string
	projectRoot: string
	baseBranch: string
	branchPrefix: string | null
	prdsDir: string
	docMsg: string
	labels: { prd: string; readyForAgent: string; needsRevision: string }
	closeOptions: { comment: string | null; deleteBranch: DeleteBranchPolicy }
	confirm: (msg: string) => Promise<boolean>
	// Optional override for id generation (file backend). Default: imported generateId.
	generateId?: () => string
}

export type BackendFactory = (deps: BackendDeps) => Backend

export interface Backend {
	readonly name: string
	readonly defaultBranchPrefix: string

	// PRD lifecycle
	createPrd(spec: PrdSpec): Promise<{ id: string; branch: string }>
	branchForExisting(id: string): Promise<string>
	findPrd(id: string): Promise<PrdRecord | null>
	listPrds(opts: { state: 'open' | 'closed' | 'all' }): Promise<PrdSummary[]>
	close(id: string): Promise<void>

	// Slice lifecycle
	createSlice(prdId: string, spec: SliceSpec): Promise<Slice>
	findSlices(prdId: string): Promise<Slice[]>
	updateSlice(prdId: string, sliceId: string, patch: SlicePatch): Promise<void>
}
