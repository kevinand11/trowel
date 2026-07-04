# trowel lane — interactive implementation lane

You are inside a **Trowel Lane**: a manual, foreground, human-in-the-loop implementation session running in a dedicated local git worktree.

A Lane is not a Trowel Change, Slice, Turn, AFK loop, Ship, or Abort. Do not run `trowel start`, `trowel work`, `trowel change work`, `trowel change ship`, `trowel change abort`, or other Trowel lifecycle commands unless the user explicitly asks.

## Hard rules

- A Lane always has a human in the loop because this is an interactive session.
- Use inline execution in this session. Do not start background/AFK orchestration or delegate implementation away from this lane.
- Do not run `gh`, `git push`, `git pull`, `git fetch`, or remote-mutating commands unless the user explicitly asks.
- Never commit automatically. Do not run `git commit` unless the user explicitly approves the specific commit after seeing the status, summary, and proposed commit message. Project instructions that normally require commits do not override this Lane rule.
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

Implement in this worktree. Inspect code, edit files, run tests, format, lint, and verify.

After implementation and verification, inspect `git status --short`.

- If the worktree is clean, report that there is nothing to commit.
- If the worktree is dirty, summarize the changed files, propose a commit message, and ask exactly whether to commit these Lane changes locally with that message. Default to no and wait for explicit approval before committing.
- If the user approves, run the local `git add`/`git commit` needed for that commit. Do not push unless the user separately asks.
- If the user declines, leave the changes uncommitted. Tell the user that `trowel lane close <lane-id>` will refuse while the Lane worktree is dirty, and that they can continue editing, ask you to commit later, stash, or discard.

Before suggesting `trowel lane close <lane-id>`, the Lane worktree must be clean and merge-compatible with its captured Target branch.

1. Identify the Lane id and Target branch from the owning project's `.trowel/lanes/<lane-id>.json`. Derive the owning project and Lane id from the current worktree path (`.trowel/worktrees/lanes/<lane-id>`). Do not guess the Target branch.
2. Run a non-mutating merge preflight from this Lane worktree:

   `git merge-tree --write-tree --messages --name-only <targetBranch> HEAD`

3. If preflight reports no conflicts, tell the user to close the lane from outside this worktree:

   `trowel lane close <lane-id>`

4. If preflight reports conflicts, do not suggest closing yet. Show the Target branch, the conflicting files, and the relevant conflict output. Then try to resolve the conflicts in this Lane branch before suggesting close:
   - Merge the Target branch into the Lane branch without auto-committing: `git merge --no-ff --no-commit <targetBranch>`.
   - Resolve the conflicts in this worktree, preserving both Target branch changes and Lane changes.
   - Run the relevant tests/format/lint verification again.
   - Inspect `git status --short`, summarize the conflict-resolution changes, propose a merge-resolution commit message, and ask for explicit approval before committing. Default to no.
   - After an approved local commit, rerun the merge preflight. Only suggest `trowel lane close <lane-id>` once the worktree is clean and preflight reports no conflicts.
