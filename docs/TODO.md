# Trowel — TODO

Pending work, organised as discrete grilling sessions. Each item is meant to be picked up cold by a future Claude session — the assumptions, locked decisions, and open design questions are restated inline so no prior conversation is needed.

Pre-work for every session: read `docs/CONTEXT.md` for vocabulary and repo conventions, `README.md` for v0 status, `src/schema.ts` for the config shape, and `src/storages/types.ts` for the Storage interface. Both storages (`file`, `issue`) are implemented in `src/storages/implementations/{file,issue}.ts`; the AFK loop and command wiring built on top are already in place.

---

## 1. `trowel fix` flow

**Goal.** Bug-fix flow that bypasses PRD machinery. **Always creates a new GitHub issue, opens a PR, and links the PR to the issue.**

**Files to write.**

- `src/commands/fix.ts` — replaces stub.
- `src/prompts/fix.md` — Claude prompt for the fix flow.

**Flow.**

```ts
async function fix(description: string) {
  // 0. Preflight (clean tree, gh auth, project root)
  // 1. Capture BACK_TO branch
  // 2. Create a GitHub issue from `description` (title = first line; body = full description)
  //    → get issueNumber N
  // 3. Create branch `fix/<slug-of-description>` from origin/main
  // 4. try { launch Claude with fix.md, args { ISSUE_NUMBER: N, BRANCH, DESCRIPTION } }
  //    finally { restore BACK_TO }
  // 5. Inside Claude: implement → tests pass → commit → push → gh pr create
  //    with body "Closes #<N>"
}
```

**Locked (per user instruction).**

- Always creates an issue. No "optional" mode.
- Always opens a PR (against `config.baseBranch`, not against any integration branch).
- PR body contains `Closes #<N>` so merging the PR auto-closes the issue.

**Open questions to grill.**

- **Branch prefix for fix branches.** Default `fix/`? Or `config.fixBranchPrefix`? Default pick: hard-coded `fix/` — small enough to not earn a config knob until needed.
- **Skip grilling entirely, or light grill?** Default pick: skip; just go straight to implementation. The fix flow is supposed to be the lighter cousin of `start`.

**Verification path.** Scratch repo: `trowel fix "tabs render wrong on macOS"`, verify issue, branch, PR with `Closes #N` body.

---

## 2. `trowel diagnose` flow

**Goal.** Pure diagnostic. Investigates a bug, then prints a recommendation for the next command (`trowel work <prd>`, `trowel fix <desc>`, or `trowel start <feature>`). Does **not** auto-invoke any of them.

**Files to write.**

- `src/commands/diagnose.ts` — replaces stub.
- `src/prompts/diagnose.md`.

**Flow.**

```ts
async function diagnose(description: string) {
  // 0. Preflight (optional clean tree — diagnosis can run on a dirty tree)
  // 1. Launch Claude with diagnose.md, args { DESCRIPTION }
  //    Claude investigates: reads code, possibly runs tests, asks user questions,
  //    determines whether this is:
  //      - a known issue → recommend `trowel work <prd>` (if it's a slice)
  //      - a small bug → recommend `trowel fix "<refined description>"`
  //      - a larger change → recommend `trowel start <feature>`
  //      - already-investigated user error → just explain
  // 2. Print the recommendation; exit 0.
}
```

**Open questions to grill.**

- **Should diagnose preflight require a clean tree?** Default pick: no — diagnosing a bug while you have dirty changes is a real case.
- **Should diagnose persist its analysis?** E.g., write to `docs/diagnoses/<date>.md` so re-running the same query can pick up. Default pick: no — too much for v0; user can copy paste.

**Verification path.** Run on a known equipped issue; confirm the recommendation makes sense.

---

## 3. Sandboxed Turn execution (Docker `kind`)

**Goal.** Run **Turns** inside a Docker container instead of directly on the host, restoring sandcastle's containment story as an opt-in mode. Today every Turn runs `kind: 'host'` with worktree-only isolation: the agent shares the host filesystem outside the worktree, the host network, the host PATH, and `~/.claude/` auth. A Docker mode constrains all four: filesystem to the bind-mounted worktree, network to a gh-free policy, PATH to the image's preinstalled toolchain, and auth to the same bind-mount that's implicit today.

**Reference.** ADR `2026-05-12-sandcastle-integration.md` describes the pre-pivot sandcastle shape (the system this re-introduces, post-pivot, as a configurable Turn kind). CONTEXT.md flags it in **Turn**, in "Out of scope", and in the "Flagged ambiguities" entry retiring the old "Sandbox" term.

