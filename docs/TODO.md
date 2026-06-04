# Trowel — TODO

Pending work, organised as discrete grilling sessions. Each item is meant to be picked up cold by a future Claude session — the assumptions, locked decisions, and open design questions are restated inline so no prior conversation is needed.

Pre-work for every session: read `docs/CONTEXT.md` for vocabulary and repo conventions, `README.md` for v0 status, `src/schema.ts` for the config shape, and `src/storages/types.ts` for the Storage interface. Both storages (`file`, `issue`) are implemented in `src/storages/implementations/{file,issue}.ts`; the AFK loop and command wiring built on top are already in place.

---

## 1. Change/retired Fix retirement and resource-first Change CLI

**Goal.** Deeply rename the container domain from **Change** to **Change**, keep **Slice**, retire **retired Fix** entirely, and move resource-scoped commands to singular resource-first grammar. This is pre-v1, so no compatibility aliases or automatic migration are required.

**Locked decisions.**

- **Change** becomes **Change** everywhere: code, docs, config, storage schema, labels, branch names, CLI help, tests.
- **Slice** stays **Slice**.
- **retired Fix** is removed entirely: no retired Fix entity, no `trowel start`, no `fix/<slug>` branch model, no `labels.fix`, no retired Fix storage paths.
- `trowel start` is the sole Change creation command. It may create a Change with one or more Slices; one-slice Changes are not special.
- One-slice Changes use the same Integration-branch plus Slice-branch model as every other Change.
- Change ids and Slice ids stay globally unique in one shared project id pool.
- File storage default path changes from `docs/prds/` to `docs/changes/` with no automatic migration. Old `docs/prds/` data is ignored unless the user manually moves it and updates config.
- Issue storage label/config renames from `prd` to `change`; default label value becomes `change`; no old-label fallback.
- Branch prefixes rename from `prd-<id>` to `change-<id>` and `prd-<id>/slice-...` to `change-<id>/slice-...`; no old-branch fallback.
- Resource-scoped CLI becomes singular resource-first:
  - `trowel change list`
  - `trowel change status <changeId>`
  - `trowel change work <changeId>`
  - `trowel change abort <changeId>`
  - `trowel slice status <sliceId>`
  - `trowel slice abort <sliceId>`
  - `trowel slice implement <sliceId>`
  - `trowel slice review <sliceId>`
  - `trowel slice address <sliceId>`
- Remove global `trowel work`.
- Manual phase commands are slice-only; no `trowel change implement/review/address`.
- Manual `close` is renamed to `abort`; it remains the non-shipping path that marks a Change/Slice closed and performs cleanup.

**Open follow-up: `ship` command.**

Add a future command that explicitly drives a Change or Slice to successful completion, distinct from `abort`.

Candidate surface:

```bash
trowel change ship <changeId>
trowel slice ship <sliceId>
```

Intended direction to grill later:

- `change ship <id>` should drive the Change to completion by running work until all Slices are done, then run Close-out or surface the remaining blockers/PRs that require human action.
- `slice ship <id>` should drive a single Slice through implement/review/address until it is merged/closed or reaches a human-gated state.
- `ship` is the success path; `abort` is the abandon path.
- Need to decide whether `ship` is just a clearer alias for `change work`/manual slice phase loops, or whether `change work` should itself eventually be renamed to `change ship`.

**Files likely touched.**

- `docs/CONTEXT.md`
- `src/cli.ts`
- `src/schema.ts`
- `src/config.ts`
- `src/storages/types.ts`
- `src/storages/implementations/file.ts`
- `src/storages/implementations/issue.ts`
- `src/commands/**`
- `src/work/**`
- `src/prompts/**`
- tests alongside those modules

**Verification path.**

Run:

```bash
pnpm build
pnpm exec vitest run --pool=threads
npx fallow audit --format json
git diff --check
```

---

## 2. `trowel diagnose` flow

**Goal.** Pure diagnostic. Investigates a bug, then prints a recommendation for the next command (`trowel change work <id>`, `trowel start`, or `trowel start`). Does **not** auto-invoke any of them.

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
  //      - a known issue → recommend `trowel change work <id>` (if it's a slice)
  //      - a small bug → recommend `trowel start` (then `trowel change work <id>`)
  //      - a larger change → recommend `trowel start`
  //      - already-investigated user error → just explain
  // 2. Print the recommendation; exit 0.
}
```

**Open questions to grill.**

- **Should diagnose preflight require a clean tree?** Default pick: no — diagnosing a bug while you have dirty changes is a real case.
- **Should diagnose persist its analysis?** E.g., write to `docs/diagnoses/<date>.md` so re-running the same query can pick up. Default pick: no — too much for v0; user can copy paste.

**Verification path.** Run on a known equipped issue; confirm the recommendation makes sense.

---

## 2. Sandboxed Turn execution (Docker `kind`)

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
- **Schema placement of `kind`.** `config.turn.kind`? `config.agent.kind`? Per-Change override? Default pick: `config.turn.kind` — the Turn is the unit being containerized.
- **Linux-only or also macOS?** Docker Desktop works on macOS but bind-mount perf is poor on large repos. Default pick: support both; document the perf caveat in `trowel doctor`.
- **What about `copyToWorktree`?** Host mode copies these into the worktree once; Docker mode would see them via the same bind-mount. No change needed unless something needs to be inside the image instead.

**Verification path.**

1. Build/pull the image; `trowel doctor` reports it present and pinned.
2. Scratch repo with `config.turn.kind: 'docker'`; run `trowel change work <id>` against a tiny one-slice Change. Verify: container starts, agent commits land inside the worktree (visible from host via bind-mount), `turn-out.json` written, verdict parsed, slice transitions.
3. Network policy test: agent attempts a `gh` call inside the container → fails. Agent runs `npm install` (or equivalent for the chosen egress policy) → succeeds.
4. Crash recovery: kill the container mid-Turn; host sees missing `turn-out.json` and surfaces a clean error (no stuck state).
5. Host fallback: flip the same project to `kind: 'host'` and re-run; verify the loop still works against the same worktree without container artifacts left behind.

---

## Order of work (suggested)

1. `diagnose` flow.
2. Docker Turn `kind`.
