# Project work drains actionable Changes without shipping

Trowel will add `trowel change work` as the project-wide AFK loop. Project work discovers Changes oldest-first, drains actionable Slice work and Close-out PR revision work under one project-wide `turn.maxConcurrent` cap with global branch-safety, and deliberately does not run Ship, prompt for PR merges, run Cleanup, or finalize Changes so Work remains the non-interactive agent-execution boundary and Ship remains the human merge/finalization boundary.
