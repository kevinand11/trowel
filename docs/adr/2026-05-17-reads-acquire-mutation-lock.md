# Reads acquire the mutation lock for reconciliation; concurrent invocations are out of scope

ADR `2026-05-17-file-storage-deterministic-shared-ids.md` locked the posture that read-only commands (`status`, `list`, `config`, `doctor`) do not acquire the **Mutation lock**. Its reasoning: reads-that-don't-write don't risk corruption and shouldn't pay the lock cost or risk `trowel busy` failures under contention. The original ADR also explicitly weighed "backgrounded `trowel work` plus an interactive `trowel status` in another shell" as a real case the read-free posture protected.

This ADR amends that posture in light of the unified **Close-out** model and the **Reconciliation** discipline it introduces (see ADR `2026-05-17-fix-entity-unified-close-out.md`). Reconciliation is the act of observing an external PR's `merged` status on GitHub and writing it back to the storage record (OPEN → CLOSED). Under `config.work.usePrs: true`, a PRD or Fix stays OPEN after Close-out opens its PR; the entity transitions CLOSED only when GitHub reports the PR merged. For `status` and `list` output to honour the CLOSED-means-merged-into-baseBranch invariant, reads must *observe* that external transition — and observing means writing.

The amended rule: **every command that touches a PRD, Slice, or Fix acquires the Mutation lock**, including `status` and `list`. Only `config` and `doctor` (which never touch entity state) remain lock-free. The previous read/write distinction in lock acquisition retires.

The trade-off the original ADR weighed (background `trowel work` racing with an interactive read) is resolved by an opposite stance: **concurrent trowel invocations are out of scope.** Trowel is single-user and, in practice, single-terminal — the user does not run a background `trowel work` while iteratively `trowel status`-ing in another shell. Under contention, `trowel busy` is the documented failure mode; surfacing it is better than the previous "reads might quietly observe stale state because they refused to write."

## Considered options

- **Conditional lock acquisition** (reads start lock-free; only acquire if reconciliation discovers something to write). Rejected during grilling: adds branching complexity to every read path for a contention case the user has deemed out of scope.
- **Add a separate `trowel reconcile` command** (reads stay lock-free; users explicitly refresh state). Rejected: relegates the canonical CLOSED-means-merged invariant to user discipline. `status` would show CLOSED-PR-but-OPEN-storage by default, which contradicts the invariant.
- **Display-only freshness in reads** (fetch GH state for display but never write). Rejected: storage record drifts permanently if the user never runs a mutating command. The invariant has to live in storage, not in display logic.
- **Keep the original posture and accept stale storage** (read commands never reconcile; user runs `trowel work` to refresh). Rejected: the user explicitly wanted reconciliation to fire on any entity-touching command, not gated by command type.

## Consequences

- `status` and `list` may fail with `trowel busy` if invoked while `trowel work` (or another mutation) holds the lock. The contention path matches every other entity-touching command — no special case.
- `config` and `doctor` remain lock-free (no entity touch).
- The **Mutation lock** entry in `docs/CONTEXT.md` is updated to reflect the new rule. Future readers see the new posture as the canonical one; this ADR records the chronology.
- The original ADR's reasoning section ("backgrounded `trowel work` plus an interactive `trowel close prd 3` can absolutely race") is no longer load-bearing — the lock still serialises that case; the difference is that *reads also serialise*, and the user has accepted `trowel busy` on contention.
