# File storage: deterministic, project-wide shared-pool integer ids; lock-guarded compute-on-demand allocation

The `file` storage today mints **PRD ids** as 10-character base-36 random strings via `src/utils/id.ts:generateId`, with slice ids drawn from the same generator. Slice ids are namespaced under their PRD directory (`<prdsDir>/<prdId>-<slug>/slices/<sliceId>-<slug>/`) — two different PRDs can in principle hold slices that share the same id without conflict, because the lookup path always carries the PRD context. Random ids carry no information beyond uniqueness, are awkward to type, and force every slice-addressed command (`status`, `close`, `implement`, `address`, `review`) to also name the PRD.

This ADR pivots `file` storage to a single project-wide pool of **positive integers**, shared between PRDs and slices. A PRD created next gets `1`; the first slice under it gets `2`; a second PRD gets `3`; a third PRD created before that PRD's slices gets `4`; the first slice under PRD `3` then gets `5`. Ids are not reused — a closed PRD's number stays reserved (its directory still exists with `closedAt` set; the scan sees it). The integer prefix in the directory name (`1-add-sso/`, `5-implement-tabs/`) is the load-bearing identifier; the slug remains for human legibility.

Two consequences follow:

1. **Slice ids become globally unique within a project.** The `trowel status slice <id>` / `trowel close slice <id>` / `trowel implement <slice-id>` shapes all become well-defined without a `<prd-id>` companion arg. The CLI surface collapses accordingly (see the companion command-scoping changes in CONTEXT.md and README.md).
2. **The id is allocated compute-on-demand**, not from a persisted counter file. At allocation time the storage scans every existing PRD dir under `prdsDir` and every existing slice dir under each PRD, finds the max integer prefix, and returns `max + 1`. No `.counter.json`. The counter is implicit in the on-disk state.

Compute-on-demand is race-prone if two trowel invocations run concurrently. To make it safe, this ADR introduces the **Mutation lock**: a project-wide advisory lock at `<projectRoot>/.trowel/lock`, acquired by any state-mutating command. Read-only commands (`status`, `list`, `config`, `doctor`) do not acquire it. The lock is modelled after git's `.git/index.lock` and implemented via the `proper-lockfile` npm package — mtime-refreshed, with stale-lock detection at a conservative threshold. On contention, the caller retries with backoff for up to ~5 seconds, then fails with `trowel busy: another command holds the lock`.

The `issue` storage is **unchanged** by this ADR. GitHub already allocates auto-incrementing issue numbers from a single repo-wide pool (sub-issues share the issue-number sequence), so the shared-pool invariant holds there by construction. The mutation lock is also a `file`-only concern in practice: `issue` storage's writes go through `gh`, which serializes against GitHub's own state, not local disk. The lock module is generic and could wrap issue-storage commands too, but doing so today buys nothing.

## Considered options

