import { fetchPrFeedback } from './pr-flow.ts'
import type { TurnIn, TurnOut } from './verdict.ts'
import type { PhaseCtx, PhaseOutcome, PreparedPhase, Slice, Storage } from '../storages/types.ts'
import type { GhOps } from '../utils/gh-ops.ts'
import type { GitOps } from '../utils/git-ops.ts'
import { withMutationLock } from '../utils/mutation-lock.ts'
import { slug as slugify } from '../utils/slug.ts'

/**
 * Dependency bag for the loop-level phase primitives. The loop builds this once per run from
 * its own `LoopDeps`; per-phase commands (`trowel implement`, etc.) build it ad-hoc.
 *
 * See ADR `storage-behavior-separation` and the post-pivot ADR `decouple-pr-flow-from-storage`:
 * phase logic lives in the loop, not on `Storage`. PR-flow behavior branches on the user's
 * `config.work.*` flags (`usePrs`, `review`, `perSliceBranches`), not on a storage capability.
 */
export type PhaseDeps = {
	storage: Storage
	git: GitOps
	gh: GhOps
	log: (msg: string) => void
	mergeNoVerify: boolean
	/**
	 * Project root used by `landX` to acquire the project-wide **Mutation lock** around the
	 * git+storage mutations that follow the agent's Turn. Optional only because some test
	 * fixtures don't construct a real one; production wiring always supplies it.
	 */
	projectRoot?: string
}

function withPhaseLock<T>(deps: PhaseDeps, fn: () => Promise<T>): Promise<T> {
	if (!deps.projectRoot) return fn()
	return withMutationLock(deps.projectRoot, fn)
}

function sliceBranchFor(changeId: string, slice: Slice): string {
	return `change-${changeId}/slice-${slice.id}-${slugify(slice.title)}`
}

async function pushSliceBranchIfNeeded(deps: PhaseDeps, branch: string, commits: number, tag: string): Promise<void> {
	if (commits <= 0) return
	await deps.git.push(branch)
	deps.log(`${tag} pushed ${branch}`)
}

/**
 * Prepare the implementer sandbox.
 *
 * - `perSliceBranches: false`: implementer runs on the integration branch directly — no per-slice
 *   branch (commits land in-place via push at land time). Used by the legacy file-storage workflow.
 * - `perSliceBranches: true`: create a per-slice remote branch from the integration branch and
 *   fetch it so the worktree can check it out.
 */
export async function prepareImplement(deps: PhaseDeps, slice: Slice, ctx: PhaseCtx): Promise<PreparedPhase> {
	if (!ctx.config.perSliceBranches) {
		return {
			branch: ctx.integrationBranch,
			turnIn: { slice: { id: slice.id, title: slice.title, body: slice.body } },
		}
	}
	const branch = sliceBranchFor(ctx.changeId, slice)
	if (await deps.git.branchExists(branch)) {
		deps.log(`[work change-${ctx.changeId} slice-${slice.id}] reusing existing slice branch '${branch}' (contains prior implementer commits from an aborted run)`)
	} else {
		await deps.git.createRemoteBranch(branch, ctx.integrationBranch)
	}
	await deps.git.fetch(branch)
	return {
		branch,
		turnIn: { slice: { id: slice.id, title: slice.title, body: slice.body } },
	}
}

/**
 * Apply the implementer's verdict.
 *
 * Verdict dispatch (all matrix cells):
 * - `partial` → return `'partial'`, no side effects.
 * - `no-work-needed` → clear `readyForAgent` via storage, return `'no-work'`.
 *
 * `ready` handling dispatches on (perSliceBranches × usePrs):
 * - `perSliceBranches: false`, `usePrs: false`: push integration, close the slice via
 *   `updateSlice({state: 'CLOSED'})`, return `'done'`. (`usePrs: true` is impossible without
 *   slice branches — rejected at config load.)
 * - `perSliceBranches: true`, `usePrs: false`: push slice branch, host-side merge `--no-ff` into
 *   the integration branch, push and delete the slice branch, close the slice via storage,
 *   return `'done'`.
 * - `perSliceBranches: true`, `usePrs: true`: push slice branch, open a draft PR, return
 *   `'progress'`. The next loop iteration's `findSlices` sees the PR and dispatches the reviewer.
 *   Works on every storage; at runtime requires a GitHub remote + `gh` auth (surfaced via
 *   `trowel doctor`, not preflight-gated).
 */
