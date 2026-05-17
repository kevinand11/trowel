# Trowel

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

Scoped commands (`list`, `status`, `close`) take a scope token (`prd` or `slice`) before the id. Phase commands (`implement`, `address`, `review`) take just `<slice-id>` — slice ids are globally unique within a project (GitHub issue numbers on `issue`; an integer from a project-wide shared pool on `file`).

| Command |
| --- |
| `trowel init [layer]` (default `project`) |
| `trowel doctor` |
| `trowel config` |
| `trowel start [--storage <kind>] [--harness <kind>]` |
| `trowel work <prd-id> [--storage <kind>] [--harness <kind>]` |
| `trowel implement <slice-id> [--storage <kind>] [--harness <kind>]` |
| `trowel address <slice-id> [--storage <kind>] [--harness <kind>]` |
| `trowel review <slice-id> [--storage <kind>] [--harness <kind>]` |
| `trowel list prd [--state open\|closed\|all] [--storage <kind>]` |
| `trowel status prd <prd-id> [--storage <kind>]` |
| `trowel status slice <slice-id> [--storage <kind>]` |
| `trowel close prd <prd-id> [--storage <kind>]` |
| `trowel close slice <slice-id> [--storage <kind>]` |
| `trowel diagnose <description>` |
| `trowel fix <description>` |

Flag rule: `--storage` is offered by any command that reads or writes a PRD or Slice; `--harness` is offered by any command that spawns an agent. `doctor` / `config` / `init` take neither.
