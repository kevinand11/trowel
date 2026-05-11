# Trowel — Context

Trowel is a personal CLI that orchestrates PRD-driven feature work — start, slice, and finish — and subsumes the AFK-agent loop (previously the standalone `sandcastle`). It is single-user, single-machine, not shareable; it installs once and runs against any git project.

## Language

### PRD lifecycle

**PRD**:
A long-form spec describing a single feature or change, identified by a unique **PRD id**. The artifact type — directory of markdown files (`file` backend) or GitHub issue (`issue` backend) — is chosen per project via the **backend**.
_Avoid_: Spec, design doc, ticket, story.

**PRD id**:
The canonical unique identifier for a **PRD**. Form depends on **backend**: GitHub issue number (`issue`) or 6-character base-36 random string (`file`). The id is what trowel commands take as arguments (`trowel close <id>`, `trowel work <id>`).
_Avoid_: Slug (slug is human-legible, not unique on its own), name.

**Backend**:
The strategy that decides how a **PRD** is stored, identified, listed, and linked to its **slices**. One of `file`, `issue`.
_Avoid_: Provider, adapter, driver.

**Slice**:
One vertical cut of a **PRD** — a discrete piece of work that can be implemented and reviewed independently. Storage is backend-defined: the `file` backend stores slices locally as directories under the PRD's `slices/` subdirectory; the `issue` backend stores them as GitHub sub-issues. Slice implementation flow is backend-dependent too: the `issue` backend routes implementation through a GitHub PR managed by the AFK loop; the `file` backend has no PR concept (slices transition OPEN → CLOSED directly). Each `Slice` carries a **Bucket** describing its current lifecycle position, and a `blockedBy: string[]` of **Blocker** slice ids.
_Avoid_: Sub-issue (overloads GitHub's "sub-issue" feature; sub-issues are only one storage mechanism), task, ticket.

**Bucket**:
The canonical lifecycle classification of a **Slice**. One of `done`, `needs-revision`, `in-flight`, `blocked`, `ready`, `draft`. Mutually exclusive — every slice is in exactly one bucket. Assigned by the **Backend** inside `findSlices` (not by `trowel status`); see ADR `backend-owns-slice-bucket-classification` for the predicate table. The `in-flight` bucket only fires for backends that track PRs (`issue`); the `file` backend never emits it.
_Avoid_: Status (overloaded with `Slice.state: OPEN | CLOSED`, which is a separate raw signal that feeds the bucket), phase, stage.

**Blocker**:
A **Slice** referenced in another **Slice**'s `blockedBy` field. Slice X is blocked by Slice Y means Y must reach the `done` **Bucket** before X is considered unblocked. Storage is backend-native: the `issue` backend uses GitHub's `dependencies/blocked_by` REST API; the `file` backend stores `blockedBy: string[]` as a flat field on the slice's `store.json`. There is no shared body-trailer convention — see ADR `backend-native-blocker-storage`.
_Avoid_: Dependency (ambiguous with build/package "dependencies"), parent (parent is a sub-issue concept, the inverse direction).

**Integration branch**:
The branch that holds the in-flight feature: doc commits from the **PRD** session, slice-implementation commits merged in from per-slice PRs, ready for one final merge to `main` when the feature ships. Naming pattern is backend-defined.
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

### AFK loop (deferred — port from `.sandcastle/`)

**Worker** (placeholder): A sandboxed agent run by `trowel work` — implementer, reviewer, or addresser. Vocabulary will sharpen when the port lands.

## Relationships

- A **PRD** has zero or more **Slices**.
- A **PRD** has exactly one **Integration branch** (named per **Backend**).
- Every **Slice** carries a **Slice marker** referring to its **PRD**.
- Every **Slice** is in exactly one **Bucket** at any time, assigned by its **Backend**.
- A **Slice** may reference zero or more **Blockers** (other slices in the same **PRD**) via its `blockedBy` field; if any blocker is not yet `done`, the slice's bucket is `blocked`.
- The **Backend** is chosen per project; `trowel start`'s `--backend <kind>` flag overrides project config for one invocation.
- Resolution of every config knob walks layers `default` → `global` → `private` → `project`, with later layers' present values overriding earlier ones.

## Example dialogue

> **Q:** "I ran `trowel start` from `~/Desktop/code/packages/equipped/src/orm/`. Which `.trowel/config.json` does it use?"
> **A:** It walks up looking for `.trowel/` first. If `~/Desktop/code/packages/equipped/.trowel/` exists, that's the **Project root** — config comes from there as the `project` **Layer**. If not, it keeps walking and stops at the nearest `.git/`, which is at `~/Desktop/code/packages/equipped/`. The **Project root** is the same in both cases (no nested `.trowel/`).

> **Q:** "I want to use a different agent model for one specific project, but I don't want to commit that to the repo."
> **A:** Drop `{ "agent": { "model": "sonnet" } }` into `~/.trowel/projects/Users/mac/Desktop/code/packages/equipped/config.json` — that's the `private` **Layer**, your per-machine, per-project setting. But if `<project root>/.trowel/config.json` (the `project` **Layer**) sets `agent.model` to something else, `project` wins — that's β precedence.

## Flagged ambiguities

- "Sub-issue" was used early in design as a synonym for **Slice**, but GitHub already has a "sub-issue" feature. To avoid confusion, **Slice** is canonical; the GitHub sub-issue API is only one possible **Slice marker** mechanism (used by the `issue` **Backend**).

## Out of scope

- Multi-user, multi-machine sharing. Trowel is personal-only.
- Non-git projects. Trowel requires a `.trowel/` or `.git/` to resolve a **Project root**.
- A `projects` map inside any single config file. The `private` layer is one file per project via directory structure, not entries in a map.
- The `issue` backend is designed but not yet implemented; it gets its own grilling session before landing.
