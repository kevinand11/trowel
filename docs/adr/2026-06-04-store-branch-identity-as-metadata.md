# Store branch identity as durable metadata

Trowel stores branch identity as durable entity metadata instead of recomputing it from mutable titles or naming conventions. A Change records required `targetBranch` and `changeBranch` fields, and every Slice records a required `sliceBranch` field; issue storage writes these values into the existing hidden `<!-- trowel:{...} -->` issue-body JSON object, while file storage writes them into its JSON records. Because Change and Slice ids are allocated by storage creation, orchestration computes branch names after creation, creates and pushes the branch, then writes branch metadata through explicit metadata updates. New Change branch names use `${changeId}-${changeSlug}` and new per-Slice branch names use `${changeId}/${sliceId}-${sliceSlug}`; when per-slice branches are disabled, the Slice's `sliceBranch` is the parent Change branch.

The canonical term for the Change-level working branch is **Change branch**, replacing **Integration branch**, so internal fields and user-facing output use `changeBranch` / "Change branch" consistently. Storage reads are strict after this schema change: missing branch metadata is an error rather than falling back to GitHub-linked PRs or recomputing from the current title, because fallback paths would preserve the original ambiguity this decision removes.

## Considered Options

- **Continue recomputing branch names from ids and titles.** Rejected because title edits and historical naming-pattern changes can make closed shipped Changes appear aborted when merge proof looks for the wrong branch.
- **Read metadata first, then fall back to GitHub-linked PRs or naming conventions.** Rejected because normal reads would still depend on heuristic branch identity and keep legacy ambiguity in the model.
- **Keep the term Integration branch.** Rejected in favor of **Change branch**, matching the stored `changeBranch` field and pairing naturally with **Slice branch**.

## Consequences

- Legacy issue/file data must be repaired before using branch-metadata-aware code.
- `createChange` returns `{ id, title }`; orchestration creates the remote Change branch, then calls `updateChangeMetadata(changeId, { targetBranch, changeBranch })`.
- `createSlice` returns `{ id, title }`; orchestration creates the remote Slice branch when per-slice branches are enabled, then calls `updateSliceMetadata(changeId, sliceId, { sliceBranch })`.
- Metadata update failure is loud and does not roll back the already-created entity or branch.
- `ChangeRecord.branch` and `ChangeSummary.branch` are renamed to `changeBranch`; `ChangeRecord.targetBranch` becomes required.
- `Slice` gains required `sliceBranch` metadata. When per-slice branches are disabled, the Slice's `sliceBranch` value is the parent Change branch.
- Phase code uses `slice.sliceBranch` as the Turn branch and `change.changeBranch` as the Slice PR base / host-merge target; `PhaseCtx.integrationBranch` is renamed to `changeBranch`.
- The work scheduler uses stored `sliceBranch` values as the concurrency boundary: no two Slices with the same Slice branch run Turns in parallel.
- Cleanup and abort PR cleanup use exact stored branch metadata rather than branch-prefix scans.
- User-facing output, guidance, cleanup messages, and docs say "Change branch" rather than "Integration branch".
