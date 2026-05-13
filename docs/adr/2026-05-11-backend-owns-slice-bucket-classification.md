# Backends own slice bucket classification

> **Superseded by:** [2026-05-13-storage-behavior-separation.md](./2026-05-13-storage-behavior-separation.md). Under the storage / behavior split, bucket classification moves from the storage to the AFK-loop driver. The storage's `findSlices` returns a raw `Slice` without a `bucket` field; the loop computes the bucket from the raw slice plus PR-state queries (when `usePrs: true`). The text below describes the previous design.

`trowel status <prd-id>` groups slices into mutually-exclusive **Buckets** that describe a slice's position in its lifecycle. The bucket is assigned by the backend inside `findSlices`, not by the status command. `Slice` gains a `bucket` field as part of the interface contract; status reads it and renders.

The six buckets, evaluated top-to-bottom (first match wins):

| Bucket | Predicate |
|---|---|
| `done` | `state === 'CLOSED'` |
| `needs-revision` | OPEN + `needsRevision` |
| `in-flight` | OPEN + has an open PR targeting the integration branch (**`issue` backend only**) |
| `blocked` | OPEN + at least one id in `Slice.blockedBy` points at a non-`done` slice |
| `ready` | OPEN + `readyForAgent` + !in-flight + !blocked |
| `draft` | OPEN + `!readyForAgent` |

`in-flight` is the only bucket whose predicate depends on backend capabilities: the `file` backend has no PR concept (slices are local directories; their implementation does not flow through a GitHub PR), so `in-flight` never fires there. Putting the predicate inside each backend lets the `file` backend skip the bucket entirely without an `if (backend === 'issue')` branch in the orchestrator.

Blocker ids come from `Slice.blockedBy` directly — each backend reads them from its native storage (issue: GitHub `dependencies/blocked_by` API; file: `store.json.blockedBy`). See ADR `backend-native-blocker-storage` for the storage details. The earlier `src/utils/deps.ts` body-trailer parser is gone; the classifier reads `slice.blockedBy.filter(id => !doneIds.has(id))` directly. The classifier itself is shared — both backends invoke the same `classify(slice, ctx) → bucket` function, varying only the `ctx` argument (a small record describing what the backend can answer about a slice, e.g. `{ hasOpenPr: boolean, unmetDepIds: string[] }`).

## Considered options

- **Status computes the bucket.** Rejected: status would need to ask the backend for per-slice signals not on the `Slice` type (PR existence, dep targets) and re-implement the classifier. Two consumers (`status` today; `work`/`address`/`review` later) would each duplicate the bucketing logic, or it would migrate into a shared util that ends up calling backend methods anyway — at which point the backend owning it is simpler.
- **Add raw signals to `Slice` (`prNumber: number | null`, `unmetDeps: string[]`) and let consumers classify.** Rejected: leaks backend-specific concepts onto a shape that is supposed to be backend-neutral. The `file` backend would carry a permanently-null `prNumber` field whose absence is meaningful — a confusing API.
- **Per-backend `Bucket` enums.** Rejected: status would need to render N different vocabularies. Unifying the enum and skipping inapplicable buckets (the `file` backend never emits `in-flight`) keeps the type narrow and the renderer single-source.
