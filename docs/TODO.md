# Trowel — TODO

Pending work, organised as discrete grilling sessions. Each item is meant to be picked up cold by a future Claude session — the assumptions, locked decisions, and open design questions are restated inline so no prior conversation is needed.

Pre-work for every session: read `docs/CONTEXT.md` for vocabulary, `README.md` for v0 status, `src/schema.ts` for the config shape, and `src/backends/types.ts` for the Backend interface. Both backends (`file`, `issue`) are implemented in `src/backends/{file,issue}.ts`; the AFK loop and command wiring (items below) build on top.

---

## Locked, repo-wide (do not re-grill)

These decisions cross every pending session. Don't reopen unless you have a concrete forcing function.

- **Distribution.** Personal CLI, single user, single machine, never shared. Lives at `~/Desktop/code/trowel/`, symlinked from `~/.local/bin/trowel`.
- **Language & runtime.** Node + `tsx`. TypeScript everywhere. `pnpm` for install/scripts/exec — never `npm`.
- **Validation.** All config + external input goes through a `valleyed` pipe. Prefer `v.validate(pipe, input)` (success/error shape) over `v.assert(pipe, input)` (throws, slower).
- **CLI parsing.** `commander`. Each command lives at `src/commands/<name>.ts` and is wired in `src/cli.ts`.
- **PRD-host model.** A **PRD** is configurable per project across two **Backends**: `file`, `issue`. Slices are backend-managed: the `file` backend stores them locally alongside the PRD; the `issue` backend uses GitHub sub-issues (see ADR `slices-local-for-file-backend`). Doc changes (CONTEXT.md, ADRs) live on the **integration branch**, not on `main`.
- **Every PRD has a unique id (see ADR `prd-unique-id-and-file-backend-layout`).** Cross-backend: issue number (`issue`) or 6-char base-36 random (`file`). The id is the argument trowel commands take.
- **Backend interface shape (see ADRs `backend-interface-composite-create`, `slices-local-for-file-backend`, `backend-owns-slice-bucket-classification`, `backend-native-blocker-storage`).** Creation: `Backend.createPrd(spec: PrdSpec) → { id, branch }` and `createSlice(prdId, spec: SliceSpec) → Slice`. `PrdSpec = { title, body }`; `SliceSpec = { title, body, blockedBy: string[] }` — split because PRDs have no blocker concept. Slices: `findSlices(prdId) → Slice[]` (each `Slice` has `bucket` and `blockedBy` populated by the backend), `updateSlice(prdId, sliceId, patch)` where `SlicePatch` accepts a full-array `blockedBy: string[]` replace. PRD discovery: `findPrd(id) → { branch, state } | null`, `branchForExisting`, `listOpen`, `close`. Each backend exposes `defaultBranchPrefix` (used when `config.branchPrefix` is null).
- **Config shape deltas (cross-cutting).** `config.branchPrefix: string | null` (was always-string; null means "use backend default"). `config.labels.prd: string` (was `string[]`), default `'prd'`. `config.labels.readyForAgent` / `config.labels.needsRevision` are used by the `issue` backend to translate GitHub labels ↔ `Slice` booleans; the `file` backend ignores them. New `config.close: { comment: string | null; deleteBranch: 'always' | 'never' | 'prompt' }`, defaults `'Closed via trowel'` / `'prompt'`. `config.close.comment` is a no-op for the `file` backend (no GitHub object to comment on).
- **Per-layer path anchoring.** Path values in any config layer resolve relative to that layer's anchor (project layer → project root; private layer → `~/.trowel/projects/<mirror>/`; global layer → `~/.trowel/`; default → project root). Resolution happens at load time before deep-merge.
- **Config discovery (named layers, β precedence — `project` wins outright).** Enum: `ConfigLayer = 'default' | 'global' | 'private' | 'project'`. `InitableLayer` excludes `'default'`.
  - `default` — hard-coded defaults (`src/schema.ts:defaultConfig`)
  - `global` — `~/.trowel/config.json`
  - `private` — `~/.trowel/projects/<full-path-mirrored>/config.json` (user per-project, this machine only)
  - `project` — `<project root>/.trowel/config.json` (**wins**)
- **Project root resolution.** Walk up from cwd to the nearest `.trowel/` (preferred) or `.git/` (fallback).
- **Failure recovery model.** Idempotent — re-run with `--prd <id>` to resume after any abort. No atomic rollback.
- **Working-tree precondition.** Strict clean tree at command start; `try/finally` restores the captured **BACK_TO branch** on exit.
- **Style.** Tabs, single quotes, kebab-case filenames, `@k11/configs` for tsconfig/eslint/prettier. Mirrors equipped's conventions.

Each pending session expands on one slice of the design; assume everything above is true.

---


