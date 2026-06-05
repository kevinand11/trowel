# trowel

Personal CLI for orchestrating Change-driven feature work — start, slice, and finish — across any git project.

## Core concepts

- **Change** — the user-visible unit of intended repository work. A Change has one or more Slices, a Target branch, and a Change branch.
- **Slice** — one vertical cut of a Change that can be implemented and reviewed independently.
- **Storage** — where Changes and Slices are tracked: local files or GitHub issues.
- **Turn** — one agent run for one role (`implement`, `review`, or `address`) against one Slice.

## Common commands

| Command | Purpose |
| --- | --- |
| `trowel start [--storage <kind>] [--harness <kind>]` | Understand a user request by grilling, plan repository work, and create a Change when needed. |
| `trowel change list [--storage <kind>]` | List all Changes newest first with computed state. |
| `trowel change status <change-id> [--storage <kind>]` | Show one Change and its Slice states. |
| `trowel change work <change-id> [--storage <kind>] [--harness <kind>]` | Run the AFK loop for a Change. |
| `trowel change ship <change-id> [--storage <kind>]` | Ship a finished Change. |
| `trowel change abort <change-id> [--storage <kind>]` | Abort a Change without shipping it. |
| `trowel slice status <slice-id> [--storage <kind>]` | Show one Slice. |
| `trowel slice implement <slice-id> [--storage <kind>] [--harness <kind>]` | Run implementer for one Slice. |
| `trowel slice review <slice-id> [--storage <kind>] [--harness <kind>]` | Run reviewer for one Slice PR. |
| `trowel slice address <slice-id> [--storage <kind>] [--harness <kind>]` | Run addresser for one Slice PR. |
| `trowel doctor` | Check local tool/config health. |
| `trowel repair branch-metadata [--dry-run\|--apply]` | Patch legacy issue-storage records with required Target, Change, and Slice branch metadata. |
| `trowel config` | Print resolved config. |
| `trowel init [global\|private\|project]` | Write a config layer. |

`--storage` is offered by commands that read or write Change/Slice state. `--harness` is offered by commands that spawn an agent Turn.

## Config highlights

`trowel config` prints the resolved configuration from the default, global, private, and project layers. `trowel init` writes a sparse config layer and a sibling `schema.json` for editor validation.

Key workflow flags:

- `ship.pr` (default `true`) controls PR-vs-host-merge shipping for Change Close-out, and controls Slice PR integration when a Slice branch differs from the Change branch.
- `work.audit` (default `false`) controls whether the AFK loop runs Auditing after implementation before integrating a Slice or making its Slice PR ready.
- `work.perSliceBranches` (default `true`) controls whether new Slices get their own Slice branch or share the Change branch.

Branch behavior: `trowel start` intentionally switches the main checkout to the newly created Change branch after materialising the Change. Later host-owned local merges do not use the main checkout: `trowel change work`, `trowel slice implement`, and merge-based `trowel change ship` merge through reserved trowel worktrees. `trowel change ship` and `trowel change abort` also refuse Cleanup when the current branch is one of the local branches Cleanup may delete; switch branches first, then retry.
