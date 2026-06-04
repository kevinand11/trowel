# Computed states and cleanup-owned housekeeping

Trowel will retire the public and internal **Bucket** concept and use lowercase computed **state** for both Changes and Slices. Slice state is computed from raw `closedAt`, `readyForAgent`, revision, blocker, and PR signals with priority `done → landed → needs-revision → in-flight → blocked → open → draft`; Change state is computed from raw `closedAt`, Slice states, Close-out PR state, and branch merge status with priority `done → landed → aborted → in-flight → ready → open`.

The shared transient state is **`landed`**: repository merge has happened but the trowel record has not been finalized. The Slice work loop finalizes landed Slices by setting `closedAt` in file storage or closing the GitHub Slice issue; `change ship` finalizes landed Changes. `done` means merged and finalized; `aborted` means `closedAt` is set without the repository merge fact.

Cleanup belongs only to explicit Change-level `ship` and `abort`, never to `work` or Slice-level commands. Cleanup removes all trowel-managed worktrees and, when safe and allowed by policy, local Integration/Slice branches only; it never deletes remote branches or logs, skips and reports local branches that contain commits not present on their remote counterpart, and asks once for the full branch set under `prompt` policy.

## Considered Options

- **Keep `Bucket` separate from stored `state`.** Rejected because users and future implementers read both as lifecycle state, creating avoidable ambiguity.
- **Store the full state enum directly.** Rejected because `blocked`, `in-flight`, `landed`, and readiness-derived states can drift from blockers, PRs, and branch/PR facts.
- **Persist explicit Change terminal reasons.** Rejected in favor of deriving `aborted` from `closedAt` plus the absence of repository merge; shipped/done is a repository fact, while aborted is the remaining closed-not-merged case.
- **Treat a missing remote Integration branch as done.** Rejected because GitHub may auto-delete after merge, but users may also manually delete branches. A missing branch proves done only when a merged Close-out PR exists.
- **Let `work` clean branches after slice completion.** Rejected because cleanup is a user-intent boundary owned by explicit `ship` and `abort`.
- **Keep Slice abort.** Rejected for now; terminal lifecycle commands are Change-level only.

## Consequences

- File storage may hard-break old local lifecycle JSON; no backward compatibility is required.
- GitHub issue storage reads terminal timestamps from issue close metadata and derives user-visible state rather than storing a separate state enum.
- Change list has no state filter; it lists all Changes newest-first by `createdAt` with their computed state.
- Work reports non-open Change states and never cleans up. It may finalize landed Slices because finalization is storage bookkeeping, not cleanup.
- Ship refuses `open` and `aborted` Changes, finalizes `landed` Changes, cleans already `done` Changes, and handles `in-flight` Changes through the existing Close-out PR.
- Abort handles `open`, `ready`, `in-flight`, and already `aborted` Changes; it refuses `landed` and `done` Changes.
- Aborting an in-flight Change requires exact-id confirmation and closes open Close-out/Slice PRs without merging, using `abort.comment` when configured.