## 1. Sandcastle port → AFK loop commands

> **Superseded by `docs/adr/2026-05-14-drop-sandcastle-for-host-exec-turns.md` (2026-05-14).** Sandcastle, Docker, and the `sandbox-{in,out}.json` IPC names are gone. Agents now run on the host via `child_process.spawn('claude', ...)` inside a persistent per-branch worktree, reset between **Turns**. The verdict contract and host-side state-machine wiring are unchanged; only the sandbox layer was ripped out. The "locked decisions" below reflect the pre-pivot design and remain as historical record of the phase the loop wiring was built against.

**Goal.** Port equipped's `.sandcastle/` directory into `src/work/` and wire `trowel work`, `trowel implement`, `trowel review`, `trowel address` to call into it. The AFK loop is **asymmetric across backends** — the `issue` backend runs the full state machine; the `file` backend runs an implementer-only serial pass. See ADRs `afk-loop-asymmetric-across-backends`, `gh-free-sandbox-host-owns-side-effects`, `optional-pr-flow-on-issue-backend` for the locked design.

**Locked decisions** (from grilling session 2026-05-11):

- **Two loop drivers.** `src/work/loops/issue.ts` runs the four-state machine (implement → review → address → done). `src/work/loops/file.ts` runs a 20-line serial implementer-only driver. `src/commands/work.ts` dispatches by `backend.name`. The `Backend` interface stays minimal — no new methods land on it for the loop's sake; the drivers import backend-internal helpers directly.
- **Commands.** Four ship: `work`, `implement`, `review`, `address`. `review` and `address` are issue-backend-only and refuse cleanly on `file` (and on issue with `config.work.usePrs: false`). Per-phase commands refuse on **bucket mismatch** with a bucket-aware message ("slice 145 is in `ready`; run `trowel implement <prd> 145` first").
- **Sandbox model.** Fresh Docker container per agent run. Opt-in via `config.sandbox.enabled` (default `true`). Concurrency capped at `config.sandbox.maxConcurrent` (default `3`, null = unbounded). Image built lazily from `~/.trowel/Dockerfile` (default `null` for `config.sandbox.dockerfile`, resolved via the global anchor; trowel ships `assets/Dockerfile` and copy-on-demands to `~/.trowel/Dockerfile` if missing). `config.sandbox.image` default `'trowel:latest'`. Per-project install hooks live under `config.sandbox.onReady: string[]` (default `[]`; equipped-style projects set `["pnpm install --prefer-offline"]`); per-project worktree copy paths under `config.sandbox.copyToWorktree: string[]` (default `[]`; equipped sets `["node_modules"]`).
- **Sandbox is gh-free.** All `gh` ops happen on the host — branch creation pre-sandbox via `gh issue develop`, PR ops / label flips / feedback fetches / sub-issue closes post-sandbox. The agent inside the sandbox does not call `gh`, does not `git push`, and does not need GitHub credentials.
- **File-IPC verdict channel.** Host writes `<worktree>/.trowel/sandbox-in.json` before launch; agent writes `<worktree>/.trowel/sandbox-out.json` before exit; host reads and translates to gh/git ops. Verdict union: `'ready' | 'needs-revision' | 'no-work-needed' | 'partial'`. Invalid verdicts (missing file, malformed JSON, role-invalid value) coerce to `'partial'` with a log line; never crash the loop.
- **`SandboxIn` shape.** Unified across roles: `{ slice: { id, title, body }, pr?: { number, branch }, feedback?: FeedbackEntry[] }`. Addresser feedback carries all three GitHub comment kinds (`line`, `review`, `thread`), no filtering, sorted by `createdAt`. Slice spec moves out of prompt placeholders into this file.
- **Reduced prompt placeholders.** Single prompt per role at `src/prompts/{implement,review,address}.md` with conditional sections by backend (e.g. `{{#if BACKEND === 'issue'}}…{{/if}}`). Only two placeholders interpolated: `{{BACKEND}}` and `{{INTEGRATION_BRANCH}}`. All per-slice data (id, title, body, pr number, slice branch, feedback) flows through `sandbox-in.json`.
- **Slice-branch pattern.** `prd-<prdId>/slice-<sliceId>-<slug>` on the issue backend. Created on the host via `gh issue develop <sliceN> --name <sliceBranch> --base <integrationBranch>` before the sandbox launches. No new config knob in v0. File backend has no slice branches.
- **File-backend implementer.** Commits straight to the integration branch (no per-slice branch, no PR). Serial — concurrency = 1. On `ready` verdict: host runs `git push origin <integrationBranch>` + `backend.updateSlice(prdId, sliceId, { state: 'CLOSED' })`.
- **PR flow is configurable.** `config.work.usePrs: boolean` (default `true`; issue-backend-only). When `false`: slice branch still created, implementer runs the same way, but on `ready` verdict the host merges `--no-ff` into the integration branch, pushes, deletes the slice branch, and closes the sub-issue (`gh issue close <sliceN>`). Reviewer and addresser refuse with: *"PR-driven review is disabled (`config.work.usePrs: false`); use `trowel work` for the implementer-only flow."* Merge conflicts at the host-side merge coerce to `partial`; slice branch left in place for manual resolution.
- **`Slice` grows two fields.** `prState: 'draft' | 'ready' | 'merged' | null` and `branchAhead: boolean`, both populated by `findSlices`. Both `Bucket` (user-facing) and the loop's internal `ResumeState` derive from these. Issue-backend `findSlices` fetches PR state per slice + a ref-ahead check; file-backend `findSlices` always returns `prState: null, branchAhead: false`.
- **Loop cadence.** `trowel work <prd-id>` runs until the queue drains (every remaining slice is `done`, `draft`, or `blocked`). Safety cap `config.work.maxIterations` (default `5`) bounds the outer loop; per-slice step cap `config.work.sliceStepCap` (default `5`) bounds the inner state-machine reruns. No `--iterations` flag; equipped's `MAX_ITERATIONS` env / CLI plumbing dropped.
- **Worktree location.** `<project root>/.trowel/worktrees/<prd-id>/<sliceId>-<role>-<runId>/`. `trowel init` (any layer; primarily `project`) always creates the target `.trowel/` directory and writes `.trowel/.gitignore` containing `worktrees/`. Lazy fallback: `trowel work` creates `.trowel/` + `.trowel/.gitignore` if missing. Project's root `.gitignore` is never touched. Cleanup: `git worktree remove` on clean exit; stale-prune older than `config.work.worktreeCleanupAge` (default `'24h'`) at next-invocation startup.
- **Verdict-to-host-action table** (per role, after sandbox exit):

  | role + verdict | issue + `usePrs: true` | issue + `usePrs: false` | file |
  |---|---|---|---|
  | implementer `ready` | push slice branch; `gh pr create --draft` | push slice branch; checkout integration; `git merge --no-ff <sliceBranch>`; push integration; delete slice branch; `gh issue close <sliceN>` | push integration; `updateSlice(state: 'CLOSED')` |
  | implementer `no-work-needed` | remove `ready-for-agent` label | remove `ready-for-agent` label | `updateSlice({ readyForAgent: false })` |
  | implementer `partial` | leave | leave | leave |
  | reviewer `ready` | if commits: push; `gh pr ready <prN>` | refuse | refuse |
  | reviewer `needs-revision` | if commits: push; `gh pr edit <prN> --add-label needs-revision` | refuse | refuse |
  | reviewer `partial` | leave | refuse | refuse |
  | addresser `ready` | if commits: push; remove `needs-revision` label | refuse | refuse |
  | addresser `no-work-needed` | remove `needs-revision` label | refuse | refuse |
  | addresser `partial` | leave | refuse | refuse |
  | any role-invalid verdict | coerce to `partial` + log | coerce to `partial` + log | coerce to `partial` + log |