- **Keep random base-36 ids.** Rejected: the user's whole motivation is determinism — deterministic ids mean predictable branch names, predictable directory listings, and the ability to address a slice by `<slice-id>` alone. Random ids force every command to carry both `<prd-id>` and `<slice-id>` because the slice id is only unique within its PRD.
- **Per-PRD slice counter** (PRD-1 contains slice-1, slice-2; PRD-2 contains its own slice-1, slice-2). Rejected: brings deterministic-ish numbering but does not solve slice global uniqueness — `status slice 1` is ambiguous across PRDs. The whole CLI-surface simplification falls over.
- **Separate PRD and slice counters** (PRD-1, PRD-2; slice-1, slice-2 — disjoint sequences). Rejected: globally unique within type but not across types. The CLI scope token (`prd` vs `slice`) carries the type, so disjoint counters would *look* fine, but the on-disk semantics get noisy: a directory named `2-foo` could be a PRD or a slice depending on its location. Shared pool makes "an integer prefix is an entity number" unambiguous on disk.
- **UUID v7 / ULIDs.** Rejected: ordered like timestamps but still verbose. The whole point is short legible ids; UUIDs trade legibility for collision freedom we don't need (the lock + scan already guarantees uniqueness).
- **Persisted counter file** (`<prdsDir>/.counter.json` holding `{ next: 17 }`). Rejected: introduces a sync-point distinct from the entity directories themselves. If a `createPrd` writes the counter but crashes before mkdir-ing the entity dir, the counter is now ahead of reality — and an out-of-band `rm -rf` of a PRD dir leaves the counter inconsistent. Compute-on-demand has none of these failure modes: max-id-on-disk is the truth.
- **Persisted counter that only ever advances (`{ allocated: number[], next: number }`).** Rejected: more complex than compute-on-demand and still drifts under manual `rm`. The drift is *fixable* with a `trowel doctor` repair, but compute-on-demand removes the need to track it at all.
- **No mutation lock; rely on user discipline.** Rejected: trowel is single-user, but it's not single-terminal. A backgrounded `trowel work` plus an interactive `trowel close prd 3` can absolutely race; the compute-on-demand id allocation would silently double-issue. The lock is the cost of choosing compute-on-demand over a persisted counter.
- **`flock(2)` via a native wrapper / `fs-ext`.** Rejected: kernel-enforced and auto-released on process death (which is desirable), but requires a native dependency or shelling out to the `flock` binary. `proper-lockfile` works on every platform Node runs on, and trowel doesn't need kernel-strength locking — advisory + mtime-based stale detection is sufficient for a single-user CLI.
- **Per-PRD lock instead of project-wide.** Rejected: doesn't serialize the id allocation step (which needs to see *all* PRDs to compute `max + 1`). A per-PRD lock would have to be combined with a project-wide allocation lock anyway; one project-wide lock is simpler.
- **Narrow the lock to id-allocating operations only** (`createPrd`, `createSlice`). Rejected during grilling: the user explicitly preferred broad scope, modelled on git's `.git/index.lock`. Broader scope means `updateSlice` and `closePrd` also serialize, preventing a class of weirder races (e.g. closing a PRD while another command is creating a slice under it). The cost is that concurrent reads-of-writes are blocked; the user judged that an acceptable trade for the simpler invariant.
- **Indefinite block on lock contention.** Rejected: a forgotten background process would hang the next command forever. Stale-lock detection mitigates but doesn't eliminate. Fixed 5-second retry-then-fail is unambiguous.
- **Fail fast on contention (no retry).** Rejected: the common case is two commands fired in quick succession in the same terminal (e.g. `close slice 4 && status prd 3`). Brief retry hides that for the user.

## Consequences

### `src/utils/id.ts` retired

Replaced by `src/utils/allocate-id.ts` (or co-located inside the file storage if no other caller emerges):

```ts
// Inside the mutation-lock critical section.
async function allocateNextId(prdsDir: string): Promise<number> {
  const seen: number[] = []
  for (const entry of await readdirSafe(prdsDir)) {
    const n = parseIntPrefix(entry)
    if (n !== null) seen.push(n)
    const slicesDir = path.join(prdsDir, entry, 'slices')
    for (const sliceEntry of await readdirSafe(slicesDir)) {
      const m = parseIntPrefix(sliceEntry)
      if (m !== null) seen.push(m)
    }
  }
  return seen.length === 0 ? 1 : Math.max(...seen) + 1
}

function parseIntPrefix(name: string): number | null {
  const m = /^(\d+)-/.exec(name)
  return m ? Number(m[1]) : null
}
```

Existing tests in `src/utils/id.test.ts` (if any) and every fixture using `generateId()` are updated. Random-id assertions in `file.ts`'s tests get rewritten against the integer-id contract.

### Mutation lock module

New `src/utils/mutation-lock.ts`:

```ts
import { lock as plLock, unlock as plUnlock } from 'proper-lockfile'

export async function withMutationLock<T>(
  projectRoot: string,
  fn: () => Promise<T>,
): Promise<T> {
  const lockPath = path.join(projectRoot, '.trowel', 'lock')
  await mkdir(path.dirname(lockPath), { recursive: true })
  // proper-lockfile creates <lockPath>.lock; retry policy below.
  const release = await plLock(lockPath, {
    retries: { retries: 50, minTimeout: 50, maxTimeout: 200, factor: 1.2 },
    stale: 30_000,
  }).catch((err) => {
    if (err.code === 'ELOCKED') {
      throw new Error('trowel busy: another command holds the lock')
    }
    throw err
  })
  try {
    return await fn()
  } finally {
    await release()
  }
}
```

- `retries`: ~50 attempts with exponential backoff capped near 200 ms — total wait fits in the ~5 s budget the user picked.
- `stale: 30000`: a lock not refreshed for 30 s is considered abandoned (proper-lockfile refreshes mtime every ~5 s by default).
- The lock file path `<projectRoot>/.trowel/lock` is the target; proper-lockfile actually writes `<target>.lock` next to it (the target need not exist).

### Where the lock is acquired

