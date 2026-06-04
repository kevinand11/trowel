# Trowel — Context

Trowel is a personal CLI that orchestrates Change-driven repository work — start, slice, and finish — across any git project. It is single-user, single-machine, not shareable; it installs once and runs against any git project.

## Language

### Change lifecycle

**Change**:
A user-visible unit of intended repository work, identified by a unique **Change id**. A Change contains one or more **Slices**, records a **Target branch**, and has an **Integration branch** where Slice work accumulates before Close-out. The artifact type — directory of markdown/JSON files (`file` storage) or GitHub issue (`issue` storage) — is chosen per project via **Storage**. The Change's state is `OPEN | CLOSED`. On file storage, trowel writes Change/Slice files but does not auto-commit them.
_Avoid_: PRD, Fix, ticket, story.

**Change id**:
The canonical unique identifier for a **Change**. Form depends on **Storage**: GitHub issue number (`issue`) or a positive integer drawn from a project-wide pool shared with **Slice** ids (`file`). It is used by commands such as `trowel change status <id>` and `trowel change work <id>`.
_Avoid_: PRD id, slug, name.

**Grill**:
The interactive questioning process used by `trowel start` to understand a user request and shape repository work before creating a **Change**. A Grill may inspect the codebase when needed, may conclude that an existing **Change** already covers the request, or may conclude that no repository work is needed. Existing-Change and No-Change are successful outcomes and exit 0.
_Avoid_: Intake, diagnose, interview.

**Storage**:
The strategy that decides how a **Change** is persisted, identified, listed, and linked to its **Slices**. One of `file`, `issue`. Storage is pure persistence: id format, Change/Slice CRUD, blocker linkage, slice flags, and branch-naming convention. AFK-loop behavior lives in the loop driver and is selected by **Flags**, not by storage choice.
_Avoid_: Backend, provider, adapter, driver.

**Flag**:
A user-configurable behavior toggle in `config.work.*`. Current flags:
- **`usePrs`**: opens one PR per Slice branch after implementation; requires `perSliceBranches: true`.
- **`review`**: runs Reviewer and Addresser phases; requires `usePrs: true`.
- **`perSliceBranches`**: each Slice gets its own branch (`change-<changeId>/slice-<sliceId>-<slug>`). When false, implementers commit directly to the **Integration branch** and concurrency is one.
_Avoid_: Option, setting.

**Slice**:
One vertical cut of a **Change** — a discrete piece of work that can be implemented and reviewed independently. Slice ids are globally unique within a project: file storage draws them from the same integer pool as **Change ids**, and issue storage uses GitHub issue numbers. Each Slice has storage fields `{ id, title, body, state: 'OPEN' | 'CLOSED', readyForAgent, needsRevision, blockedBy, prState }`.
_Avoid_: Sub-issue, task, ticket.

**Bucket**:
The canonical lifecycle classification of a **Slice**, computed from storage fields plus PR-state queries when `usePrs: true`. One of `done`, `needs-revision`, `in-flight`, `blocked`, `ready`, `draft`. Commands that display or gate behavior on buckets use the same PR-enriched effective slice state as the AFK loop. With `usePrs: true`, enrichment failures surface instead of falling back to raw storage state.
_Avoid_: Status, phase, stage.

**Blocker**:
A **Slice** referenced in another **Slice**'s `blockedBy` field. Slice X is blocked by Slice Y means Y must reach the `done` **Bucket** before X is unblocked.
_Avoid_: Dependency, parent.

**Target branch**:
The branch a **Change** will be completed back into. Captured from the current branch when `trowel start` materialises the Change. Legacy records without a stored target fall back to `git.baseBranch()`.
_Avoid_: Base branch, BACK_TO branch, merge branch.

**Integration branch**:
The branch that holds in-flight Change work. Slice commits are merged into it (or written directly when `perSliceBranches: false`) before Close-out ships it to the **Target branch**. New integration branches use `change-<changeId>-<slug>`.
_Avoid_: Feature branch.

**Close-out**:
The terminal step that ships a closeable **Change**. A Change becomes closeable when every **Slice** is CLOSED. If `config.work.usePrs` is true, Close-out opens/marks-ready a PR from the Integration branch to the Target branch and leaves the Change OPEN until merge reconciliation. If false, Close-out host-merges the Integration branch into the Target branch and marks the Change CLOSED.
_Avoid_: Abort.

**Abort**:
The manual abandon path. `trowel change abort <id>` or `trowel slice abort <id>` marks records CLOSED and performs cleanup without merging or opening a shipping PR. Abort is not the success path.
_Avoid_: Close (old command name), ship.

**Reconciliation**:
The act of observing external state — specifically a Close-out PR's merged status on GitHub — and writing it back to storage. Commands that touch Change/Slice state run reconciliation under the **Mutation lock**.
_Avoid_: Sync, refresh, poll.

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
A project-wide advisory lock at `<projectRoot>/.trowel/lock` acquired by commands that touch Change/Slice state, including read commands because reconciliation may write.
_Avoid_: Mutex, semaphore.

### AFK loop

**AFK loop**:
The auto-iterating agent flow run by `trowel change work <id>`. A shared worker pool claims one actionable Slice, runs exactly one phase step (`implement`, `review`, or `address`), releases the slot, then refetches effective state before the next claim. The loop exits when no actionable Slices remain.
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
The per-slice working branch used when `perSliceBranches: true`. Pattern: `change-<changeId>/slice-<sliceId>-<slug>`.
_Avoid_: Feature branch, task branch.

## Relationships

- A **Change** has one or more **Slices**.
- A **Change** has exactly one **Target branch** and one **Integration branch**.
- Each **Slice** has zero or more **Blockers**.
- Each **Slice** is in exactly one **Bucket**.
- Each **Turn** produces exactly one **Verdict**.
- Storage is chosen per project; flags apply uniformly across storages.

## Repo conventions

- Personal CLI, single user, single machine, never shared.
- Node + TypeScript + `tsx`; `pnpm` for scripts.
- Config/input validation uses `valleyed`.
- CLI parsing uses `commander`; command modules live in `src/commands/`.
- Docs/ADR edits land on the Integration branch, not `main`, unless explicitly doing repo-maintenance work.
- `trowel start` is the command that understands a user request by grilling, plans repository work, and creates a Change when needed. It accepts optional variadic positional initial-request words (`trowel start fix flaky auth test` joins them with spaces). If no positional request is provided and non-empty stdin is piped, `start` uses stdin as the initial request. Providing both positional request words and non-empty piped stdin is an error. Otherwise the Grill asks what the user wants. The initial request and dirty-tree context are passed to the start agent in memory; `.trowel/start-out.json` stores only the final Grill outcome. It may investigate the codebase when needed to satisfy the user's request, point to an existing Change, or exit with no Change when no repository work is needed. The start agent decides whether investigation is necessary. Its grill output is a discriminated union: create Change, existing Change, or no Change. If an existing Change appears to cover the request, `start` reports it but does not update it; the host verifies the referenced Change exists. Existing-Change detection may consider open and closed Changes, but `start` only prints `trowel change work <id>` next-step guidance after creating a new Change. For an existing Change, it reports the verified Change and suggests `trowel change status <id>` for inspection. `trowel change work <id>` executes Changes. Manual abort uses `trowel change abort` / `trowel slice abort`.
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
