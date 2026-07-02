# Interactive Lanes use local Trowel worktrees

Trowel adds **Lanes** for foreground human-in-the-loop implementation sessions that need isolated local worktrees without creating a Change/Slice lifecycle. `trowel lane start` allocates a local Lane id, creates a generated branch `lane-<laneId>-<slug>`, stores Lane metadata under `.trowel/lanes/`, creates the worktree under `.trowel/worktrees/lanes/<laneId>`, and opens an interactive harness session there. `trowel lane close` asks before merging the Lane branch into the captured Target branch, then removes the Lane worktree and applies `ship.deleteBranch`; closed Lane metadata remains so ids are not reused.

The Trowel worktree layout is split by owner: Change/Slice Turn and host-merge worktrees live under `.trowel/worktrees/changes/<changeId>/...`, while Lane worktrees live under `.trowel/worktrees/lanes/<laneId>`. Lanes are local-only: no fetch, push, PR, remote branch deletion, Change creation, Slice creation, Turn verdict, or AFK loop occurs unless the user explicitly asks from inside the interactive session.

## Considered Options

- **Use the existing Change/Slice lifecycle.** Rejected because Lanes intentionally avoid the full Trowel delivery lifecycle for quick parallel terminal-based implementation sessions.
- **Make the user provide a branch name.** Rejected because Trowel already generates Change/Slice branch identity from ids and titles, then stores it as metadata.
- **Delete Lane metadata on close.** Rejected because ids would be reusable and closed Lane history would disappear.
