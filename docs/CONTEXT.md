# Trowel — Context

Trowel is a personal CLI that orchestrates Change-driven repository work — start, slice, and finish — across any git project. It is single-user, single-machine, not shareable; it installs once and runs against any git project.

## Language

### Change lifecycle

**Change**:
A user-visible unit of intended repository work, identified by a unique **Change id**. A Change contains one or more **Slices**, records a **Target branch**, and has a stored **Change branch** where Slice work accumulates before Close-out. The artifact type — directory of markdown/JSON files (`file` storage) or GitHub issue (`issue` storage) — is chosen per project via **Storage**. The Change lifecycle state is computed from raw `closedAt`, Slice states, branch merge status, and Close-out PR state.
_Avoid_: PRD, Fix, ticket, story.

**Change id**:
The canonical unique identifier for a **Change**. Form depends on **Storage**: GitHub issue number (`issue`) or a positive integer drawn from a project-wide pool shared with **Slice** ids (`file`). It is used by commands such as `trowel change status <id>` and `trowel change work <id>`.
_Avoid_: PRD id, slug, name.

**Change state**:
A lowercase computed Change lifecycle classification with values `open`, `ready`, `in-flight`, `landed`, `done`, and `aborted`. `landed` means the Change has merged to the Target branch but has not been finalized; `done` means Finalization has set `closedAt` after merge; `aborted` means `closedAt` is set without merge.
_Avoid_: Bucket, raw state, status, closed reason, uppercase lifecycle enums.

**Grill**:
The interactive questioning process used by `trowel start` to understand a user request and shape repository work before creating a **Change**. A Grill may inspect the codebase when needed, may conclude that an existing **Change** already covers the request, or may conclude that no repository work is needed. Existing-Change and No-Change are successful outcomes and exit 0.
_Avoid_: Intake, diagnose, interview.

**Storage**:
The strategy that decides how a **Change** is persisted, identified, listed, and linked to its **Slices**. One of `file`, `issue`. Storage is pure persistence: id format, Change/Slice CRUD, blocker linkage, slice flags, and stored branch metadata. AFK-loop behavior lives in the loop driver and is selected by **Flags**, not by storage choice.
_Avoid_: Backend, provider, adapter, driver.

**Flag**:
A user-configurable behavior toggle in `config.work.*`. Current flags:
- **`usePrs`**: opens one PR per Slice branch after implementation; requires `perSliceBranches: true`.
- **`review`**: runs Reviewer and Addresser phases; requires `usePrs: true`.
- **`perSliceBranches`**: each Slice gets its own stored **Slice branch** (`<changeId>/<sliceId>-<slug>` for new Slices). When false, each Slice stores the parent **Change branch** as its **Slice branch** and concurrency is one.
_Avoid_: Option, setting.

**Slice**:
One vertical cut of a **Change** — a discrete piece of work that can be implemented and reviewed independently. Slice ids are globally unique within a project: file storage draws them from the same integer pool as **Change ids**, and issue storage uses GitHub issue numbers. A Slice lifecycle state is computed from raw `closedAt`, readiness, revision, blocker, and PR signals.
_Avoid_: Sub-issue, task, ticket.

**Slice state**:
The canonical lifecycle classification of a **Slice**, computed from storage fields plus PR-state queries when `usePrs: true`. One of `done`, `landed`, `needs-revision`, `in-flight`, `blocked`, `open`, `draft`. Commands that display or gate behavior on Slice state use the same PR-enriched effective Slice state as the AFK loop. With `usePrs: true`, enrichment failures surface instead of falling back to raw storage state. `landed` means merged into the Change branch but not finalized; `done` means Finalization has set `closedAt`.
_Avoid_: Bucket, status, phase, stage.

**Blocker**:
A **Slice** referenced in another **Slice**'s `blockedBy` field. Slice X is blocked by Slice Y means Y must reach the `done` **Slice state** before X is unblocked.
_Avoid_: Dependency, parent.

**Target branch**:
The branch a **Change** will be completed back into. Captured from the current branch when `trowel start` materialises the Change. New records require stored Target branch metadata. Legacy issue-storage records without stored Target, Change, or Slice branch metadata must be repaired with `trowel repair branch-metadata --dry-run`, then `trowel repair branch-metadata --apply` after reviewing the patch plan.
_Avoid_: Base branch, BACK_TO branch, merge branch.