async function mergeSliceIntoIntegration(deps: PhaseDeps, slice: Slice, ctx: PhaseCtx, branch: string): Promise<void> {
	const tag = `[work change-${ctx.changeId} slice-${slice.id}]`
	await deps.git.checkout(ctx.integrationBranch)
	try {
		await deps.git.mergeNoFf(branch, { noVerify: deps.mergeNoVerify })
	} catch (e) {
		// Leave the working tree clean for re-run. Common cause: the project's commit-msg
		// hook rejects git's default "Merge branch 'X' into 'Y'" message; opt into
		// `config.work.mergeNoVerify: true` to bypass that hook on host-owned merges.
		await deps.git.mergeAbort()
		throw e
	}
	await deps.git.push(ctx.integrationBranch)
	await deps.git.deleteRemoteBranch(branch)
	deps.log(`${tag} merged ${branch} into ${ctx.integrationBranch}; deleted slice branch`)
	await deps.storage.updateSlice(ctx.changeId, slice.id, { state: 'CLOSED' })
	deps.log(`${tag} closed slice`)
}

export async function landImplement(deps: PhaseDeps, slice: Slice, verdict: TurnOut, ctx: PhaseCtx): Promise<PhaseOutcome> {
	return withPhaseLock(deps, () => landImplementLocked(deps, slice, verdict, ctx))
}

async function landImplementLocked(deps: PhaseDeps, slice: Slice, verdict: TurnOut, ctx: PhaseCtx): Promise<PhaseOutcome> {
	if (verdict.verdict === 'partial') return 'partial'
	if (verdict.verdict === 'no-work-needed') return landImplementNoWork(deps, slice, ctx)
	if (verdict.verdict !== 'ready') return 'partial'
	return landImplementReady(deps, slice, ctx, verdict.commits)
}

async function landImplementNoWork(deps: PhaseDeps, slice: Slice, ctx: PhaseCtx): Promise<PhaseOutcome> {
	const recovered = await recoverNoWorkNeededSliceBranch(deps, slice, ctx)
	if (recovered) return recovered
	const tag = `[work change-${ctx.changeId} slice-${slice.id}]`
	await deps.storage.updateSlice(ctx.changeId, slice.id, { readyForAgent: false })
	deps.log(`${tag} no-work-needed: cleared readyForAgent`)
	return 'no-work'
}

async function recoverNoWorkNeededSliceBranch(deps: PhaseDeps, slice: Slice, ctx: PhaseCtx): Promise<PhaseOutcome | null> {
	if (!canRecoverNoWorkNeededSliceBranch(ctx)) return null
	const branch = sliceBranchFor(ctx.changeId, slice)
	const ahead = await deps.git.commitsAhead(branch, ctx.integrationBranch)
	if (ahead <= 0) return null
	const tag = `[work change-${ctx.changeId} slice-${slice.id}]`
	deps.log(`${tag} no-work-needed but slice branch has ${ahead} unmerged commit(s) from a prior Turn; treating as ready`)
	await mergeSliceIntoIntegration(deps, slice, ctx, branch)
	return 'done'
}

function canRecoverNoWorkNeededSliceBranch(ctx: PhaseCtx): boolean {
	return ctx.config.perSliceBranches && !ctx.config.usePrs
}

async function landImplementReady(deps: PhaseDeps, slice: Slice, ctx: PhaseCtx, commits: number): Promise<PhaseOutcome> {
	if (!ctx.config.perSliceBranches) return closeDirectIntegrationSlice(deps, slice, ctx)
	const branch = sliceBranchFor(ctx.changeId, slice)
	await pushSliceBranchIfNeeded(deps, branch, commits, `[work change-${ctx.changeId} slice-${slice.id}]`)
	if (ctx.config.usePrs) return openSliceDraftPr(deps, slice, ctx, branch)
	await mergeSliceIntoIntegration(deps, slice, ctx, branch)
	return 'done'
}

