import type { Bucket } from '../utils/bucket.ts'
import type { GhRunner } from '../utils/gh-runner.ts'
import type { SandboxIn, SandboxOut } from '../work/verdict.ts'

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

/**
 * Persistent git operations the backend can call. Wired once at construction in `BackendDeps`.
 */
export type GitOps = {
	fetch: (branch: string) => Promise<void>
	push: (branch: string) => Promise<void>
	checkout: (branch: string) => Promise<void>
	mergeNoFf: (branch: string) => Promise<void>
	deleteRemoteBranch: (branch: string) => Promise<void>
	createRemoteBranch: (newBranch: string, baseBranch: string) => Promise<void>
}

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
 * Returned by `prepare<Role>` — the branch the sandbox should run on, and the `SandboxIn` payload.
 */
export type PreparedPhase = {
	branch: string
	sandboxIn: SandboxIn
}

/**
 * Loop dispatch state for one slice. Computed by `Backend.classifySlice`.
 *
 * - `'done'` — slice has nothing more for the loop to do (closed, !readyForAgent, PR merged/ready,
 *   or PR draft with `config.review: false`). The loop skips it.
 * - `'blocked'` — at least one unfinished blocker exists. Loop skips; will reconsider once a blocker closes.
 * - `'implement'` — run the implementer sandbox next.
 * - `'review'` — run the reviewer sandbox next (issue backend only; only reachable with `usePrs && review`).
 * - `'address'` — run the addresser sandbox next (issue backend only; only reachable with `usePrs && review`).
 *
 * The `'create-pr-then-review'` recovery state from the prior loop design is gone — that path now lives
 * inside `reconcileSlices`, which heals branch-ahead-no-PR drift before each iteration's `findSlices`.
 */
export type ResumeState = 'done' | 'blocked' | 'implement' | 'review' | 'address'

export type ClassifySliceConfig = { usePrs: boolean; review: boolean }

/**
 * Per-loop-invocation context passed to backend methods that need to act against a specific PRD's
 * integration branch. Same shape across all phase methods so the call sites stay uniform.
 */
export type PhaseCtx = {
	prdId: string
	integrationBranch: string
	config: ClassifySliceConfig
}

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
	git: GitOps
	log: (msg: string) => void
	// Optional override for id generation (file backend). Default: imported generateId.
	generateId?: () => string
}

export type BackendFactory = (deps: BackendDeps) => Backend

export interface Backend {
	readonly name: string
	readonly defaultBranchPrefix: string
	/**
	 * Declarative concurrency cap. The loop uses `min(config.sandbox.maxConcurrent, backend.maxConcurrent ?? Infinity)`.
	 * `null` = unbounded (user config wins). File backend declares 1 because its implementer commits
	 * land directly on the integration branch (no slice branches); parallel implementers would race.
	 */
	readonly maxConcurrent: number | null

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

	/**
	 * Decide what the loop should do next for this slice. Pure: reads slice fields and config flags only.
	 * The file backend's classifier never returns `'review'` or `'address'` (no PR concept).
	 */
	classifySlice(slice: Slice, config: ClassifySliceConfig): ResumeState

	/**
	 * Heal cross-process drift on each outer-loop iteration. The issue backend opens draft PRs for any
	 * slice with `branchAhead && !prState` (a prior run died after pushing but before `gh pr create`).
	 * The file backend implements this as a no-op — reconciliation isn't a missing capability, it just
	 * has nothing to reconcile.
	 *
	 * Contract: the loop calls `findSlices`, passes the result here, then re-calls `findSlices` to see
	 * post-reconcile state. Taking slices as input (rather than internally calling `findSlices`) keeps
	 * this method pure with respect to backend internals and trivially testable.
	 */
	reconcileSlices(slices: Slice[], ctx: PhaseCtx): Promise<void>

	/**
	 * Per-role phase primitives. The loop dispatches via `classifySlice`:
	 *   - For each phase the classifier emits, the loop calls `prepare<Role>` (which may create branches,
	 *     fetch PR data, build a `SandboxIn`), spawns the sandbox itself, then calls `land<Role>` with
	 *     the verdict to apply gh/git side effects.
	 *   - Methods unreachable on a given backend (e.g. `prepareReview` on file backend) throw.
	 *     The throw is a runtime invariant: `classifySlice` on that backend never returns the matching
	 *     state, so the loop never calls the method. Per-phase commands (`trowel review`) that bypass
	 *     `classifySlice` propagate the throw as a "not supported on this backend" error.
	 */
	prepareImplement(slice: Slice, ctx: PhaseCtx): Promise<PreparedPhase>
	landImplement(slice: Slice, verdict: SandboxOut, ctx: PhaseCtx): Promise<PhaseOutcome>

	prepareReview(slice: Slice, ctx: PhaseCtx): Promise<PreparedPhase>
	landReview(slice: Slice, verdict: SandboxOut, ctx: PhaseCtx): Promise<PhaseOutcome>

	prepareAddress(slice: Slice, ctx: PhaseCtx): Promise<PreparedPhase>
	landAddress(slice: Slice, verdict: SandboxOut, ctx: PhaseCtx): Promise<PhaseOutcome>
}