- **PR title prefix dropped.** PRs are titled with the slice title verbatim. Equipped's `"Sandcastle: "` prefix retires with the port.

**Files to write or port (final layout under (c) + the gh-free + sandbox-in.json locks).**

```
src/work/
  loops/
    issue.ts       # the four-state machine; ports utils/process.ts + utils/candidates.ts logic
    file.ts        # 20-line serial implementer-only driver
  sandbox.ts       # wraps @ai-hero/sandcastle; spawns a fresh container per run; reads sandbox-out.json
  prompts.ts       # loadPrompt(role, { BACKEND, INTEGRATION_BRANCH }): string
  types.ts         # SandboxIn, SandboxOut, FeedbackEntry, Verdict, ResumeState, ProcessOutcome
  worktrees.ts     # git worktree add/remove; stale-prune; lazy `.trowel/.gitignore` creation
  feedback.ts      # gh-side fetch of PR comments / reviews / threads into FeedbackEntry[]
src/commands/
  work.ts          # dispatch by backend.name to loops/{issue,file}.ts
  implement.ts     # one-phase command; refuses on bucket mismatch + on file backend nothing extra
  review.ts        # one-phase command; refuses on bucket mismatch + on file backend / usePrs: false
  address.ts       # one-phase command; refuses on bucket mismatch + on file backend / usePrs: false
src/prompts/
  implement.md     # single file, conditional by {{BACKEND}}
  review.md
  address.md
assets/
  Dockerfile       # copied from equipped's .sandcastle/Dockerfile; trowel lazy-copies to ~/.trowel/Dockerfile
```

**Files NOT ported (intentional drops vs the old TODO).**

