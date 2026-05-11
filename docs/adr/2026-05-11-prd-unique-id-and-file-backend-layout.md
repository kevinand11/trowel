# PRDs have unique ids; `file` backend uses a directory layout

Every PRD carries a unique id, regardless of backend. For the `issue` backend the id is the GitHub issue number; for the `draft-pr` backend it is the PR number; for the `file` backend (renamed from `markdown` in the same session — see commit history) the id is a 6-character base-36 random string, collision-checked against existing PRD directories.

The `file` backend's PRD lives as a directory at `<prdsDir>/<id>-<slug>/`, containing `README.md` (the PRD body authored during grilling), `store.json` (trowel-managed metadata: `id`, `slug`, `title`, `createdAt`, `closedAt`), and a `slices/` subdirectory (each slice mirrors this same `<id>-<slug>/README.md + store.json` shape; see ADR `slices-local-for-file-backend`). The directory pattern mirrors the `issue` backend's branch format `<id>-<slug>`, so users see a parallel structure across backends. Slugs are derived from titles but are *not* unique on their own — two PRDs with similar titles get distinct directories because the random id differs. The slug exists for human legibility (in branch names, slice markers, and `ls` output); the id is the load-bearing identifier.

State (open vs closed) lives in `store.json` as `closedAt: string | null`, not in branch existence. `listOpen` scans the directory and filters; `close` sets `closedAt` and applies the shared `config.close.deleteBranch` policy to the integration branch.

## Considered options

- **Slug as the canonical id for `file`.** Rejected because slug collisions (similar titles) would force renames that break referential stability — every link to the PRD would have to be updated.
- **Flat markdown file (`<slug>.md`) instead of a directory.** Rejected because the unique-id directive plus non-derivable metadata (`createdAt`, `closedAt`) need a structured sibling artifact. A directory with `README.md` + `store.json` is the smallest honest shape.
- **UUID v4 or ULID for the id.** Rejected for verbosity. 6 base-36 chars give 2 billion combinations; the collision check makes practical collision zero. Short ids stay legible in `ls`, branch names, and command-line arguments.
- **Branch-existence as the open/closed signal (originally proposed as Q4 (α)).** Superseded by `store.json.closedAt` once the directory layout was locked — local state is cheaper to read and records *when* closed, not just *that* it is closed.
