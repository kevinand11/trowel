# Slice review state comes from review surfaces, not storage flags

Slice review state is split from storage flags: Slices store process milestones (`implementedAt`, `auditedAt`, and `closedAt`) but do not store `needsRevision`. The computed Slice states add `implemented`, `audited`, and `awaiting-review`: implementation and Auditing are agent-completion milestones, while `awaiting-review` and `needs-revision` come from the PR review surface when Slice PRs exist. This avoids treating branch-ahead facts or stored booleans as review truth, and keeps PR-less Auditing as a branch-diff quality gate while PR-connected Reviewer work is driven by actual PR feedback.

## Considered Options

- **Keep stored `needsRevision`.** Rejected because it creates a second source of truth beside PR review state and labels.
- **Infer implementation from Slice branch commits.** Rejected because a branch can be ahead of the Change branch while the Implementer is still incomplete.
- **Use PRs for every review flow.** Rejected because `ship.pr: false` should support PR-less Auditing before host-merging a Slice branch.
