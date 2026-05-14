# AFK loop is asymmetric across backends; two loop drivers, minimal Backend interface

> **Superseded by:** [2026-05-12-unified-loop-via-backend-primitives.md](./2026-05-12-unified-loop-via-backend-primitives.md). The asymmetry that justified two drivers narrowed once `config.work.review` defaulted to `false` (see ADR `agent-review-opt-in`); the interface-bloat objection was resolved by gating unsupported methods through `classifySlice` and having them throw rather than no-op. The text below is kept for historical context.
>
> **Further superseded by:** [2026-05-14-decouple-pr-flow-from-storage.md](./2026-05-14-decouple-pr-flow-from-storage.md). The original `issue`-vs-`file` asymmetry premise — that PR-flow is a storage property — is itself retired. Under the post-pivot model the loop is symmetric across storages; asymmetry, when it exists, comes from the user's `config.work.*` flag choices, not the storage choice.

The **AFK loop** does not share a single state machine across **Backends**. The `issue` backend runs the full four-state per-slice machine (`implement` → `review` → `address` → `done`) with parallel agents, draft PRs, and label-driven transitions. The `file` backend runs a serial implementer-only pass: pop the next `ready` **Slice**, run an **Implementer** in a fresh **Sandbox** on the **Integration branch**, commit, push, mark the slice CLOSED, repeat.

The two flows live in separate driver files:

```
src/work/loops/issue.ts      # the four-state machine; per-slice branches; PR-driven review
src/work/loops/file.ts       # serial implementer-only driver
```

`trowel work <prd-id>` dispatches by `backend.name` to one of them. Shared utilities (`spawnSandbox`, `loadPrompt`, generic git ops, verdict file I/O) live in `src/work/` and are imported by both drivers.

The `Backend` interface stays minimal — the AFK-loop drivers do not call through generic backend methods for their phase logic. The issue driver imports backend-internal helpers from `src/backends/implementations/issue.ts` (e.g. `gh issue develop` to create a **Slice branch**, label flips, PR creation) directly when it needs GitHub-specific behavior; the file driver imports the analogous helpers from `src/backends/implementations/file.ts`. No new generic methods land on `Backend` for the loop's sake.

`Slice.bucket` (the user-facing **Bucket** classification, computed inside `findSlices`) is the loop's filter for "actionable slices in this iteration" — both drivers consume it. `Slice.prState` and `Slice.branchAhead` are populated by `findSlices` so the loop can compute its internal per-slice classification (implement / review / address / done / create-pr-then-review) without re-fetching PR state.

## Considered options

- **One shared loop driver in `src/work/`, with `if backend.name === 'issue'` branches inside.** Rejected: the issue and file flows have almost nothing in common beyond "spawn a sandbox to run an agent with a prompt." The shared file would be dominated by the backend-conditional branches, defeating the unification. Reading "two loops squashed into one for no benefit."
- **Hoist new methods onto `Backend` (`getOrCreateSliceBranch`, `openImplementationChannel`, `markReadyForReview`, …); single loop calls through the interface; file backend implements PR-flow methods as no-ops.** Rejected: bloats the interface with methods that exist only to be no-ops on one implementation. The asymmetry between PR-driven and PR-free flows is real and structural; pretending otherwise via interface symmetry is a documentation liability.
- **Make the `file` backend grow a PR-shaped flow (`requestReview`, `recordFeedback`, etc.) so review/address apply to it too.** Rejected: the file backend's reason for existing is "fast, local, no GitHub round-trips." Inventing a local PR analog (text files for review comments, manual state flips for `ready-for-review`) would be a parallel review system the user has to operate by hand. Real review needs a real review surface; the file backend opts out.
- **Make `trowel work` issue-only and crash on the file backend.** Rejected: the file backend deserves a usable implementer-only flow (the implementer is the productive part of AFK; the PR-flow review/address is the bureaucracy). A serial implementer loop is 20 lines and unlocks AFK semantics for the file backend's audience.

## Consequences

- The TODO's earlier line — "Generalise it across the three backends via the `Backend` interface (`findSlices` replaces direct sub-issue API calls)" — is reframed: `findSlices` is the only generalised call. Phase-specific operations are not generalised.
- Reviewer and Addresser commands (`trowel review` / `trowel address`) refuse on the file backend with a message naming the backend and pointing at `trowel work` for the supported flow.
- `Slice.prState` and `Slice.branchAhead` are always `null` / `false` on the file backend; the issue backend's `findSlices` populates them with real values. Consumers (loop and `trowel status`) treat the file-backend values as "no PR concept here."
- Future backends, if any, slot in by adding another loop driver under `src/work/loops/` and a dispatcher case in `src/commands/work.ts`. The `Backend` interface stays at its current ~10 methods.
