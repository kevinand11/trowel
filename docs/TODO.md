# Trowel — TODO

Pending work, organised as discrete grilling sessions. Each item is meant to be picked up cold by a future agent session.

Pre-work for every session: read `docs/CONTEXT.md` for vocabulary and repo conventions, `README.md` for current command shape, `src/schema.ts` for config, and `src/storages/types.ts` for the Storage interface.

---

## 1. `ship` command

**Goal.** Add an explicit success-path command that drives a Change or Slice to completion, distinct from `abort`.

Candidate surface:

```bash
trowel change ship <changeId>
trowel slice ship <sliceId>
```

Open questions to grill:

- Is `change ship` a replacement for `change work`, or a higher-level command that calls work and then Close-out?
- Should `slice ship` run repeated phase claims until terminal/human-gated?
- What counts as “shipped” in PR mode: PR opened, PR ready, PR merged, or storage CLOSED?
- Should `ship` ever merge/push without prompting?

Default pick: keep `change work` for the AFK loop today; design `ship` separately once the Change/Slice rename has settled.

---

## 2. Sandboxed Turn execution (Docker `kind`)

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
