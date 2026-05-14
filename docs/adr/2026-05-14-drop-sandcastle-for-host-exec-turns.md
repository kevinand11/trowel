# Drop sandcastle for host-exec Turns

Trowel retires `@ai-hero/sandcastle` and runs each agent **Turn** as a direct `claude --print` child process on the host inside a trowel-managed git worktree. The Sandbox vocabulary (Docker container, image, bind-mount) is renamed to **Turn** with no `kind` dimension yet — host mode is the only mode; a future Docker mode is anticipated but not part of this ADR's schema.

Supersedes: `2026-05-12-sandcastle-integration.md`.

## Why

Sandcastle's `run()` / `createSandbox()` only accept `SandboxProvider` (Docker, Podman, Vercel). The `noSandbox()` provider exists but is **interactive-only** (gated to `interactive()` / `wt.interactive()`), so there's no first-class path through sandcastle's API to run an agent on the host without a container. Trowel needs a "no container" mode for fast local iteration; the cleanest way to deliver it is to drop sandcastle entirely and own the worktree + child-process lifecycle directly.

This also lets us simplify a few things sandcastle was carrying for us but that didn't earn their weight in a single-user CLI: the OAuth-env injection (the host's `~/.claude/` is read directly), the per-role `iterationCaps` (sandcastle's inner iteration loop is gone; the `claude` CLI self-limits), and the `onReady` container hooks (host shell already has whatever the user needs).

## What replaces it

- **Worktree lifecycle.** Trowel calls `git worktree add` / `git worktree remove` directly. One worktree per branch, at `<projectRoot>/.trowel/worktrees/<prdId>/<branch-slug>/`, reused across every Turn that checks out that branch. Reset between Turns with `git restore --staged --worktree . && git clean -fd` (ignored files survive, so a `copyToWorktree`'d `node_modules` persists).
- **Agent invocation.** `child_process.spawn('claude', ['--print', '--model', config.agent.model, '--dangerously-skip-permissions', '--output-format', 'text', '--no-session-persistence'], { cwd: worktreePath, env: process.env, stdio: ['pipe', logFd, logFd] })`. Prompt text piped on stdin. CLAUDE.md auto-discovery and the user's default tool set are intentionally inherited — host mode's whole point is to reuse the user's setup.
- **Verdict contract unchanged.** Agent writes `<worktree>/.trowel/turn-out.json`; missing or malformed → coerced to `partial`. Commits counted post-exit via `git rev-list --count <baseHead>..HEAD` where `baseHead` is captured pre-spawn.
- **Orphan sweep.** On `trowel work` start, walk `.trowel/worktrees/<prdId>/`, remove any worktree whose branch no longer exists or whose Slice is `CLOSED`, gated by `config.work.worktreeCleanupAge` as a minimum age. Active worktrees are never swept regardless of age.

## Schema migration

- `config.sandbox` → `config.turn`. Final shape: `{ copyToWorktree: string[], maxConcurrent: number | null }`.
- Dropped: `sandbox.image`, `sandbox.onReady`, `sandbox.iterationCaps`. No replacement — `claude` self-limits and the host shell handles bootstrapping.
- `config.agent.model` unchanged.

## Code surface

Dropped:
- The `@ai-hero/sandcastle` dependency.
- `src/work/image.ts` (`ensureSandboxImage`).
- `src/utils/oauth-token.ts` (`loadClaudeOauthToken`).
- `assets/Dockerfile`.

Renamed:
- `spawnSandbox` → `spawnTurn` (`src/work/sandbox.ts` → `src/work/turn.ts`).
- `SpawnSandboxArgs` / `SpawnSandboxDeps` → `SpawnTurnArgs` / `SpawnTurnDeps`.
- `sandbox-in.json` / `sandbox-out.json` → `turn-in.json` / `turn-out.json`.
- `SandboxIn` / `SandboxOut` types → `TurnIn` / `TurnOut`.

## Considered options

- **Wait for sandcastle to support `noSandbox` in `run()`.** Open-ended; the public README explicitly scopes `noSandbox` to interactive mode. Blocked indefinitely on upstream.
- **Add Podman as the second mode instead of dropping sandcastle.** Still requires Docker-class isolation (a different daemon, but the same model). Doesn't deliver the "run the agent directly with my host's `~/.claude/` and CLAUDE.md" use case the user actually wanted.
- **Keep `kind: 'host' \| 'docker'` schema from day one with `docker` throwing "not implemented".** Rejected on YAGNI grounds — the dimension can be added cleanly when Docker actually returns; there's no second mode today to validate the dispatch against.

## Consequences

- **No filesystem or network isolation.** A misbehaving agent can read/write anything under the user's HOME. Acceptable for single-user CLI on a personal machine; documented as a known trade-off. Future Docker mode re-introduces isolation if/when needed.
- **`claude` CLI becomes a hard install dependency.** Trowel's preflight will need a `which claude` check. (Previously sandcastle could run an agent in a fresh container without claude installed on the host.)
- **Worktrees survive across `trowel work` invocations.** Inspection-friendly (the user can `cd` into a stuck worktree and look around). Disk-usage-unfriendly for long-running PRDs with many slices — `config.work.worktreeCleanupAge` is the lever.
- **Single-user assumption hardens.** The OAuth-env injection path is gone; multi-user / multi-machine designs would need to add it back.
- **Existing sandcastle ADR is superseded.** `2026-05-12-sandcastle-integration.md` describes the pre-pivot wiring and gets a `Superseded by` note.
