# Trowel — TODO

Pending work, organised as discrete grilling sessions. Each item is meant to be picked up cold by a future Claude session — the assumptions, locked decisions, and open design questions are restated inline so no prior conversation is needed.

Pre-work for every session: read `docs/CONTEXT.md` for vocabulary, `README.md` for v0 status, `src/schema.ts` for the config shape, and `src/storages/types.ts` for the Storage interface. Both storages (`file`, `issue`) are implemented in `src/storages/implementations/{file,issue}.ts`; the AFK loop and command wiring built on top are already in place.

---

## Locked, repo-wide (do not re-grill)

These decisions cross every pending session. Don't reopen unless you have a concrete forcing function.

- **Distribution.** Personal CLI, single user, single machine, never shared. Lives at `~/Desktop/code/trowel/`, symlinked from `~/.local/bin/trowel`.
- **Language & runtime.** Node + `tsx`. TypeScript everywhere. `pnpm` for install/scripts/exec — never `npm`.
- **Validation.** All config + external input goes through a `valleyed` pipe. Prefer `v.validate(pipe, input)` (success/error shape) over `v.assert(pipe, input)` (throws, slower).
- **CLI parsing.** `commander`. Each command lives at `src/commands/<name>.ts` and is wired in `src/cli.ts`.
- **PRD-host model.** A **PRD** is configurable per project across two **Storages**: `file`, `issue`. Slices are storage-managed: the `file` storage stores them locally alongside the PRD; the `issue` storage uses GitHub sub-issues (see ADR `slices-local-for-file-backend`). Doc changes (CONTEXT.md, ADRs) live on the **integration branch**, not on `main`.
- **Every PRD has a unique id (see ADR `prd-unique-id-and-file-backend-layout`).** Cross-storage: issue number (`issue`) or 6-char base-36 random (`file`). The id is the argument trowel commands take.
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

## 1. `trowel start` flow + `start.md` / `resume.md` prompts

**Goal.** The orchestration we've grilled — preflight → grill → create PRD → branch → slice → restore — wired up as a real command, with the Claude prompt that drives it.

**Files to write.**
- `src/commands/start.ts` — replaces the stub in `src/commands/stubs.ts:start`.
- `src/prompts/start.md` — initial-launch prompt.
- `src/prompts/resume.md` — `--prd <id>` mode prompt.

**Flow under (a) strict-precondition + (Y) bookended trap.**

```ts
async function start(opts: { prd?: string; storage?: string }) {
  const { config, projectRoot } = await loadConfig()
  if (!projectRoot) crash('no project root')

  // 0. Preflight (refuse on failure)
  const failures = await runPreflight({ config, projectRoot })
  if (failures.length) crashWithFailures(failures)

  // 1. Capture BACK_TO branch
  const backTo = await captureBranch(projectRoot)

  // 2. Fetch base
  await fetchBase(projectRoot, config.baseBranch)

  // 3. Cross-PRD collision warning (see §4)
  const collisions = await detectCollisions({ config, projectRoot })
  if (collisions.length) printAndConfirm(collisions) // y/N prompt

  // 4. Resolve storage (CLI flag → config → default)
  const kind = (opts.storage as StorageKind) ?? config.storage
  const storage = getStorage(kind)

  // 5. Launch Claude with start.md (or resume.md if --prd was passed),
  //    interpolating { BACK_TO, PROJECT_ROOT, STORAGE, PRD_ID? } via loadPrompt().
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
{{PROJECT_ROOT}}. The chosen storage is {{STORAGE}}.

The user is starting a new feature. Your job:

1. Grill them on the design, sharpening vocabulary and updating docs/CONTEXT.md
   and docs/adr/ as decisions crystallise (read .claude/skills/grill-with-docs/).
2. When the user confirms grilling is done, produce a PRD spec body.
3. Call the appropriate gh / git commands to materialise the PRD per storage:
   - file: generate id, write docs/prds/<id>-<slug>/{README.md, store.json}, create branch prd/<id>-<slug>, commit, push.
   - issue: gh issue create, then create prds-issue-<N>, commit docs, push, gh issue develop.
4. Slice the PRD into vertical-slice GitHub issues, each carrying the
   sliceMarker for this storage ({{SLICE_MARKER_TEMPLATE}}).
5. Apply the `ready-for-agent` label to each slice.
6. Print a summary: PRD identifier, branch, slice URLs.

Do not switch back to {{BACK_TO_BRANCH}} — the host script's `finally` clause
handles that.
```