async function closeDirectIntegrationSlice(deps: PhaseDeps, slice: Slice, ctx: PhaseCtx): Promise<PhaseOutcome> {
	const tag = `[work change-${ctx.changeId} slice-${slice.id}]`
	await deps.git.push(ctx.integrationBranch)
	deps.log(`${tag} pushed ${ctx.integrationBranch}`)
	await deps.storage.updateSlice(ctx.changeId, slice.id, { state: 'CLOSED' })
	deps.log(`${tag} closed slice`)
	return 'done'
}

async function openSliceDraftPr(deps: PhaseDeps, slice: Slice, ctx: PhaseCtx, branch: string): Promise<PhaseOutcome> {
	const tag = `[work change-${ctx.changeId} slice-${slice.id}]`
	await deps.gh.createDraftPr({ title: slice.title, head: branch, base: ctx.integrationBranch, body: `Closes #${slice.id}` })
	deps.log(`${tag} opened draft PR for ${branch}`)
	return 'progress'
}

/**
 * Prepare the reviewer Turn. Requires an open PR (looked up via `findPrNumber`); the loop only
 * dispatches `'review'` when `prState` is `'draft'`, which presupposes `config.work.usePrs: true`.
 * Per-phase commands (`trowel review`) bypass the classifier; if no PR exists `findPrNumber` throws.
 *
 * Looks up the slice branch's PR number so the reviewer prompt has `{pr.number, pr.branch}` to
 * fetch the diff and post comments against.
 */
export async function prepareReview(deps: PhaseDeps, slice: Slice, ctx: PhaseCtx): Promise<PreparedPhase> {
	const branch = sliceBranchFor(ctx.changeId, slice)
	const prNumber = await deps.gh.findPrNumberByHead(branch)
	const turnIn: TurnIn = {
		slice: { id: slice.id, title: slice.title, body: slice.body },
		pr: { number: prNumber, branch },
	}
	return { branch, turnIn }
}

/**
 * Apply the reviewer's verdict. Requires an open PR (the `ready` and `needs-revision` paths call
 * `findPrNumber` / `gh pr edit`; both throw if no PR exists for the slice branch).
 *
 * - `ready` → push review commits (if any), then `gh pr ready` to flip the PR out of draft. The
 *   slice's `prState` becomes 'ready' on next `findSlices`; classify routes to 'done'. Returns
 *   `'progress'` so the inner step-cap loop refetches.
 * - `needs-revision` → push review commits, flip `needsRevision: true` via storage. Next iteration
 *   classifies to 'address'. Returns `'progress'`.
 * - `partial` → return `'partial'`, no side effects.
 */
export async function landReview(deps: PhaseDeps, slice: Slice, verdict: TurnOut, ctx: PhaseCtx): Promise<PhaseOutcome> {
	return withPhaseLock(deps, async () => landReviewOrAddress('review', deps, slice, verdict, ctx))
}

/**
 * Prepare the addresser Turn. Requires an open PR (calls `findPrNumber` + `fetchPrFeedback`;
 * both throw if no PR exists for the slice branch).
 *
 * Same PR-discovery as the reviewer plus a `fetchPrFeedback` call so the addresser prompt has the
 * reviewer's comments in `turnIn.feedback`.
 */
export async function prepareAddress(deps: PhaseDeps, slice: Slice, ctx: PhaseCtx): Promise<PreparedPhase> {
	const branch = sliceBranchFor(ctx.changeId, slice)
	const prNumber = await deps.gh.findPrNumberByHead(branch)
	const feedback = await fetchPrFeedback(deps.gh, prNumber)
	const turnIn: TurnIn = {
		slice: { id: slice.id, title: slice.title, body: slice.body },
		pr: { number: prNumber, branch },
		feedback,
	}
	return { branch, turnIn }
}

