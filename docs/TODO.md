# Trowel — TODO

Pending work, organised as discrete grilling sessions. Each item is meant to be picked up cold by a future agent session.

Pre-work for every session: read `docs/CONTEXT.md` for vocabulary and repo conventions, `README.md` for current command shape, `src/schema.ts` for config, and `src/storages/types.ts` for the Storage interface.

---

## 1. Sandboxed Turn execution (Docker `kind`)

**Goal.** Run **Turns** inside a Docker container instead of directly on the host. Today every Turn runs host-side with worktree-only isolation: the agent shares host filesystem outside the worktree, host network, host PATH, and user auth. A Docker mode would constrain filesystem to the bind-mounted worktree, network to a host-controlled policy, PATH to the image toolchain, and auth to an explicit mount.

**Reference.** Historical ADRs under `docs/adr/` describe the pre-pivot sandcastle shape. Treat them as history, not current terminology.

**Files likely touched.**

- `src/schema.ts` — add `turn.kind: 'host' | 'docker'` and image/network knobs if needed.
- `src/work/turn.ts` — dispatch host vs docker.
- harness adapters — expose argv suitable for container execution.
- tests for host parity and docker command construction.

Open questions to grill:

- Where should Docker config live: `turn.*`, `agent.*`, or a dedicated `docker.*` section?
- What is the default network policy?
- Which host paths are mounted beyond the worktree and auth?
- How are missing Docker/image/tooling failures surfaced in `doctor`?

---

## 2. Slice PR readiness when `ship.pr` is true and `work.audit` is false

**Goal.** Confirm and lock the semantics for PR-mode Slice work when Auditing is disabled: implementation opens a draft Slice PR from the **Slice branch** to the **Change branch**, then Trowel either marks it ready immediately or records a clear state/guidance that a human must make it ready.

**Files likely touched.**

- `src/work/phases.ts` — implementation landing behavior that opens the draft PR and optional readiness transition.
- `src/work/classify.ts`, `src/work/loop.ts` — draft PR classification when `work.audit: false`.
- `src/work/pr-flow.ts` — PR-state enrichment for draft vs ready PRs.
- Tests for `ship.pr: true`, `work.audit: false` across implementation, classification, and loop behavior.

Open questions to grill:

- Should status display this as `implemented`, `awaiting-review`, or another explicit Slice state/message?
- Should `trowel change work` remind the user to manually review/merge the draft Slice PR?
- If `work.audit` is later toggled to `true`, should existing draft Slice PRs resume into the Auditor phase?

---

## 3. Separate Change Close-out revision handling from Slice work

**Goal.** Change-level Close-out PRs are now controlled by `ship.pr`. Follow up by deciding whether requested changes on a Close-out PR should create a Change-level agent pass, stay manual, or block Ship with guidance only.

**Files likely touched.**

- `src/utils/change-state.ts` — Change state vocabulary and computation for Close-out PR feedback.
- `src/commands/ship/index.ts` — Ship guidance when a Close-out PR needs revision.
- `src/work/pr-flow.ts`, `src/utils/gh-ops.ts` — Close-out PR feedback/label enrichment.
- `README.md`, `docs/CONTEXT.md` — command/config language.

Open questions to grill:

- Is the state name `needs-revision`, `blocked`, `in-review`, or something else?
- Does revision work run from `trowel change work`, `trowel change ship`, or only a future project-level loop?
- What feedback payload should the Turn receive, and how does it avoid mutating Slice state?

---

## 4. Change Close-out PR needs-revision state and agent pass

**Goal.** Add a Change lifecycle representation for an open Close-out PR that cannot be shipped because it has review feedback, blockers, or requested changes that need an agent **Turn** on the **Change branch**.

**Files likely touched.**

- `src/storages/types.ts`, `src/utils/change-state.ts` — Change state vocabulary and computation.
- `src/work/entity-loop.ts` and any future project-level loop — dispatch for Change-level PR work.
- `src/work/pr-flow.ts`, `src/utils/gh-ops.ts` — Close-out PR feedback/label enrichment.
- `src/prompts/` — possible Change-level review-feedback prompt.
- Tests for state computation and loop/Ship guidance.

Open questions to grill:

- What is the state name: `needs-revision`, `blocked`, `in-review`, or something else?
- Is the agent role the same as Slice Reviewer, or a distinct Change-level role?
- Does this run from `trowel change work`, `trowel change ship`, or only the future project-level loop?
- What feedback payload should the Turn receive, and how does it avoid mutating Slice state?

