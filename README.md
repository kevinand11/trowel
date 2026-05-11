# trowel

Personal CLI for orchestrating PRD-driven feature work — start, slice, finish — across any git project.

> v0 scaffold. Backends (markdown, draft-pr, issue) and the AFK loop are deferred to per-area grilling sessions. `doctor` and `config` work today; every other subcommand is a stub that prints "not yet implemented" and exits non-zero.

## Install

```sh
git clone https://github.com/kevinand11/trowel
cd trowel
pnpm install
mkdir -p ~/.local/bin
ln -s "$PWD/bin/trowel" ~/.local/bin/trowel
```

`~/.local/bin` should already be on PATH; if not, add it.

## Config

Config files are JSON, validated at load time by [valleyed](https://github.com/kevinand11/valleyed). Trowel walks four named layers (lowest → highest precedence):

| Layer | Source | Path |
|---|---|---|
| `default` | hard-coded defaults | (in `src/schema.ts`) |
| `global` | global defaults | `~/.trowel/config.json` |
| `private` | per-project, this user only | `~/.trowel/projects/<full-path-mirrored>/config.json` |
| `project` (**wins outright**) | project file | `<project root>/.trowel/config.json` |

"Project root" = the nearest ancestor of cwd containing `.trowel/` (preferred) or `.git/` (fallback).

See `docs/CONTEXT.md` for full vocabulary.

## v0 commands

| Command | Status |
|---|---|
| `trowel doctor` | ✓ implemented |
| `trowel config` | ✓ implemented |
| `trowel start [--prd <id>] [--backend <kind>]` | stub |
| `trowel work <prd-id> [--backend <kind>]` | stub |
| `trowel close <prd-id>` | stub |
| `trowel status <prd-id>` | stub |
| `trowel init [layer]` (default `project`) | stub |
| `trowel diagnose <description>` | stub |
| `trowel fix <description>` | stub |
| `trowel implement <prd-id> <slice-id>` | stub |
| `trowel address <prd-id> <slice-id>` | stub |
| `trowel review <prd-id> <slice-id>` | stub |

## Deferred (separate grilling sessions)

- **Backends** — `markdown`, `draft-pr`, `issue` strategies for PRD storage and slice linkage.
- **AFK loop** — port of equipped's `.sandcastle/` into `src/work/` + the `work` / `implement` / `address` / `review` command bodies.
- **Prompts** — `start.md`, `resume.md`, `implement.md`, `review.md`, `respond-to-feedback.md`.
- **`init` wizard** — when no layer flag is given, prompts interactively for which layer to write.

## Layout

```
.
├── bin/trowel                  ← shim using tsx
├── src/
│   ├── cli.ts                  ← commander wiring
│   ├── schema.ts               ← Config + valleyed pipe + defaults + merge
│   ├── config.ts               ← four-layer loader
│   ├── project.ts              ← walk-up project-root resolver
│   ├── preflight.ts            ← clean-tree / fetch / collision helpers
│   ├── backends/
│   │   ├── types.ts            ← Backend interface
│   │   └── registry.ts         ← not-implemented shim per kind
│   ├── commands/
│   │   ├── doctor.ts           ← implemented
│   │   ├── config.ts           ← implemented
│   │   └── stubs.ts            ← every other command
│   ├── prompts/
│   │   ├── load.ts             ← {{PLACEHOLDER}} template loader
│   │   └── README.md
│   └── utils/{shell,git,gh}.ts
├── docs/CONTEXT.md
├── package.json
├── tsconfig.json
└── README.md
```
