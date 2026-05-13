# Storage / behavior separation; PR-flow as utility functions; capability primitives

> **Supersedes (when implementation lands):** [2026-05-12-unified-loop-via-backend-primitives.md](./2026-05-12-unified-loop-via-backend-primitives.md), [2026-05-11-backend-owns-slice-bucket-classification.md](./2026-05-11-backend-owns-slice-bucket-classification.md), [2026-05-11-optional-pr-flow-on-issue-backend.md](./2026-05-11-optional-pr-flow-on-issue-backend.md).

The `Backend` concept is split. What was previously one interface that bundled **persistence** (how PRDs/slices are stored) with **AFK-loop behavior** (per-slice branches, PR-flow, reviewer/addresser phases) becomes two cleanly separated layers:

- **Storage** (renamed from `Backend`): pure persistence. PRD/slice CRUD, id format, blocker linkage, slice-flag storage, branch-naming convention. No phase methods. No knowledge of PRs.
- **Loop** (`src/work/loop.ts` + siblings): the single AFK-loop driver. Owns classification, reconciliation, and all phase orchestration (`implement`/`review`/`address`). Behavior is uniform across storages, parameterized by user **Flags** in `config.work.*`.

PR-flow operations — `openDraftPr`, `markPrReady`, `fetchPrFeedback`, `getPrState` — live as **free utility functions** in `src/work/pr-flow.ts`, taking a `gh: GhRunner` plus primitives (slice, branch, prNumber). They are not methods on any storage; the loop calls them directly when `usePrs: true`.

Storage / flag compatibility is enforced by **capability primitives**. Each storage declares which capabilities it opts into (today the only one is `prFlow: boolean`). Flags that require a capability the storage doesn't expose are rejected at **config load**, with a precise error message. Capabilities are storage *opinions*, not pure technical-can-do — a storage author may decline a capability for UX coherence.

The new `Storage` interface shape:

```ts
interface Storage {
  readonly name: string
  readonly defaultBranchPrefix: string
  readonly capabilities: { prFlow: boolean }

  // PRD CRUD
  createPrd(spec: PrdSpec): Promise<{ id: string; branch: string }>
  branchForExisting(id: string): Promise<string>
  findPrd(id: string): Promise<PrdRecord | null>
  listPrds(opts: { state: 'open' | 'closed' | 'all' }): Promise<PrdSummary[]>
  closePrd(id: string): Promise<void>

  // Slice CRUD
  createSlice(prdId: string, spec: SliceSpec): Promise<Slice>
  findSlices(prdId: string): Promise<Slice[]>          // raw; no prState/branchAhead/bucket
  updateSlice(prdId: string, sliceId: string, patch: SlicePatch): Promise<void>
}
```

The `Slice` shape simplifies — `prState`, `branchAhead`, and `bucket` are removed because they are not storage state. They are projections the loop computes from the storage's raw slice plus, when applicable, a `getPrState(gh, sliceBranch)` query. The ADR `backend-owns-slice-bucket-classification` is superseded: bucket classification moves to the loop.

`usePrs` and `review` are existing flags whose meaning becomes uniform across storages. A third flag, **`perSliceBranches`** (default `true`), is promoted from being implicit in the storage choice to being a user-configurable flag — the `file` storage's historical "always integration-branch-only" mode is reachable via `perSliceBranches: false`, but the new universal default is per-slice branches everywhere. The `maxConcurrent: 1` constraint binds to `perSliceBranches: false` (because integration-branch writes can't parallelize), not to the storage choice.

`Backend.close()` renames to `Storage.closePrd()` to disambiguate from the command-level `runClose` logic in `src/commands/close.ts`. The CLI flag `--backend` renames to `--storage`; `config.backend` renames to `config.storage`; `BackendDeps` renames to `StorageDeps`; `BackendFactory` to `StorageFactory`; `getBackend` to `getStorage`. The CLI is single-user, single-machine — breaking the old name is fine; no compatibility alias is provided.

## Considered options

