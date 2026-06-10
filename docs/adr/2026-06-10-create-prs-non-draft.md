# Create Trowel PRs as non-draft

Trowel-created Slice PRs and Close-out PRs will be created as open non-draft PRs directly. Trowel will not create draft PRs and immediately mark them ready, and it will not auto-promote existing draft PRs.

Existing open non-draft PRs for the same head branch are reused. Existing open draft PRs are treated as human-owned blockers: Work, Ship, and Status surface guidance to make the draft PR ready or close it before retrying. Closed unmerged PRs do not block creating a replacement PR. Merged PRs continue to prove landed state.

Amends earlier ADR language that described `openDraftPr`, `markPrReady`, or draft PRs as the normal Trowel-created review surface, including:

- [2026-05-11-gh-free-sandbox-host-owns-side-effects.md](./2026-05-11-gh-free-sandbox-host-owns-side-effects.md)
- [2026-05-12-agent-review-opt-in.md](./2026-05-12-agent-review-opt-in.md)
- [2026-05-12-unified-loop-via-backend-primitives.md](./2026-05-12-unified-loop-via-backend-primitives.md)
- [2026-05-13-storage-behavior-separation.md](./2026-05-13-storage-behavior-separation.md)
- [2026-05-14-decouple-pr-flow-from-storage.md](./2026-05-14-decouple-pr-flow-from-storage.md)

## Why

The old draft-first flow created a draft PR and immediately called `gh pr ready`. That transient draft state no longer represents a meaningful Trowel lifecycle step. It adds an extra GitHub operation, creates confusing event noise, and introduces a second failure point without protecting the user from anything: the intended next state is always an open non-draft PR.

Existing draft PRs are different. A draft PR may have been intentionally created or left in that state by a human. Auto-promoting it would cross a human-intent boundary, so Trowel reports guidance instead.

## Consequences

- `GhOps` exposes `createPr`, not `createDraftPr` or `markPrReady`.
- Slice integration opens non-draft Slice PRs directly.
- Close-out opens non-draft Close-out PRs directly.
- Polling Work treats draft PRs as deferred external state: it retries after the next poll rather than tight-looping or skipping for the entire process.
- Status and Ship explain draft PR blockers explicitly.

## Considered options

- **Keep draft-first and immediate ready.** Rejected because it preserves noisy, confusing behavior with no current workflow benefit.
- **Auto-promote existing draft PRs.** Rejected because draft status is human-owned intent; Trowel should not silently override it.
- **Add a new Change or Slice state for draft PR blockers.** Rejected for now. Existing states remain sufficient if Work, Ship, and Status provide precise guidance.