---

## 5. Commit grilling doc updates before Slice branch creation

**Goal.** Settle how doc updates made during **Grill** — especially `docs/CONTEXT.md` and ADR edits — are committed onto the **Change branch** before **Slice branches** are created, so every Slice starts from the agreed domain/docs baseline.

**Files likely touched.**

- `src/commands/start.ts`, `src/commands/grill-flow.ts` — Start materialisation order.
- `src/utils/git-ops.ts` — detecting, staging, and committing eligible doc updates.
- `src/prompts/start.md` — Grill instructions around docs and ADRs.
- Tests covering doc edits, unrelated working-tree changes, and Slice branch base commits.

Open questions to grill:

- Which paths are eligible for auto-commit: `docs/CONTEXT.md`, `docs/adr/**`, generated Change/Slice artifacts, others?
- Should auto-commit always happen when eligible docs changed, or require user confirmation?
- What commit message should be used, and should it include the Change id?
- How are unrelated uncommitted changes protected from accidental staging?
- Does behavior differ between `file` and `issue` Storage?

---

## 6. Config schema descriptions and flow audit

**Goal.** Add metadata descriptions for every config schema property emitted by `emitJsonSchema`, and verify how each property actually controls Trowel flow so schema/docs/defaults do not drift from runtime behavior.

**Files likely touched.**

- `src/schema.ts` — JSON Schema metadata, defaults, tests.
- `README.md` and any config docs/examples — user-facing descriptions.
- Command/runtime files that consume config: `src/commands/**`, `src/work/**`, storage factories, harness factories.
- Tests for emitted schema descriptions/default-sensitive behavior.

Open questions to grill:

- Does `valleyed` support descriptions/defaults directly, or does Trowel need a schema post-processing layer?
- Should schema include only `description`, or also `default`, examples, and enum descriptions?
- Where should the flow audit live: inline comments, generated schema, README, or a dedicated config doc?
- Which descriptions need to change after the `ship.pr` / `work.perSliceBranches` runtime audit?

---

## 7. Start Target branch selection prompt

**Goal.** `trowel start` should ask whether to use the current branch as the **Target branch** or let the user provide another branch, then verify that branch exists before materialising the Change.

**Files likely touched.**

- `src/commands/start.ts`, `src/commands/grill-flow.ts` — Target branch selection and resume behavior.
- `src/utils/git-ops.ts` — local/remote branch existence checks.
- `README.md` — command shape and examples.
- Tests for default current-branch flow, alternate branch input, missing branch failure, and non-interactive handling.

Open questions to grill:

- Does the prompt run before Grill, after Grill, or only just before materialisation?
- Is the default Target branch the current branch, `git baseBranch`, or a configured default?
- Should an existing remote-only branch be accepted and checked out/fetched, or must it exist locally?
- How should resume/non-interactive flows recover if the selected Target branch later disappears?

---

## 8. Work loop slot polling instead of batch completion

**Goal.** Ensure the **AFK loop** continuously fills free concurrency slots as soon as a Slice finishes, rather than launching a batch and waiting for the whole batch to complete before picking new work. This may be a verification/refactor task if current `runLoop` already satisfies it.

**Files likely touched.**

- `src/work/loop.ts` — scheduler and concurrency refill behavior.
- `src/work/process-slice.ts` — per-Slice outcome boundaries.
- Tests for slow/fast Slices, blocked Slices becoming unblocked, partial failures, and branch-sharing limits.

Open questions to grill:

- Does current `Promise.race` refill behavior already meet the desired semantics? If not, which scenario fails?
- How often should the loop refetch PR-enriched Slice state while other Turns are still running?
- How should `partial` and failed Slices affect future slot selection in the same run?
- How does this interact with `perSliceBranches: false`, where Slices share the Change branch and concurrency must collapse safely?

---

## 9. Project-level AFK loop across Changes

**Goal.** Add a project-scoped work loop that scans Slices across all open Changes and drives available work to completion, optionally filtered by a list of Change ids. This could replace or soft-deprecate the current `trowel change work <id>` workflow.

**Files likely touched.**

- CLI command wiring for a project-level work command.
- `src/work/entity-loop.ts`, `src/work/loop.ts` — scheduling across more than one Change.
- `src/storages/types.ts` and storage implementations — listing Changes and fetching Slices efficiently.
- `README.md`, `docs/CONTEXT.md` — command language and lifecycle docs.
- Tests for filtering, fairness, concurrency, and non-work Change states.

