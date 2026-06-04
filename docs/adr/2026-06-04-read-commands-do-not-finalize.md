# Read commands do not finalize or lock

Entity read commands (`trowel change list`, `trowel change status`, and `trowel slice status`) only display current Change and Slice state; they do not acquire the Mutation lock, do not run Finalization, and do not switch the main working tree branch. A merged Close-out PR may therefore appear as `landed` until the user explicitly runs `trowel change ship <id>`, which is the only command that finalizes a landed Change and then runs Cleanup.

## Considered Options

- **Finalize from status/list.** Rejected because a read command would unexpectedly write storage and contend on the Mutation lock.
- **Switch branches from status/list to inspect repository facts.** Rejected because read commands should not disturb the user's main working tree; they may inspect external facts without checkout side effects.
- **Finalize from work.** Rejected because Work is for Slice execution and should not perform Change-level success-path finalization.
- **Finalize only from Ship.** Chosen because Ship is the explicit user intent boundary for shipping, finalization, and Cleanup.
