# Trowel — Context

Trowel is a personal CLI that orchestrates PRD-driven feature work — start, slice, and finish — and subsumes the AFK-agent loop (previously the standalone `sandcastle`). It is single-user, single-machine, not shareable; it installs once and runs against any git project.

> **Note**: Some terminology below — in particular the rename of "Backend" → "Storage" and the storage/loop split — anticipates the architectural pivot recorded in ADR `2026-05-13-storage-behavior-separation.md`. Implementation may lag the documented vocabulary; ADR `2026-05-12-unified-loop-via-backend-primitives.md` still describes the current shape of the code.

## Language

### PRD lifecycle

**PRD**:
A long-form spec describing a single feature or change, identified by a unique **PRD id**. The artifact type — directory of markdown files (`file` storage) or GitHub issue (`issue` storage) — is chosen per project via the **Storage**. The PRD's state (`OPEN` | `CLOSED`) is storage-native: the `file` storage encodes it as a `closedAt: <iso> | null` field in the PRD's `store.json`; the `issue` storage reads native GitHub issue state. On the `file` storage, **trowel does not commit any contents of `prdsDir`** — PRD docs, slice state files, and close transitions are all working-tree-only mutations. If the user keeps `prdsDir` in a git repo, they own staging and committing those changes (including slice-level state transitions written by `trowel work`). The `issue` storage has no working-tree state to commit; its state changes flow through `gh` calls.
_Avoid_: Spec, design doc, ticket, story.

**PRD id**:
The canonical unique identifier for a **PRD**. Form depends on **Storage**: GitHub issue number (`issue`) or 6-character base-36 random string (`file`). The id is what trowel commands take as arguments (`trowel close <id>`, `trowel work <id>`).
_Avoid_: Slug (slug is human-legible, not unique on its own), name.

**Storage**:
The strategy that decides how a **PRD** is persisted, identified, listed, and linked to its **Slices**. One of `file`, `issue`. Storage is **pure persistence** — id format, slice/PRD CRUD, blocker linkage, slice-flag storage, branch-naming convention. The AFK-loop behavior (per-slice branches, PR-flow, reviewer/addresser phases) lives in the loop driver and is selected by **Flags**, not by the storage choice. Each storage declares a set of **Capabilities** that constrain which flag combinations are legal; mismatch errors at config load. PR-flow operations (`openDraftPr`, `markPrReady`, `fetchPrFeedback`, `getPrState`) are free utility functions parameterized by `gh`, not methods on the storage.
_Avoid_: Backend (old name, retired), provider, adapter, driver.

**Capability**:
A primitive property declared by a **Storage** that expresses what platform-level operations the storage's environment supports. Currently the only capability is `prFlow` — true iff the storage's environment has a PR/review surface (`issue`: true, `file`: false). Capabilities gate **Flag** validity: a user-flag that requires a capability the chosen storage doesn't expose is rejected at config load with a precise error. Capabilities are storage **opinions**, not pure technical can-do — a storage author may decline a capability for UX coherence even when the platform technically supports it.
_Avoid_: Feature, support flag.

**Flag**:
A user-configurable behavior toggle in `config.work.*`. Flags drive AFK-loop behavior uniformly across storages, subject to capability gating. The three flags today:
- **`usePrs`** (requires capability `prFlow`): the loop opens a draft PR per slice branch after the implementer's push; the slice's transition to `done` is gated on PR merge. When false, the loop merges the slice branch into the **Integration branch** via `git merge --no-ff` host-side (if `perSliceBranches: true`) or skips slice branches entirely (if `perSliceBranches: false`).
- **`review`** (requires `usePrs: true` and therefore capability `prFlow`): the loop runs the **Reviewer** and **Addresser** phases against the slice's PR. When false, the loop opens the draft PR and stops, awaiting a human review.
- **`perSliceBranches`** (no capability required): each Slice gets its own branch (`prd-<prdId>/slice-<sliceId>-<slug>`) on which the implementer commits. When false, the implementer commits directly to the **Integration branch**. Default `true`; the `false` mode is `maxConcurrent: 1` because parallel implementers would race on a single branch.
_Avoid_: Option, setting.

