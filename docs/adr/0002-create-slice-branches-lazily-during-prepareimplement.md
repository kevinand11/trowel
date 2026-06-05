# Create Slice branches lazily during prepareImplement

New Slices store `sliceBranch: null` until the first `prepareImplement` call needs a branch. At that point trowel uses the current `work.perSliceBranches` config: if per-Slice branches are enabled, it fetches the latest remote Change branch, creates and pushes the Slice branch from that tip, then stores the branch metadata; if per-Slice branches are disabled, it stores the Change branch as the Slice branch. This delays branch creation until work starts, reducing stale bases and merge conflicts while keeping branch identity durable once work has begun.

## Considered Options

- **Create all Slice branches during Change materialisation.** Rejected because dormant Slice branches grow stale as earlier Slices land, increasing avoidable merge conflicts.
- **Store planned Slice branch names before branches exist.** Rejected because durable metadata should identify real branch identity, not a prediction.
- **Infer the branch decision from creation-time config.** Rejected because nullable branch metadata intentionally delays the branch decision; unprepared Slices should use current config at prepare time.