- `utils/candidates.ts` — fetching is `backend.findSlices`; classification logic into `ResumeState` lives in `src/work/loops/issue.ts` and derives from `Slice.prState` + `Slice.branchAhead` populated by `findSlices`.
- `utils/deps.ts` — body-trailer parser is obsolete after the `blockedBy` refactor (ADR `backend-native-blocker-storage`).
- `utils/config.ts` — `MAX_ITERATIONS` / `ISSUE_STEP_CAP` plumbing replaced by `config.work.maxIterations` / `config.work.sliceStepCap`. `--iterations` CLI flag dropped.
- `utils/gh.ts` — the helpers split between `src/work/feedback.ts` (host-side fetch for addresser) and per-backend modules in `src/backends/implementations/{issue,file}.ts` (PR creation, label flips, slice-branch setup).
- `utils/branches.ts` — slice-branch creation moves to `src/backends/implementations/issue.ts` (host-side, pre-sandbox).

**Dependencies to add.**
- `@ai-hero/sandcastle` (^0.5.7 in equipped; pin to same).

**Verification path.** Two end-to-end runs against scratch repos:
- `file` backend: create a PRD with two `ready` slices, run `trowel work`, verify both slices close in serial; verify worktrees cleaned up; verify slice store.json reflects CLOSED state.
- `issue` backend (private throwaway GitHub repo): create a PRD with three slices (`ready`, `in-flight` mid-flow, `needs-revision`), run `trowel work` once, verify the four-state machine drives each forward correctly; verify a `gh pr ready` fired on the reviewer's `ready` verdict; verify a `needs-revision` label landed on the reviewer's `needs-revision` verdict; verify the addresser pre-fetch populated `.trowel/sandbox-in.json` with the right feedback shape. Then flip `config.work.usePrs: false`, create another PRD, verify no PRs created and slice branches merged via `--no-ff` into the integration branch.

---

## 1.5. ~~Wire `@ai-hero/sandcastle` into the AFK loop~~ — superseded

**Status (2026-05-14).** Done and then undone. The sandcastle integration landed briefly and was then ripped out in favour of host-mode persistent worktrees + a direct `child_process.spawn('claude', ...)` agent invocation. See `docs/adr/2026-05-14-drop-sandcastle-for-host-exec-turns.md` for the rationale and the new design; the original sandcastle integration ADR (`docs/adr/2026-05-12-sandcastle-integration.md`) carries a "Superseded by" banner.

**Net effect on the codebase.** `@ai-hero/sandcastle`, `src/work/image.ts`, `src/utils/oauth-token.ts`, and `assets/Dockerfile` are gone. `src/work/sandbox.ts` was renamed to `src/work/turn.ts` and rewritten around `ensureWorktree`/`resetWorktree`. `config.sandbox` became `config.turn` with shape `{ copyToWorktree, maxConcurrent }`. IPC filenames `sandbox-{in,out}.json` became `turn-{in,out}.json`. Verdict contract and `parseVerdict` semantics unchanged. `_loop-wiring.ts` now preflights `which claude` and sweeps orphan worktrees on each `runLoopFor`.

**Remaining manual sanity check** (not blocking): create a throwaway file-storage PRD, mark a slice ready, run `trowel work <id>`, confirm a worktree spawns under `.trowel/worktrees/<prdId>/<branch-slug>/`, the agent runs, and the verdict is translated.

---

## 2. `trowel start` flow + `start.md` / `resume.md` prompts

**Goal.** The orchestration we've grilled — preflight → grill → create PRD → branch → slice → restore — wired up as a real command, with the Claude prompt that drives it.

**Files to write.**
- `src/commands/start.ts` — replaces the stub in `src/commands/stubs.ts:start`.
- `src/prompts/start.md` — initial-launch prompt.
- `src/prompts/resume.md` — `--prd <id>` mode prompt.

**Flow under (a) strict-precondition + (Y) bookended trap.**

```ts
async function start(opts: { prd?: string; backend?: string }) {
  const { config, projectRoot } = await loadConfig()
  if (!projectRoot) crash('no project root')

  // 0. Preflight (refuse on failure)
  const failures = await runPreflight({ config, projectRoot })
  if (failures.length) crashWithFailures(failures)

  // 1. Capture BACK_TO branch
  const backTo = await captureBranch(projectRoot)

  // 2. Fetch base
  await fetchBase(projectRoot, config.baseBranch)

  // 3. Cross-PRD collision warning (config.collision.enabled)
  const collisions = await detectCollisions({ config, projectRoot })
  if (collisions.length) printAndConfirm(collisions) // y/N prompt

  // 4. Resolve backend (CLI flag → config → default)
  const kind = (opts.backend as BackendKind) ?? config.backend
  const backend = getBackend(kind)

  // 5. Launch Claude with start.md (or resume.md if --prd was passed),
  //    interpolating { BACK_TO, PROJECT_ROOT, BACKEND, PRD_ID? } via loadPrompt().
  //    Use try/finally to restore branch:
  try {
    await spawnClaude(promptText, { agent: config.agent })
  } finally {
    if (backTo) await switchBranch(projectRoot, backTo)
  }
}
```