- **Keep `Backend` as the bundled storage + behavior unit.** Rejected: every new storage would re-implement the AFK-loop primitives, mostly identically to the previous one (the duplication ADR `unified-loop-via-backend-primitives` already reduced is still there in spirit — `prepare<Role>` / `land<Role>` are 60% storage-specific glue and 40% identical orchestration). Splitting concentrates orchestration in one driver and per-storage code in one persistence class.
- **Storage / behavior split, but PR-flow as a sub-interface attached to `Storage` (option Z from the grilling: `storage.prFlow: PrFlowOps | null`).** Rejected: keeps PR-flow operations bound to a class hierarchy that doesn't need them. PR-flow ops only need a `gh` runner and primitives; pulling them into the storage means every new storage either implements them or attaches a nullable bag. Free utility functions are testable in isolation, importable anywhere, and don't accrete onto the storage interface as the capability surface grows.
- **PR-flow as required methods on `Storage`, throw when `capabilities.prFlow === false` (option X).** Rejected: re-introduces exactly the dishonesty we rejected for the per-call-vs-construction-time GitOps split (ADR `unified-gitops-via-module-factory` option B2-ii). The type would still claim methods exist that aren't valid; runtime throws would replace compile-time absence.
- **PR-flow as optional `?` methods on `Storage` (option Y).** Rejected: `storage.openDraftPr?.(...)` at every call site is small noise that adds up, and the pattern doesn't match the rest of the codebase. The capability check should be one place, not at every call.
- **Two granular capabilities `prFlow` + `reviewerFeedback` (option b).** Rejected: every real-world code-hosting platform with PRs has the operations the loop needs as a bundle; decoupling them is speculative for a hypothetical Gerrit-shaped storage. YAGNI. If a storage with PRs-but-no-review-feedback arrives, adding a second capability is a small migration.
- **Soft "no-op or degrade" on incompatible flag + storage (option ii from Q1).** Rejected: silently dropping `usePrs: true` to `false` on a storage without `prFlow` hides the user's intent and makes debugging hostile. Hard error at config load is the only honest signal.
- **`perSliceBranches` defaults storage-specific (`file: false`, `issue: true`).** Rejected: the bundling-into-storage is exactly what this pivot removes. A universal default keeps the flag genuinely orthogonal; users who want the old `file` behavior set it explicitly.

## Consequences

### Code structure
- **New module `src/work/pr-flow.ts`** exports `openDraftPr`, `markPrReady`, `fetchPrFeedback`, `getPrState`, each taking `gh: GhRunner` + the primitives it needs. No class, no `this`.
- **`src/work/loop.ts`** absorbs `classifySlice`, `reconcileSlices`, `prepareImplement`/`landImplement`, `prepareReview`/`landReview`, `prepareAddress`/`landAddress`. These become free functions or methods on a `LoopDriver` instance, parameterized by `Storage` + `GitOps` + config flags. They orchestrate storage mutations + GitOps + PR-flow utils + sandbox spawn.
- **`src/backends/`** is renamed to `src/storages/`. `src/storages/implementations/file.ts` and `src/storages/implementations/issue.ts` shrink substantially — only their CRUD methods survive.
- **`src/storages/types.ts`**: `Backend` → `Storage`, `BackendDeps` → `StorageDeps`, `BackendFactory` → `StorageFactory`. The `Backend` methods `classifySlice`/`reconcileSlices`/`prepare*`/`land*` are removed from the type. `Slice` drops `prState`, `branchAhead`, `bucket`. A new field `capabilities: { prFlow: boolean }` is added on the storage instance.
- **`src/backends/registry.ts`** → **`src/storages/registry.ts`**. Renamed `getBackend` → `getStorage`. Loads config-validation rules and runs them against the chosen storage's `capabilities`.
- **Existing per-phase commands (`trowel implement`, `trowel review`, `trowel address`)** call into the loop's phase functions directly, bypassing `classifySlice`. The error message for `trowel review` against a storage without `prFlow` becomes "review requires capability `prFlow`; storage `<name>` does not declare it" — surfaced at the command layer, not from a backend's throw.

### Config schema
- **`config.work.perSliceBranches: boolean`** is added, default `true`.
- **`config.work.usePrs: boolean`** survives, default `false`. Validation: requires capability `prFlow` on the chosen storage; otherwise config-load errors.
- **`config.work.review: boolean`** survives, default `false`. Validation: requires `usePrs: true`.
- **`config.backend`** → **`config.storage`**. CLI flag `--backend` → `--storage`. No compatibility alias.

