# trowel

Personal CLI for orchestrating Change-driven repository work — start, slice, and finish — across any git project.

## Core concepts

- **Change** — the user-visible unit of intended repository work. A Change has one or more Slices, a Target branch, and a Change branch.
- **Slice** — one vertical cut of a Change that can be implemented and reviewed independently.
- **Storage** — where Changes and Slices are tracked: local files or GitHub issues.
- **Slice branch** — the durable branch a Slice Turn runs on. New Slices may store `null`; `prepareImplement` fills it lazily using `work.perSliceBranches`.
- **Turn** — one agent run for one role (`implement`, `audit`, or `review`) against one Slice.
- **Auditing / Auditor** — the optional branch-diff quality gate after implementation. The Auditor compares the Slice branch against the Change branch, fixes and commits when possible, and records `auditedAt` when ready.
- **Reviewer** — the PR-feedback response role. It runs only when an open Slice PR's review surface computes the Slice state as `needs-revision`, then responds to the feedback and clears that signal when ready.

## Common commands

| Command | Purpose |
| --- | --- |
| `trowel start [--storage <kind>] [--harness <kind>]` | Understand a user request by grilling, plan repository work, and create a Change when needed. |
| `trowel change list [--storage <kind>]` | List all Changes newest first with computed state. |
| `trowel change status <change-id> [--storage <kind>]` | Show one Change and its Slice states. |
| `trowel change work <change-id> [--storage <kind>] [--harness <kind>]` | Run the AFK loop for a Change. |
| `trowel change ship <change-id> [--storage <kind>]` | Ship a finished Change. |
| `trowel change abort <change-id> [--storage <kind>]` | Abort a Change without shipping it. |
| `trowel slice status <change-id> <slice-id> [--storage <kind>]` | Show one Slice. |
| `trowel slice implement <change-id> <slice-id> [--storage <kind>] [--harness <kind>]` | Run the Implementer for one open Slice. |
| `trowel slice audit <change-id> <slice-id> [--storage <kind>] [--harness <kind>]` | Run the Auditor for one implemented Slice. |
| `trowel slice review <change-id> <slice-id> [--storage <kind>] [--harness <kind>]` | Run the Reviewer for one `needs-revision` Slice with PR feedback. |
| `trowel doctor` | Check local tool/config health. |
| `trowel repair branch-metadata [--dry-run\|--apply]` | Patch legacy issue-storage records with required Target, Change, and Slice branch metadata. |
| `trowel config` | Print resolved config. |
| `trowel init [global\|project]` | Write a config layer. |

`--storage` is offered by commands that read or write Change/Slice state. `--harness` is offered by commands that spawn an agent Turn.

## States and workflow flags

Slice states are computed from storage fields and PR review surfaces: `draft`, `open`, `blocked`, `in-flight`, `implemented`, `audited`, `awaiting-review`, `needs-revision`, `landed`, and `done`. `needs-revision` is derived from the Slice PR's review surface (for example the configured `labels.needsRevision`, default `needs-revision`, or a changes-requested review decision); it is not stored on the Slice.

Key workflow flags:

- `ship.pr` (default `true`) controls PR-vs-host-merge shipping for Change Close-out, and controls Slice PR integration when a Slice branch differs from the Change branch.
- `work.audit` (default `false`) controls whether the AFK loop runs Auditing after implementation before integrating a Slice or making its Slice PR ready.
- `work.perSliceBranches` (default `true`) controls how `prepareImplement` fills a null Slice branch: when true it creates a per-Slice branch from the latest remote Change branch; when false it stores the parent Change branch and serializes work on that shared branch.

Branch behavior: `trowel start` intentionally switches the main checkout to the newly created Change branch after materialising the Change. Later host-owned local merges do not use the main checkout: `trowel change work`, `trowel slice implement`, and merge-based `trowel change ship` merge through reserved trowel worktrees. `trowel change ship` and `trowel change abort` also refuse Cleanup when the current branch is one of the local branches Cleanup may delete; switch branches first, then retry.
