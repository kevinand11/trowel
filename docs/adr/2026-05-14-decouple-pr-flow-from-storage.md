# Decouple PR-flow from Storage; retire `Capability`; software preconditions move to `trowel doctor`

> **Amends:** [2026-05-13-storage-behavior-separation.md](./2026-05-13-storage-behavior-separation.md). The storage / behavior split it introduced stays; the `Capability` primitive and `capabilities.prFlow` field it introduced retire.

The `2026-05-13` pivot split the `Backend` god-class into a thin `Storage` (pure persistence) and a fat loop driver. PR-flow operations (`openDraftPr`, `markPrReady`, `fetchPrFeedback`, `getPrState`) moved into free utility functions under `src/work/pr-flow.ts`. To stop the user from enabling `usePrs: true` against a storage that has no PR/review surface (the `file` storage), the same ADR introduced a `capabilities.prFlow: boolean` primitive on `Storage`, gated `config.work.usePrs` and `config.work.review` at config load against it, and added defensive `requirePrFlow` throws in the reviewer/addresser phases.

That gate is now removed. **PR-flow is a behavior driven by `config.work.*` flags alone; it works on every storage.** The `Capability` concept retires. Storage shrinks further: it owns persistence, branch-naming convention, and label/flag encoding, nothing else. Tool availability (`gh`, GitHub remote, `claude` on PATH) is not a storage opinion and not a config flag — it's the concern of a forthcoming **`trowel doctor`** diagnostic command. The loop runs and lets missing tools fail naturally; doctor is the discovery surface for users who want to know what trowel needs given their config.

The post-pivot flag matrix collapses to one table, identical across every storage:

| `usePrs` | `review` | behavior |
|---|---|---|
| `false` | — | implementer pushes; if `perSliceBranches: true` the loop host-merges the slice branch into the integration branch (`git merge --no-ff`); slice closes |
| `true` | `false` | implementer pushes; loop opens a draft PR (slice → integration); loop returns `progress` and exits the slice — human reviews |
| `true` | `true` | implementer pushes; loop opens a draft PR; reviewer / addresser phases run against the PR; loop marks the PR ready and the slice closes when the agent reaches a `ready` verdict |

Flag combination validity is enforced **at config load**, storage-independent:

- `review: true` requires `usePrs: true`.
- `usePrs: true` requires `perSliceBranches: true` (no slice branch → no PR head — previously a silent footgun under the prior matrix).

The `Slice` returned by `findSlices` becomes truly raw: `{ id, title, body, state, readyForAgent, needsRevision, blockedBy }`. `prState` and `branchAhead` are populated by the loop after fetch, via `enrichSlicePrStates(deps.gh, prdId, slices)`, only when `config.work.usePrs: true`. The issue storage's `findSlices` stops pre-enriching; the file storage stops hard-coding `null`/`false`. The downstream consumers (the classifier, status, list) see one source-of-truth path: storage gives raw slices, the loop optionally enriches.

`Storage.capabilities` is removed. `storageCapabilities` in `src/storages/registry.ts` is removed. The `requirePrFlow` guard at the top of `prepareReview` / `prepareAddress` / `landReview` / `landAddress` in `src/work/phases.ts` is removed. The `config.preconditions.requireGhAuth` flag retires; so does the `which claude` preflight added in `_loop-wiring.ts` during the host-exec Turns pivot. Both checks move (deferred) into `trowel doctor`.

## Considered options

- **Keep `capabilities.prFlow` and just flip `file` storage's value to `true`.** Rejected: it's a lie — the `file` storage doesn't have a different PR-flow surface than `issue` storage; the surface is `gh` plus a GitHub remote, neither of which is a storage property. Keeping the field would force the file storage to claim `prFlow: true` even on a local-only repo with no remote, where `gh pr create` will fail. The capability primitive was answering the wrong question (which storage do I have?) instead of the right one (does my environment have `gh` + a remote?).
- **Make `usePrs: true` require a runtime precondition check (`gh auth status` + `origin` is a github.com remote) at command start.** Rejected: software/environment availability is `trowel doctor`'s concern. Bolting per-flag preconditions into the loop reintroduces the kind of "storage knows what tools it needs" coupling we're removing. Tools that aren't present fail naturally when the loop tries to use them; doctor surfaces them ahead of time as a separate diagnostic.
- **Soft fall-through: `usePrs: true` on a repo without `gh` silently degrades to `usePrs: false`.** Rejected on the same grounds as the prior pivot's same rejection (ADR `2026-05-13`, Considered Options): silent mode-switching hides the user's intent and makes debugging hostile.
- **Soft fall-through: `usePrs: true && perSliceBranches: false` silently behaves like `usePrs: false`.** Rejected: same reason; today's silent ignore in `landImplement`'s `!perSliceBranches` branch becomes a hard config-load error.
- **Retire `usePrs` entirely; fold "PR is opened" into `review: true`.** Rejected: the "draft PR for human review only" mode (`usePrs: true && review: false`) is a legitimate workflow — the agent implements, the user reviews. Collapsing to one flag would force users into either a fully human flow or a fully agent flow, with no halfway. Two flags + the constraint matrix is small enough to keep.
- **Split `prFlow` into multiple capabilities (`pr`, `reviewerFeedback`).** Rejected: never reached the implementation; speculative for a hypothetical Gerrit-shaped storage. With capabilities now retiring entirely, also moot.