The lock is layered — both at the command-layer entry for short-running mutation commands AND inside `Storage` write methods for the bare-bones single-mutation guarantee. To make the layering safe, `withMutationLock` is **reentrant per async context** via `AsyncLocalStorage`: nested calls on the same project root, in the same async stack, skip `proper-lockfile` and just run the inner function. Concurrent async contexts in the same process still serialise correctly because each gets its own copy of the held-roots set.

Acquisition points:

- `close prd <id>` / `close slice <id>` — wrapped at command entry. The whole `runClose{Prd,Slice}` body runs in the critical section. Confirms (delete-branch policy, slice-not-done) hold the lock; they're brief user-attention prompts and another concurrent command will fail with `trowel busy` after 5 s — acceptable feedback for a user actively at a prompt.
- `start` — **not** wrapped at command entry. The interactive grilling session can run for many minutes; locking the whole thing would freeze the rest of trowel. Storage methods (`createPrd`, `createSlice`, `updateSlice`) acquire the lock individually for the final write phase. Since IDs are allocated inside `createPrd`/`createSlice` (under the lock), the race-critical step is still atomic.
- `implement` / `address` / `review` / `work` — the **per-Turn land step** acquires the lock, not the whole command. Each `landImplement`/`landReview`/`landAddress` body in `src/work/phases.ts` runs inside `withPhaseLock(deps, …)`, which calls `withMutationLock(deps.projectRoot, …)`. The Turn itself (`prepare<Role>` → spawn agent → wait) runs unlocked — agent mutations live in its worktree, and `prepare` reads-mostly. This means a multi-hour `trowel work` run only blocks other commands during the brief landX windows, not during agent execution.
- Read-only commands (`status`, `list`, `config`, `doctor`) — never acquire the lock.
- `Storage` write methods on `file` — `createPrd`, `createSlice`, `closePrd`, `updateSlice` each wrap their body in `withMutationLock(deps.projectRoot, …)`. These are the innermost guarantee; when called from `landX` or `runClose{Prd,Slice}` the reentry check skips the OS lock since the outer call already holds it.

`PhaseDeps` carries an optional `projectRoot: string`. `_loop-wiring.ts` always supplies it. `LoopDeps` likewise carries an optional `projectRoot` so `runLoop` can build the per-Turn `PhaseDeps`. Test fixtures that don't construct a real `projectRoot` get the no-op pass-through (`fn()`); production wiring always gets the locking path.

### Storage interface

```ts
interface Storage {
  // existing…
  findSlice(sliceId: string): Promise<{ prdId: string; slice: Slice } | null>
}
```

