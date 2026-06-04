# Fix as a slice-without-PRD; unified Close-out for PRDs and Fixes

> **Historical note:** the Reconciliation/read-command behavior described below is superseded by [2026-06-04-read-commands-do-not-finalize.md](./2026-06-04-read-commands-do-not-finalize.md). Entity read commands are lock-free and never run Finalization; Ship owns Change-level Finalization after a landed Close-out.

Trowel today has two top-level entities: the **PRD** (heavyweight, sliced, run by `trowel work`) and the slice (sub-entity of a PRD). Bug-fix work has no canonical surface — the `trowel fix` stub was a one-shot agent run with no entity tracking, no symmetry with PRD/slice machinery, and no shared shipping logic.

This ADR introduces a third first-class entity, **Fix**, and a shared **Close-out** step that ships both PRDs and Fixes through the same code path. The two pieces are entwined: Fix is defined as "a slice without a PRD," and that definition is what makes a unified Close-out tractable.

## The Fix entity

A **Fix** has its own id, drawn from the same project-wide pool as PRD ids and slice ids (per ADR `2026-05-17-file-storage-deterministic-shared-ids.md`). On `file` storage it lives at `config.docs.fixesDir/<id>-<slug>/store.json` — a new directory peer to `prdsDir/`. On `issue` storage it is a GitHub issue tagged with `config.labels.fix`. The storage interface gains `createFix`, `findFix`, `findFixes`, `updateFix`, `closeFix` — mirroring the PRD CRUD methods.

A Fix has no slices of its own. Structurally it is a slice: it runs through the same Turn machinery (implement → optionally review → address, gated by `config.work.review`), it carries the same flags (`readyForAgent`, `needsRevision`), and it has its own working branch (`fix/<id>-<slug>`). Where a slice's branch lives off a PRD's **Integration branch**, a Fix's branch lives off `config.baseBranch` directly — Fix has no integration layer.

The `config.work.perSliceBranches` flag does **not** apply to Fix. The flag is named for slices and means "slice gets its own branch (true) vs commits directly on integration (false)." A Fix's analog under `false` would be "commit directly on `baseBranch`" — qualitatively different (integration is feature WIP; `baseBranch` is shipped state). Fix is always on its own branch.

## Unified Close-out

An entity becomes **closeable** when its internal work is done. For a PRD: every Slice is CLOSED. For a Fix: the phase loop converges (implement `ready`, plus review/address convergence if `config.work.review`).

When closeable, **Close-out** fires inside `runLoop` — `trowel work prd <id>` and `trowel work fix <id>` both route through it. The action branches on `config.work.usePrs`:

- `usePrs: true` — opens a PR from the entity's branch (PRD's integration branch; Fix's `fix/<id>-<slug>` branch) against `config.baseBranch`. Entity stays OPEN. The human merges on GitHub; **Reconciliation** later observes the merge and flips entity to CLOSED.
- `usePrs: false` — host-merges the entity's branch into `config.baseBranch` via `git merge --no-ff`, then marks entity CLOSED immediately.

Branch deletion at Close-out is gated by `config.close.deleteBranch`. `'always'` deletes the entity branch (local + remote) after shipping; `'never'` keeps it; `'prompt'` coerces to `'never'` during auto Close-out (the loop is non-interactive). Slice branches remain unconditionally deleted at their own merge-into-integration step — they are ephemeral WIP, not policy-gated.

`trowel close prd <id>` / `trowel close slice <id>` / `trowel close fix <id>` remain the **manual abort** path: set state CLOSED on the storage record, optionally delete branches per `config.close.deleteBranch`, but **do not** merge or open a PR. Manual close is for abandoning work; auto Close-out is for shipping.

## Generalised runLoop

`runLoop` generalises over the entity kind. It is parameterised by an entity (a PRD or a Fix) and operates over that entity's actionable units (slices for a PRD; the Fix itself for a Fix). Close-out fires when units converge. Same function, same tests, same termination path.

## Considered options

- **Fix as degenerate PRD** (one entity kind, slice-less PRDs are fixes, distinguished by a `kind` field). Rejected: collapses CLI ergonomics (`trowel list prd --kind fix` instead of `trowel list fix`), forces a single filesystem area to hold conceptually-different artifacts, and creates a `findPrds`-without-filter foot-gun.
- **Fix as its own entity but no shared Close-out** (each entity has bespoke shipping logic). Rejected: duplicates the `usePrs`-branching merge/PR logic in two places. The shared Close-out is the payoff for the entity-symmetry framing.
- **Fix shares the PRD's integration branch model** (each Fix has a "fix integration branch" with the agent committing on a sub-branch that PRs into it). Rejected: adds a layer for no benefit. Fix has no sub-entities to merge in; the extra branch level is bookkeeping.
- **Auto Close-out fires PR-merge-then-CLOSED in one transaction** under `usePrs: true`. Rejected: GitHub merge is external; trowel cannot transact it. This historical option's read/write posture was later superseded by ADR `2026-06-04-read-commands-do-not-finalize.md`.
- **`trowel close` does double duty** (manual abort + force-ship). Rejected: collapsing "abort" and "ship" under one verb makes the dangerous case (accidental ship) as easy as the safe case (abort).
- **Co-locate Fixes under `prdsDir/`** with a `kind` marker. Rejected: `prdsDir` is named for PRDs; layering violation. Separate `fixesDir` keeps the filesystem semantics clean.
- **Fix gets a separate id pool** (fix ids count from 1 independently). Rejected: reintroduces the cross-entity ambiguity the shared-pool ADR retired (a directory named `5-tabs-fix/` could collide with `5-add-sso/`). Shared pool keeps "an integer prefix is an entity number" unambiguous.

## Consequences

- New entity, new commands, new storage methods, new config knobs (`config.docs.fixesDir`, `config.labels.fix`).
- `trowel work` adopts a scope token: `trowel work prd <id>` / `trowel work fix <id>`. Old `trowel work <prd-id>` shape retires.
- `trowel fix` becomes a *create-only* interactive grill (mirror of `trowel start`); execution flows through `trowel work fix <id>`.
- `runLoop` is refactored to operate over `LoopEntity = { kind: 'prd' | 'fix'; ... }`; today's PRD-only signature retires.
- Close-out is a new phase between "last actionable unit done" and "loop exits"; it is idempotent (re-running `trowel work` on an already-shipped entity is a no-op or a Reconciliation-only pass).
- Historical Reconciliation behavior was later superseded by ADR `2026-06-04-read-commands-do-not-finalize.md`; Ship now owns Change-level Finalization after a landed Close-out.
