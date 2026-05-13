import type { Bucket } from '../utils/bucket.ts'
import type { GhRunner } from '../utils/gh-runner.ts'
import type { GitOps } from '../utils/git-ops.ts'
import type { SandboxIn } from '../work/verdict.ts'

export type { GitOps }

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
	/**
	 * ISO 8601 creation timestamp. Issue storage uses the underlying GitHub issue's `createdAt`;
	 * file storage uses the PRD's `store.json:createdAt`. Consumers sort by this (e.g. `trowel
	 * list` shows newest first); storages return unsorted.
	 */
	createdAt: string
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
 * - `null`: no PR exists, or the storage has no PR concept (file storage always emits `null`).
 *
 * Populated by `findSlices`. See ADR `afk-loop-asymmetric-across-storages`.
 */
export type SlicePrState = 'draft' | 'ready' | 'merged' | null

export type Slice = {
	id: string
	title: string
	body: string
	state: 'OPEN' | 'CLOSED'
	readyForAgent: boolean
	needsRevision: boolean
	/** Ids of slices that block this one. See ADR `storage-native-blocker-storage`. */
	blockedBy: string[]
	/** Current PR pipeline state for this slice, or null when no PR / no PR concept. Always null on the file storage. */
	prState: SlicePrState
	/** True when the slice's local branch is ahead of the integration branch with no PR open (a self-heal case). Always false on the file storage. */
	branchAhead: boolean
}

/**
 * A `Slice` enriched with the loop-computed lifecycle bucket. Storages return raw `Slice`s;
 * consumers that need bucket (status, list, loop classifier) call `classifySlices` from
 * `src/utils/bucket.ts` to enrich.
 */
export type ClassifiedSlice = Slice & { bucket: Bucket }

export type SlicePatch = Partial<Pick<Slice, 'readyForAgent' | 'needsRevision' | 'state' | 'blockedBy'>>

export type DeleteBranchPolicy = 'always' | 'never' | 'prompt'

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
 * Loop dispatch state for one slice. Computed by `classify` in `src/work/classify.ts`.
 *
 * - `'done'` — slice has nothing more for the loop to do (closed, !readyForAgent, PR merged/ready,
 *   or PR draft with `config.review: false`). The loop skips it.
 * - `'blocked'` — at least one unfinished blocker exists. Loop skips; will reconsider once a blocker closes.
 * - `'implement'` — run the implementer sandbox next.
 * - `'review'` — run the reviewer sandbox next (issue storage only; only reachable with `usePrs && review`).
 * - `'address'` — run the addresser sandbox next (issue storage only; only reachable with `usePrs && review`).
 *
 * The `'create-pr-then-review'` recovery state from the prior loop design is gone — that path now lives
 * inside `reconcileSlices` (`src/work/reconcile.ts`), which heals branch-ahead-no-PR drift before each
 * iteration's `findSlices`.
 */
export type ResumeState = 'done' | 'blocked' | 'implement' | 'review' | 'address'

export type ClassifySliceConfig = { usePrs: boolean; review: boolean }

/**
 * Per-loop-invocation context passed to storage methods that need to act against a specific PRD's
 * integration branch. Same shape across all phase methods so the call sites stay uniform.
 */
export type PhaseCtx = {
	prdId: string
	integrationBranch: string
	config: ClassifySliceConfig
}

export type StorageDeps = {
	gh: GhRunner
	repoRoot: string
	projectRoot: string
	baseBranch: string
	branchPrefix: string | null
	prdsDir: string
	labels: { prd: string; readyForAgent: string; needsRevision: string }
	closeOptions: { comment: string | null; deleteBranch: DeleteBranchPolicy }
	/**
	 * Optional runtime channels. Read-only call paths (status, list) construct a storage
	 * without these wired; phase methods and `Storage.close` (which prompts) throw at
	 * the top if invoked without their channel. See ADR `unified-gitops-via-module-factory`.
	 */
	confirm?: (msg: string) => Promise<boolean>
	git?: GitOps
	log?: (msg: string) => void
	// Optional override for id generation (file storage). Default: imported generateId.
	generateId?: () => string
}

export type StorageFactory = (deps: StorageDeps) => Storage

export interface Storage {
	readonly name: string
	readonly defaultBranchPrefix: string
	/**
	 * Declarative concurrency cap. The loop uses `min(config.sandbox.maxConcurrent, storage.maxConcurrent ?? Infinity)`.
	 * `null` = unbounded (user config wins). File storage declares 1 because its implementer commits
	 * land directly on the integration branch (no slice branches); parallel implementers would race.
	 */
	readonly maxConcurrent: number | null

	/**
	 * Declarative capabilities a storage exposes to the loop and to config validation.
	 *
	 * - `prFlow` — the storage participates in a PR-based lifecycle (slice branches, draft PRs,
	 *   reviewer/addresser roles). File storage: `false`. Issue storage: `true`.
	 *   The loop's phase dispatch and `reconcileSlices` are no-ops on `prFlow: false` storages.
	 *   Config validation (step 4) will reject `config.work.usePrs: true` against a non-`prFlow` storage.
	 */
	readonly capabilities: { prFlow: boolean }

	// PRD lifecycle
	createPrd(spec: PrdSpec): Promise<{ id: string; branch: string }>
	branchForExisting(id: string): Promise<string>
	findPrd(id: string): Promise<PrdRecord | null>
	listPrds(opts: { state: 'open' | 'closed' | 'all' }): Promise<PrdSummary[]>
	closePrd(id: string): Promise<void>

	// Slice lifecycle
	createSlice(prdId: string, spec: SliceSpec): Promise<Slice>
	findSlices(prdId: string): Promise<Slice[]>
	updateSlice(prdId: string, sliceId: string, patch: SlicePatch): Promise<void>

}
