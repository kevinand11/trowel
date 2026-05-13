# Agent review is opt-in; `work.review` defaults to false; independent of `work.usePrs`

`config.work.review: boolean` (default `false`) gates the **Reviewer** and **Addresser** sandboxes inside the **AFK loop**. PR creation remains controlled by `config.work.usePrs` (default `true`, see ADR `optional-pr-flow-on-issue-backend`). The two knobs are independent — they control different things and the user can set them in any combination.

The behavior matrix on the issue backend:

| `usePrs` | `review` | Issue-backend behavior |
|---|---|---|
| `false` | (ignored) | Slice branches merged `--no-ff` into the **Integration branch** by the host; no PR, no reviewer, no addresser. (File backend behaves this way regardless of either knob.) |
| `true` | `false` | Implementer runs, draft PR is opened, slice's loop work stops there. The PR awaits a human reviewer (or external CI) to mark it ready. `classifySlice` returns `'done'` for any slice with `prState: 'draft'` when `review: false`. |
| `true` | `true` | Full four-state machine: implementer → reviewer → addresser → `gh pr ready`. |

The default flips from "agent reviewer on" (the prior implicit behavior, before the knob existed) to "agent reviewer off" because:

- The **Implementer** is the productive part of the AFK loop. The reviewer/addresser cycle is bureaucracy that pays off only when the user trusts a human-quality second pass and is willing to spend agent turns on it. In practice, the agent reviewer is the role most likely to fire spuriously and consume turns without changing the slice's substantive state.
- A draft PR is itself a review surface. The user (or a CI pipeline, or a human reviewer) can review it without an agent reviewer involved. "Open the PR, then stop" is the most-common useful behavior — the agent has done its part and the human takes over.
- Existing projects that want the agent reviewer set `review: true` explicitly in their `.trowel/config.json`. The opt-in is a one-line change for users who want the prior behavior.

## Considered options

- **Make `review` the only knob; collapse `usePrs` into it (a single `pr` or `reviewMode` knob with values `'none' | 'pr-only' | 'pr-and-agent-review'`).** Rejected: PR creation and agent review are independently valuable. A user can want "draft PR per slice, no agent reviewer" (the new default), "no PR at all, no reviewer" (`usePrs: false`), or "full agent review pipeline" (`usePrs: true, review: true`). A single enum forces a tri-state and obscures the fact that PR creation is a structural choice (where do slice commits land?) while review is a workflow choice (does an agent inspect them?). Two booleans map to two questions; one enum doesn't.
- **Default `review: true`, preserve current behavior.** Rejected: the current behavior was set when the AFK loop was the only execution mode for the issue backend; experience now shows the agent reviewer is the part most likely to fire spuriously. Default-off matches expected usage; users who want the agent reviewer are exactly the audience willing to flip a config knob.
- **Per-PRD `review` flag on `PrdSpec`, rather than config.** Rejected: same reasoning as `usePrs` in its prior ADR — review mode is a project-wide preference, not a per-feature one. Setting the same flag on every PRD spec would be ceremony.
- **Per-slice `review` flag.** Rejected: mixing reviewed and unreviewed slices inside one PRD produces a confusing audit trail (some slices have agent-review history, others don't) with no upside.
- **`review` as a verbosity-style enum (`'off' | 'lint' | 'full'`).** Rejected: speculative. The current reviewer prompt is one thing; if a "lint-only" reviewer becomes a real need, it can be added as a third value later without breaking the boolean.

## Consequences

- `partialConfigPipe()` and `Config` in `src/schema.ts` gain `work.review: boolean`.
- `defaultConfig.work.review = false`.
- The issue backend's `classifySlice` short-circuits to `'done'` when `prState === 'draft' && !config.review`, instead of returning `'review'`. The same slice with `review: true` still routes to `'review'`.
- `trowel review` and `trowel address` ignore `config.work.review` — they are explicit role overrides; the user opted in by typing the command. They still fail on the file backend (the backend method throws; the command surfaces the error).
- The CONTEXT entry for `Implementer / Reviewer / Addresser` is updated to reflect the new gating condition (`usePrs && review` both required).
- ADR `optional-pr-flow-on-issue-backend`'s description of the post-implementer handoff is unchanged; this ADR adds a second branch point downstream of "draft PR was opened" — does an agent reviewer fire, or does the loop stop?