**Change branch**:
The branch that holds in-flight Change work. Slice commits are merged into it (or written directly when `perSliceBranches: false`) before Close-out ships it to the **Target branch**. New Change branches use `<changeId>-<slug>` and are stored durably as `changeBranch` metadata.
_Avoid_: Integration branch, feature branch.

**Close-out**:
The success-path operation that ships a closeable **Change**, invoked only by **Ship**. The **AFK loop** never runs Close-out. A Change becomes closeable when every **Slice** is in the `done` **Slice state** after effective state is applied. If `config.work.usePrs` is true, Close-out opens/marks-ready a PR from the Change branch to the Target branch; the Change may later appear `landed` until Ship runs Finalization. If false, Close-out host-merges the Change branch into the Target branch and runs Finalization immediately.
_Avoid_: Abort, Cleanup.

**Ship**:
The user command that invokes **Close-out** for an already-finished **Change**. `trowel change ship <id>` first requires a clean working tree, then holds the **Mutation lock** for the state-mutating operation. If the Change is `landed`, Ship runs Finalization by setting `closedAt`, then runs Cleanup. If the Change is already `done`, it exits successfully after Cleanup. Otherwise it fails if any **Slice** is not in the `done` **Slice state**, listing each non-terminal Slice id, Slice state, and title. Ship does not run the **AFK loop** or agent **Turns**. Shipping is the only path that invokes Change-level Close-out and Finalization. Ship behavior is storage-agnostic and works the same for `file` and `issue` Storage; flags/config decide git/PR behavior, not Storage kind. Merge-mode Ship host-merges through the reserved `__merge-change` Worktree rather than checking out the Target branch in the user's main checkout. Ship restores the **BACK_TO branch** after completion/failure when possible. If ship cleanup deletes the BACK_TO branch, deletion wins; ship leaves the user on the safe current branch and reports that BACK_TO was deleted. Ship cleanup may delete local branches according to ship config (`ship.deleteBranch: 'always' | 'prompt' | 'never'`, default `prompt`), but never deletes remote branches; under `always` or `prompt`, Ship refuses before Close-out/Cleanup if the current branch is a Cleanup deletion candidate, and under `never` it does not refuse. PR-mode merge uses `ship.mergeMethod: 'merge' | 'squash' | 'rebase'`, default `merge`; the first implementation has no ship-specific CLI override flags. Before PR-mode Close-out, ship fetches and checks whether the local **Change branch** is ahead of its remote counterpart; if ahead, interactive ship prompts to push with default yes, while non-interactive ship fails. If the remote counterpart is missing, interactive ship prompts to publish it with default yes; declining or running non-interactively fails because a Close-out PR requires a remote head branch. Non-interactive ship is not a primary workflow, but promptless contexts use deterministic safe defaults: required prompts fail, optional merge/delete prompts default to no. In PR mode, ship cleanup deletes the local **Change branch** only after `ship` successfully merges the Close-out PR; if the PR is only opened/readied, the local **Change branch** is kept. Shipping is Change-level; there is no Slice ship command until Slice-level shipping has a distinct domain meaning.
_Avoid_: Work, abort, slice ship.

**Abort**:
The manual abandon path. `trowel change abort <id>` operates only at the top-level Change lifecycle: it abandons open or ready Changes, requires exact-id confirmation for in-flight Changes, refuses landed or done Changes with Ship guidance, and cleans already aborted Changes. Abort cleanup may delete local branches according to abort config, but never deletes remote branches; under `always` or `prompt`, Abort refuses before closing records/Cleanup if the current branch is a Cleanup deletion candidate, and under `never` it does not refuse. There is no Slice abort command.
_Avoid_: Close (old command name), ship.

**Cleanup**:
The housekeeping step run by Abort and Ship that removes all trowel-managed Worktrees and, when safe, removes a Change's local Change branch and local Slice branches without deleting remote branches or logs. Non-interactive prompt policy skips branch deletion but still removes Worktrees.
_Avoid_: Close-out, reconciliation, garbage collection.

**Entity read command**:
A command that displays Change or Slice state without acquiring the **Mutation lock**, writing storage, or switching the main working tree branch. Entity read commands are `trowel change list`, `trowel change status <change-id>`, and `trowel slice status <slice-id>`.
_Avoid_: Refresh, reconcile, sync.