- `file` impl: scan each entry under `prdsDir` matching `^\d+-`; for each, scan its `slices/` for `^${sliceId}-`; return on first hit. O(PRDs) on miss, fast on hit. The scan is unlocked — `findSlice` is read-only and the worst lossy outcome under a concurrent allocation is "not found" on a slice that was being created at the same instant, which is the same answer the caller would have gotten a millisecond earlier.
- `issue` impl: `gh issue view <number> --json number,title,body,state,labels,parent` and read `.parent` (or equivalent for the sub-issue API). Return `null` if the issue is not a sub-issue (or doesn't exist).

`findSlice` powers `status slice`, `close slice`, and the simplified `implement` / `address` / `review` commands.

### CLI surface

Commander wiring in `src/cli.ts`:

```
trowel list   prd  [--state open|closed|all] [--storage <kind>]
trowel status prd  <prd-id>                   [--storage <kind>]
trowel status slice <slice-id>                [--storage <kind>]
trowel close  prd  <prd-id>                   [--storage <kind>]
trowel close  slice <slice-id>                [--storage <kind>]
trowel implement <slice-id>                   [--storage <kind>] [--harness <kind>]
trowel address   <slice-id>                   [--storage <kind>] [--harness <kind>]
trowel review    <slice-id>                   [--storage <kind>] [--harness <kind>]
```

The flag rule (applied in this session, not invented by this ADR but documented here because it shapes the surface):

- `--storage <kind>` is offered by every command that reads or writes PRDs or Slices: `start`, `work`, `list`, `status`, `close`, `implement`, `address`, `review`.
- `--harness <kind>` is offered by every command that spawns an Agent harness: `start`, `work`, `implement`, `address`, `review`.
- `doctor`, `config`, `init` do not touch storage entities or run an agent; they take neither flag.
- `diagnose` and `fix` are still stubs; their flag set will be decided when their bodies land.

`trowel work` and `trowel start` are unchanged (they already carried both flags).

**Hard rename** — the old shapes (`list prds`, `status <id>`, `close <id>`, `implement <prd-id> <slice-id>`, etc.) are removed. No silent aliases, no deprecation warnings. The CLI is pre-1.0 and personal-use only; the cost of compatibility shims exceeds the cost of muscle-memory retraining.

### `status slice <id>` rendering

```
Slice 42  Implement tab parser
PRD:     17  Add SSO
Branch:  prd-17/slice-42-implement-tab-parser    (only when perSliceBranches: true)
State:   OPEN   bucket: blocked
ready-for-agent: true
needs-revision:  false
blockedBy:
  40  ready    Schema migration
  41  done     Constants
```

The renderer reuses the bucket-classification primitives already in `src/utils/bucket.ts`. Blockers are resolved against the parent PRD's slice set (one `findSlices(prdId)` call) so the right column can show each blocker's bucket.

### `close slice <id>` semantics

```
1. Resolve slice via storage.findSlice(id); throw if not found.
2. If slice.bucket !== 'done': confirm "Slice <id> is in bucket '<bucket>'. Close anyway? [y/N]".
3. storage.updateSlice(prdId, sliceId, { state: 'CLOSED' }).
4. If config.work.perSliceBranches && a branch named prd-<prdId>/slice-<id>-<slug> exists:
     apply config.close.deleteBranch policy (always | prompt | never), same routine as close prd.
5. Restore BACK_TO if we switched branches.
```

The branch-delete sub-flow is factored out of the existing `close prd` path into a shared helper so both call sites share the policy logic.

### `close prd <id>` semantics

Unchanged except for the new wrapper (lock acquisition; scope-token argument parsing). The auto-close-open-slices warn-and-confirm flow stays as-is; it operates on the storage records directly without going through `close slice` (no need — it's already inside the same locked section).

### `findSlice` failure modes

- Not found → command-level error `slice '<id>' not found`.
- Found but the parent PRD is `CLOSED` → still operate, with an info line `(slice <id> belongs to closed PRD <prd-id>)`. Closing a slice of a closed PRD is allowed; reopening would be a different (out-of-scope) operation.

### Migration / existing data

Pre-existing PRD dirs with base-36 random ids (`abc123-add-sso/`) are **not auto-migrated**. Trowel is pre-release and personal-use; the user (the only user) confirmed during grilling that no existing data needs preserving. On encountering a non-integer id prefix, the file-storage scan logs a warning and ignores that entry. A future `trowel doctor` repair could rewrite legacy dirs to integer ids, but is out of scope here.

### Config schema

No schema changes. `config.close.deleteBranch` already exists and is reused for slice branches. The mutation lock has no config knobs in this ADR — the 5-second retry budget and 30-second stale threshold are hard-coded in `withMutationLock`. If a user reports the budget being too tight, lifting them to `config.lock.{retrySeconds,staleSeconds}` is mechanical.

### CONTEXT.md updates (made in this session)

- **PRD id**: form updated to "positive integer from a project-wide pool shared with Slice ids" on `file`.
- **Slice**: notes that slice ids are globally unique within a project on both storages, which is what makes slice-only addressing well-defined.
- **Mutation lock**: new glossary entry capturing the lock's location, scope, library choice, retry policy, and the git `.git/index.lock` analogy.

### Out of scope

- Migration of legacy random-id PRDs to integer ids.
- Lock semantics for the `issue` storage (currently no-op; the module is generic enough to opt-in later if a use case appears).
- Exposing the lock retry budget / stale threshold via config.
- A `trowel doctor` repair that detects lock files orphaned across reboots (`proper-lockfile`'s stale detection handles the common case).
- Cross-machine coordination. Trowel remains single-user, single-machine; the lock is filesystem-local.
- Renumbering after manual `rm -rf` of an entity directory. Compute-on-demand will reuse the freed id; the user owns that consequence (matches the existing "trowel does not commit prdsDir" stance — out-of-band edits are the user's responsibility).
- Sub-command scope tokens on `work`, `start`, `doctor`, `config`, `init`, `diagnose`, `fix`. Only `list`, `status`, `close` carry the `prd` / `slice` scope token.

## Supersession notes

Partially supersedes `2026-05-11-prd-unique-id-and-file-backend-layout.md`:

- The id-format claim ("6-character base-36 random string") is replaced by "positive integer from a project-wide shared pool".
- The directory-layout claim (`<prdsDir>/<id>-<slug>/` with `README.md` + `store.json` + `slices/`) is unchanged.
- The slug-as-load-bearing-identifier rejection still stands.
- The `store.json:closedAt`-as-state claim is unchanged.

The older ADR is not deleted — its "Considered options" rationale (rejecting slug-as-id, rejecting UUIDs, rejecting branch-existence-as-state) remains useful context.