**Prompt outline (`start.md`).**

```
You are running inside a `trowel start` orchestration session for project at
{{PROJECT_ROOT}}. The chosen backend is {{BACKEND}}.

The user is starting a new feature. Your job:

1. Grill them on the design, sharpening vocabulary and updating docs/CONTEXT.md
   and docs/adr/ as decisions crystallise (read .claude/skills/grill-with-docs/).
2. When the user confirms grilling is done, produce a PRD spec body.
3. Call the appropriate gh / git commands to materialise the PRD per backend:
   - file: generate id, write docs/prds/<id>-<slug>/{README.md, store.json}, create branch prd/<id>-<slug>, commit, push.
   - issue: gh issue create, then create prds-issue-<N>, commit docs, push, gh issue develop.
4. Slice the PRD into vertical-slice GitHub issues, each carrying the
   sliceMarker for this backend ({{SLICE_MARKER_TEMPLATE}}).
5. Apply the `ready-for-agent` label to each slice.
6. Print a summary: PRD identifier, branch, slice URLs.

Do not switch back to {{BACK_TO_BRANCH}} — the host script's `finally` clause
handles that.
```

**Open questions to grill.**
- **One prompt or per-backend prompts?** Default pick: one prompt with conditional sections keyed by `{{BACKEND}}`; Claude reads its own backend and follows the matching block.
- **Where does the slug come from in start mode?** Claude proposes; user confirms? Or trowel asks before invoking Claude? Default pick: Claude proposes mid-grill, locks it before writing artifacts.
- **Cross-grill skill invocation.** Should `start.md` instruct Claude to invoke the `/grill-with-docs` skill? Default pick: yes — its `grill-with-docs` skill is the de-facto grilling discipline.

**Verification path.** Run on a tiny scratch repo with the `file` backend; verify the branch, doc commit, and two slice issues land.

---

## 3. `trowel fix` flow

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

## 4. `trowel diagnose` flow

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

## 5. `trowel init` interactive wizard

**Goal.** Replace the stub with a config-file writer for one of the three init-able layers (`global`, `private`, `project`). Signature: `trowel init [layer]`, where `layer` is a positional arg defaulting to `project`.

**Files to write.**
- `src/commands/init.ts` — replaces stub.

**Flow.**

```
$ trowel init                  # writes the 'project' layer (default)
$ trowel init global           # writes ~/.trowel/config.json
$ trowel init private          # writes ~/.trowel/projects/<full-path>/config.json
$ trowel init project          # writes <project root>/.trowel/config.json

# After picking a layer, prompt for the most-used knobs (current values
# from the existing file, if any, become the prompt defaults):
Backend (file | issue) [file]:
> issue

Branch prefix [prds-issue-]:
>

About to write to /Users/mac/Desktop/code/packages/equipped/.trowel/config.json:

  {
    "backend": "issue",
    "branchPrefix": "prds-issue-"
  }

Write? [Y/n]
> y

Wrote /Users/mac/Desktop/code/packages/equipped/.trowel/config.json
```

**Locked decisions** (from grilling session 2026-05-11):

- **Sparse writes.** Only the keys the user explicitly answered land in the file. Lower layers / defaults supply the rest. Rationale: `partialConfigPipe` is partial-by-design; a full snapshot would couple user files to defaults that change in trowel updates.
- **Prompt set: `backend` always; `branchPrefix` conditional on `backend === 'issue'`.** All other knobs are skipped — power users edit JSON directly. The `file` backend's default branch prefix (`prd/`) is fine universally; the `issue` backend's default is `''`, which collides with feature branches, so we ask.
- **Existing-file behavior: merge, don't refuse.** Parse the existing JSON, validate it, use current values as prompt defaults, then `{ ...existing, ...answers }`. No `--force` flag. Rationale: with sparse writes, force-overwrite would silently destroy hand-edited keys. Read-modify-write is safe to re-run.
- **No project root → refuse for `project` and `private`.** Error message: "no project root found (no `.git/` or `.trowel/` walking up from cwd). Run `git init` first or `cd` into a git repo." `init global` works anywhere — no project root needed.
- **Show resulting JSON + confirm `[Y/n]` before writing.** Closes the loop in merge mode where the user only sees their answers, not the existing keys being preserved. Default-yes (Enter to accept).
- **Library: `@inquirer/prompts`.** Small, typed, supports default-value-in-prompt out of the box (which merge mode requires); `confirm()` covers the write-prompt.
- **Parent dir auto-create.** `mkdir -p` on the target file's directory before writing (`~/.trowel/projects/<mirror>/` won't exist on first use).
- **Abort path.** `n` at the confirm prompt → print "Aborted; nothing written." → exit 0.
- **File format.** JSON, two-space indent, final newline. (Repo uses tabs in source but JSON convention is spaces — matches `gh`, `npm`, etc.)