/**
 * Apply the addresser's verdict. Requires an open PR for the slice branch.
 *
 * - `ready` → push fixup commits (if any), clear `needsRevision` via storage. The next iteration
 *   classifies back to 'review' (draft PR still open). Returns `'progress'`.
 * - `no-work-needed` → clear `needsRevision` without pushing. Returns `'no-work'`; loop drops the
 *   slice for this run.
 * - `partial` → return `'partial'`, no side effects.
 */
export async function landAddress(deps: PhaseDeps, slice: Slice, verdict: TurnOut, ctx: PhaseCtx): Promise<PhaseOutcome> {
	return withPhaseLock(deps, async () => landReviewOrAddress('address', deps, slice, verdict, ctx))
}

type ReviewAddressKind = 'review' | 'address'
type ReviewAddressLandRule = {
	matches: (kind: ReviewAddressKind, verdict: TurnOut) => boolean
	land: (kind: ReviewAddressKind, deps: PhaseDeps, slice: Slice, verdict: TurnOut, ctx: PhaseCtx, branch: string, tag: string) => Promise<PhaseOutcome>
}

const REVIEW_ADDRESS_LAND_RULES: ReviewAddressLandRule[] = [
	{ matches: (_kind, verdict) => verdict.verdict === 'partial', land: async () => 'partial' },
	{ matches: (_kind, verdict) => verdict.verdict === 'ready', land: landReadyReviewOrAddress },
	{ matches: (kind, verdict) => kind === 'review' && verdict.verdict === 'needs-revision', land: landReviewNeedsRevision },
	{ matches: (kind, verdict) => kind === 'address' && verdict.verdict === 'no-work-needed', land: landAddressNoWorkNeeded },
]

async function landReviewOrAddress(kind: ReviewAddressKind, deps: PhaseDeps, slice: Slice, verdict: TurnOut, ctx: PhaseCtx): Promise<PhaseOutcome> {
	const tag = `[work change-${ctx.changeId} slice-${slice.id}]`
	const branch = sliceBranchFor(ctx.changeId, slice)
	const rule = REVIEW_ADDRESS_LAND_RULES.find((r) => r.matches(kind, verdict))
	return rule?.land(kind, deps, slice, verdict, ctx, branch, tag) ?? 'partial'
}

async function landReadyReviewOrAddress(kind: ReviewAddressKind, deps: PhaseDeps, slice: Slice, verdict: TurnOut, ctx: PhaseCtx, branch: string, tag: string): Promise<PhaseOutcome> {
	await pushSliceBranchIfNeeded(deps, branch, verdict.commits, tag)
	if (kind === 'review') return markSlicePrReady(deps, branch, tag)
	await clearSliceNeedsRevision(deps, ctx, slice, branch, tag)
	return 'progress'
}

async function markSlicePrReady(deps: PhaseDeps, branch: string, tag: string): Promise<PhaseOutcome> {
	const prNumber = await deps.gh.findPrNumberByHead(branch)
	await deps.gh.markPrReady(prNumber)
	deps.log(`${tag} marked PR #${prNumber} ready for merge`)
	return 'progress'
}

async function landReviewNeedsRevision(_kind: ReviewAddressKind, deps: PhaseDeps, slice: Slice, verdict: TurnOut, ctx: PhaseCtx, branch: string, tag: string): Promise<PhaseOutcome> {
	await pushSliceBranchIfNeeded(deps, branch, verdict.commits, tag)
	await deps.storage.updateSlice(ctx.changeId, slice.id, { needsRevision: true })
	await updatePrNeedsRevisionLabel(deps, branch, true)
	deps.log(`${tag} flagged needsRevision`)
	return 'progress'
}

async function landAddressNoWorkNeeded(_kind: ReviewAddressKind, deps: PhaseDeps, slice: Slice, _verdict: TurnOut, ctx: PhaseCtx, branch: string, tag: string): Promise<PhaseOutcome> {
	await clearSliceNeedsRevision(deps, ctx, slice, branch, tag, 'no-work-needed: ')
	return 'no-work'
}

