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

## 2. `trowel diagnose` flow

**Goal.** Pure diagnostic. Investigates a bug, then prints a recommendation for the next command (`trowel change work <id>` or `trowel start`). Does **not** auto-invoke any of them.

**Files to write.**

- `src/commands/diagnose.ts` — replaces stub.
- `src/prompts/diagnose.md`.

**Flow.**

```ts
async function diagnose(description: string) {
  // 0. Preflight (diagnosis can run on a dirty tree)
  // 1. Launch an agent with diagnose.md and args { DESCRIPTION }
  // 2. Agent investigates: reads code, runs tests if useful, asks questions if needed.
  // 3. Agent determines whether this is:
  //      - existing work → recommend `trowel change work <id>`
  //      - new small/large change → recommend `trowel start`
  //      - user/config/tooling issue → explain, no Change needed
  // 4. Print recommendation; exit 0.
}
```

Open questions to grill:

- Should diagnose preflight require a clean tree? Default pick: no.
- Should diagnose persist its analysis? Default pick: no for v0.

---

## 3. Sandboxed Turn execution (Docker `kind`)

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