**Open questions to grill.**
- **One prompt or per-storage prompts?** Default pick: one prompt with conditional sections keyed by `{{STORAGE}}`; Claude reads its own storage and follows the matching block.
- **Where does the slug come from in start mode?** Claude proposes; user confirms? Or trowel asks before invoking Claude? Default pick: Claude proposes mid-grill, locks it before writing artifacts.
- **Cross-grill skill invocation.** Should `start.md` instruct Claude to invoke the `/grill-with-docs` skill? Default pick: yes — its `grill-with-docs` skill is the de-facto grilling discipline.

**Verification path.** Run on a tiny scratch repo with the `file` storage; verify the branch, doc commit, and two slice issues land.

---

## 2. `trowel fix` flow

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

## 3. `trowel diagnose` flow

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

## 4. Cross-PRD collision warning

**Goal.** Warn the user when starting a new PRD if other in-flight PRD branches have already touched files. Intended as a pre-step inside `trowel start` (see §1).

**Design (re-grill before implementing — the previous `config.collision.*` knobs were stripped from the schema as unused).**

- List branches on origin matching the PRD branch pattern (e.g. `prd/*` for `file`, `prds-issue-*` for `issue`).
- For each: `git diff --name-only ${config.baseBranch}...${branch}` → file set.
- Return `[{ branch, files }]`; `start` prints them and prompts `[y/N]`.

**Catch.** The session hasn't *yet* touched files when the collision check runs — we can only show "what other branches have changed," not "what overlaps." Trade-off: show all branches with any in-flight changes; let the user judge.

**Files.** New `src/preflight.ts` (or wire directly into `src/commands/start.ts`). Re-introduce a `collision` schema block only if the implementation genuinely needs config knobs.

**Verification path.** Tested via integration with `trowel start` on a repo with active integration branches.

---

## 5. JSON Schema emission (deferred)

**Goal.** Emit a JSON Schema from `partialConfigPipe()` and write to `~/.trowel/schema.json`. `trowel init` writes `"$schema": "<absolute path>"` into new config files.

**Why deferred.** The user dropped `$schema` from v0. Re-enable when editor autocomplete pain becomes real.

**Files.** New `src/commands/emit-schema.ts` (or sub-command of `init`).

---

## 6. ADR backlog

Decisions worth turning into ADRs once the implementation stabilises:

- **β precedence (project file wins outright).** Genuine trade-off; future-self will wonder why.
- **`private` layer keyed by full-path mirror.** Alternatives considered (basename, encoded segment, git remote).
- **Two storages, one interface.** The strategy pattern + the choice of which operations live on the interface.
- **pnpm-only.** Cross-cutting; matches the user's standing preference (already in personal memory).

Write each as `docs/adr/YYYY-MM-DD-<slug>.md` when the relevant implementation lands.

---

## Order of work (suggested)

1. `trowel start` flow end-to-end against the `file` storage (the simpler of the two; no GitHub round-trip for the PRD itself).
2. `fix` + `diagnose` flows.
3. Cross-PRD collision warning (pre-step inside `start`).
4. ADR backlog cleanup.

Both storages (`file`, `issue`) are implemented; all four AFK-loop commands (`work`, `implement`, `review`, `address`) are wired end-to-end against the host-mode Turn flow. `init`, `close`, `status`, and blocker-storage migration are done. The remaining unblockers are the workflows above.