**Slice**:
One vertical cut of a **PRD** — a discrete piece of work that can be implemented and reviewed independently. Storage is storage-defined: the `file` storage stores slices locally as directories under the PRD's `slices/` subdirectory; the `issue` storage stores them as GitHub sub-issues. Each `Slice` returned by the storage carries `{ id, title, body, state: 'OPEN' | 'CLOSED', readyForAgent, needsRevision, blockedBy: string[] }`. The two AFK-loop signals — `readyForAgent` (eligible for the implementer to pick up) and `needsRevision` (the reviewer flagged the slice's PR for changes) — are stored natively per storage: the `file` storage uses boolean fields in the slice's `store.json`; the `issue` storage uses the presence of GitHub labels whose names come from `StorageDeps.labels.{readyForAgent,needsRevision}` (configurable per project). The slice's **Bucket** and PR-state are **not** storage fields — they are loop-computed projections (see below).
_Avoid_: Sub-issue (overloads GitHub's "sub-issue" feature; sub-issues are only one storage mechanism), task, ticket.

**Bucket**:
The canonical lifecycle classification of a **Slice**, computed by the AFK loop from the slice's storage fields plus PR-state queries. One of `done`, `needs-revision`, `in-flight`, `blocked`, `ready`, `draft`. Mutually exclusive — every slice is in exactly one bucket at any time. Computed by the loop (not the storage) using the storage's raw Slice plus an optional PR-state probe via `getPrState(gh, sliceBranch)` when `usePrs: true`. The `in-flight` bucket only fires when there's an open draft PR for the slice — therefore only reachable under `usePrs: true && prFlow` capability.
_Avoid_: Status (overloaded with `Slice.state: OPEN | CLOSED`, which is one of the raw signals that feeds the bucket), phase, stage.

**Blocker**:
A **Slice** referenced in another **Slice**'s `blockedBy` field. Slice X is blocked by Slice Y means Y must reach the `done` **Bucket** before X is considered unblocked. Storage is storage-native: the `issue` storage uses GitHub's `dependencies/blocked_by` REST API; the `file` storage stores `blockedBy: string[]` as a flat field on the slice's `store.json`. There is no shared body-trailer convention — see ADR `backend-native-blocker-storage`.
_Avoid_: Dependency (ambiguous with build/package "dependencies"), parent (parent is a sub-issue concept, the inverse direction).

**Integration branch**:
The branch that holds the in-flight feature: slice-implementation commits merged in from per-slice branches (or written directly when `perSliceBranches: false`), ready for one final merge to `main` when the feature ships. Naming pattern is storage-defined (the `issue` storage uses `${prefix}${issueNumber}-${slug}`; the `file` storage uses `${prefix}${prdId}-${slug}`). The integration branch is created by `createPrd` on both storages — it is AFK-loop infrastructure, not user content.
_Avoid_: Feature branch (overloaded; trowel reserves "feature branch" for `fix/<slug>` lightweight branches).

### Config discovery

**Project root**:
The directory trowel considers the project's anchor. Resolved by walking up from cwd to the nearest `.trowel/` (preferred) or `.git/` (fallback), whichever is closer.
_Avoid_: Repo root (ambiguous when `.trowel/` lives in a subdir of a monorepo).

**Layer**:
One of the four named config sources trowel reads and merges. Precedence (β): **`project` wins outright** over `private` wins over `global` wins over `default`.

- **`default`** — hard-coded defaults in trowel's source; every knob has a sensible builtin.
- **`global`** — `~/.trowel/config.json`; applies to every project.
- **`private`** — user per-project layer at `~/.trowel/projects/<full-path-mirrored>/config.json`; applies to one project on this machine, never committed.
- **`project`** — project file at `<project root>/.trowel/config.json`; the source of truth for project conventions, wins outright.

The `private` layer is keyed by **full-path mirror**: a project at `/Users/mac/Desktop/code/packages/equipped` reads its private config from `~/.trowel/projects/Users/mac/Desktop/code/packages/equipped/config.json`. No encoding, no hashing — true filesystem mirror.

**Path values inside any layer's config resolve relative to that layer's anchor.** Project-layer paths anchor to the project root (matching every other config-file convention — tsconfig, eslint, prettier). Private-layer paths anchor to the directory of the private config file (`~/.trowel/projects/<mirror>/`). Global-layer paths anchor to `~/.trowel/`. Default-layer paths anchor to project root. Each layer resolves its paths to absolutes at load time; deep-merge then operates on resolved absolute paths, so the merge stays meaningful even when sources have different anchors. A `docs.prdsDir: 'docs/prds'` in the project layer resolves to `<project root>/docs/prds/`; the same string in the private layer resolves to `~/.trowel/projects/<mirror>/docs/prds/`.

The TS type for this enum is `ConfigLayer = 'default' | 'global' | 'private' | 'project'` (see `src/schema.ts`). `InitableLayer` is the subset `Exclude<ConfigLayer, 'default'>` — the three layers `trowel init` can write to.

**BACK_TO branch**:
The branch the user was on when they invoked a trowel command that switches branches. Captured at command start; restored via `try/finally` on exit (clean exit, error, or abort).
_Avoid_: Original branch, prior branch.

### AFK loop

**AFK loop**:
The auto-iterating agent flow run by `trowel work`. A single loop driver in `src/work/loop.ts` iterates the actionable **Slice** queue, computes each slice's **Bucket** from the storage's raw slice plus PR-state queries (when `usePrs: true`), and orchestrates the per-slice phases (`implement` → optionally `review` → `address`) by calling **Storage** CRUD methods + free PR-flow utility functions + GitOps + sandbox spawn. Phase enablement is driven by **Flags** (`usePrs`, `review`, `perSliceBranches`) gated by **Capabilities** (`prFlow`); storages do not contain phase logic. One outer-loop invocation iterates until the **PRD**'s actionable queue drains (every remaining **Slice** is `done`, `draft`, or `blocked`) or the safety cap fires.
_Avoid_: Sandcastle (the equipped-era name; trowel subsumes it), agent runner.

**Implementer / Reviewer / Addresser**:
The three agent roles inside the **AFK loop**. The **Implementer** writes the first cut of a **Slice**, commits, and exits. The **Reviewer** reads the resulting draft PR and either marks it ready or flags `needs-revision`. The **Addresser** reads the reviewer's feedback (line-level, summary, and thread comments fetched by the host via PR-flow utils) and responds with code changes. Reviewer and Addresser fire only when `config.work.usePrs && config.work.review` are both true; this combination requires the chosen **Storage** to declare capability `prFlow`. The default is `usePrs: false`: the implementer's commit is merged into the **Integration branch** (host-side or directly), and the slice's lifecycle ends at the implementer's verdict.
_Avoid_: Worker (placeholder term retired with this entry), agent.

**Turn**:
The bounded execution of one agent **role** (**Implementer**, **Reviewer**, or **Addresser**) against one **Slice**. Each Turn runs as a child process of trowel inside a git worktree, has a definite end (the agent process exits), and produces a **Verdict** plus zero or more commits. Isolation is *worktree-only*: the agent shares the host filesystem outside the worktree, host network, and host PATH. The user's existing `claude` CLI auth in `~/.claude/` is inherited automatically.

Worktrees are **one-per-branch**: each branch trowel checks out (a **Slice branch** under `perSliceBranches: true`, or the **Integration branch** under `perSliceBranches: false`) gets exactly one persistent worktree at `<projectRoot>/.trowel/worktrees/<prdId>/<branch-slug>/`. The worktree is reused across every Turn that checks out that branch (implement, then review, then address, then review again, ...). Between Turns the host resets the working tree to the branch tip (`git restore --staged --worktree .` + `git clean -fd`); the **Verdict** file is the contract for what state survives between Turns, not the working tree. `copyToWorktree` paths are populated once at worktree creation and survive resets because they are gitignored by convention (`git clean -fd` does not touch ignored files). Worktrees are torn down on **orphan** only: when the worktree's branch no longer exists OR the corresponding **Slice** is `CLOSED`. The orphan sweep runs at `trowel work` start; `config.work.worktreeCleanupAge` is the minimum age before an orphan is removed (active worktrees are never swept regardless of age).

Turns are **gh-free**: no GitHub round-trips happen from inside the agent's environment. All `gh` operations (PR creation, label flips, comment fetches, sub-issue closing) happen on the **host** before or after the Turn. The Turn's IPC contract with the host is two files in the worktree's `.trowel/` directory: `turn-in.json` (written by the host before the Turn starts) and `turn-out.json` (written by the agent before it exits).
_Avoid_: Sandbox (retired — the term overspecified Docker isolation), session (claude-coded — Claude Code's own per-conversation JSONL state in `~/.claude/projects/` is a "session"; one Turn may resume or create one or more of those), run (verb-heavy), container, worker.

**Verdict**:
The agent's self-reported outcome of one **Turn**, written by the agent to `.trowel/turn-out.json` and read by the host post-exit. One of `ready`, `needs-revision`, `no-work-needed`, `partial`. The host translates the verdict into `gh` operations (e.g. `gh pr ready` for a reviewer's `ready`; `gh pr edit --add-label needs-revision` for a reviewer's `needs-revision`). A missing or unparseable verdict file is coerced to `partial`; a verdict invalid for the role (e.g. an implementer reporting `needs-revision`) is coerced to `partial` with a log line.
_Avoid_: Result, status, outcome (overloaded; the value's purpose is specifically to drive host follow-up).

**Slice branch**:
The per-slice working branch used by the AFK loop when `perSliceBranches: true`. Pattern: `prd-<prdId>/slice-<sliceId>-<slug>`. Created on the **host** before the **Turn** launches; the implementer's Turn runs in a worktree checked out on this branch. After the implementer's `ready` verdict, the loop either opens a draft PR (`usePrs: true`) or merges the branch into the **Integration branch** via `git merge --no-ff` (`usePrs: false`). When `perSliceBranches: false`, no slice branches exist — the implementer commits directly to the **Integration branch**.
_Avoid_: Feature branch (reserved for `fix/<slug>`), task branch.

## Relationships

- A **PRD** has zero or more **Slices**.
- A **PRD** has exactly one **Integration branch** (named per **Storage**).
- When `config.work.perSliceBranches: true`, every **Slice** has its own **Slice branch**. The post-implementer disposition depends on `usePrs`: `true` → open a draft PR; `false` → `git merge --no-ff` into the **Integration branch**. When `perSliceBranches: false`, no slice branches exist and the implementer commits directly to the **Integration branch**.
- Each **Turn** produces exactly one **Verdict**; the host translates verdicts into the `gh` and `git` operations that move the **Slice**'s **Bucket** forward.
- Every **Slice** is in exactly one **Bucket** at any time, assigned by the **AFK loop** (not the storage).
- A **Slice** may reference zero or more **Blockers** (other slices in the same **PRD**) via its `blockedBy` field; if any blocker is not yet `done`, the slice's bucket is `blocked`.
- The **Storage** is chosen per project; `trowel start`'s `--storage <kind>` flag overrides project config for one invocation.
- Each **Storage** declares zero or more **Capabilities**. **Flag** values are validated against the chosen storage's capabilities at config load; an enabled flag requiring an unavailable capability errors before any work runs.
- Resolution of every config knob walks layers `default` → `global` → `private` → `project`, with later layers' present values overriding earlier ones.

## Example dialogue

> **Q:** "I ran `trowel start` from `~/Desktop/code/packages/equipped/src/orm/`. Which `.trowel/config.json` does it use?"
> **A:** It walks up looking for `.trowel/` first. If `~/Desktop/code/packages/equipped/.trowel/` exists, that's the **Project root** — config comes from there as the `project` **Layer**. If not, it keeps walking and stops at the nearest `.git/`, which is at `~/Desktop/code/packages/equipped/`. The **Project root** is the same in both cases (no nested `.trowel/`).

> **Q:** "I want to use a different agent model for one specific project, but I don't want to commit that to the repo."
> **A:** Drop `{ "agent": { "model": "sonnet" } }` into `~/.trowel/projects/Users/mac/Desktop/code/packages/equipped/config.json` — that's the `private` **Layer**, your per-machine, per-project setting. But if `<project root>/.trowel/config.json` (the `project` **Layer**) sets `agent.model` to something else, `project` wins — that's β precedence.

> **Q:** "I'm on the `file` storage and I set `config.work.usePrs: true`. What happens?"
> **A:** Config load errors with something like `config.work.usePrs requires capability 'prFlow', but storage 'file' does not declare it`. The check fires before any work runs. If you want PR-flow, switch to the `issue` storage; if you want to stay on `file`, drop the `usePrs` flag.

## Flagged ambiguities

- "Sub-issue" was used early in design as a synonym for **Slice**, but GitHub already has a "sub-issue" feature. To avoid confusion, **Slice** is canonical; the GitHub sub-issue API is only one possible **Slice marker** mechanism (used by the `issue` **Storage**).
- "Backend" is the retired name for **Storage**. The codebase (as of this writing) still uses `Backend`, `BackendDeps`, `BackendFactory`, `getBackend`, `config.backend`, and `--backend`; the rename to `Storage`/`StorageDeps`/`StorageFactory`/`getStorage`/`config.storage`/`--storage` is captured in ADR `2026-05-13-storage-behavior-separation.md` and will land with that pivot.
- "Sandbox" is the retired name for **Turn**. It overspecified Docker isolation; the **Turn** vocabulary covers both `kind: 'host'` (no container) and `kind: 'docker'` (future). Code-level identifiers (`spawnSandbox`, `SpawnSandboxArgs`, `sandbox-in.json`, `sandbox-out.json`, `config.sandbox.*`) are scheduled to rename in the same pass that retires sandcastle. The pre-pivot ADR `2026-05-12-sandcastle-integration.md` describes the old shape.
- "Session" is informally used in some places (and in the `2026-05-12-sandcastle-integration.md` ADR body) to mean *Claude Code's per-conversation JSONL state* in `~/.claude/projects/`. It is **not** a trowel-level glossary term; the trowel-level concept is **Turn**. One Turn may resume or create one or more of Claude Code's sessions.

## Out of scope

- Multi-user, multi-machine sharing. Trowel is personal-only.
- Non-git projects. Trowel requires a `.trowel/` or `.git/` to resolve a **Project root**.
- A `projects` map inside any single config file. The `private` layer is one file per project via directory structure, not entries in a map.
- Shared **Turn** environments across agent runs. Each Turn gets a fresh worktree; trowel does not pool or reuse them.
- Containerized isolation for **Turns**. Today Turns run on the host with worktree-only isolation. A future Docker mode is anticipated but not yet a schema dimension; it would re-introduce a sandbox image, the `~/.claude/` bind-mount, and the gh-free network policy.
- `gh` operations from inside a **Turn**. All GitHub round-trips happen on the host; Turns are gh-free by design.
- Reviewer / Addresser on storages without **Capability** `prFlow`. The PR-driven review surface is absent there by construction; users wanting it pick a storage that declares `prFlow` (today: `issue`).
- Auto-committing `prdsDir` contents on the `file` storage. Trowel writes PRD/slice JSON and markdown to disk; if the user keeps `prdsDir` in a git repo, they own staging and committing those files. (The integration branch's per-slice commits — made by the AFK loop's implementer from inside the sandbox — are a different matter and are pushed by the loop as today.)
