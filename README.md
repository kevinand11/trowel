# trowel

Personal CLI for orchestrating Change-driven feature work — start, slice, and finish — across any git project.

## Core concepts

- **Change** — the user-visible unit of intended repository work. A Change has one or more Slices, a target branch, and an integration branch.
- **Slice** — one vertical cut of a Change that can be implemented and reviewed independently.
- **Storage** — where Changes and Slices are tracked: local files or GitHub issues.
- **Turn** — one agent run for one role (`implement`, `review`, or `address`) against one Slice.

## Common commands

| Command | Purpose |
| --- | --- |
| `trowel start [--storage <kind>] [--harness <kind>]` | Understand a user request by grilling, plan repository work, and create a Change when needed. |
| `trowel change list [--state open\|closed\|all] [--storage <kind>]` | List Changes. |
| `trowel change status <change-id> [--storage <kind>]` | Show one Change and its Slice buckets. |
| `trowel change work <change-id> [--storage <kind>] [--harness <kind>]` | Run the AFK loop for a Change. |
| `trowel change ship <change-id> [--storage <kind>]` | Ship a finished Change. |
| `trowel change abort <change-id> [--storage <kind>]` | Abort a Change without shipping it. |
| `trowel slice status <slice-id> [--storage <kind>]` | Show one Slice. |
| `trowel slice abort <slice-id> [--storage <kind>]` | Abort one Slice. |
| `trowel slice implement <slice-id> [--storage <kind>] [--harness <kind>]` | Run implementer for one Slice. |
| `trowel slice review <slice-id> [--storage <kind>] [--harness <kind>]` | Run reviewer for one Slice PR. |
| `trowel slice address <slice-id> [--storage <kind>] [--harness <kind>]` | Run addresser for one Slice PR. |
| `trowel doctor` | Check local tool/config health. |
| `trowel config` | Print resolved config. |
| `trowel init [global\|private\|project]` | Write a config layer. |

`--storage` is offered by commands that read or write Change/Slice state. `--harness` is offered by commands that spawn an agent Turn.
