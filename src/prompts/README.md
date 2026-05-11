# Prompts

Markdown templates fed to Claude when trowel launches an agent session. Each prompt uses `{{PLACEHOLDER}}` tokens that `loadPrompt(name, args)` substitutes at runtime.

This directory is empty in v0 — the actual prompts (`start.md`, `resume.md`, `implement.md`, `review.md`, `respond-to-feedback.md`) arrive together with the backend implementations and the sandcastle port. See `docs/CONTEXT.md` for the deferred-work list.

## Adding a prompt

1. Create `<name>.md` in this directory.
2. Use `{{TOKEN}}` for placeholders (e.g. `{{PRD_ID}}`, `{{BRANCH}}`, `{{BACK_TO_BRANCH}}`).
3. From a command, call `await loadPrompt('<name>', { TOKEN: value, … })`.
