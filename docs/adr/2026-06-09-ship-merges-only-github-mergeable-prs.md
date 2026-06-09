# Ship merges only GitHub-mergeable PRs

`trowel change ship` offers PR merge prompts only after GitHub reports the PR as mergeable. In PR mode, Ship may prompt for mergeable Slice PRs, merge accepted Slice PRs with `ship.mergeMethod`, reclassify and finalize those Slices, then recheck Change readiness before Close-out; the AFK loop remains non-interactive and never prompts to merge human-facing PRs.