**Verification path.** Run from a scratch repo; verify file content, sparse-key contents, mkdir-p of `~/.trowel/projects/<mirror>/`, idempotent re-run (no changes → second run is a no-op accept), and merge-preservation of a hand-edited key.

---

## 6. `trowel close` + `trowel status`

**Goal.** Wire the two read-only-ish commands to the backend.

**Files.** `src/commands/{close,status}.ts`. Also: extend `Backend` interface with `findPrd(id) → { branch, state: 'OPEN' | 'CLOSED' } | null`; add `Slice.bucket` field; port `.sandcastle/utils/deps.ts` → `src/utils/deps.ts`.

---

### `close <prd-id>`

**Locked decisions** (from grilling session 2026-05-11):

- **Idempotent.** Every step probes state first; partial-completion re-runs pick up where the previous run stopped. Re-running on a fully-closed PRD prints what was already done and exits 0.
- **Open slices: warn + auto-close.** Before any destructive action, list open slices and prompt `[y/N]`. On `y`, iterate `updateSlice(prdId, sliceId, { state: 'CLOSED' })` then proceed. On `n` or empty, exit 0 without changes. Rationale: PRDs are commonly abandoned mid-flight; forcing per-slice cleanup is bureaucracy. The default-no prompt protects against typo'd PRD ids.
- **Open slice PRs: list + warn.** Between slice auto-close and branch delete, run `gh pr list --base <integrationBranch>` and print any open PRs. If `deleteBranch` policy will delete and PRs exist, prompt `[y/N]` once more. Don't auto-close the PRs — GitHub auto-marks them "Closed" when their base branch is deleted, and the PR thread is worth preserving as a record.
- **Branch deletion: local + remote together, per policy.** `config.close.deleteBranch: 'always' | 'never' | 'prompt'` controls both. `'always'` deletes local + origin without prompting; `'never'` deletes neither; `'prompt'` asks once with `Delete integration branch '<name>' (local + origin)? [y/N]`.
- **Unmerged-branch warning, not refuse.** If the integration branch is not an ancestor of `config.baseBranch`, warn separately (`Branch '<name>' contains commits not on '<baseBranch>' — delete anyway? [y/N]`) **in addition to** the policy prompt. PRDs are commonly closed *because* they're being abandoned — refusing would re-create the bureaucracy.
- **BACK_TO escape for self-deletion.** Use the standard BACK_TO pattern (capture branch on entry, restore on exit). If the user is currently on the integration branch and the delete fires, switch to `config.baseBranch` first, delete, then restore BACK_TO only if BACK_TO still exists. If BACK_TO was the deleted branch, leave the user on `baseBranch` and print: `Switched to '<baseBranch>' (was on deleted branch '<name>')`.
- **Comment behavior follows `config.close.comment`.** Issue backend posts the comment via `gh issue comment` before closing if `comment !== null`. File backend ignores (no GitHub object to comment on).
- **No clean-tree precondition relaxation.** Close switches branches and runs git operations; the global `requireCleanTree: true` precondition stays in force.

**Step ordering.**

```
1. preflight (clean tree, project root, gh auth)
2. capture BACK_TO branch
3. backend.findPrd(prdId) → exit if not found
4. backend.findSlices(prdId) → if any OPEN: warn + confirm + auto-close
5. if prd.state === 'OPEN':
     if backend supports comments && config.close.comment: post comment
     backend.close(prdId)
   else: print "already closed in store"
6. if integration branch exists:
     a. if gh pr list --base <branch> nonempty AND policy will delete: warn + confirm
     b. if not ancestor of baseBranch: warn + confirm
     c. if currently on branch: switch to baseBranch
     d. delete local + origin per policy
7. restore BACK_TO (or stay on baseBranch if BACK_TO was deleted)
```

---

### `status <prd-id>`

**Locked decisions** (from grilling session 2026-05-11):

