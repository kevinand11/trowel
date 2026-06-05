# Trowel

Trowel is a personal CLI for coordinating Change-driven repository work across agent Turns. It tracks the intended work as Changes and Slices, runs agents in isolated worktrees, and leaves shipping or abandoning work to explicit user commands.

## Language

**Change**:
The user-visible unit of intended repository work, tracked with a working Change branch and one or more Slices; its lifecycle state is computed from raw `closedAt`, Slice states, branch merge status, and Close-out PR state.
_Avoid_: PRD, feature, project

**Slice**:
A vertical cut of a Change that can be implemented and reviewed independently; its lifecycle state is computed from `closedAt`, readiness, revision, blocker, and PR signals.
_Avoid_: Task, ticket, subtask

**Turn**:
One agent run for one role against one Slice in a trowel-managed worktree.
_Avoid_: Sandbox, job, run

**Agent harness**:
The CLI binary trowel invokes to run an agent Turn or interactive start session.
_Avoid_: Agent, provider, model

**Storage**:
The persistence backend that records Changes, Slices, blockers, and lifecycle flags.
_Avoid_: Backend, database

**Change branch**:
The Change-level working branch that receives completed Slice work before the Change is shipped.
_Avoid_: Integration branch, PRD branch

**Slice branch**:
The branch recorded on a Slice as its work branch, captured as intended branch metadata when the Slice is created and stored durably rather than recomputed from mutable fields; under `work.perSliceBranches: false` this value is the Change branch.
_Avoid_: Feature branch, task branch, computed branch

**Target branch**:
The branch a Change is intended to ship into, captured from the branch where the Change was created.
_Avoid_: Base branch, default branch, main

**Worktree**:
A trowel-managed git worktree under `.trowel/worktrees/` used as disposable Turn infrastructure.
_Avoid_: Checkout, sandbox directory

**Cleanup**:
The housekeeping step run by abort and ship that removes all trowel-managed worktrees and, when safe, removes a Change's local Change branch and local Slice branches without deleting remote branches or logs; non-interactive prompt policy skips branch deletion but still removes worktrees.
_Avoid_: Close-out, reconciliation, garbage collection

**Abort**:
The explicit top-level command path for abandoning a Change, closing any in-flight Close-out PR without merging, or housekeeping an already terminal Change, then running Cleanup.
_Avoid_: Close, cancel, delete, slice abort

**Ship**:
The explicit command path for shipping a Change to its Target branch and then running Cleanup.
_Avoid_: Close, merge, deploy

**Close-out**:
The success-path operation that merges or opens a shipping PR for a completed Change.
_Avoid_: Cleanup, abort, close

**Entity read command**:
A command that displays Change or Slice state without acquiring the Mutation lock, writing storage, or switching the main working tree branch.
_Avoid_: Refresh, reconcile, sync

**Mutation lock**:
The project-wide advisory lock at `.trowel/lock` that serializes state-mutating Change and Slice commands.
_Avoid_: Read lock, status lock, Git lock

**Finalization**:
The storage write that records landed repository work as done by setting `closedAt`.
_Avoid_: Reconciliation, status refresh, read repair

**Slice state**:
A lowercase computed Slice lifecycle classification with values `draft`, `open`, `blocked`, `in-flight`, `needs-revision`, `landed`, and `done`, evaluated as `done → landed → needs-revision → in-flight → blocked → open → draft`, where `landed` means the Slice has merged into the Change branch but has not been finalized, and `done` means finalization has set `closedAt`.
_Avoid_: Bucket, ready, raw state, status, uppercase lifecycle enums

**Change state**:
A lowercase computed Change lifecycle classification with values `open`, `ready`, `in-flight`, `landed`, `done`, and `aborted`, evaluated as `done → landed → aborted → in-flight → ready → open`, where `ready` requires all Slices to be done, `in-flight` means the Close-out PR is open, `landed` means the Change has merged to the Target branch but has not been finalized, `done` means finalization has set `closedAt` after merge, and `aborted` means `closedAt` is set without merge.
_Avoid_: Bucket, raw state, status, closed reason, uppercase lifecycle enums

## Relationships

