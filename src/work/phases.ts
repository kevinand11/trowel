import { fetchPrFeedback } from './pr-flow.ts'
import type { TurnIn, TurnOut } from './verdict.ts'
import type { PhaseCtx, PhaseOutcome, PreparedPhase, Slice, Storage } from '../storages/types.ts'
import type { GhOps } from '../utils/gh-ops.ts'
import type { GitOps } from '../utils/git-ops.ts'
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
}

function sliceBranchFor(prdId: string, slice: Slice): string {
	return `prd-${prdId}/slice-${slice.id}-${slugify(slice.title)}`
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
	const branch = sliceBranchFor(ctx.prdId, slice)
	if (await deps.git.branchExists(branch)) {
		deps.log(`[work prd-${ctx.prdId} slice-${slice.id}] reusing existing slice branch '${branch}' (contains prior implementer commits from an aborted run)`)
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
export async function landImplement(deps: PhaseDeps, slice: Slice, verdict: TurnOut, ctx: PhaseCtx): Promise<PhaseOutcome> {
	const tag = `[work prd-${ctx.prdId} slice-${slice.id}]`
	if (verdict.verdict === 'partial') return 'partial'
	if (verdict.verdict === 'no-work-needed') {
		await deps.storage.updateSlice(ctx.prdId, slice.id, { readyForAgent: false })
		deps.log(`${tag} no-work-needed: cleared readyForAgent`)
		return 'no-work'
	}
	if (verdict.verdict !== 'ready') return 'partial'

	if (!ctx.config.perSliceBranches) {
		await deps.git.push(ctx.integrationBranch)
		deps.log(`${tag} pushed ${ctx.integrationBranch}`)
		await deps.storage.updateSlice(ctx.prdId, slice.id, { state: 'CLOSED' })
		deps.log(`${tag} closed slice`)
		return 'done'
	}

	const branch = sliceBranchFor(ctx.prdId, slice)
	await deps.git.push(branch)
	deps.log(`${tag} pushed ${branch}`)

	if (ctx.config.usePrs) {
		await deps.gh.createDraftPr({ title: slice.title, head: branch, base: ctx.integrationBranch, body: `Closes #${slice.id}` })
		deps.log(`${tag} opened draft PR for ${branch}`)
		return 'progress'
	}

	// usePrs: false → host-side merge-and-close.
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
	await deps.storage.updateSlice(ctx.prdId, slice.id, { state: 'CLOSED' })
	deps.log(`${tag} closed slice`)
	return 'done'
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
	const branch = sliceBranchFor(ctx.prdId, slice)
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
	const tag = `[work prd-${ctx.prdId} slice-${slice.id}]`
	if (verdict.verdict === 'partial') return 'partial'
	const branch = sliceBranchFor(ctx.prdId, slice)

	if (verdict.verdict === 'ready') {
		if (verdict.commits > 0) {
			await deps.git.push(branch)
			deps.log(`${tag} pushed ${branch}`)
		}
		const prNumber = await deps.gh.findPrNumberByHead(branch)
		await deps.gh.markPrReady(prNumber)
		deps.log(`${tag} marked PR #${prNumber} ready for merge`)
		return 'progress'
	}
	if (verdict.verdict === 'needs-revision') {
		if (verdict.commits > 0) {
			await deps.git.push(branch)
			deps.log(`${tag} pushed ${branch}`)
		}
		await deps.storage.updateSlice(ctx.prdId, slice.id, { needsRevision: true })
		deps.log(`${tag} flagged needsRevision`)
		return 'progress'
	}
	return 'partial'
}

/**
 * Prepare the addresser Turn. Requires an open PR (calls `findPrNumber` + `fetchPrFeedback`;
 * both throw if no PR exists for the slice branch).
 *
 * Same PR-discovery as the reviewer plus a `fetchPrFeedback` call so the addresser prompt has the
 * reviewer's comments in `turnIn.feedback`.
 */
export async function prepareAddress(deps: PhaseDeps, slice: Slice, ctx: PhaseCtx): Promise<PreparedPhase> {
	const branch = sliceBranchFor(ctx.prdId, slice)
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
	const tag = `[work prd-${ctx.prdId} slice-${slice.id}]`
	if (verdict.verdict === 'partial') return 'partial'
	const branch = sliceBranchFor(ctx.prdId, slice)

	if (verdict.verdict === 'ready') {
		if (verdict.commits > 0) {
			await deps.git.push(branch)
			deps.log(`${tag} pushed ${branch}`)
		}
		await deps.storage.updateSlice(ctx.prdId, slice.id, { needsRevision: false })
		deps.log(`${tag} cleared needsRevision`)
		return 'progress'
	}
	if (verdict.verdict === 'no-work-needed') {
		await deps.storage.updateSlice(ctx.prdId, slice.id, { needsRevision: false })
		deps.log(`${tag} no-work-needed: cleared needsRevision`)
		return 'no-work'
	}
	return 'partial'
}

if (import.meta.vitest) {
	const { describe, test, expect } = import.meta.vitest

	type GitCall = { method: string; args: unknown[] }

	function makePhaseDeps(overrides: {
		mergeNoFfThrows?: Error
		mergeNoVerify?: boolean
		branchExists?: (b: string) => boolean
	} = {}): { deps: PhaseDeps; calls: GitCall[]; storageState: { state: 'OPEN' | 'CLOSED' }; logs: string[] } {
		const calls: GitCall[] = []
		const logs: string[] = []
		const storageState = { state: 'OPEN' as 'OPEN' | 'CLOSED' }
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
			deleteBranch: recorded('deleteBranch'),
			worktreeAdd: recorded('worktreeAdd'),
			worktreeRemove: recorded('worktreeRemove'),
			worktreeList: async () => [],
			restoreAll: recorded('restoreAll'),
			cleanUntracked: recorded('cleanUntracked'),
			isWorkingTreeClean: async () => true,
			stashPush: recorded('stashPush'),
			stashPop: recorded('stashPop'),
		}
		const storage: Storage = {
			createPrd: async () => ({ id: 'p', branch: 'b' }),
			findPrd: async () => null,
			listPrds: async () => [],
			closePrd: async () => {},
			createSlice: async () => ({ id: 's', title: '', body: '', state: 'OPEN', readyForAgent: false, needsRevision: false, blockedBy: [], prState: null, branchAhead: false }),
			findSlices: async () => [],
			updateSlice: async (_p, _s, patch) => {
				if (patch.state === 'CLOSED') storageState.state = 'CLOSED'
			},
		}
		const deps: PhaseDeps = {
			storage,
			git,
			gh: {} as GhOps,
			log: (m) => { logs.push(m) },
			mergeNoVerify: overrides.mergeNoVerify ?? false,
		}
		return { deps, calls, storageState, logs }
	}

	const slice: Slice = {
		id: '42', title: 'A slice', body: 'b', state: 'OPEN',
		readyForAgent: true, needsRevision: false, blockedBy: [],
		prState: null, branchAhead: false,
	}
	const ctx: PhaseCtx = {
		prdId: 'pid',
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
			expect(prep.branch).toBe('prd-pid/slice-42-a-slice')
		})

		test('slice branch ALREADY exists → skip createRemoteBranch, still fetch, log a "reusing" warning', async () => {
			const sliceBranch = 'prd-pid/slice-42-a-slice'
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