Open questions to grill:

- Command shape: `trowel work`, `trowel project work`, or an evolved `trowel change work`?
- How should work be prioritised across Changes: round-robin, oldest first, newest first, or configurable?
- Should the project loop only run Slice work, or also guide/handle closeable, in-flight, landed, and Close-out PR revision states?
- How are concurrency limits applied across Changes, Change branches, Slice branches, and the Mutation lock?
- What does `--change <id>` / filter-list behavior look like?

---

## 10. Post-Ship Target branch sync

**Goal.** After **Ship**, pull or otherwise fast-forward from `origin` when the user's checkout ends on the **Target branch**, so the local branch reflects remote updates caused by PR merge or host push.

**Files likely touched.**

- `src/commands/ship/index.ts` — post-Ship restore/sync order.
- `src/utils/git-ops.ts` — fetch/pull/fast-forward operation.
- Tests for PR-mode merge, host-merge Ship, BACK_TO restoration, missing upstream, and dirty-tree safety.

Open questions to grill:

- Should sync run only when `BACK_TO === Target branch`, or whenever the current branch after restore is the Target branch?
- Should implementation use `git pull --ff-only`, `fetch` plus fast-forward, or explicit ref update?
- Does this apply after PR-mode Ship only, or also after host-merge Ship?
- How should missing upstream, diverged branches, or post-Ship dirtiness be reported?

---

## 11. Ship cleanup must not delete Target branch

**Goal.** During Ship cleanup, delete the local **Change branch** only when it is different from the **Target branch**. If they are equal, cleanup must not delete the Target branch even when branch deletion policy is `always`.

**Files likely touched.**

- `src/work/cleanup.ts` — local branch deletion candidate selection.
- `src/commands/ship/index.ts` — Ship-specific cleanup policy and tests.
- Possibly `src/commands/abort/index.ts` if the shared Cleanup guard should apply to Abort too.
- Tests for candidate filtering, current-branch refusal, and protected branch messaging.

Open questions to grill:

- Should the protection apply only to Ship, or to all Cleanup callers including Abort?
- Should Slice branches equal to the Target branch also be protected?
- Should current-branch refusal ignore protected branches so Ship does not fail before a safe cleanup?
- What should output say when a protected branch is skipped?

---

## 12. Multiple Changes from one Grill

**Goal.** Allow `trowel start` to produce more than one Change from a single Grill session when the user request naturally splits into independent
 Changes.

**Files likely touched.**

- `src/commands/start.ts`, `src/commands/grill-flow.ts` — materialise multiple Change outcomes.
- Start output schema / host handling — support an array of Changes with Slices.
- `src/prompts/start.md` — allow the agent to propose multiple Changes and ask the user to confirm boundaries.
- Storage implementations — verify branch creation and metadata writes are safe across multiple Changes.
- Tests for one-Change backward compatibility, multi-Change materialisation, partial failure handling, and output guidance.

Open questions to grill:

- Should `start-out.json` support both single and multiple Changes, or hard-migrate to an array shape?
- Should multiple Changes be materialised atomically, or can earlier Changes remain if later materialisation fails?
- How should `trowel start` present next-step guidance for multiple created Changes?
- Should Slices be allowed to block Slices in other Changes, or are Change boundaries dependency-isolated?
- Should the Grill decide multiple Changes autonomously, or only after explicit user confirmation?

---

## 13. Loosen Grill doc-edit permissions

**Goal.** Allow `trowel start` Grill sessions to edit any appropriate files under `docs/`, not only `docs/CONTEXT.md` and `docs/adr/**`, so domain
decisions, TODOs, and other planning docs can be updated inline when they crystallize during grilling.

**Files likely touched.**

- `src/prompts/start.md` — update allowed edit paths for the start agent.
- `src/commands/start.ts`, `src/commands/grill-flow.ts` — ensure host/session permissions match prompt constraints.
- Tests or fixtures that assert allowed/blocked Grill file edits.
- `docs/CONTEXT.md` / README — document what Grill may edit.

Open questions to grill:

- Should all `docs/**` be editable, or only markdown files under `docs/`?
- Should generated Change/Slice artifacts under docs be protected from Grill edits?
- Should `docs/TODO.md` be explicitly called out as editable?
- Should ADR numbering/format rules remain special even when all docs are editable?
- How should dirty-tree warnings describe broader docs edits during Grill?
