import type { TurnIn } from './verdict.ts'

/**
 * Outcome of a single per-slice phase invocation (one `prepare<Role>` + Turn + `land<Role>`).
 *
 * - `'done'` — slice has reached terminal state in this run; loop drops it.
 * - `'progress'` — phase moved forward; loop refetches and continues the inner step-cap loop.
 * - `'partial'` — agent reported partial / coerced from invalid verdict; loop stops here for this run.
 * - `'no-work'` — agent reported nothing to do; loop drops it (slice mutation already applied).
 */
export type PhaseOutcome = 'done' | 'progress' | 'partial' | 'no-work' | 'skipped'

/**
 * Returned by `prepare<Role>` — the branch the Turn should run on, and the `TurnIn` payload.
 */
export type PreparedPhase = {
	branch: string
	turnIn: TurnIn
}

/**
 * Loop dispatch state for one slice. Computed by `classify` in `src/work/classify.ts`.
 *
 * - `'done'` — slice has nothing more for the loop to do (done, draft, in-flight, or awaiting-review). The loop skips it.
 * - `'blocked'` — at least one unfinished blocker exists. Loop skips; will reconsider once a blocker closes.
 * - `'finalize'` — record `closedAt` for a landed Slice.
 * - `'implement'` — run the Implementer Turn next.
 * - `'audit'` — run the Auditor Turn next for an implemented distinct Slice branch.
 * - `'integrate'` — host-integrate an implemented/audited Slice.
 * - `'review'` — run the Reviewer Turn next for PR review feedback on a `needs-revision` Slice.
 */
export type ResumeState = 'done' | 'blocked' | 'finalize' | 'implement' | 'audit' | 'integrate' | 'review'

export type ClassifySliceConfig = { pr: boolean; audit: boolean; perSliceBranches: boolean }

/**
 * Per-loop-invocation context passed to phase methods that need to act against a specific Change's
 * Change branch. Same shape across all phase methods so the call sites stay uniform.
 */
export type PhaseCtx = {
	changeId: string
	changeBranch: string
	config: ClassifySliceConfig
}