- **Six-bucket taxonomy.** `done`, `needs-revision`, `in-flight`, `blocked`, `ready`, `draft`. Mutually exclusive. See ADR `backend-owns-slice-bucket-classification` for predicates.
- **Backend owns classification.** Each backend computes `Slice.bucket` inside `findSlices`. `status` is pure presentation. Blocker ids come from `Slice.blockedBy` directly (no body trailers — see ADR `backend-native-blocker-storage`). The `in-flight` bucket is backend-conditional: the `file` backend never emits it.
- **Output: PRD header + sectioned slices.** Header carries id, title, branch, state, and one-line summary counts. Body is one section per non-empty bucket; each section shows slice id + title + bucket-specific right-column metadata. Empty buckets are omitted (so `file`-backend output collapses cleanly with no `in-flight` heading).
- **Right-column metadata per bucket.**
  - `done` — merged PR link/number (issue backend) or `merged` indicator (file backend).
  - `needs-revision` — open PR number (issue backend) or just the badge (file backend).
  - `in-flight` — open PR number + review state (issue backend only).
  - `blocked` — `blockedBy: <id>[, <id>...]` listing unmet blocker slice ids (read from `Slice.blockedBy`).
  - `ready`, `draft` — no extra column.
- **No `--json` mode in v0.** Add when there's a real scripting consumer.
- **Closed PRDs work too.** Read-only / cheap; useful for retro lookups.

**Example output.**

```
PRD ab12cd  Add SSO via Okta
Branch:  prds-issue-142
State:   OPEN          (3 done · 1 in-flight · 2 ready · 1 blocked · 1 draft)

  done
    142  Schema migration                                      #157 merged
    143  Token issuer                                          #160 merged
    144  Logout endpoint                                       #163 merged

  in-flight
    145  Session middleware                                    #168 review

  blocked
    146  SSO admin UI                                          deps: 145

  ready
    147  Audit log
    148  Rate limiter

  draft
    149  Migration rollback runbook
```

**Step ordering.**

```
1. preflight (project root only; status is read-only — no clean-tree needed)
2. backend.findPrd(prdId) → error if not found
3. slices = backend.findSlices(prdId)   // returns Slice[] with .bucket pre-set
4. group slices by bucket; compute summary counts
5. render header + non-empty sections
```

---

**Verification path.** Run both against a scratch PRD on the `file` backend with a handful of slices in different buckets; then against the `issue` backend with real GitHub state (open PR, merged PR, open sub-issue with `needs-revision` label).

---

## 6.5. Migrate from body-trailer deps to backend-native blockers

**Goal.** Replace the `Depends-on:` body-trailer convention with backend-native blocker storage per ADR `backend-native-blocker-storage`. Spike against the live GitHub API was completed 2026-05-11 (results captured in the ADR).

**Locked decisions** (from grilling session 2026-05-11):

- **No coexistence.** Trailers are deleted, not kept as fallback. v0 has no production data to migrate; existing slice bodies that contain `Depends-on:` lines become harmless prose.
- **Field name + shape.** `Slice.blockedBy: string[]` — always present (empty array when none), ids only, no resolution state cached on the type.
- **Spec split.** `PrdSpec = { title, body }`; `SliceSpec = { title, body, blockedBy: string[] }`. `createSlice` takes `SliceSpec`; `createPrd` takes `PrdSpec`.
- **Patch shape.** `SlicePatch.blockedBy?: string[]` is a full-array **replace**, not a delta. Backends compute the diff against the existing list internally.
- **No backend-side validation** that blocker ids resolve to real slices in the PRD. The classifier already tolerates unknown ids (unknown == unmet). Validation belongs to whatever orchestrator wires user input → `updateSlice`.
- **No `blocking` field on `Slice`.** The inverse is pure derivation across the slice list — implement when a consumer needs it.

**Files to change.**

- `src/backends/types.ts` — add `SliceSpec` (separate from `PrdSpec`); add `blockedBy: string[]` to `Slice` and `SlicePatch`.
- `src/utils/deps.ts` — **delete** (no callers after refactor).
- `src/utils/bucket.ts` — unchanged signature; classifier already takes `ctx.unmetDepIds: string[]`. Source of those ids switches from `parseDeps(body)` to `slice.blockedBy.filter(id => !doneIds.has(id))`.
- `src/backends/implementations/file.ts`:
  - `SliceStore` gains `blockedBy: string[]` (flat, alongside `readyForAgent` / `needsRevision`).
  - `createSlice` writes `spec.blockedBy` to `store.json`.
  - `updateSlice` overwrites `store.json.blockedBy` when `patch.blockedBy !== undefined`.
  - `findSlices` reads `blockedBy` from `store.json`; passes `slice.blockedBy.filter(id => !doneIds.has(id))` to `classify`.
