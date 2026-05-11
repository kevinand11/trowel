# Backend-native blocker storage; no body trailers

A **Slice** carries `blockedBy: string[]` listing the ids of other slices in the same **PRD** that block it. Each backend stores this list using its native idiom; there is no cross-backend body-trailer convention.

- The `issue` backend uses GitHub's REST `dependencies/blocked_by` endpoint family (stable as of API version `2026-03-10`):
  - Read: `GET /repos/{o}/{r}/issues/{n}/dependencies/blocked_by` → array of issue objects (full pagination supported via `gh api --paginate`).
  - Write add: `POST /repos/{o}/{r}/issues/{n}/dependencies/blocked_by` with `-F issue_id=<int>` (the **internal id**, not the issue number; `-F` is required so `gh api` types the value as integer — `-f` will fail with HTTP 422).
  - Write remove: `DELETE /repos/{o}/{r}/issues/{n}/dependencies/blocked_by/<issue_id>` (idempotent: returns 200 on already-removed).
  - Every issue object now carries `issue_dependencies_summary: { blocked_by, blocking, total_blocked_by, total_blocking }` inline. `findSlices` reads `total_blocked_by` to skip the per-slice `GET` when there are no blockers; only slices with a non-zero count incur the extra round-trip.
- The `file` backend stores `blockedBy: string[]` as a flat field on each slice's `store.json` (alongside `readyForAgent`, `needsRevision`).

Both `createSlice(prdId, spec)` and `updateSlice(prdId, sliceId, patch)` accept the **full array** of blocker ids. The backend computes the diff against the existing list and emits the right writes:

- `file` backend: overwrite `store.json.blockedBy` atomically.
- `issue` backend: diff old vs new; emit one `POST` per added blocker, one `DELETE` per removed blocker (sequential — the API has no bulk operation).

Because the create/update spec is a complete list, `SliceSpec` and `SlicePatch` both expose `blockedBy: string[]` directly. `PrdSpec` does **not** carry blockers — PRDs cannot block other PRDs in trowel's model — so the spec types are split: `PrdSpec = { title, body }` and `SliceSpec = { title, body, blockedBy }`.

Backends do **not** validate that ids in `blockedBy` resolve to real slices. The `Bucket` classifier already tolerates unknown ids: an id not in the `done` set is "unmet," whether it doesn't exist or just isn't done. Validation is the orchestrator's job (the layer that wires user input → `updateSlice`).

The inverse relationship (`blocking`) is **not** a field on `Slice`. Renderers that want it derive it once across the slice list: `blocking[X] = slices.filter(s => s.blockedBy.includes(X)).map(s => s.id)`. This keeps the field authoritatively single-direction-of-truth and avoids a staleness category where the issue backend's API-fetched `blocking` could disagree with what the local slice array says.

## Considered options

- **Keep the body-trailer convention (`Depends-on:` lines parsed from slice body text).** Rejected: works uniformly across backends but creates a free-form, parser-dependent source of truth for a relationship that has structured representations natively available. The parser is fragile (final-paragraph rule, key-value shape requirements) and adds two layers between user intent and the dep graph (write trailer → parse trailer → resolve ids).
- **Coexist: native source of truth, body trailers as fallback.** Rejected: re-introduces the same source-of-truth ambiguity the move was intended to remove. A slice with both a `blockedBy: [57]` native relation and a `Depends-on: 99` trailer leaves one of the two silently shadowed. No combination of "native wins" or "trailer wins" eliminates the question of which is authoritative.
- **Coexist: trailers canonical, native cached.** Rejected: makes the GitHub UI's "Blocked by" panel a read-only mirror that's always one parse-and-sync step out of sync with the slice body. Defeats the purpose of using the native API at all.
- **Hidden HTML comment markers in body (e.g. `<!-- trowel:blockedBy: 57,99 -->`).** Rejected: this is the trailer convention with worse ergonomics — invisible in the rendered issue, still requires a parser, still in the body. Would only have been justified if the GitHub API turned out to be preview-only or `gh api`-uncallable. The 2026-05-11 spike confirmed it is neither.
- **Bidirectional storage on `Slice` (`blockedBy` and `blocking` both materialised).** Rejected: the second field is pure derivation from the first across the slice list; storing both invites them to drift. The render-time helper is ~5 lines.
- **Granular `addBlocker` / `removeBlocker` methods on `Backend`.** Rejected: breaks the existing declarative-patch shape of `SlicePatch` (every other field is "here is the new value"). The full-array semantics convert to GitHub's per-relation `POST`/`DELETE` calls inside the backend; consumers see the simple shape.
- **Combined `PrdSpec` with optional `blockedBy?: string[]`.** Rejected: PRDs have no blocker concept, so the optional field is a lie in the type signature. Splitting into `PrdSpec` and `SliceSpec` matches the actual domain.