### Slice shape
- **Storage-returned `Slice`**: `{ id, title, body, state, readyForAgent, needsRevision, blockedBy }`. No computed fields.
- **Loop-internal slice view**: the loop wraps the storage's `Slice` into a richer in-memory type (`ClassifiedSlice` or similar) that adds `prState`, `branchAhead`, `bucket` when needed for classification. This wrapping happens inside the loop and is invisible to commands consuming `findSlices` for display (status, list).
- **`trowel status` and `trowel list`** that today render the slice's `bucket` either call the loop's classifier directly with the storage's raw slice, or read pre-classified output from a shared classification helper. Either way, the per-storage-`bucket`-assignment path in `findSlices` goes away.

### Storage shape simplifications

- **The `"Part of #${prdId}"` body trailer convention on the `issue` storage's slices is removed.** `createSlice` no longer appends the trailer; `findSlices` no longer calls `stripBodyTrailer`. The structural parent-link continues via GitHub's sub-issue REST API — the trailer was a visual breadcrumb that the storage was forced to bookkeep on every read/write. The trailer's hidden round-trip (append on write, strip on read) was a small but real source of complexity for what was purely a UX-on-GitHub-web hint; removing it shrinks the issue storage's surface and removes a divergence from the file storage that earned nothing structurally.
- **`PrdSummary` gains a `createdAt: string` field** (ISO timestamp). The `issue` storage reads native `created_at` from the GitHub issue object; the `file` storage reads it from `PrdStore`. Storages return unsorted; sorting is the consumer's responsibility. The current `file.ts:listPrds` internal `summaries.sort((a, b) => b.createdAt.localeCompare(a.createdAt))` is moved out into the command layer (e.g. `src/commands/list.ts`) so the rule "newest-first" applies uniformly regardless of storage, and other consumers can sort differently if they wish.

### Capability validation
- Validation runs at **config load**, after the storage instance is constructed but before any work happens. The validator reads `storage.capabilities` and walks the user's `config.work.*` flags. Any flag that requires a missing capability triggers a precise error: `config.work.<flag> requires capability '<cap>', but storage '<name>' does not declare it`.
- The `capabilities` field on `Storage` is a readonly object; storages declare it at construction. Future capabilities can be added as new boolean fields; missing capabilities default `false` at the validator's read.

### Migration / staging
- The pivot is large enough to land in multiple commits / PRs. A reasonable order:
  1. Introduce `Storage` type alongside `Backend` (or rename `Backend` directly — the codebase is small enough).
  2. Move `classifySlice` + `reconcileSlices` to the loop. `Slice` drops `bucket`/`prState`/`branchAhead`.
  3. Move `prepare*`/`land*` from storages to the loop. Storages lose all phase methods.
  4. Extract PR-flow utils to `src/work/pr-flow.ts`.
  5. Add `capabilities` + config-validation.
  6. Promote `perSliceBranches` to a top-level flag.
  7. Rename `--backend` / `config.backend` and finalize file moves.
- The two earlier ADRs (`2026-05-13-unified-gitops-via-module-factory.md`, `2026-05-13-file-backend-no-auto-commits.md`) are orthogonal and can land before or after this pivot in any order. They reference `BackendDeps`; their references update when this pivot's rename lands.

### Supersession (deferred to implementation)
- **`2026-05-12-unified-loop-via-backend-primitives.md`** is superseded. The per-role primitives it added to the `Backend` interface move off the storage into the loop driver. The "throw on unsupported phase" pattern goes away (there are no unsupported phases at the storage layer because storages no longer have phase methods).
- **`2026-05-11-backend-owns-slice-bucket-classification.md`** is superseded. Bucket classification moves to the loop; the storage no longer assigns buckets inside `findSlices`.
- **`2026-05-11-optional-pr-flow-on-issue-backend.md`** is superseded. The `usePrs` flag survives but is no longer storage-bound — it's a universal flag, capability-gated.
- **`2026-05-11-backend-native-blocker-storage.md`** stays valid: blocker storage is pure persistence and lives on `Storage`.
- **`2026-05-11-prd-unique-id-and-file-backend-layout.md`** stays valid: id format and on-disk layout are pure persistence.
- These ADRs are not edited yet — the prior decisions still describe the current code. Supersession lines (`Superseded by:` at the top of each old ADR) land when the corresponding implementation lands.