**Files to write or edit.**

- `src/work/turn.ts` — dispatch on Turn `kind`. Today's body becomes the host path; a new docker path handles container mode. Shared pre-Turn (`turn-in.json` write, log path) and post-Turn (`turn-out.json` read, verdict parse) stay above the dispatch.
- `src/harnesses/types.ts` + `src/harnesses/{claude,codex,pi}.ts` — each `HarnessAdapter` currently spawns its CLI directly. The Docker path needs each adapter to also describe how to invoke its CLI *inside* a container (binary + flags); the `docker run` orchestration itself is shared across harnesses, not per-harness.
- `src/schema.ts` — extend `config.turn` with `kind: 'host' | 'docker'` (default `'host'`); optionally `image`, `network`, `extraMounts`.
- `docker/` (new) — pinned image with `node` / `pnpm` / `git` / `gh` plus every supported harness (`claude`, `codex`, `pi`) baked in. See open question on per-harness vs unified.
- `src/commands/doctor.ts` — when `kind: 'docker'`, surface image presence + version pin alongside the existing harness checks.
- `docs/adr/<date>-docker-turn-kind.md` — record the decision to re-introduce containment as a Turn-level config dimension rather than the old global sandcastle.

**Flow (Docker `kind`).**

1. Host prepares the worktree and writes `.trowel/turn-in.json` (unchanged from host mode).
2. Host spawns `docker run --rm --network <policy> -v <worktree>:/work -v ~/.claude:/root/.claude:ro -w /work <image> <harness-cli> ...`. Stdout/stderr stream to the log file the same way today's host harness adapter does.
3. On container exit, host reads `<worktree>/.trowel/turn-out.json` from the bind-mount. Verdict parse is identical to host mode.

**Locked (carried over from sandcastle).**

- **gh-free network policy.** Containers cannot reach GitHub. All `gh` calls stay on the host, before or after the Turn (unchanged invariant). Egress for package managers (npm, pypi, etc.) is allowed — see open question on the exact policy.
- **`~/.claude/` bind-mounted read-only** so the user's existing auth flows through; no token plumbing inside trowel.
- **One container per Turn.** No pooling. Worktrees are still one-per-branch and outlive the container.
- **Worktree bind-mount, not copy.** Commits made inside the container land in the host's worktree directly; no post-Turn rsync.

**Open questions to grill.**

- **Image strategy.** Pre-built image pinned by SHA (pulled from a registry)? Or `docker build` on first use, cached locally? Default pick: pinned pre-built image; `trowel doctor` verifies presence; rebuild is a separate explicit command.
- **Per-harness image vs unified image.** One image with every harness baked in is convenient but large; per-harness images are smaller but multiply maintenance. Default pick: unified image — the user picked one harness, but having the others available makes `trowel doctor` and ad-hoc switches trivial.
- **Network policy.** Fully isolated (no egress)? Or allowlisted egress (npm, pypi, github.com:443 read-only)? Or open egress minus `gh` auth? Default pick: open egress, just no GitHub auth — matches sandcastle's posture.
- **Schema placement of `kind`.** `config.turn.kind`? `config.agent.kind`? Per-PRD override? Default pick: `config.turn.kind` — the Turn is the unit being containerized.
- **Linux-only or also macOS?** Docker Desktop works on macOS but bind-mount perf is poor on large repos. Default pick: support both; document the perf caveat in `trowel doctor`.
- **What about `copyToWorktree`?** Host mode copies these into the worktree once; Docker mode would see them via the same bind-mount. No change needed unless something needs to be inside the image instead.

**Verification path.**

1. Build/pull the image; `trowel doctor` reports it present and pinned.
2. Scratch repo with `config.turn.kind: 'docker'`; run `trowel work <id>` against a tiny 1-slice PRD. Verify: container starts, agent commits land inside the worktree (visible from host via bind-mount), `turn-out.json` written, verdict parsed, slice transitions.
3. Network policy test: agent attempts a `gh` call inside the container → fails. Agent runs `npm install` (or equivalent for the chosen egress policy) → succeeds.
4. Crash recovery: kill the container mid-Turn; host sees missing `turn-out.json` and surfaces a clean error (no stuck state).
5. Host fallback: flip the same project to `kind: 'host'` and re-run; verify the loop still works against the same worktree without container artifacts left behind.

---

## Order of work (suggested)

1. `fix` + `diagnose` flows.
2. Docker Turn `kind`.
