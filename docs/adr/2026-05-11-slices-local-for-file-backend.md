# Slices are backend-managed; `file` backend stores them locally

The earlier repo-wide lock "slices are *always* GitHub issues" is overturned. Each backend now owns slice storage to match the backend's own storage model: the `file` backend persists slices as local directories alongside the PRD; the `issue` backend continues to use GitHub sub-issues. The `Backend` interface returns a uniform `Slice` shape across backends; the storage details are private.

On disk for the `file` backend:

```
<prdsDir>/<prd-id>-<prd-slug>/
├── README.md
├── store.json
└── slices/
    └── <slice-id>-<slice-slug>/
        ├── README.md      ← slice spec body
        └── store.json     ← slice metadata
```

Slice id format mirrors PRD id: 6-character base-36 random, globally unique (collision-checked across all PRDs' `slices/`).

The uniform `Slice` shape becomes:

```ts
type Slice = {
  id: string
  title: string
  body: string
  state: 'OPEN' | 'CLOSED'
  readyForAgent: boolean
  needsRevision: boolean
}
```

Workflow signals (`readyForAgent`, `needsRevision`) are explicit booleans on the `Slice`, not GitHub labels in a string array. The `issue` backend translates between GitHub labels and these booleans using the `config.labels.readyForAgent` / `config.labels.needsRevision` strings; the `file` backend stores them in `store.json`.

The `Backend` interface for slices is `createSlice(prdId, spec) → Slice`, `findSlices(prdId) → Slice[]`, `updateSlice(prdId, sliceId, patch) → void`. The earlier `attachSlice` and `sliceMarker` methods are gone: `attachSlice` is folded into `createSlice` (which actually creates the slice, including composing the body trailer for the `issue` backend), and `sliceMarker`'s purpose is now an internal detail of `createSlice` for the `issue` backend.

## Considered options

- **Keep "slices are always GitHub issues" repo-wide.** Rejected: the `file` backend was meant to be a local-first option, but routing every slice through GitHub re-introduced the same friction (auth, network, public visibility for personal experiments) we were avoiding for the PRD body itself.
- **Cache GitHub-issue slices locally to mimic local storage.** Rejected: caches drift. GitHub remained the source of truth, so the local store added complexity without changing the experience.
- **Keep `labels: string[]` on `Slice` and let consumers string-match.** Rejected: every consumer would need to know the configured label strings to interpret the array. Explicit booleans put the semantics in the type system.
