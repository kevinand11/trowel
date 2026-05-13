# Unified GitOps via module factory; backend git deps are optional

All git access in trowel — backend phase methods, the file backend's `createPrd`, and `trowel close`'s host-side branch cleanup — routes through one canonical `GitOps` type, produced by a single factory `createRepoGit(projectRoot)` in a new module `src/utils/git-ops.ts`. `BackendDeps.git` becomes optional; backends constructed without it cannot invoke methods that need git. The runtime guard (a throw at the top of phase methods) is unreachable in practice because read-only command paths never call those methods — the same unreachable-runtime-invariant pattern ADR `unified-loop-via-backend-primitives` already uses for unsupported phase methods on the file backend.

The `GitOps` surface is the union of operations across all consumers:

```ts
type GitOps = {
  // phase-method ops (existing six)
  fetch(branch: string): Promise<void>
  push(branch: string): Promise<void>
  checkout(branch: string): Promise<void>
  mergeNoFf(branch: string): Promise<void>
  deleteRemoteBranch(branch: string): Promise<void>
  createRemoteBranch(newBranch: string, baseBranch: string): Promise<void>
  // file backend's createPrd (absorbs the raw `exec('git', ...)` block)
  createLocalBranch(name: string, baseBranch: string): Promise<void>
  pushSetUpstream(branch: string): Promise<void>
  // host-side close cleanup (absorbs the locally-defined GitOps in close.ts)
  currentBranch(): Promise<string>
  branchExists(branch: string): Promise<boolean>
  isMerged(branch: string, baseBranch: string): Promise<boolean>
  deleteBranch(branch: string): Promise<void>  // local + remote
}
```

Three places that talked to git on different channels collapse into this surface:

1. **`BackendDeps.git`** (the existing six phase ops). Stays, gains the file-backend ops, becomes optional.
2. **Raw `exec('git', ...)`** in `file.ts:100-109` (the `createPrd` branch-creation + push block). Routes through `deps.git.createLocalBranch` + `deps.git.pushSetUpstream`. The `git add` + `git commit` block in the same function goes away entirely (see ADR `file-backend-no-auto-commits`).
3. **The locally-defined `GitOps` type in `close.ts:13-19`**, used only by `runClose`. Removed; `runClose` consumes the canonical bag — which it gets from the same `createRepoGit` factory the backend was constructed against.

`BackendDeps.git` is optional because read-only commands (`trowel status`, `trowel list`) do not need git wired to construct a backend they only query through. The friction those commands previously paid — hand-rolled six-method `noopGit` stubs — disappears. `BackendDeps.confirm` and `BackendDeps.log` also become optional under the same rationale: `confirm` is used only by `Backend.close`'s branch-policy prompt, `log` only by phase methods.

## Considered options

- **Backend-only unification.** Unify `BackendDeps.git` and the file backend's raw `exec`, but leave `close.ts`'s local `GitOps` type alone. Rejected: it leaves the most visible smell (two types named `GitOps` in different files with overlapping verb sets) intact. The whole reason to unify is to have one named module for git ops; this option keeps two.
- **Construction-time, fat bag.** All git ops on `BackendDeps.git`, required for every backend, no factory. Rejected: read-only commands continue to hand-roll noop stubs (now larger — ~12 noop methods). The candidate that started this grilling (read-only callers fake git) gets *worse*.
- **Per-call git argument.** Drop `BackendDeps.git` entirely; every phase method (and `Backend.close`) takes a `git: GitOps` parameter. Type-system catches misuse: you can't call a method that needs git without passing one. Rejected: requires touching every phase-method signature on both backends and threading git through the loop and per-phase commands. The misuse surface it protects against is four entry points all wired in `_loop-wiring.ts:buildLoopWiring`; the ceremony isn't justified.
- **Backend grows, host shrinks.** Move branch-cleanup responsibilities from `runClose` into `Backend.close()`. Then `close.ts`'s host-side `GitOps` disappears not because it merged into the canonical surface, but because it stopped existing. Deferred: this requires re-homing real responsibilities (cleanup policy, prompt logic) inside `Backend.close()`, which is its own grilling session. The unified-surface decision doesn't need it to be useful; it can land later without revisiting this ADR.

## Consequences

- New module `src/utils/git-ops.ts` exports the `GitOps` type and `createRepoGit(projectRoot)` factory. The `GitOps` type moves out of `backends/types.ts` and is re-exported there if convenient for downstream imports.
- `BackendDeps.git`, `BackendDeps.confirm`, and `BackendDeps.log` become optional. Phase methods throw at the top if invoked without `git`; `Backend.close` throws if invoked without `confirm` (only relevant for prompt-policy paths). Read-only call paths never touch any of them.
- `status.ts`, `list.ts`: shrink by ~10 lines each (drop the `noopGit` literal and the `confirm`/`log` noop lines).
- `close.ts`: locally defined `GitOps` type removed; `runClose`'s `CloseRuntime.git` is the canonical type.
- `_loop-wiring.ts`: the ~25-line inline construction of `gitFetch`/`gitPush`/`gitCheckout`/... (lines 77-102) collapses to one `const git = createRepoGit(projectRoot)`.
- `file.ts:createPrd`: raw `exec('git', ...)` for branch creation and push routes through `deps.git.createLocalBranch` + `deps.git.pushSetUpstream`.
- Tests: file-backend tests that run against a real bare git repo are unchanged. Tests that want unit-level isolation can now pass a synthetic `GitOps` — today they can't, because the raw `exec` calls bypass any seam. Issue-backend tests already stub `deps.git`; their stub shape grows to include the new ops or omits `deps.git` entirely for read-only scenarios.
- Two open architecture findings collapse into this ADR: "read-only callers fake git" (`status`/`list` build `noopGit` stubs) and "`close.ts` shadows backend git with its own `GitOps`."
