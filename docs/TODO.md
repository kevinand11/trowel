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
- **Backend interface shape (see ADRs `backend-interface-composite-create`, `slices-local-for-file-backend`, `backend-owns-slice-bucket-classification`).** Creation collapses into a single `Backend.createPrd(spec) → { id, branch }`. Slices: `createSlice(prdId, spec) → Slice`, `findSlices(prdId) → Slice[]` (each `Slice` has `bucket` pre-computed by the backend), `updateSlice(prdId, sliceId, patch)`. PRD discovery: `findPrd(id) → { branch, state } | null`, `branchForExisting`, `listOpen`, `close`. Each backend exposes `defaultBranchPrefix` (used when `config.branchPrefix` is null).
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

**Goal.** Port equipped's `.sandcastle/` directory into `src/work/` and wire `trowel work`, `trowel implement`, `trowel address`, `trowel review` to call into it. Generalise it across the three backends via the `Backend` interface (`findSlices` replaces direct sub-issue API calls).

**Files to port from `~/Desktop/code/packages/equipped/.sandcastle/`.**
- `utils/types.ts` → `src/work/types.ts`
- `utils/shell.ts` → already done as `src/utils/shell.ts` (re-use)
- `utils/deps.ts` → `src/work/deps.ts` (verbatim — the trailer parser is backend-agnostic)
- `utils/git.ts` → merge into `src/utils/git.ts` (most helpers already there)
- `utils/branches.ts` → `src/work/branches.ts`
- `utils/gh.ts` → split: backend-agnostic parts into `src/work/gh.ts`, backend-specific into `src/backends/<kind>.ts`
- `utils/sandbox.ts` → `src/work/sandbox.ts` (wraps `@ai-hero/sandcastle`; add `@ai-hero/sandcastle` as dependency)
- `utils/config.ts` → fold into Trowel's config; loop-specific knobs (`MAX_ITERATIONS`, `ISSUE_STEP_CAP`) move under `config.sandbox`
- `utils/candidates.ts` → split: classify is generic, fetch is backend-specific (already accounted for in `Backend.findSlices`)
- `utils/process.ts` → `src/work/process.ts`
- `main.ts` → `src/commands/work.ts` (entry)
- `implement-prompt.md`, `review-prompt.md`, `respond-to-feedback-prompt.md` → `src/prompts/`

**Generalisations needed.**
- Sub-issue fetch goes through `backend.findSlices(prdId)` — `gh api .../sub_issues` is `issue`-only.
- Branch naming uses `backend.branchFor(prdId)`.
- The `FEATURE_BRANCH` constant becomes `config.baseBranch` (or per-PRD: `backend.branchFor(prdId)`, since PRs target the integration branch, not main).
- Prompt placeholders (`TASK_ID`, `ISSUE_TITLE`, `BRANCH`, `FEATURE_BRANCH`, `PR_NUMBER`) stay; the backend supplies the values.
- The `Sandcastle:` PR title prefix becomes configurable or drops entirely.

**Dependencies to add.**
- `@ai-hero/sandcastle` (^0.5.7 in equipped; pin to same).

**Slice-id-must-belong-to-prd-id check.** Every per-slice command (`implement`, `address`, `review`) calls `backend.findSlices(prdId)` and confirms `sliceId` is in the returned set before proceeding. If not in set: print error + exit non-zero.

**Open questions to grill.**
- **Sandbox image.** `config.sandbox.image` defaults to `node:22-bookworm` in `defaultConfig`. The Dockerfile in equipped's `.sandcastle/` does more than that (installs gh, claude CLI, etc.). Port the Dockerfile? Or run un-sandboxed? Default pick: port the Dockerfile to `~/.trowel/Dockerfile`; trowel builds the image lazily.
- **Per-PRD vs per-project sandboxing.** Each `trowel work <prd-id>` builds and uses a single sandbox container; siblings (multiple PRDs concurrently) get their own. Confirm.

**Verification path.** Run end-to-end on equipped against a real PRD with one or two simple slices.

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
- **Backend owns classification.** Each backend computes `Slice.bucket` inside `findSlices`. `status` is pure presentation. Dep parsing lives in shared `src/utils/deps.ts`; both backends import it. The `in-flight` bucket is backend-conditional: the `file` backend never emits it.
- **Output: PRD header + sectioned slices.** Header carries id, title, branch, state, and one-line summary counts. Body is one section per non-empty bucket; each section shows slice id + title + bucket-specific right-column metadata. Empty buckets are omitted (so `file`-backend output collapses cleanly with no `in-flight` heading).
- **Right-column metadata per bucket.**
  - `done` — merged PR link/number (issue backend) or `merged` indicator (file backend).
  - `needs-revision` — open PR number (issue backend) or just the badge (file backend).
  - `in-flight` — open PR number + review state (issue backend only).
  - `blocked` — `deps: <id>[, <id>...]` listing unmet dep slice ids.
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
- **Subsume sandcastle into trowel (Option X).** Trowel grows the AFK loop; equipped's `.sandcastle/` retires.
- **Three backends, one interface.** The strategy pattern + the choice of which operations live on the interface.
- **pnpm-only.** Cross-cutting; matches the user's standing preference (already in personal memory).

Write each as `docs/adr/YYYY-MM-DD-<slug>.md` when the relevant implementation lands.

---

## Order of work (suggested)

1. Implement `trowel start` flow end-to-end against the `file` backend (the simpler of the two; no GitHub round-trip for the PRD itself).
2. Port the sandcastle AFK loop into `src/work/`; wire `trowel work` against both backends via the `Backend` interface.
3. `fix` + `diagnose` flows.
4. `init` wizard.
5. `close` + `status`.
6. Collision detection + ADR backlog cleanup.

Both backends (`file`, `issue`) are implemented; the remaining work is wiring them into commands and orchestration.
