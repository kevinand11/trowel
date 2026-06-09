# Remove Slice command surface in favor of Change-level orchestration

Trowel will remove the `trowel slice ...` command surface entirely: Slice inspection happens through `trowel change status <change-id>`, and Slice state transitions happen through the **AFK loop** via `trowel change work <change-id>`. This gives one orchestration boundary for Slice lifecycle changes and avoids preserving manual expert overrides that can drift from scheduler, effective-state, and branch-safety behavior.
