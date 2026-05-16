# Configurable agent harness; support `claude`, `codex`, `pi` behind a per-project choice

Trowel hard-codes `claude` as the CLI it spawns to run every agent role. The Turn-mode invocation in `_loop-wiring.ts:runAgent` and the interactive PRD-grill in `commands/start.ts` both shell out to `claude` literally, passing claude-specific flags (`--print` / `--append-system-prompt` / `--dangerously-skip-permissions` / `--model`). The only configurable piece is `config.agent.model`, which is meaningful only because the harness is fixed.

The agent ecosystem has fanned out: **codex** (OpenAI's coding CLI, `codex exec` for non-interactive) and **pi** (the multi-provider terminal harness from pi.dev, `pi -p` for print mode) are both viable Turn runners — same shape as claude (spawn, prompt-in, filesystem cwd, exit), different argv conventions. The Turn IPC contract (`.trowel/turn-in.json` / `.trowel/turn-out.json`) is harness-neutral by construction; only the spawn args differ.

This ADR introduces the **Agent harness** concept: the CLI binary that runs an agent role inside a Turn. Trowel supports three harnesses out of the box — `claude` (default), `codex`, `pi`. The harness is chosen per project via `config.agent.harness`; `trowel start` and `trowel work` accept `--harness <kind>` to override per invocation, mirroring `--storage`. Per-harness spawn logic lives in `src/harnesses/`, parallel to `src/storages/`. `trowel doctor` enumerates every known harness and reports installed/version; the *configured* harness being missing is a failure, others missing are info.

## Considered options

- **Keep `claude` hard-coded, add codex/pi later if anyone asks.** Rejected: the design pressure exists today (the user asked for it), and the contract layer (`runAgent`, `runInteractive` in start) is small enough that abstracting it now is cheaper than retrofitting later. Two call sites and one config key — the cost of waiting is roughly the cost of doing it.
- **Nested per-harness models** (`agent.models.claude`, `agent.models.codex`, `agent.harness: 'claude'`). Rejected: speculative — nothing today suggests the user switches harnesses often enough to need a remembered model per harness. YAGNI. If a real workflow emerges, lifting `agent.model: string` to `agent.models: Record<HarnessKind, string>` is mechanical.
- **Discriminated union** (`agent: { harness: 'claude', model: ... } | { harness: 'codex', model: ... } | { harness: 'pi', model: ... }`). Rejected: type-safe per harness, but no harness-specific knobs exist today besides `model`. If one harness grows a unique knob (auth profile, extra args), promote to a union then.
- **Per-harness config block** (`agent.claude.model`, `agent.codex.model`). Rejected: same critique as nested + more nesting; conflates "remembered settings" with "active selection".
- **Model-string allowlist per harness** (validate `model` at config load). Rejected: pi alone supports 15+ providers' models; tracking that list is a maintenance pit. Pass model strings through verbatim; the harness CLI produces its own "unknown model" error.
- **Probe-the-configured-harness-only in `doctor`** instead of enumerating all three. Rejected: the user explicitly asked for the full list. The non-configured harnesses double as discovery ("I didn't know I could use pi"); listing them at info level (not failure level) keeps the green/red signal meaningful.
- **Detect harness from `model` string** (claude-* → claude, gpt-* → codex). Rejected: fragile, and pi accepts model names from many providers — claude-* via pi is a legal combination, breaking the heuristic.
- **Keep `start` on claude even though `work` is configurable.** Rejected: mental-model whiplash. The user picks one harness; both commands respect it. If a "per-command harness" preference emerges, it slots in cleanly via the existing `--harness` override pattern. `start.md`'s one claude-specific phrasing (line 256, "the user closes the Claude session") is rewritten to be harness-neutral.

## Consequences

### Config schema

```ts
// schema.ts
agent: {
  harness: HarnessKind   // 'claude' | 'codex' | 'pi'
  model: string          // free-form, no allowlist; per-harness default supplied by the adapter
}
```

- `partialConfigPipe()` adds `agent.harness: optional(v.in(Object.keys(harnessFactories)))`.
- `defaultConfig.agent.harness = 'claude'`. Legacy configs with bare `agent.model` and no `agent.harness` keep working — the defaults layer fills `harness: 'claude'`, which matches what those configs always meant.
- `defaultConfig.agent.model` is resolved at module load as `harnessFactories.claude.defaultModel`, not a hard-coded literal. Per-harness `defaultModel` becomes the single source of truth.

### Harness adapter registry

New tree, parallel to `src/storages/`:

```
src/harnesses/
  types.ts         // HarnessAdapter, HarnessKind
  registry.ts      // harnessFactories, getHarness()
  claude.ts        // claude adapter
  codex.ts         // codex adapter
  pi.ts            // pi adapter
```

Adapter shape:

```ts
type HarnessAdapter = {
  kind: HarnessKind
  defaultModel: string
  spawnPrint(args: {
    model: string
    prompt: string
    cwd: string
    logStream: WriteStream
  }): { child: ChildProcess; waitForExit: Promise<number> }
  spawnInteractive(args: {
    model: string
    systemPrompt: string
    cwd: string
  }): { child: ChildProcess; waitForExit: Promise<number> }
  detectVersion(): Promise<{ installed: boolean; version?: string }>
}
```

Per-harness argv mappings live inside the adapters and are not config-exposed. Flags verified against `claude --help` (v2.1.142), `pi --help` (v0.74.0), and the codex CLI reference at `developers.openai.com/codex/cli/reference`:

- `claude.spawnPrint` → `claude --print --model X --dangerously-skip-permissions --output-format text`, prompt piped via stdin.
- `claude.spawnInteractive` → `claude --append-system-prompt <prompt> --model X`, `stdio: 'inherit'`.
- `claude.defaultModel` = `claude-opus-4-6`.
- `claude.detectVersion` → `claude --version` returns `2.1.142 (Claude Code)`; parse the leading semver.

- `pi.spawnPrint` → `pi -p --model X --no-session "<prompt>"`, prompt as positional argv. `--no-session` keeps each Turn ephemeral (no session file written under the project), matching the Turn's worktree-isolated lifecycle.
- `pi.spawnInteractive` → `pi --append-system-prompt <prompt> --model X`, `stdio: 'inherit'`. Pi's `--append-system-prompt` is name-compatible with claude's (happy coincidence; not a contract).
- `pi.defaultModel` = `anthropic/claude-sonnet-4-5`. Pi's `--provider` defaults to `google`; using the provider-prefixed `provider/id` form in `--model` removes the dependency on `--provider`.
- `pi.detectVersion` → `pi --version` returns the bare semver (`0.74.0`).
- Pi has **no permission system** to bypass — tools run unconditionally. The adapter passes no permission-related flag. See "Per-harness asymmetries" below.

- `codex.spawnPrint` → `codex exec --model X --dangerously-bypass-approvals-and-sandbox -`, prompt piped via stdin (codex's `-` positional reads stdin). `--yolo` is the documented alias and equivalent. Adapter passes `--cd <cwd>` explicitly rather than relying on `spawn`'s `cwd` option, because codex's working-directory handling differs from typical CLIs.
- `codex.spawnInteractive` → `codex --model X --cd <cwd>`, `stdio: 'inherit'`. System prompt injection: write the prompt to `<cwd>/AGENTS.md` before spawning, delete it on exit (codex auto-discovers `AGENTS.md`). See "Per-harness asymmetries".
- `codex.defaultModel` = `gpt-5.1-codex` (placeholder; verify against codex's `--list-models` or current docs at adapter-implementation time).
- `codex.detectVersion` → try `codex --version` first, fall back to `codex -V` (rust convention), fall back to `{ installed: true }` with no version string if both exit non-zero.

### Per-harness asymmetries

Two harness differences leak into the abstraction. The ADR documents them rather than papering over them.

1. **Codex has no `--append-system-prompt` equivalent.** For `spawnPrint`, this is a non-issue — concatenate the system + user prompt before piping. For `spawnInteractive` (used by `trowel start`), the codex adapter writes the start prompt to `<cwd>/AGENTS.md` before spawning and removes it after exit. This:
   - works inside the worktree-isolated `start` flow (`AGENTS.md` is gitignored by convention; if it's not, the user sees a transient file during the session),
   - is a known codex-specific quirk worth a comment in the adapter,
   - is *not* applied to Turn execution (Turns use print mode, which concatenates).
2. **Pi has no permission/sandbox system.** Claude's `--dangerously-skip-permissions` and codex's `--dangerously-bypass-approvals-and-sandbox` exist because those tools default to prompting; pi never prompts. The harness contract doesn't promise equivalent isolation across harnesses — a pi Turn runs with the same authority a pi user gets from a shell. Trowel's existing Turn isolation story (worktree-only, host PATH, host network) is unchanged; this ADR doesn't *worsen* anything, but a future reader should not assume `claude --dangerously-skip-permissions ≡ pi (no flag) ≡ codex --yolo` in isolation strength.

### Loop wiring

`src/commands/_loop-wiring.ts:runAgent` becomes harness-neutral:

```ts
const harness = getHarness(harnessKind)
const { child, waitForExit } = harness.spawnPrint({ model, prompt, cwd, logStream })
const exitCode = await waitForExit
```

`buildLoopWiring(opts: { storage?: StorageKind; harness?: HarnessKind })` accepts the override; falls back to `config.agent.harness`.

### `trowel start`

`commands/start.ts` swaps the literal `spawn('claude', [...])` call for `getHarness(harnessKind).spawnInteractive(...)`. The `--append-system-prompt` flag is replaced by the harness's equivalent system-prompt injection. The `start.md` prompt is rewritten to remove the one Claude-specific phrasing (line 256 → "the user exits the agent session").

### `trowel init`

The wizard order becomes:

```
1. storage         (select)
2. prdsDir         (if storage === 'file')
3. agent.harness   (select; default = existing.agent.harness ?? 'claude')   ← NEW
4. agent.model     (input; default derived per the rule below)
5. work.usePrs
6. work.review     (if usePrs)
```

Model-default derivation:

```
modelDefault =
  existing.agent.harness === answeredHarness
    ? (existing.agent.model ?? harness.defaultModel)
    : harness.defaultModel
```

Switching harness *resets* the model to the new harness's default — the existing model is almost certainly wrong cross-harness. Preserving harness keeps the existing model.

`InitPrompts.agentModel` signature is unchanged (`(current: string) => Promise<string>`) — derivation happens in `runInit`, not in the prompt.

### `trowel doctor`

Replace the single `claude CLI installed` line with a per-harness block iterating `harnessFactories`. Output:

```
ok  git                       v2.43.0
i   claude harness            v1.0.103  ← configured
i   codex harness             v0.45.2
X   pi harness                not installed
ok  gh                        v2.62.0
ok  gh authenticated          ok
ok  project root              /…/trowel
ok  config layers loaded      project@…/.trowel/config.json
```

- Per-harness line uses `detectVersion()` on the adapter.
- The `← configured` annotation marks the active harness.
- A new `i ` prefix (info) joins `ok ` / `X `: non-configured harnesses missing are info-level, not failure. Only the *configured* harness missing exits doctor non-zero.
- `gitInstalled` and `ghInstalled` checks are upgraded to report the parsed version string (`git --version`, `gh --version`) when available, falling back to `found` if parse fails.

### `--harness <kind>` CLI override

Added to `trowel start` and `trowel work`, parallel to `--storage`. Falls back to `config.agent.harness` when absent. No persistence — single-invocation override only.

### Prompts

The implementer / reviewer / addresser prompts at `src/prompts/{implement,review,address}.md` are already harness-neutral by content (they instruct the agent to write `.trowel/turn-out.json`, no Claude-specific phrasing). Only `start.md:256` and `prompts/README.md:3` need de-claude-ification.

### CONTEXT.md

- New **Agent harness** glossary entry (added in this session) — the CLI binary that runs an agent role.
- The existing **Implementer / Reviewer / Addresser** entry is unchanged; "agent" continues to mean the AI playing a role.
- `config.agent.model` references in dialogue/relationships are updated to mention `config.agent.harness` where the harness choice is relevant.

### Out of scope

- Per-harness extra-args knobs (`agent.claude.flags`, etc.). Deferred until a real need surfaces.
- Per-command harness override in config (`config.start.harness` distinct from `config.work.harness`). Deferred — the `--harness` flag covers the single observed use case.
- Docker / sandbox mode for non-claude harnesses. Already out of scope for claude (see `2026-05-14-drop-sandcastle-for-host-exec-turns.md`); inherits that status.
- Auth diagnostics for harnesses (e.g. "codex is installed but not logged in"). `detectVersion()` reports only installed + version. Auth checks can grow later if any harness gains a stable `auth status` subcommand.

## Supersession notes

None. This is an additive change. ADRs covering the Turn IPC contract and host-exec model (`2026-05-12-sandcastle-integration.md`, `2026-05-14-drop-sandcastle-for-host-exec-turns.md`) stand unchanged — the harness abstraction sits cleanly inside the host-exec Turn model.
