# Trowel — Context

Trowel is a personal CLI that orchestrates PRD-driven feature work — start, slice, and finish — and subsumes the AFK-agent loop (previously the standalone `sandcastle`). It is single-user, single-machine, not shareable; it installs once and runs against any git project.

## Language

### PRD lifecycle

**PRD**:
A long-form spec describing a single feature or change. The artifact type — markdown file, GitHub draft PR, or GitHub issue — is chosen per project via the **backend**.
_Avoid_: Spec, design doc, ticket, story.

**Backend**:
The strategy that decides how a **PRD** is stored, identified, listed, and linked to its **slices**. One of `markdown`, `draft-pr`, `issue`.
_Avoid_: Provider, adapter, driver.

**Slice**:
A GitHub issue that implements one vertical cut of a **PRD**. Slices are always GitHub issues in v0, regardless of which **backend** the parent PRD uses.
_Avoid_: Sub-issue (overloads GitHub's "sub-issue" feature), task, ticket.

**Integration branch**:
The branch that holds the in-flight feature: doc commits from the **PRD** session, slice commits merged in from sub-PRs, ready for one final merge to `main` when the feature ships. Naming pattern is backend-defined.
_Avoid_: Feature branch (overloaded; trowel reserves "feature branch" for `fix/<slug>` lightweight branches).

**Slice marker**:
The string a **slice** carries (in its body, as a trailer, or via the GitHub sub-issue API) that identifies which **PRD** it belongs to. Backend-defined.
_Avoid_: Parent link, breadcrumb.

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
- The `draft-pr` and `issue` backends are designed but not yet implemented; each gets its own grilling session before landing.
