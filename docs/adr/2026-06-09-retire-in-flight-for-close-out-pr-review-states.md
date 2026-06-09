# Retire in-flight for Close-out PR review states

Trowel will retire the broad Change `in-flight` state and classify open Close-out PRs as either `awaiting-review` or `needs-revision`. This deliberately reuses the PR-flow language already used by Slices, making human-review and revision states common across Slice PRs and Close-out PRs while keeping Ship as the merge/finalization boundary and Work as the agent-revision boundary.