async function clearSliceNeedsRevision(deps: PhaseDeps, ctx: PhaseCtx, slice: Slice, branch: string, tag: string, prefix = ''): Promise<void> {
	await deps.storage.updateSlice(ctx.changeId, slice.id, { needsRevision: false })
	await updatePrNeedsRevisionLabel(deps, branch, false)
	deps.log(`${tag} ${prefix}cleared needsRevision`)
}

async function updatePrNeedsRevisionLabel(deps: PhaseDeps, branch: string, present: boolean): Promise<void> {
	const prNumber = await deps.gh.findPrNumberByHead(branch)
	await deps.gh.editIssueLabels(String(prNumber), present ? { add: ['needs-revision'] } : { remove: ['needs-revision'] })
}

if (import.meta.vitest) {
	const { describe, test, expect } = import.meta.vitest

	type GitCall = { method: string; args: unknown[] }

	function makePhaseDeps(overrides: {
		mergeNoFfThrows?: Error
		mergeNoVerify?: boolean
		branchExists?: (b: string) => boolean
		commitsAhead?: number
	} = {}): { deps: PhaseDeps; calls: GitCall[]; storageState: { state: 'OPEN' | 'CLOSED'; needsRevision: boolean }; logs: string[] } {
		const calls: GitCall[] = []
		const logs: string[] = []
		const storageState = { state: 'OPEN' as 'OPEN' | 'CLOSED', needsRevision: true }
		const recorded = (method: string) => (...args: unknown[]) => { calls.push({ method, args }); return Promise.resolve() }
		const git: GitOps = {
			fetch: recorded('fetch'),
			push: recorded('push'),
			checkout: recorded('checkout'),
			mergeNoFf: async (b, opts) => {
				calls.push({ method: 'mergeNoFf', args: [b, opts] })
				if (overrides.mergeNoFfThrows) throw overrides.mergeNoFfThrows
			},
			mergeAbort: recorded('mergeAbort'),
			deleteRemoteBranch: recorded('deleteRemoteBranch'),
			createRemoteBranch: recorded('createRemoteBranch'),
			createLocalBranch: recorded('createLocalBranch'),
			pushSetUpstream: recorded('pushSetUpstream'),
			currentBranch: async () => 'integration',
			baseBranch: async () => 'main',
			branchExists: async (b) => overrides.branchExists ? overrides.branchExists(b) : true,
			isMerged: async () => false,
			commitsAhead: async () => overrides.commitsAhead ?? 0,
			deleteBranch: recorded('deleteBranch'),
			worktreeAdd: recorded('worktreeAdd'),
			worktreeRemove: recorded('worktreeRemove'),
			worktreeList: async () => [],
			restoreAll: recorded('restoreAll'),
			cleanUntracked: recorded('cleanUntracked'),
			isWorkingTreeClean: async () => true,
			stashPush: recorded('stashPush'),
			stashPop: recorded('stashPop'),
			detectVersion: async () => ({ installed: true, version: '0.0.0' }),
		}
		const storage: Storage = {
			createChange: async () => ({ id: 'p', branch: 'b' }),
			findChange: async () => null,
			listChanges: async () => [],
			closeChange: async () => {},
			createSlice: async () => ({ id: 's', title: '', body: '', state: 'OPEN', readyForAgent: false, needsRevision: false, blockedBy: [], prState: null }),
			findSlices: async () => [],
			findSlice: async () => null,
			updateSlice: async (_p, _s, patch) => {
				if (patch.state === 'CLOSED') storageState.state = 'CLOSED'
				if (patch.needsRevision !== undefined) storageState.needsRevision = patch.needsRevision
			},
		}
		const gh: GhOps = {
			findPrNumberByHead: async (head) => { calls.push({ method: 'findPrNumberByHead', args: [head] }); return 132 },
			editIssueLabels: async (id, patch) => { calls.push({ method: 'editIssueLabels', args: [id, patch] }) },
			markPrReady: async (prNumber) => { calls.push({ method: 'markPrReady', args: [prNumber] }) },
		} as GhOps
		const deps: PhaseDeps = {
			storage,
			git,
			gh,
			log: (m) => { logs.push(m) },
			mergeNoVerify: overrides.mergeNoVerify ?? false,
		}
		return { deps, calls, storageState, logs }
	}

	const slice: Slice = {
		id: '42', title: 'A slice', body: 'b', state: 'OPEN',
		readyForAgent: true, needsRevision: false, blockedBy: [], prState: null,
	}
	const ctx: PhaseCtx = {
		changeId: 'pid',
		integrationBranch: 'integration',
		config: { usePrs: false, review: false, perSliceBranches: true },
	}

	describe('prepareImplement: slice branch reuse on re-runs', () => {
		test('slice branch does NOT exist → createRemoteBranch then fetch', async () => {
			const { deps, calls } = makePhaseDeps({ branchExists: () => false })
			const prep = await prepareImplement(deps, slice, ctx)
			const methods = calls.map((c) => c.method)
			expect(methods).toContain('createRemoteBranch')
			expect(methods).toContain('fetch')
			expect(prep.branch).toBe('change-pid/slice-42-a-slice')
		})

		test('slice branch ALREADY exists → skip createRemoteBranch, still fetch, log a "reusing" warning', async () => {
			const sliceBranch = 'change-pid/slice-42-a-slice'
			const { deps, calls, logs } = makePhaseDeps({ branchExists: (b) => b === sliceBranch })
			const prep = await prepareImplement(deps, slice, ctx)
			const methods = calls.map((c) => c.method)
			expect(methods).not.toContain('createRemoteBranch')
			expect(methods).toContain('fetch')
			expect(prep.branch).toBe(sliceBranch)
			expect(logs.some((l) => /reusing existing slice branch/i.test(l))).toBe(true)
		})

		test('perSliceBranches: false → no branch creation, no fetch, returns integration branch', async () => {
			const { deps, calls } = makePhaseDeps()
			const prep = await prepareImplement(deps, slice, { ...ctx, config: { ...ctx.config, perSliceBranches: false } })
			const methods = calls.map((c) => c.method)
			expect(methods).not.toContain('createRemoteBranch')
			expect(methods).not.toContain('fetch')
			expect(prep.branch).toBe('integration')
		})
	})

	describe('landImplement: no-work-needed handling with leftover commits on slice branch', () => {
		test('no-work-needed + slice branch even with integration (commitsAhead: 0) → just clear readyForAgent (today behavior)', async () => {
			const { deps, calls, storageState } = makePhaseDeps({ commitsAhead: 0 })
			const outcome = await landImplement(deps, slice, { verdict: 'no-work-needed', notes: 'already done', commits: 0 }, ctx)
			expect(outcome).toBe('no-work')
			expect(storageState.state).toBe('OPEN')
			const methods = calls.map((c) => c.method)
			expect(methods).not.toContain('mergeNoFf')
			expect(methods).not.toContain('deleteRemoteBranch')
		})

		test('no-work-needed + slice branch ahead of integration (commitsAhead > 0) → run merge sequence + close, log the recovery', async () => {
			const { deps, calls, storageState, logs } = makePhaseDeps({ commitsAhead: 2 })
			const outcome = await landImplement(deps, slice, { verdict: 'no-work-needed', notes: 'already done', commits: 0 }, ctx)
			expect(outcome).toBe('done')
			const methods = calls.map((c) => c.method)
			expect(methods).toContain('mergeNoFf')
			expect(methods).toContain('deleteRemoteBranch')
			expect(storageState.state).toBe('CLOSED')
			expect(logs.some((l) => /no-work-needed but slice branch has 2 unmerged commit/.test(l))).toBe(true)
		})

		test('no-work-needed + perSliceBranches:false → just clear readyForAgent regardless of commitsAhead (integration-direct mode has no slice branch to merge)', async () => {
			const { deps, calls } = makePhaseDeps({ commitsAhead: 5 })
			const outcome = await landImplement(deps, slice, { verdict: 'no-work-needed', notes: 'done', commits: 0 }, { ...ctx, config: { ...ctx.config, perSliceBranches: false } })
			expect(outcome).toBe('no-work')
			expect(calls.map((c) => c.method)).not.toContain('mergeNoFf')
		})
	})

	describe('landImplement: host-merge failure recovery', () => {
		test('happy path: mergeNoFf succeeds → no mergeAbort call', async () => {
			const { deps, calls, storageState } = makePhaseDeps()
			const outcome = await landImplement(deps, slice, { verdict: 'ready', commits: 1 }, ctx)
			expect(outcome).toBe('done')
			expect(calls.find((c) => c.method === 'mergeAbort')).toBeUndefined()
			expect(storageState.state).toBe('CLOSED')
		})

		test('mergeNoFf throws → mergeAbort runs, error re-thrown, push and deleteRemoteBranch NOT reached', async () => {
			const boom = new Error('commit-msg hook rejected the merge')
			const { deps, calls } = makePhaseDeps({ mergeNoFfThrows: boom })
			await expect(landImplement(deps, slice, { verdict: 'ready', commits: 1 }, ctx)).rejects.toThrow(boom)
			const methods = calls.map((c) => c.method)
			expect(methods).toContain('mergeAbort')
			expect(methods.indexOf('mergeAbort')).toBeGreaterThan(methods.indexOf('mergeNoFf'))
			expect(methods).not.toContain('deleteRemoteBranch')
			// `push` IS called once (the slice-branch push earlier in landImplement), but NOT
			// the integration-branch push that comes after the merge.
			expect(methods.filter((m) => m === 'push')).toHaveLength(1)
		})
	})

	describe('landAddress: clears needs-revision state', () => {
		test('ready clears storage flag and matching PR label so enrichment does not requeue address', async () => {
			const { deps, calls, storageState } = makePhaseDeps()
			await landAddress(deps, { ...slice, needsRevision: true }, { verdict: 'ready', commits: 5 }, { ...ctx, config: { usePrs: true, review: true, perSliceBranches: true } })
			expect(storageState.needsRevision).toBe(false)
			expect(calls).toContainEqual({ method: 'editIssueLabels', args: ['132', { remove: ['needs-revision'] }] })
		})

		test('no-work-needed clears storage flag and matching PR label so enrichment does not requeue address', async () => {
			const { deps, calls, storageState } = makePhaseDeps()
			await landAddress(deps, { ...slice, needsRevision: true }, { verdict: 'no-work-needed', commits: 0 }, { ...ctx, config: { usePrs: true, review: true, perSliceBranches: true } })
			expect(storageState.needsRevision).toBe(false)
			expect(calls).toContainEqual({ method: 'editIssueLabels', args: ['132', { remove: ['needs-revision'] }] })
		})
	})

	describe('landReview: flags needs-revision state', () => {
		test('needs-revision sets storage flag and matching PR label', async () => {
			const { deps, calls, storageState } = makePhaseDeps()
			await landReview(deps, slice, { verdict: 'needs-revision', commits: 0 }, { ...ctx, config: { usePrs: true, review: true, perSliceBranches: true } })
			expect(storageState.needsRevision).toBe(true)
			expect(calls).toContainEqual({ method: 'editIssueLabels', args: ['132', { add: ['needs-revision'] }] })
		})
	})

	describe('landImplement: passes mergeNoVerify through to mergeNoFf opts', () => {
		test('mergeNoVerify: false → mergeNoFf called with { noVerify: false }', async () => {
			const { deps, calls } = makePhaseDeps({ mergeNoVerify: false })
			await landImplement(deps, slice, { verdict: 'ready', commits: 1 }, ctx)
			const merge = calls.find((c) => c.method === 'mergeNoFf')!
			expect(merge.args[1]).toEqual({ noVerify: false })
		})

		test('mergeNoVerify: true → mergeNoFf called with { noVerify: true }', async () => {
			const { deps, calls } = makePhaseDeps({ mergeNoVerify: true })
			await landImplement(deps, slice, { verdict: 'ready', commits: 1 }, ctx)
			const merge = calls.find((c) => c.method === 'mergeNoFf')!
			expect(merge.args[1]).toEqual({ noVerify: true })
		})
	})
}