- A **Change** has one stored **Change branch** and one or more **Slices** across all storages; because the Change id is allocated by storage creation, orchestration creates and pushes the Change branch before writing branch metadata through an explicit metadata update; new Change branch names use `${changeId}-${changeSlug}`.
- For issue storage, branch metadata is stored in one existing hidden issue-body comment per issue as a JSON object with entity-specific keys (`targetBranch`, `changeBranch`, `sliceBranch`); after the branch-metadata change lands, storage reads require this metadata and do not fall back to Development-linked PR history or naming conventions.
- All storages require `targetBranch` and `changeBranch` on Change records and `sliceBranch` on Slice records after the branch-metadata schema change lands.
- Storage exposes generic metadata update methods such as `updateChangeMetadata(changeId, { targetBranch, changeBranch })` and `updateSliceMetadata(changeId, sliceId, { sliceBranch })`; branch metadata is written only after the named branch exists remotely, except when a Slice records the parent Change branch under `work.perSliceBranches: false`.
- A **Change state** is computed rather than stored directly; repository merge is proven by a merged Close-out PR, or by the remote Change branch not being ahead of the Target branch, or by local fallback when the remote is missing; a missing branch only proves merge when a merged Close-out PR exists.
- `landed` is the shared transient state for merged-but-not-finalized Slices and Changes.
- Slice finalization runs in the work loop when it encounters a landed Slice; after finalization the loop refetches and may report the parent Change as ready in the same invocation. Status/list may report `landed` but do not finalize Slices.
- Only **Ship** runs **Finalization** for a landed **Change** after a merged Close-out PR; **Entity read commands** may report `landed` but never finalize.
- **Entity read commands** are `trowel change list`, `trowel change status <change-id>`, and `trowel slice status <slice-id>`; they do not acquire the **Mutation lock**, create/delete branches, or switch the main working tree branch.
- `done` means merged and finalized with `closedAt`; `aborted` means `closedAt` is set without merge.
- A **Slice** has one stored **Slice branch** value for the branch its Turns run on across all storages; because the Slice id is allocated by storage creation, orchestration creates and pushes the Slice branch before writing branch metadata when per-slice branches are enabled, or writes the parent Change branch as metadata when per-slice branches are disabled.
- When per-slice branches are enabled the Slice branch value is a per-Slice branch named `${changeId}/${sliceId}-${sliceSlug}`, and when per-slice branches are disabled the value is the parent Change's Change branch.
- The work scheduler treats Slice branch values as the concurrency boundary: no two Slices with the same stored Slice branch may run Turns in parallel.
- A **Slice state** is computed from Slice metadata and external PR/blocker relationships rather than stored directly; Slice `open` is the old ready-for-agent bucket renamed, while `readyForAgent` remains the raw opt-in signal.
- User-facing output and internal domain types use **state** for Change and Slice lifecycle classifications; the word "bucket" is retired from the codebase.
- Internal Change types use `changeBranch`, not ambiguous `branch`, for the stored **Change branch** field.
- Change list has no state filter; it lists all Changes newest-first by `createdAt`, with each Change's computed state.
- Change status shows the computed Change state, Target branch, Change branch, state-based guidance, and every Slice with its computed Slice state.
- A Slice's terminal raw storage field is `closedAt: string | null`, not `state: OPEN | CLOSED`; Slice finalization sets it once the Slice has landed.
- A Change's terminal raw storage field is also `closedAt: string | null`, not `state: OPEN | CLOSED`; file storage writes it when trowel observes ship completion or abort, while GitHub storage reads the issue's close timestamp.
- File-storage lifecycle schema changes do not need backward compatibility with old local Change/Slice JSON.
- A **Turn** runs in one **Worktree** checked out to the Slice's stored **Slice branch**; under `work.perSliceBranches: false`, that stored Slice branch is the parent **Change branch**.
- **Ship** invokes **Close-out** for a ready Change, finalizes a landed Change by setting `closedAt`, then runs **Cleanup**; if the Change is done, Ship only runs Cleanup; if the Change is open or aborted, Ship refuses without Cleanup.
- **Abort** marks an `open` or `ready` Change abandoned, closes any open Slice PRs without merging, then runs **Cleanup**; if the Change is `in-flight`, Abort requires exact-id confirmation, closes the Close-out PR without merging, marks the Change closed, then runs Cleanup; if the Change is `aborted`, Abort runs Cleanup only; if the Change is `landed` or `done`, Abort refuses and tells the user to run Ship.
- **Abort** uses `abort.comment` when closing GitHub issues, Slice PRs, and in-flight Close-out PRs; if the comment is `null`, it closes silently.
- **Ship** and **Abort** are Change-level operations only; individual Slices are not shipped or aborted directly, and there is no Slice abort command.
- Slice phase commands remain as execution overrides: implement, review, and address are not terminal lifecycle commands.
- **Work** never runs Cleanup or Change-level Finalization; when a Change state is `ready`, `in-flight`, `landed`, `done`, or `aborted`, Work reports the state and exits.
- **Cleanup** considers the Change's **Change branch** and all stored **Slice branches**, removes all trowel-managed Worktrees, and never removes remote branches.
- When a Change is `in-flight`, **Ship** may run worktree-only Cleanup while keeping local branches until the Close-out PR is merged.
- Under a `prompt` branch deletion policy, **Cleanup** asks once for the full local branch set; without an interactive terminal, it skips local branch deletion but still removes Worktrees.
- `abort.deleteBranch` and `ship.deleteBranch` remain separate policies, both governing local branch deletion only.
- `work.perSliceBranches` controls Slice branch metadata for new Slices only; runtime Turn placement and concurrency use stored Slice branch values, while `work.usePrs` remains a current runtime workflow choice rather than stored Slice metadata.
- **Cleanup** skips and reports any local branch with commits that are not present on its remote counterpart.

## Example dialogue

> **Dev:** "When `trowel change status` sees that the **Close-out** PR was merged, should it finalize the **Change** or switch branches to inspect it?"
> **Domain expert:** "No. `status` is an **Entity read command**: it may report the **Change state** as `landed`, but only **Ship** runs **Finalization** for the **Change** and then runs **Cleanup**."

## Flagged ambiguities

- "Cleanup" was used broadly; resolved: it means local housekeeping for the Change branch, all Slice branches, and all trowel-managed Worktrees, and explicitly excludes remote branch deletion.
- "Done or aborted" conflicts with the old stored `OPEN | CLOSED` state; resolved: Change state is computed, with `aborted` derived as `closedAt && !done` rather than stored as an explicit reason.
- A Slice-level abort surface was considered and rejected for now; resolved: only top-level Changes can be shipped or aborted.