**Finalization**:
The storage write that records landed repository work as done by setting `closedAt`.
_Avoid_: Reconciliation, status refresh, read repair.

### Config discovery

**Project root**:
The directory trowel considers the project anchor. Resolved by walking up from cwd to the nearest `.trowel/` or `.git/`.
_Avoid_: Repo root.

**Layer**:
One of `default`, `global`, `private`, `project`. Precedence: default < global < private < project. Path values resolve relative to the layer anchor before merging.

**BACK_TO branch**:
The branch the user was on when they invoked a command that switches branches. Captured at command start and restored when the command lifecycle requires it.
_Avoid_: Original branch, prior branch.

**Mutation lock**:
A project-wide advisory lock at `<projectRoot>/.trowel/lock` acquired by state-mutating Change/Slice commands. Entity read commands do not acquire it.
_Avoid_: Read lock, status lock, Git lock.

### AFK loop

**AFK loop**:
The auto-iterating agent flow run by `trowel change work <id>`. A shared worker pool claims one actionable Slice, runs exactly one phase step (`implement`, `review`, or `address`), releases the slot, then refetches effective state before the next claim. The loop exits successfully when no actionable Slices remain; if every Slice is `done`, it prints `trowel change ship <id>` guidance instead of running Close-out.
_Avoid_: Sandcastle, agent runner.

**Agent harness**:
The CLI binary that runs an agent role inside a **Turn**. One of `claude`, `codex`, `pi`. Harness is selected via `config.agent.harness` and surfaced by `trowel doctor`.
_Avoid_: Agent, driver, adapter, backend.

**Implementer / Reviewer / Addresser**:
The three agent roles inside the **AFK loop**. Implementer writes the first cut, Reviewer reviews the Slice PR, Addresser responds to reviewer feedback. Reviewer/Addresser require `usePrs && review`.
_Avoid_: Worker.

**Turn**:
The bounded execution of one agent role against one Slice. A Turn runs in a trowel-managed git worktree, receives `.trowel/turn-in.json`, and must write `.trowel/turn-out.json`.
_Avoid_: Sandbox, session, run, container.

**Verdict**:
The agent's self-reported outcome of one **Turn**, written to `.trowel/turn-out.json`. One of `ready`, `needs-revision`, `no-work-needed`, `partial`. The host translates verdicts into git/gh/storage operations.
_Avoid_: Result, status, outcome.

**Slice branch**:
The stored branch a **Slice**'s Turns run on. With `perSliceBranches: true`, new Slice branches use `<changeId>/<sliceId>-<slug>`. With `perSliceBranches: false`, the stored Slice branch is the parent Change branch.
_Avoid_: Feature branch, task branch, computed branch.

**Worktree**:
A trowel-managed git worktree under `.trowel/worktrees/` used as disposable infrastructure for Turns and host-owned merge work.
_Avoid_: Checkout, sandbox directory.

## Relationships

- A **Change** has one stored **Change branch** and one or more **Slices** across all storages; because the Change id is allocated by storage creation, orchestration creates and pushes the Change branch before writing branch metadata through an explicit metadata update; new Change branch names use `${changeId}-${changeSlug}`.
- A **Change** has exactly one stored **Target branch** and one stored **Change branch**.
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
- Merge-based **Ship** performs the Target-branch merge inside a trowel-managed **Worktree**, not the user's main working tree.
- Host-owned local merges run inside trowel-managed **Worktrees**, not the user's main working tree.
- After a host-owned local merge command completes, the user's main working tree remains on its starting branch.
- **Ship** and **Abort** refuse when the user's current branch is a local branch **Cleanup** may delete; the user must switch branches first.
- Merge-based **Ship** uses the reserved `__merge-change` **Worktree** under the Change's worktree root, checks out a detached HEAD at the Target branch tip, merges the **Change branch**, and pushes `HEAD` to the Target branch.
- Slice-branch host merges use the reserved `__merge-slice` **Worktree** under the Change's worktree root, check out a detached HEAD at the **Change branch** tip, merge the **Slice branch**, and push `HEAD` to the **Change branch**.
- Host-owned merge commands may reset and reuse an existing reserved merge **Worktree** after printing a clear warning; the implementation must clear both worktree contents and any in-progress merge state before starting a new host-owned merge.
- Successful slice **Change branch** merge **Worktrees** are kept for reuse until Change-level **Cleanup** removes the Change's trowel-managed Worktrees.
- Successful merge-based **Ship** removes its ship **Worktree** through the normal **Cleanup** pass rather than deleting it in the merge helper.
- If merge-based **Ship** fails during the merge, trowel preserves the failed **Worktree** and reports its path for inspection instead of finalizing the **Change** or running **Cleanup**; a later retry may reset and reuse that Worktree.
- If a ship **Worktree** already exists from a previous Ship attempt, merge-based **Ship** resets and reuses it before starting a new host-owned merge.
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
- Each **Slice** has zero or more **Blockers**.
- Each **Slice** is in exactly one **Slice state**.
- Each **Turn** produces exactly one **Verdict**.
- Storage is chosen per project; flags apply uniformly across storages.

