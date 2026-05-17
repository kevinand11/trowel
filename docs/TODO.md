# Trowel — TODO

Pending work, organised as discrete grilling sessions. Each item is meant to be picked up cold by a future Claude session — the assumptions, locked decisions, and open design questions are restated inline so no prior conversation is needed.

Pre-work for every session: read `docs/CONTEXT.md` for vocabulary and repo conventions, `README.md` for v0 status, `src/schema.ts` for the config shape, and `src/storages/types.ts` for the Storage interface. Both storages (`file`, `issue`) are implemented in `src/storages/implementations/{file,issue}.ts`; the AFK loop and command wiring built on top are already in place.

---

## 1. `trowel start` flow + `start.md` prompt

**Status.** Design fully grilled and locked. Ready to implement. Pick this up cold — every decision is recorded inline below.

**Goal.** Single-shot orchestration: host launches interactive Claude, user grills out a PRD spec + slices, Claude writes the structured result to `.trowel/start-out.json` and exits, host materialises the PRD + slices via the existing Storage interface and leaves the user on the integration branch.

**Files to write or edit.**

- **`src/commands/start.ts`** — new file; replaces the stub in `src/commands/stubs.ts:start`.
- **`src/prompts/start.md`** — new file; single self-contained prompt with **no template variables**.
- **`src/work/verdict.ts`** — tighten validation to fail loudly on malformed `turn-out.json` instead of coercing to `partial`. Same strict valleyed pipe shape is reused for parsing `start-out.json`.
- **`src/prompts/implement.md` / `review.md` / `address.md`** — drop `{{INTEGRATION_BRANCH}}` and `{{STORAGE}}`; delete the `{{#issue}}` / `{{#file}}` conditional blocks in `implement.md` (the loader in `src/prompts/load.ts:22` doesn't support mustache conditionals anyway, so they're already emitted verbatim today).
- **`src/commands/_loop-wiring.ts:57`** — `loadPrompt(role, { integrationBranch, storage })` becomes `loadPrompt(role, {})`.
- **`src/cli.ts`** — point `start` at the real command; remove the `--prd <id>` option line.
- **`src/commands/stubs.ts`** — delete the `start` export.

**CLI surface.**

```
trowel start [--storage <kind>]
```

No `--prd` flag. No resume mode.

**Host flow.**

1. **Preflight (fail-fast).** Project root resolvable; clean working tree (`git status --porcelain` empty); `claude` on PATH; `gh` on PATH + `gh auth status` succeeds. Applied unconditionally regardless of storage.
2. **Capture BACK_TO** via the existing `GitOps.currentBranch()`.
3. **Render prompt.** `loadPrompt('start', {})` — no variable substitution.
4. **Launch interactive Claude.** Spawn `claude --append-system-prompt @<path-to-rendered>` (verify exact flag against current Claude Code CLI at implementation time; fall back to a project-level slash-command pattern if the flag has dropped). `stdio: 'inherit'`, `cwd: projectRoot`. **No log capture** — the user *is* the output.
5. **On Claude exit, read `.trowel/start-out.json`.**
    - Missing → print "PRD not created. Working tree has grill changes; review with `git status`, then `git checkout .` to discard or stash/commit to keep." Restore BACK_TO via `finally`. Exit non-zero.
    - Present → continue.
6. **Validate schema.** Run through a valleyed pipe (shape below). Then host-side checks: every index in `slices[*].blockedBy` ∈ `[0, slices.length)`; no self-references; no cycles (DAG check). On any violation: print the offending slice + reason; restore BACK_TO; exit non-zero.
7. **Stash any dirty tree.** `git stash --include-untracked`. If clean, skip the stash entirely (no `git stash` call).
8. **`storage.createPrd({title: prd.title, body: prd.body})`** → `{id, branch}`. Storage handles slug derivation, integration-branch creation off `git.baseBranch()`, and any side artifacts.
9. **`git switch <branch>`** onto the new integration branch.
10. **`git stash pop`** (only if a stash was made). On conflict: leave the user on integration with conflict markers, print the stash hash, exit non-zero. Do **not** restore BACK_TO — the grill output is too expensive to discard.
11. **Create slices in array order.** For each `spec.slices[i]`: `storage.createSlice(prdId, {title, body, blockedBy: []})`. Keep an array `realIds[i]` of returned slice ids.
12. **Resolve and patch.** For each slice, map `blockedBy: number[]` to `realIds[...]` and call `storage.updateSlice(prdId, sliceId, {blockedBy: resolvedIds, readyForAgent: spec.slices[i].readyForAgent})`.
13. **Print summary** — PRD id, integration branch, slice list with ids + titles, list of uncommitted paths from `git status --porcelain` as a reminder for the user to review and commit at their discretion, and a `Next: trowel work <id>` hint.
14. **`finally` clause.**
    - Success → **no branch restore** (user stays on integration).
    - Failure before step 8 → restore BACK_TO. Tree state stays as Claude left it; user inspects and discards.
    - Failure after step 8 → leave user where they are. The PRD exists and can be closed via `trowel close <id>`.

**`start-out.json` schema.**

```ts
{
  prd: { title: string, body: string },
  slices: Array<{
    title: string,
    body: string,
    blockedBy: number[],   // 0-based indexes into `slices`
    readyForAgent: boolean
  }>
}
```

