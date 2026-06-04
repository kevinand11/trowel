# Explicit ship owns Close-out

Close-out is a success-path operation that can merge or open a shipping PR against the Target branch, so it should require explicit user intent rather than being triggered automatically by the AFK loop. `trowel change work` stops after agent work and prints `trowel change ship <id>` guidance when every Slice is done; `trowel change ship <id>` is the only command that invokes Close-out, fails if any Slice is not in the `done` state, and may merge a Close-out PR only after an explicit prompt.

Consequences: Ship is Change-level only, restores the BACK_TO branch when possible, and local branch cleanup belongs to `ship.deleteBranch`; ship and abort cleanup never delete remote branches.
