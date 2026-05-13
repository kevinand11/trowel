# File backend does not auto-commit `prdsDir` contents

The `file` backend's `createPrd` and `close` no longer run `git add` + `git commit`. Trowel writes the PRD/slice JSON and markdown files to disk; if the user keeps `prdsDir` in a git repo, they own staging and committing those files themselves. The rule is captured in CONTEXT.md's `**PRD**` entry and re-stated in "Out of scope."

Branch creation in `createPrd` stays. `git checkout -b <integration> <base>` followed by `git push -u origin <integration>` is **AFK-loop infrastructure**, not doc-content tracking: the integration branch must exist as a real git ref because `sandcastle` creates worktrees on it during `trowel work`. Trowel owns the branch's lifecycle, symmetric with the issue backend (which creates and checks out the branch via `gh issue develop --branch ... --checkout`).

Slice-level state transitions — `readyForAgent`, `needsRevision`, `state: 'CLOSED'` — are written to the slice's `store.json` by the AFK loop's `landImplement` on the host's working tree, and are never committed by trowel. The user owns these commits too (or chooses not to track slice state in git). The AFK loop's *application* commits, made by the implementer agent from inside the sandbox, are unaffected: `landImplement` still pushes the integration branch with the agent's commits as today.

## Considered options

- **(a) Status quo minus the commit (chosen).** `createPrd` runs `git checkout -b <integration> <base>` + `git push -u origin <integration>` with no commit between them. `close` does no git operations. Working tree ends up on the integration branch after `trowel start`, matching the issue backend's `gh issue develop --checkout` behavior.
- **(b) Branch-only.** `createPrd` creates the local ref but doesn't checkout or push. AFK loop sets `-u` on first push. Rejected: breaks symmetry with the issue backend, and the user has to checkout the integration branch manually before running `trowel work`.
- **(c) No git in `createPrd` at all.** User pre-creates the integration branch before running `trowel work`. Rejected: introduces a usability cliff — the user has to mirror trowel's `${prefix}${id}-${slug}` naming convention exactly, or `trowel work` fails on a missing branch. Branch existence is trowel's contract with sandcastle; trowel should own it.

Auto-committing was reconsidered on its own merits and rejected: the current implementation commits to whatever branch `HEAD` points at when `trowel close` runs (not necessarily the integration branch), it never pushes the doc commit upstream, and it silently skips the commit when `prdsDir` lives outside the repo (`isInsideRepo` guard at `file.ts:103`, `file.ts:157`). The behavior was bookkeeping the user couldn't rely on; pushing the responsibility to the user removes the ambiguity.

## Consequences

- `file.ts:createPrd` drops the `git add` + `git commit` block (the inner `if (isInsideRepo) { ... }` at lines 104-108). Keeps `git checkout -b` (line 100) and `git push -u origin <branch>` (line 109). When ADR `unified-gitops-via-module-factory` lands, the surviving two raw `exec` calls route through `deps.git.createLocalBranch` + `deps.git.pushSetUpstream`.
- `file.ts:close` drops the `git add` + `git commit` block entirely (lines 156-161). `close` becomes a pure `writeFile` to `store.json` plus the existing idempotence check.
- `BackendDeps.docMsg` drops. The only consumer was the deleted commit block.
- The `commit` config namespace in `schema.ts` (`docMsg`, `convention`, `sign`) drops entirely. `convention` and `sign` had no consumers anywhere in the codebase before this ADR; they were carried along unused.
- All `BackendDeps` construction sites (`_loop-wiring.ts:113`, `status.ts:112`, `close.ts:128`, `list.ts:89`, plus registry and test fixtures) drop the `docMsg: config.commit.docMsg` line.
- Slice-state-in-working-tree-only is now intentional model, not a gap. A clean re-clone of the repo loses uncommitted slice state by design; users who care about durability commit `prdsDir` periodically. Reflected in CONTEXT.md.
- The "close-doesn't-push" concern from the grilling session goes away for the file backend (no commit means nothing to push). The separate concern about `runClose` capturing `back = currentBranch()` before any mutation on the issue backend is independent of this ADR and remains a small bug to fix.
- Does not depend on ADR `unified-gitops-via-module-factory`. The two were grilled together and can land in either order; if this ADR lands first, `createPrd` keeps using raw `exec` for `git checkout -b` and `git push -u origin <branch>` until the GitOps ADR replaces them.