Validated by a valleyed pipe (same discipline as `src/schema.ts:partialConfigPipe`). Then DAG-checked host-side.

**`start.md` outline (single self-contained file, no template variables).**

1. **Role.** "You are inside a `trowel start` orchestration. Your output target is the file `.trowel/start-out.json` in the current working directory."
2. **Pre-grill reading list.** `CONTEXT.md`, `CONTEXT-MAP.md` (if present), every file under `docs/adr/`, `README.md`, and the top-level `src/` directory listing.
3. **Grilling discipline (inlined — do not depend on any user-installed skill).**
    - One question at a time; wait for feedback before continuing.
    - Provide a recommended default with every question.
    - Cross-reference with code; surface contradictions immediately.
    - Sharpen fuzzy language; challenge against the existing glossary.
    - Discuss concrete scenarios to probe boundaries.
    - Update CONTEXT.md inline as terms resolve.
    - Offer ADRs **only** when all three hold: (a) hard-to-reverse, (b) surprising without context, (c) the result of a real trade-off.
4. **CONTEXT.md format spec (inlined verbatim).** Title and one-paragraph description; `## Language` with bold-name definitions plus `_Avoid_:` alias lines; `## Relationships` (bold-name terms with cardinality); `## Example dialogue`; `## Flagged ambiguities`. Rules: be opinionated, flag conflicts explicitly, keep definitions tight (one sentence — define what it IS, not what it does), show relationships, only domain-specific terms (no general programming concepts), group under subheadings when natural clusters emerge, write an example dialogue.
5. **ADR format spec (inlined verbatim).** Lives in `docs/adr/` with sequential `NNNN-slug.md` numbering. Body can be 1–3 sentences. Optional `Status` frontmatter, `Considered Options`, `Consequences` sections — only when they add value.
6. **Doc-edit scope rule.** During the grill, Claude may edit **only** `CONTEXT.md`, `CONTEXT-MAP.md`, files under `docs/adr/`, and per-context `CONTEXT.md` files. No other working-tree writes.
7. **Phase 1 — grill.** Run until the user signals "grill done." Vocabulary, scope, and design questions are all on the table.
8. **Phase 2a — draft the PRD body in markdown.** Template (adapted from the `to-prd` skill; inline verbatim):
    - `## Problem Statement` — user's-perspective description of the problem.
    - `## Solution` — user's-perspective description of the solution.
    - `## User Stories` — numbered list, `As a <actor>, I want <feature>, so that <benefit>`. Extensive.
    - `## Implementation Decisions` — modules built/modified, interfaces, schema changes, API contracts, architectural decisions. **No** specific file paths or code snippets.
    - `## Testing Decisions` — what makes a good test (external behavior, not implementation), modules to test, prior art.
    - `## Out of Scope`.
    - `## Further Notes`.
    - Show the drafted markdown body in chat; user pushes back or locks before continuing.
9. **Phase 2b — draft slices.** Present as a markdown table — columns: index, title, AFK/HITL, blocked-by-indexes, one-line summary. Inline vertical-slice rules (from the `to-issues` skill): each slice cuts end-to-end through every layer (schema → API → UI → tests); a completed slice is demoable on its own; prefer many thin slices over few thick ones. All blockers are treated as hard — there is no soft/hard distinction in trowel. User pushes back or locks.
10. **Slice body template (markdown).** Two sections only:
    - `## What to build` — end-to-end behavior of this vertical slice. Not layer-by-layer.
    - `## Acceptance criteria` — checkbox list.
    No `Blocked by` section in the body; the data lives only in the JSON's `blockedBy` array.
11. **Final step.** Serialize the locked spec to JSON matching the schema, write to `.trowel/start-out.json`, then print "ready — exit when you're done" so the user can close the Claude session.

**Verification path.**

1. Scratch repo with `storage: file` and a clean tree.
2. Run `trowel start` from `main`. Grill a tiny feature (e.g. "rename Foo to Bar"); draft a 2-slice PRD.
3. Verify: integration branch checked out; `docs/prds/<id>-<slug>/{README.md, store.json}` written; two slice directories with bodies; `readyForAgent: true` in each slice's `store.json` per the spec; summary printed.
4. Repeat on a scratch GitHub repo with `storage: issue`; verify the GH issue + sub-issues are created; integration branch from `gh issue develop` checked out; labels applied.
5. Abort path: run `trowel start`, exit Claude without writing `start-out.json`. Verify host prints recovery message; user back on BACK_TO; working tree retains Claude's CONTEXT/ADR edits for manual handling.
6. Validation path: hand-craft a `.trowel/start-out.json` with an out-of-range `blockedBy` index; verify host fails with the offending slice's index named and no `createPrd` call.

**Non-goals for this session.**

- Cross-PRD collision warning (dropped — see deleted §4 in git history).
- Worktree usage for the grill (start runs in the user's main checkout, not a worktree).
- Auto-committing CONTEXT/ADR edits on the integration branch (user commits at their discretion; host only stash-dances them across the branch switch).

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

## Order of work (suggested)

1. `trowel start` flow end-to-end against the `file` storage (the simpler of the two; no GitHub round-trip for the PRD itself).
2. `fix` + `diagnose` flows.
