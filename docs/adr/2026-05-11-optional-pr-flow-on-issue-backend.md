# PR flow is opt-out on the issue backend; no-PR mode merges slice branches into the integration branch

> **Superseded by:** [2026-05-13-storage-behavior-separation.md](./2026-05-13-storage-behavior-separation.md). The `usePrs` flag survives but is no longer storage-bound. It becomes a universal **Flag** on `config.work.*`, gated by storage **Capability** `prFlow` at config load: a user setting `usePrs: true` against a storage that doesn't declare `prFlow` errors before any work runs (rather than being "silently ignored"). The slice-branch / integration-branch disposition is governed by a separate orthogonal flag `perSliceBranches`. The text below describes the previous issue-backend-specific design.

Under `usePrs: false`:

- Slice branches are still created on the host via `gh issue develop <sliceN> --name prd-<prdId>/slice-<sliceN>-<slug> --base <integrationBranch>`. The slice-branch lifecycle structure (one branch per slice, named consistently, discoverable via `git branch --list prd-<prdId>/*`) is preserved — only the PR layer goes away.
- The **Implementer** runs the same way (fresh **Sandbox**, edits, commits, `Verdict`). The host's post-sandbox handoff for a `ready` verdict becomes: `git push origin <sliceBranch>` → local checkout of the integration branch → `git merge --no-ff <sliceBranch>` → `git push origin <integrationBranch>` → `git push origin --delete <sliceBranch>` → `gh issue close <sliceN>`.
- The **Reviewer** and **Addresser** are not invoked. `trowel review` / `trowel address` refuse with: "PR-driven review is disabled (`config.work.usePrs: false`); use `trowel work` for the implementer-only flow."
- Concurrency is preserved at the implementer step (each slice has its own branch; sandboxes run in parallel up to `config.sandbox.maxConcurrent`). The host-side merge step is serial — only one `git merge` against the integration branch at a time — which is a small bottleneck because merges are fast.
- A host-side merge that fails with a conflict coerces the slice's verdict to `partial`, leaves the slice branch in place (unmerged, undeleted), and logs the conflict. The user resolves manually and re-runs.

Merge strategy is `--no-ff` (not `--ff-only`, not `--squash`, not `rebase`): each slice produces a discoverable merge commit on the integration branch, so `git log --merges` on the integration branch shows the slice history at a glance. The historical context of which slice landed when is preserved.

## Considered options

- **PR-flow mandatory on issue backend; users who don't want PRs use the file backend.** Rejected: a project using `issue` for the PRD/slice tracking surface (GitHub sub-issues, the GitHub Projects view, the linked-branch sidebar) is still a legitimate choice even when the user doesn't want a draft PR per slice. Forcing such users to give up the entire issue-backend surface for the sake of one preference is over-coupled.
- **No slice branches in no-PR mode; commit straight to integration branch (collapse to file-backend behavior).** Rejected: loses the issue-backend's parallel-agent benefit. The slice-branch lifecycle is cheap (one `gh issue develop` call per slice) and preserves concurrency, which is one of the primary reasons to pick the issue backend in the first place.
- **Use a `--ff-only` merge.** Rejected: forbids merging when two slice branches' work has interleaved on the integration branch. Real concurrent AFK runs will produce such interleaving routinely.
- **Use `--squash` or `rebase`.** Rejected: rewrites history; users investigating "when did slice 145 land?" via `git log --merges <integrationBranch>` lose the answer. The slight extra history `--no-ff` produces is the point — each slice is a discoverable historical unit.
- **Make `usePrs` per-PRD (e.g. a flag on `PrdSpec`) rather than config.** Rejected: a user's preference for PR-flow vs no-PR is project-wide, not feature-wide. A per-PRD knob would just be set the same way for every PRD and would clutter the spec type.
- **Make `usePrs` per-slice.** Rejected: same as above, more extreme. The PR flow is a coherent mode of working; mixing PR-driven slices with merge-direct slices inside one PRD would produce a confusing integration-branch history (some slices arrive via merged PRs, others via direct merges) with no upside.

## Consequences

- The post-sandbox handoff table in `src/work/loops/issue.ts` branches on `config.work.usePrs` in the implementer's `ready` path. The reviewer and addresser paths are unreachable when `usePrs: false` because the per-phase commands refuse and `trowel work` skips those phases.
- `trowel close` (TODO Section 6) already accounts for the sub-issue close semantics. Under `usePrs: false` the sub-issues close as the loop runs (one per merged slice), so the integration-branch close-out has fewer open sub-issues to enumerate.
- The `gh issue close <sliceN>` host-side close is explicit (no PR's `Closes #N` auto-close to rely on). Idempotent: re-running on an already-closed sub-issue is a no-op.
- Users investigating slice history on the integration branch use the same `git log --merges` query regardless of whether the slice came in via a merged PR or a direct merge — both produce merge commits.
