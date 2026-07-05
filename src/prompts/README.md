# Prompts

Markdown templates fed to the configured agent harness when trowel launches an agent Turn. Each role prompt is static and instructs the agent to read `.trowel/turn-in.json` and write `.trowel/turn-out.json`.

Current role prompts:

- `implement.md` — Implementer first-cut Slice work.
- `audit.md` — Auditor branch-diff quality gate; compares the Slice branch against the Change branch.
- `review.md` — Reviewer response to PR review feedback when a Slice or Change is `needs-revision`.
- `start-change.md` — Grill prompt for `trowel change start`.
- `lane.md` — Interactive Lane prompt for foreground human-in-the-loop implementation sessions.

## Adding a prompt

1. Create `<name>.md` in this directory.
2. Use `{{TOKEN}}` for placeholders only when `loadPrompt(name, args)` substitutes them at runtime.
3. From a command, call `await loadPrompt('<name>')` or extend `loadPrompt` if placeholders become necessary.