## Example dialogue

> **Dev:** "When `trowel change status` sees that the **Close-out** PR was merged, should it finalize the **Change** or switch branches to inspect it?"
> **Domain expert:** "No. `status` is an **Entity read command**: it may report the **Change state** as `landed`, but only **Ship** runs **Finalization** for the **Change** and then runs **Cleanup**."

## Flagged ambiguities

- "Cleanup" was used broadly; resolved: it means local housekeeping for the Change branch, all Slice branches, and all trowel-managed Worktrees, and explicitly excludes remote branch deletion.
- "Done or aborted" conflicts with the old stored `OPEN | CLOSED` state; resolved: Change state is computed, with `aborted` derived as `closedAt && !done` rather than stored as an explicit reason.
- A Slice-level abort surface was considered and rejected for now; resolved: only top-level Changes can be shipped or aborted.
- "usePrs: false Ship" was used to mean local merge-based **Ship**; resolved: the invariant is about whether Ship performs a local merge, not about the `usePrs` flag value.

## Repo conventions

- Personal CLI, single user, single machine, never shared.
- Node + TypeScript + `tsx`; `pnpm` for scripts.
- Config/input validation uses `valleyed`.
- CLI parsing uses `commander`; command modules live in `src/commands/`.
- Docs/ADR edits land on the Change branch, not `main`, unless explicitly doing repo-maintenance work.
- `trowel start` is the command that understands a user request by grilling, plans repository work, and creates a Change when needed. It accepts optional variadic positional initial-request words (`trowel start fix flaky auth test` joins them with spaces). If no positional request is provided and non-empty stdin is piped, `start` uses stdin as the initial request. Providing both positional request words and non-empty piped stdin is an error. Otherwise the Grill asks what the user wants. The initial request and dirty-tree context are passed to the start agent in memory; `.trowel/start-out.json` stores only the final Grill outcome. It may investigate the codebase when needed to satisfy the user's request, point to an existing Change, or exit with no Change when no repository work is needed. The start agent decides whether investigation is necessary. Its grill output is a discriminated union: create Change, existing Change, or no Change. If an existing Change appears to cover the request, `start` reports it but does not update it; the host verifies the referenced Change exists. Existing-Change detection may consider open and closed Changes, but `start` only prints `trowel change work <id>` next-step guidance after creating a new Change. For an existing Change, it reports the verified Change and suggests `trowel change status <id>` for inspection. `trowel change work <id>` executes Changes. Manual abort uses `trowel change abort`.
- Fresh `trowel start` checks the working tree before launching the grill/investigation. If dirty, it warns: “Working tree is dirty. Commit/stash first for a clean start, or continue and let the start grill account for your current changes. Continue with dirty tree? [y/N]”. If the user declines, it exits without deleting resume state or creating a Change. If the user continues, the start agent receives a dirty-tree note plus `git status --short` so it can treat uncommitted changes as relevant context; normal agent permissions apply, including modifying already-dirty files. Resuming from `.trowel/start-out.json` skips that preflight. After the host successfully handles any start outcome, it deletes `.trowel/start-out.json`.
- Tabs, single quotes, kebab-case filenames, `@k11/configs`.
- No eager exports.

## Out of scope

- Multi-user/multi-machine sharing.
- Non-git projects.
- A projects map inside one config file.
- Shared Turn environments across agent runs.
- Containerized Turn isolation for now.
- `gh` operations inside Turns.
- Auto-committing file-storage Change/Slice docs.
