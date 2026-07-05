# Entity target branch is captured from invocation branch

`trowel change start` and `trowel fix` now store a **Target branch** on the entity: the branch the user was on for the invocation that materialised the PRD or Fix. Trowel creates the entity's working branch from that target and Close-out ships the entity back into that same target, either by opening a PR against it (`usePrs: true`) or by host-merging into it (`usePrs: false`).

This replaces the earlier implicit default-branch behaviour (`git.baseBranch()`) for normal new entities. Legacy PRDs/Fixes without stored target metadata continue to fall back to `git.baseBranch()`.

Manual abort close follows the same target-aware safety rule: deleting a PRD integration branch is checked against the PRD target branch, deleting a Fix branch is checked against the Fix target branch, and deleting a Slice branch is checked against its PRD integration branch.
