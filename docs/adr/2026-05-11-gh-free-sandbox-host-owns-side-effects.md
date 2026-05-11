# Gh-free sandbox; host owns all GitHub side effects; file-IPC verdict channel

The **Sandbox** does not run `gh`. Every GitHub-side-effecting operation — creating the **Slice branch** (`gh issue develop`), creating the draft PR (`gh pr create --draft`), flipping labels (`gh issue edit --add-label` / `--remove-label`), marking a PR ready (`gh pr ready`), fetching PR review feedback for the **Addresser**, and closing a sub-issue after merge — happens on the **host**, either before the sandbox launches or after it exits.

The agent inside the sandbox is restricted to local operations: read the slice spec, edit code, run tests/formatters, `git add`, `git commit`. It does not `git push` (host pushes post-sandbox), it does not call `gh` (host calls `gh`), and it does not need GitHub credentials.

Communication crosses the sandbox boundary via two files inside the bind-mounted worktree:

- `<worktree>/.trowel/sandbox-in.json` — host writes; agent reads. Carries the slice spec (`{ id, title, body }`) for every role, plus `{ pr: { number, branch } }` for reviewer/addresser, plus the full `feedback: FeedbackEntry[]` array for addresser (line-level review comments, review summaries, and thread comments — fetched by the host pre-launch, no filtering).
- `<worktree>/.trowel/sandbox-out.json` — agent writes; host reads after the container exits. Carries the **Verdict** as a tagged-union value: `{ verdict: 'ready' | 'needs-revision' | 'no-work-needed' | 'partial'; notes?: string }`. The agent's prompt instructs it to write this file before exit; if the file is missing, malformed, or carries a verdict invalid for the agent's role, the host coerces to `partial` and logs.

The host's post-sandbox handoff table is per-role (see TODO Section 1's locked verdict table for the full mapping). Briefly: a reviewer's `ready` triggers `gh pr ready`; a reviewer's `needs-revision` triggers `gh pr edit --add-label needs-revision`; an addresser's `ready` triggers a label removal; an implementer's `ready` triggers a `git push` + (under `usePrs: true`) a `gh pr create --draft`, or (under `usePrs: false`) a host-side `git merge --no-ff` + `gh issue close`.

## Considered options

- **`gh`-aware sandbox; agent runs `gh pr create` / `gh pr ready` etc. itself, matching equipped's sandcastle.** Rejected: requires GitHub credentials inside the container, which means bind-mounting the user's `gh` auth token (a secret) into every sandbox run. The agent's side effects on the user's GitHub account are then unconstrained — a rogue or confused agent can comment on arbitrary PRs, label arbitrary issues, even close issues outside the PRD. Moving side effects to the host bounds the blast radius: the host runs exactly the gh ops trowel's loop code requires, no more.
- **Heuristic verdict derivation from sandbox state (commit count, exit cleanliness).** Rejected: collapses three meaningful verdicts (`ready` / `needs-revision` / `no-work-needed`) into two (commits-made / no-commits), losing the reviewer's "I'm happy" vs "this needs another pass" signal. Equipped lives with this for the addresser only (no commits + clean exit ⇒ "no work needed; remove label"), and even that is fragile — an addresser that decides "this feedback is wrong, no changes" looks identical to "I crashed before doing anything."
- **MCP server in the host that the sandbox calls.** Rejected: heaviest option. Requires the sandbox image to ship MCP client tooling, the host to manage an MCP server lifecycle per sandbox run, and network plumbing for the container to reach the host. v0 doesn't earn that overhead. The file-IPC channel is forward-compatible — if a real MCP-style RPC becomes desirable later, the verdict file is trivially replaceable.
- **Single sandbox-state JSON file (read-write by both sides).** Rejected: ambiguous direction; race conditions between host pre-write and agent first-read; harder to reason about than two unidirectional files. The two-file split makes "host inputs" and "sandbox outputs" textually obvious.

## Consequences

- The agent's prompt is shorter and more stable: instead of "use `gh` to fetch the issue body, then implement it; create a draft PR when done," it reads "read `.trowel/sandbox-in.json` for the slice spec; edit code; commit; write your verdict to `.trowel/sandbox-out.json` before exit." Prompts are now cacheable across runs (one prompt per role, parametrized only by `{{BACKEND}}` and `{{INTEGRATION_BRANCH}}`).
- The sandbox image does not need a GitHub auth token. It does still need outbound network for the Anthropic API session and for any `pnpm install`-class operations the agent runs.
- The host's loop driver grows: where equipped's loop did `runImplementer → push → ghCreateDraftPr`, trowel's does `prepareWorktree → spawnSandbox → readVerdict → switch(verdict){ ... }`. The state machine is more explicit, easier to test (the verdict-to-action switch is pure), and easier to instrument.
- An invalid verdict (`partial`-coerced) is logged with a tag indicating which role produced it and why it was invalid (missing file, bad JSON, role-invalid value); this becomes the primary debug signal when a sandbox run misbehaves.
- The `Verdict` taxonomy is part of the user-visible vocabulary (see CONTEXT.md) so prompt edits and log messages share one term.