- `src/backends/implementations/issue.ts`:
  - `findSlices` reads `issue_dependencies_summary.total_blocked_by` inline from each sub-issue. For slices where `total_blocked_by > 0`, makes one `GET /repos/{o}/{r}/issues/{n}/dependencies/blocked_by` call and maps the response array to `blockedBy: string[]` (issue numbers as strings). For slices where it's 0, `blockedBy: []`.
  - `createSlice` POSTs each entry of `spec.blockedBy` after the issue is created and sub-issue link is established (sequential — `gh api -X POST .../dependencies/blocked_by -F issue_id=<int>`). The blocker's *internal id* is required; resolve via `gh api repos/.../issues/{n} --jq .id` per blocker (or batch from a pre-fetch).
  - `updateSlice` diffs old `blockedBy` (from `findSlices`-like fetch) against `patch.blockedBy`; emits `POST` per added and `DELETE` per removed.
- `src/commands/status.ts` — `extractDepsFromBody` deleted; right column for `blocked` reads `slice.blockedBy.filter(unmet)` and renders `blockedBy: <ids>`.
- Tests:
  - All slice-body fixtures using `\n\nDepends-on: ...` trailers rewritten to use the `blockedBy` field.
  - `src/utils/deps.ts` tests deleted with the file.
  - New issue-backend tests for: `findSlices` skipping `dependencies/blocked_by` fetch when `total_blocked_by === 0`; `findSlices` fetching when > 0; `createSlice` POSTing each blocker; `updateSlice` diffing add/remove.
  - New file-backend tests for: `store.json.blockedBy` round-trip; classifier integration.

**Open question.** None — fact-check on the GitHub API has been resolved (see ADR). Implementation can proceed.

**Verification path.** Scratch repo with both backends:
- file: create two slices, set `blockedBy: [A.id]` on B, verify B's `bucket === 'blocked'`. Close A, re-`findSlices`, verify B's bucket flips to `ready` (assuming readyForAgent).
- issue: end-to-end against a real (private throwaway) GitHub repo. Verify the "Blocked by" panel updates in the GitHub UI after `updateSlice`.

---

## 7. Cross-PRD collision warning (full implementation)

**Goal.** Currently a stub in `src/preflight.ts:detectCollisions`. Real implementation:

- List all branches on origin matching `config.collision.branchPattern` (default `${branchPrefix}*`).
- For each: `git diff --name-only ${config.baseBranch}...${branch}`.
- Return `[{ branch, files }]` for branches with overlapping files vs what the upcoming `trowel start` session is about to touch.

**Catch.** The session hasn't *yet* touched files when the collision check runs — we can only show "what other branches have changed," not "what overlaps." Trade-off: show all branches with any in-flight changes; let the user judge. That matches Q8 (q) from the grilling.

**Files.** Update `src/preflight.ts:detectCollisions`.

**Verification path.** Tested via integration with `trowel start` on a repo with active integration branches.

---

## 8. JSON Schema emission (deferred)

**Goal.** Emit a JSON Schema from `partialConfigPipe()` and write to `~/.trowel/schema.json`. `trowel init` writes `"$schema": "<absolute path>"` into new config files.

**Why deferred.** The user dropped `$schema` from v0. Re-enable when editor autocomplete pain becomes real.

**Files.** New `src/commands/emit-schema.ts` (or sub-command of `init`).

---

## 9. ADR backlog

Decisions worth turning into ADRs once the implementation stabilises:

- **β precedence (project file wins outright).** Genuine trade-off; future-self will wonder why.
- **`private` layer keyed by full-path mirror.** Alternatives considered (basename, encoded segment, git remote).
- ~~**Subsume sandcastle into trowel (Option X).**~~ — superseded by the host-exec Turns pivot (ADR `2026-05-14-drop-sandcastle-for-host-exec-turns`); sandcastle is no longer a dependency.
- **Three backends, one interface.** The strategy pattern + the choice of which operations live on the interface.
- **pnpm-only.** Cross-cutting; matches the user's standing preference (already in personal memory).

Write each as `docs/adr/YYYY-MM-DD-<slug>.md` when the relevant implementation lands.

---

## Order of work (suggested)

1. ~~Port the sandcastle AFK loop into `src/work/`; wire `trowel work`, `implement`, `review`, `address` against both backends.~~ **(done 2026-05-12; Phases A–E committed.)**
2. ~~Section 1.5: wire `@ai-hero/sandcastle`.~~ **(done and then superseded 2026-05-14 — sandcastle dropped in favour of host-mode persistent-worktree Turns; see ADR `2026-05-14-drop-sandcastle-for-host-exec-turns`. `trowel work` now reaches the agent on real `claude` CLI.)**
3. Implement `trowel start` flow end-to-end against the `file` backend (the simpler of the two; no GitHub round-trip for the PRD itself).
4. `fix` + `diagnose` flows.
5. `init` wizard.
6. `close` + `status`.
7. Collision detection + ADR backlog cleanup.

Both backends (`file`, `issue`) are implemented; all four AFK-loop commands are wired end-to-end against the host-mode Turn flow. The remaining unblockers are the workflows in Sections 2–6.