## Consequences

### Storage interface
```ts
interface Storage {
  readonly name: string
  readonly defaultBranchPrefix: string
  // no `capabilities` field

  createPrd(spec: PrdSpec): Promise<{ id: string; branch: string }>
  branchForExisting(id: string): Promise<string>
  findPrd(id: string): Promise<PrdRecord | null>
  listPrds(opts: { state: 'open' | 'closed' | 'all' }): Promise<PrdSummary[]>
  closePrd(id: string): Promise<void>

  createSlice(prdId: string, spec: SliceSpec): Promise<Slice>
  findSlices(prdId: string): Promise<Slice[]>  // raw — no prState/branchAhead
  updateSlice(prdId: string, sliceId: string, patch: SlicePatch): Promise<void>
}
```

### Config schema
- `config.work.usePrs: boolean` survives, default `false`. New validation: errors at config load if `perSliceBranches: false`.
- `config.work.review: boolean` survives, default `false`. Validation unchanged (requires `usePrs: true`).
- `config.work.perSliceBranches: boolean` survives, default `true`. Unchanged.
- `config.preconditions.requireGhAuth` retires (the field is removed from the schema). `requireCleanTree` and `requireGitRoot` stay — those are state checks, not software checks.

### Loop
- `src/work/loop.ts` calls `enrichSlicePrStates(deps.gh, prdId, raw)` whenever `config.work.usePrs: true`, regardless of storage. The existing `if (!storage.capabilities.prFlow) return raw` gates retire.
- `reconcileSlices` (`src/work/reconcile.ts`) runs when `usePrs: true`, regardless of storage. The current capability gate retires.
- `src/work/phases.ts`: `requirePrFlow` is deleted. `prepareReview` / `landReview` / `prepareAddress` / `landAddress` no longer throw based on storage; the `usePrs` check inside `landImplement` is preserved (it picks PR vs host-merge).

### Storage implementations
- `src/storages/implementations/issue.ts`: `capabilities: { prFlow: true }` removed. `findSlices` stops calling `enrichSlicePrStates` internally — returns raw slices. The test `declares capabilities.prFlow = true` is deleted; tests that depended on storage-side PR-state enrichment are rewritten to enrich at the loop layer.
- `src/storages/implementations/file.ts`: `capabilities: { prFlow: false }` removed. `findSlices` keeps returning `prState: null, branchAhead: false` until the type is fully simplified; once `Slice` drops those fields, the `null`/`false` literals go away. Tests asserting `prepareReview` throws `'review requires capability prFlow'` are deleted — `prepareReview` no longer throws on the file storage; if `usePrs: true && perSliceBranches: true`, it really does open a PR.
- `src/storages/registry.ts`: `storageCapabilities` is removed.

### Commands
- The `trowel review` / `trowel address` per-phase command wrappers in `src/commands/{review,address}.ts` no longer special-case the file storage. They run on any storage where `usePrs: true && review: true` is configured. Refusal messages that referenced `capability 'prFlow'` retire.
- `_loop-wiring.ts`: the `which claude` preflight at `buildLoopWiring` retires. The `await tryExec('which', ['claude'])` block is removed; the loop spawns `claude` and lets it fail naturally if absent. Discovery moves to `trowel doctor` (deferred).
- A new `trowel doctor` command is **scoped but not implemented in this ADR**. It will enumerate trowel's tool dependencies (`git`, `gh`, `claude`) and check their availability + auth state given the project's resolved config (e.g. only nag about `gh` if `config.work.usePrs: true`). Implementation is a separate session.

### Bucket classification
- `in-flight` bucket: previously documented as reachable only under `usePrs: true && prFlow capability`. Now reachable under `usePrs: true` on any storage.
- `draft` bucket: same — was file-storage-impossible by capability, now reachable.

### CONTEXT.md
- The `Capability` glossary entry is deleted (moved to `Flagged ambiguities` as a historical note).
- `Storage`, `Flag`, `Bucket`, Relationships, Example dialogue, and Out of scope entries are updated to drop capability references and reflect the new flag-only model.

## Supersession notes

- **[2026-05-13-storage-behavior-separation.md](./2026-05-13-storage-behavior-separation.md)** — *amended*, not superseded. The Storage/loop split, the PR-flow utils, the `perSliceBranches` flag promotion, and the `Slice` shape simplification all stand. The `Capability` primitive that ADR introduced is the only piece this ADR retires.
- **[2026-05-11-optional-pr-flow-on-issue-backend.md](./2026-05-11-optional-pr-flow-on-issue-backend.md)** — already marked superseded by 2026-05-13; the supersession deepens here. `usePrs` is no longer storage-bound *and* no longer capability-gated; it is a uniform flag, validated against other flags only.
- **[2026-05-11-afk-loop-asymmetric-across-backends.md](./2026-05-11-afk-loop-asymmetric-across-backends.md)** — superseded. The asymmetry (issue storage = full state machine; file storage = implementer-only) was the original reason for the `prFlow` gate. Under this ADR the loop is symmetric across storages; asymmetry, when it exists, comes from the user's flag choices, not the storage choice.
