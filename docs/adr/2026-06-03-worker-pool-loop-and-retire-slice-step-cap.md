# Worker-pool AFK loop and retired sliceStepCap

Date: 2026-06-03

## Status

Accepted

## Context

The PRD AFK loop used fixed batches: it selected actionable slices, ran `processSlice` for each slice in a batch with `Promise.allSettled`, and waited for the entire batch before scheduling more work. `processSlice` also had an inner `sliceStepCap` loop that could advance one slice through multiple phase steps before releasing its concurrency slot.

That meant a fast slice could finish implementation and become review-eligible while a slower sibling was still implementing, but review would not start until the whole current batch settled. It also made `sliceStepCap` meaningful only because a single claim could contain several phase steps.

The desired behavior is that every slice proceeds independently. A completed phase should release its worker slot immediately, and the scheduler should refetch storage/PR state before choosing the next phase step.

## Decision

Replace fixed batch scheduling with a shared worker-pool scheduler.

Each worker-pool claim runs exactly one phase step for one Slice (`implement`, `review`, or `address`) and then releases the slot. The scheduler refetches storage and PR state before each new claim, so scheduling decisions are based on current Slice buckets and PR state, not stale batch snapshots.

Retire `config.work.sliceStepCap`. Because one claim is exactly one phase step, a per-claim step cap is meaningless. Existing config files that still contain `work.sliceStepCap` must be rejected as using a retired key rather than silently accepted.

## Consequences

- A slice that finishes implementation early can advance to review while another slice from the previous batch is still implementing, subject to the same shared concurrency limit.
- `config.turn.maxConcurrent` remains the total cap across all agent phase turns, not a per-role cap.
- Every phase step must win a fresh scheduler claim after state refetch.
- Loop safety no longer relies on `sliceStepCap`; it relies on fresh state, per-run partial/error suppression, and each phase landing a durable transition before another phase can be claimed.
- Projects with `work.sliceStepCap` in config must remove that key.

## Alternatives considered

### Keep fixed batches

Rejected. It preserves the current batch barrier and prevents independent phase advancement for fast slices.

### Worker pool with multi-step claims

Rejected. It keeps a worker slot occupied by one slice through multiple transitions and weakens fairness across slices.

### Keep `sliceStepCap` as a per-slice-per-run budget

Rejected. It would preserve a safety knob, but the desired model is simpler: one claim is one phase step, and stale configs should be cleaned up instead of carrying a renamed semantic.

### Accept retired `sliceStepCap` silently

Rejected. Silent acceptance makes the config misleading; users may believe the knob still controls loop behavior.
