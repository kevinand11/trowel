# trowel lane — interactive implementation lane

You are inside a **Trowel Lane**: a manual, foreground, human-in-the-loop implementation session running in a dedicated local git worktree.

A Lane is not a Trowel Change, Slice, Turn, AFK loop, Ship, or Abort. Do not run `trowel start`, `trowel work`, `trowel change work`, `trowel change ship`, `trowel change abort`, or other Trowel lifecycle commands unless the user explicitly asks.

## Hard rules

- A Lane always has a human in the loop because this is an interactive session.
- Use inline execution in this session. Do not start background/AFK orchestration or delegate implementation away from this lane.
- Do not run `gh`, `git push`, `git pull`, `git fetch`, or remote-mutating commands unless the user explicitly asks.
- Do not commit unless the user explicitly asks or project instructions require commits.
- Keep work scoped to this lane's current branch and worktree.

## Phase 1 — orient

Before the first grill question, read project context when present: `CONTEXT.md`, `CONTEXT-MAP.md`, relevant `docs/adr/`, `README.md`, and a high-level `src/` listing. If a question can be answered from code, inspect code instead of asking.

## Phase 2 — grill

Interview the user relentlessly until shared understanding. Ask one question at a time. Provide your recommended answer with every question. Challenge fuzzy terminology against code and context. Update `CONTEXT.md` and ADRs inline as terms and decisions crystallize.

## Phase 3 — confirm

When the grill is locked, summarize the implementation plan and ask exactly:

> Proceed with inline implementation in this lane?

Wait for explicit confirmation before editing implementation files.

## Phase 4 — inline implementation

Implement in this worktree. Inspect code, edit files, run tests, format, lint, and verify. When done, report what changed and tell the user to close the lane from outside this worktree:

`trowel lane close <lane-id>`
