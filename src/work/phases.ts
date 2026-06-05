import { MERGE_SLICE_WORKTREE, mergeBranchIntoDestinationWithWorktree } from './merge-worktree.ts'
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
	projectRoot?: string
}

function withPhaseLock<T>(deps: PhaseDeps, fn: () => Promise<T>): Promise<T> {
	if (!deps.projectRoot) return fn()
	return withMutationLock(deps.projectRoot, fn)
}

function sliceBranchFor(slice: Slice): string {
	if (slice.sliceBranch === null) throw new Error(`Slice '${slice.id}' has no stored Slice branch; run implement preparation first`)
	return slice.sliceBranch
}

function sliceBranchName(changeId: string, sliceId: string, title: string): string {
	return `${changeId}/${sliceId}-${slugify(title)}`
}

async function pushSliceBranchIfNeeded(deps: PhaseDeps, branch: string, commits: number, tag: string): Promise<void> {
	if (commits <= 0) return
	await deps.git.push(branch)
	deps.log(`${tag} pushed ${branch}`)
}

/**
 * Prepare the implementer Turn on the Slice's durable Slice branch. New Slice records may start
 * with null Slice branch metadata; first preparation assigns and stores the branch using the
 * current work.perSliceBranches setting. Non-null stored metadata remains authoritative.
 */
export async function prepareImplement(deps: PhaseDeps, slice: Slice, ctx: PhaseCtx): Promise<PreparedPhase> {
	return withPhaseLock(deps, () => prepareImplementLocked(deps, slice, ctx))
}

async function prepareImplementLocked(deps: PhaseDeps, slice: Slice, ctx: PhaseCtx): Promise<PreparedPhase> {
	const branch = slice.sliceBranch ?? await assignSliceBranch(deps, slice, ctx)
	// Preserve the assigned branch for landImplement in this same Turn; durable identity is already
	// stored through updateSliceMetadata above.
	slice.sliceBranch = branch
	assertPrHeadCanTargetChangeBranch(slice, ctx, branch)
	await verifyStoredSliceBranch(deps, slice, ctx, branch)
	await deps.git.fetch(branch)
	return {
		branch,
		turnIn: { slice: { id: slice.id, title: slice.title, body: slice.body } },
	}
}

async function assignSliceBranch(deps: PhaseDeps, slice: Slice, ctx: PhaseCtx): Promise<string> {
	const branch = ctx.config.perSliceBranches ? await createPerSliceBranch(deps, slice, ctx) : ctx.changeBranch
	await deps.storage.updateSliceMetadata(ctx.changeId, slice.id, { sliceBranch: branch })
	return branch
}

async function createPerSliceBranch(deps: PhaseDeps, slice: Slice, ctx: PhaseCtx): Promise<string> {
	const branch = sliceBranchName(ctx.changeId, slice.id, slice.title)
	await deps.git.createRemoteBranch(branch, ctx.changeBranch)
	return branch
}

async function verifyStoredSliceBranch(deps: PhaseDeps, slice: Slice, ctx: PhaseCtx, branch: string): Promise<void> {
	if (await deps.git.remoteBranchExists(branch)) return
	throw new Error(`stored Slice branch '${branch}' for Slice '${slice.id}' is missing on origin; create or restore the branch before running work for Change '${ctx.changeId}'`)
}

function assertPrHeadCanTargetChangeBranch(slice: Slice, ctx: PhaseCtx, branch: string): void {
	if (!ctx.config.usePrs || branch !== ctx.changeBranch) return
	throw new Error(`Slice '${slice.id}' stores Slice branch '${branch}', which equals Change branch '${ctx.changeBranch}'; config.ship.pr cannot open a Slice PR with the same head and base`)
}

/**
 * Apply the implementer's verdict.
 *
 * Verdict dispatch (all matrix cells):
 * - `partial` → return `'partial'`, no side effects.
 * - `no-work-needed` → clear `readyForAgent` via storage, return `'no-work'`.
 *
 * `ready` handling dispatches on stored branch metadata and runtime `usePrs`:
 * - `slice.sliceBranch === change.changeBranch`, `usePrs: false`: push the stored branch,
 *   finalize the Slice, return `'done'`.
 * - distinct stored Slice branch, `usePrs: false`: push the Slice branch, host-side merge
 *   `--no-ff` into the Change branch through the reserved `__merge-slice` Worktree when
 *   `projectRoot` is available, close the Slice via storage, return `'done'`. Slice branch cleanup
 *   belongs to explicit Change-level Cleanup.
 * - distinct stored Slice branch, `usePrs: true`: push the Slice branch, open a draft PR, return
 *   `'progress'`. The next loop iteration's `findSlices` sees the PR and dispatches the reviewer.
 *   Works on every storage; at runtime requires a GitHub remote + `gh` auth (surfaced via
 *   `trowel doctor`, not preflight-gated).
 */
async function mergeSliceIntoChangeBranch(deps: PhaseDeps, slice: Slice, ctx: PhaseCtx, branch: string): Promise<void> {
	const tag = `[work change-${ctx.changeId} slice-${slice.id}]`
	await mergeSliceBranch(deps, ctx, branch)
	deps.log(`${tag} merged ${branch} into ${ctx.changeBranch}; slice branch retained for Cleanup`)
	await finalizeSlice(deps, ctx.changeId, slice.id)
	deps.log(`${tag} finalized slice`)
}

async function mergeSliceBranch(deps: PhaseDeps, ctx: PhaseCtx, branch: string): Promise<void> {
	if (deps.projectRoot) {
		await mergeBranchIntoDestinationWithWorktree({
			projectRoot: deps.projectRoot,
			changeId: ctx.changeId,
			reservation: MERGE_SLICE_WORKTREE,
			destinationBranch: ctx.changeBranch,
			sourceBranch: branch,
			git: deps.git,
			mergeNoVerify: deps.mergeNoVerify,
			log: deps.log,
		})
		return
	}
	await legacyMergeSliceBranch(deps, ctx, branch)
}

async function legacyMergeSliceBranch(deps: PhaseDeps, ctx: PhaseCtx, branch: string): Promise<void> {
	await deps.git.checkout(ctx.changeBranch)
	try {
		await deps.git.mergeNoFf(branch, { noVerify: deps.mergeNoVerify })
	} catch (e) {
		// Leave the working tree clean for re-run. Common cause: the project's commit-msg
		// hook rejects git's default "Merge branch 'X' into 'Y'" message; opt into
		// `config.work.mergeNoVerify: true` to bypass that hook on host-owned merges.
		await deps.git.mergeAbort()
		throw e
	}
	await deps.git.push(ctx.changeBranch)
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
	if (!canRecoverNoWorkNeededSliceBranch(ctx, slice)) return null
	const branch = sliceBranchFor(slice)
	const ahead = await deps.git.commitsAhead(branch, ctx.changeBranch)
	if (ahead <= 0) return null
	const tag = `[work change-${ctx.changeId} slice-${slice.id}]`
	deps.log(`${tag} no-work-needed but slice branch has ${ahead} unmerged commit(s) from a prior Turn; treating as ready`)
	await mergeSliceIntoChangeBranch(deps, slice, ctx, branch)
	return 'done'
}

function canRecoverNoWorkNeededSliceBranch(ctx: PhaseCtx, slice: Slice): boolean {
	return !ctx.config.usePrs && sliceBranchFor(slice) !== ctx.changeBranch
}

async function landImplementReady(deps: PhaseDeps, slice: Slice, ctx: PhaseCtx, commits: number): Promise<PhaseOutcome> {
	const branch = sliceBranchFor(slice)
	const tag = `[work change-${ctx.changeId} slice-${slice.id}]`
	if (ctx.config.usePrs) {
		assertPrHeadCanTargetChangeBranch(slice, ctx, branch)
		await pushSliceBranchIfNeeded(deps, branch, commits, tag)
		return openSliceDraftPr(deps, slice, ctx, branch)
	}
	if (branch === ctx.changeBranch) return closeDirectStoredSliceBranch(deps, slice, ctx, branch)
	await pushSliceBranchIfNeeded(deps, branch, commits, tag)
	await mergeSliceIntoChangeBranch(deps, slice, ctx, branch)
	return 'done'
}

async function closeDirectStoredSliceBranch(deps: PhaseDeps, slice: Slice, ctx: PhaseCtx, branch: string): Promise<PhaseOutcome> {
	const tag = `[work change-${ctx.changeId} slice-${slice.id}]`
	await deps.git.push(branch)
	deps.log(`${tag} pushed ${branch}`)
	await finalizeSlice(deps, ctx.changeId, slice.id)
	deps.log(`${tag} finalized slice`)
	return 'done'
}

async function finalizeSlice(deps: PhaseDeps, changeId: string, sliceId: string): Promise<void> {
	await deps.storage.updateSlice(changeId, sliceId, { closedAt: new Date().toISOString() })
}

async function openSliceDraftPr(deps: PhaseDeps, slice: Slice, ctx: PhaseCtx, branch: string): Promise<PhaseOutcome> {
	assertPrHeadCanTargetChangeBranch(slice, ctx, branch)
	const tag = `[work change-${ctx.changeId} slice-${slice.id}]`
	await deps.gh.createDraftPr({ title: slice.title, head: branch, base: ctx.changeBranch, body: `Closes #${slice.id}` })
	deps.log(`${tag} opened draft PR for ${branch}`)
	return 'progress'
}

/**
 * Prepare the reviewer Turn. Requires an open PR (looked up via `findPrNumber`); the loop only
 * dispatches `'review'` when `prState` is `'draft'`, which presupposes `config.ship.pr: true`.
 * Per-phase commands (`trowel review`) bypass the classifier; if no PR exists `findPrNumber` throws.
 *
 * Looks up the slice branch's PR number so the reviewer prompt has `{pr.number, pr.branch}` to
 * fetch the diff and post comments against.
 */
export async function prepareReview(deps: PhaseDeps, slice: Slice, _ctx: PhaseCtx): Promise<PreparedPhase> {
	const branch = sliceBranchFor(slice)
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
export async function prepareAddress(deps: PhaseDeps, slice: Slice, _ctx: PhaseCtx): Promise<PreparedPhase> {
	const branch = sliceBranchFor(slice)
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
	const branch = sliceBranchFor(slice)
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
		remoteBranchExists?: (b: string) => boolean
		branchExists?: (b: string) => boolean
		commitsAhead?: number
	} = {}): { deps: PhaseDeps; calls: GitCall[]; storageState: { closedAt: string | null; needsRevision: boolean; sliceBranch: string | null }; logs: string[] } {
		const calls: GitCall[] = []
		const logs: string[] = []
		const storageState = { closedAt: null as string | null, needsRevision: true, sliceBranch: null as string | null }
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
			mergeNoFfIn: recorded('mergeNoFfIn'),
			mergeAbortIn: recorded('mergeAbortIn'),
			deleteRemoteBranch: recorded('deleteRemoteBranch'),
			remoteBranchExists: async (b) => {
				calls.push({ method: 'remoteBranchExists', args: [b] })
				return overrides.remoteBranchExists ? overrides.remoteBranchExists(b) : true
			},
			createRemoteBranch: recorded('createRemoteBranch'),
			createLocalBranch: recorded('createLocalBranch'),
			pushSetUpstream: recorded('pushSetUpstream'),
			currentBranch: async () => 'change-branch',
			baseBranch: async () => 'main',
			branchExists: async (b) => overrides.branchExists ? overrides.branchExists(b) : true,
			localBranchExists: async (b) => overrides.branchExists ? overrides.branchExists(b) : true,
			isMerged: async () => false,
			commitsAhead: async (branch, base) => { calls.push({ method: 'commitsAhead', args: [branch, base] }); return overrides.commitsAhead ?? 0 },
			listLocalBranches: async () => [],
			deleteBranch: recorded('deleteBranch'),
			resolveRef: async (ref, worktreePath) => { calls.push({ method: 'resolveRef', args: [ref, worktreePath] }); return ref === 'HEAD' ? 'pushed-head' : ref },
			checkoutDetached: recorded('checkoutDetached'),
			resetHard: recorded('resetHard'),
			pushHeadTo: recorded('pushHeadTo'),
			updateLocalBranchRef: recorded('updateLocalBranchRef'),
			worktreeAdd: recorded('worktreeAdd'),
			worktreeRemove: recorded('worktreeRemove'),
			worktreeList: async () => [],
			restoreAll: recorded('restoreAll'),
			cleanUntracked: recorded('cleanUntracked'),
			cleanAll: recorded('cleanAll'),
			isWorkingTreeClean: async () => true,
			statusShort: async () => '',
			stashPush: recorded('stashPush'),
			stashPop: recorded('stashPop'),
			detectVersion: async () => ({ installed: true, version: '0.0.0' }),
		}
		const storage: Storage = {
			createChange: async () => ({ id: 'p', title: 'p' }),
			findChange: async () => null,
			listChanges: async () => [],
			closeChange: async () => {},
			updateChangeMetadata: async () => {},
			createSlice: async () => ({ id: 's', title: '', body: '', state: 'draft', closedAt: null, readyForAgent: false, needsRevision: false, blockedBy: [], sliceBranch: 'change-p/slice-s', prState: null }),
			findSlices: async () => [],
			findSlice: async () => null,
			updateSlice: async (_p, _s, patch) => {
				if (patch.closedAt !== undefined) storageState.closedAt = patch.closedAt
				if (patch.needsRevision !== undefined) storageState.needsRevision = patch.needsRevision
			},
			updateSliceMetadata: async (_p, _s, patch) => {
				calls.push({ method: 'updateSliceMetadata', args: [_p, _s, patch] })
				if (patch.sliceBranch !== undefined) storageState.sliceBranch = patch.sliceBranch
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
		id: '42', title: 'A slice', body: 'b', state: 'open', closedAt: null,
		readyForAgent: true, needsRevision: false, blockedBy: [], sliceBranch: 'change-pid/slice-42-a-slice', prState: null,
	}
	const ctx: PhaseCtx = {
		changeId: 'pid',
		changeBranch: 'change-branch',
		config: { usePrs: false, review: false, perSliceBranches: true },
	}

	describe('prepareImplement: stored Slice branch', () => {
		test('stored Slice branch exists remotely → verifies, fetches, and returns it without creation', async () => {
			const { deps, calls } = makePhaseDeps()
			const prep = await prepareImplement(deps, slice, ctx)
			const methods = calls.map((c) => c.method)
			expect(methods).toContain('remoteBranchExists')
			expect(methods).toContain('fetch')
			expect(methods).not.toContain('createRemoteBranch')
			expect(prep.branch).toBe('change-pid/slice-42-a-slice')
		})

		test('stored Slice branch missing remotely → fails instead of creating it', async () => {
			const { deps, calls } = makePhaseDeps({ remoteBranchExists: () => false })
			await expect(prepareImplement(deps, slice, ctx)).rejects.toThrow(/stored Slice branch 'change-pid\/slice-42-a-slice'.*missing on origin/)
			const methods = calls.map((c) => c.method)
			expect(methods).toContain('remoteBranchExists')
			expect(methods).not.toContain('createRemoteBranch')
			expect(methods).not.toContain('fetch')
		})

		test('direct shared-branch Slice execution uses the stored Slice branch even when it equals the Change branch', async () => {
			const { deps, calls } = makePhaseDeps()
			const shared = { ...slice, sliceBranch: 'change-branch' }
			const prep = await prepareImplement(deps, shared, { ...ctx, config: { ...ctx.config, perSliceBranches: false } })
			const methods = calls.map((c) => c.method)
			expect(methods).not.toContain('createRemoteBranch')
			expect(methods).toContain('fetch')
			expect(prep.branch).toBe('change-branch')
		})

		test('usePrs:true rejects a stored Slice branch equal to the Change branch', async () => {
			const { deps } = makePhaseDeps()
			const shared = { ...slice, sliceBranch: 'change-branch' }
			await expect(prepareImplement(deps, shared, { ...ctx, config: { usePrs: true, review: false, perSliceBranches: true } })).rejects.toThrow(/same head and base/)
		})

		test('null Slice branch + perSliceBranches:true creates and stores a fresh per-Slice branch at preparation time', async () => {
			const { deps, calls, storageState } = makePhaseDeps()
			const unassigned = { ...slice, sliceBranch: null }
			const prep = await prepareImplement(deps, unassigned, ctx)
			expect(prep.branch).toBe('pid/42-a-slice')
			expect(storageState.sliceBranch).toBe('pid/42-a-slice')
			expect(unassigned.sliceBranch).toBe('pid/42-a-slice')
			expect(calls).toContainEqual({ method: 'createRemoteBranch', args: ['pid/42-a-slice', 'change-branch'] })
			expect(calls).toContainEqual({ method: 'updateSliceMetadata', args: ['pid', '42', { sliceBranch: 'pid/42-a-slice' }] })
			expect(calls).toContainEqual({ method: 'fetch', args: ['pid/42-a-slice'] })
		})

		test('null Slice branch + perSliceBranches:false stores the Change branch at preparation time', async () => {
			const { deps, calls, storageState } = makePhaseDeps()
			const unassigned = { ...slice, sliceBranch: null }
			const prep = await prepareImplement(deps, unassigned, { ...ctx, config: { usePrs: false, review: false, perSliceBranches: false } })
			expect(prep.branch).toBe('change-branch')
			expect(storageState.sliceBranch).toBe('change-branch')
			expect(calls.map((c) => c.method)).not.toContain('createRemoteBranch')
			expect(calls).toContainEqual({ method: 'updateSliceMetadata', args: ['pid', '42', { sliceBranch: 'change-branch' }] })
		})
	})

	describe('landImplement: no-work-needed handling with leftover commits on slice branch', () => {
		test('no-work-needed + slice branch even with Change branch (commitsAhead: 0) → just clear readyForAgent (today behavior)', async () => {
			const { deps, calls, storageState } = makePhaseDeps({ commitsAhead: 0 })
			const outcome = await landImplement(deps, slice, { verdict: 'no-work-needed', notes: 'already done', commits: 0 }, ctx)
			expect(outcome).toBe('no-work')
			expect(storageState.closedAt).toBeNull()
			const methods = calls.map((c) => c.method)
			expect(methods).not.toContain('mergeNoFf')
			expect(methods).not.toContain('deleteRemoteBranch')
		})

		test('no-work-needed + slice branch ahead of Change branch (commitsAhead > 0) → run merge sequence + close, log the recovery', async () => {
			const { deps, calls, storageState, logs } = makePhaseDeps({ commitsAhead: 2 })
			const outcome = await landImplement(deps, slice, { verdict: 'no-work-needed', notes: 'already done', commits: 0 }, ctx)
			expect(outcome).toBe('done')
			const methods = calls.map((c) => c.method)
			expect(methods).toContain('mergeNoFf')
			expect(methods).not.toContain('deleteRemoteBranch')
			expect(storageState.closedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
			expect(logs.some((l) => /no-work-needed but slice branch has 2 unmerged commit/.test(l))).toBe(true)
		})

		test('no-work-needed + stored Slice branch equals Change branch → just clear readyForAgent regardless of commitsAhead', async () => {
			const { deps, calls } = makePhaseDeps({ commitsAhead: 5 })
			const shared = { ...slice, sliceBranch: 'change-branch' }
			const outcome = await landImplement(deps, shared, { verdict: 'no-work-needed', notes: 'done', commits: 0 }, { ...ctx, config: { ...ctx.config, perSliceBranches: false } })
			expect(outcome).toBe('no-work')
			expect(calls.map((c) => c.method)).not.toContain('mergeNoFf')
		})
	})

	describe('landImplement: stored branch landing', () => {
		test('ready + stored Slice branch equals Change branch → pushes the stored branch directly and finalizes', async () => {
			const { deps, calls, storageState } = makePhaseDeps()
			const shared = { ...slice, sliceBranch: 'change-branch' }
			const outcome = await landImplement(deps, shared, { verdict: 'ready', commits: 1 }, { ...ctx, config: { ...ctx.config, perSliceBranches: false } })
			expect(outcome).toBe('done')
			expect(calls).toContainEqual({ method: 'push', args: ['change-branch'] })
			expect(calls.map((c) => c.method)).not.toContain('mergeNoFf')
			expect(storageState.closedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
		})

		test('usePrs:true rejects PR creation when the stored Slice branch equals the Change branch', async () => {
			const { deps } = makePhaseDeps()
			const shared = { ...slice, sliceBranch: 'change-branch' }
			await expect(landImplement(deps, shared, { verdict: 'ready', commits: 1 }, { ...ctx, config: { usePrs: true, review: false, perSliceBranches: true } })).rejects.toThrow(/same head and base/)
		})
	})

	describe('landImplement: host-merge failure recovery', () => {
		test('happy path: mergeNoFf succeeds → no mergeAbort call', async () => {
			const { deps, calls, storageState } = makePhaseDeps()
			const outcome = await landImplement(deps, slice, { verdict: 'ready', commits: 1 }, ctx)
			expect(outcome).toBe('done')
			expect(calls.find((c) => c.method === 'mergeAbort')).toBeUndefined()
			expect(storageState.closedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
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
			// the Change branch push that comes after the merge.
			expect(methods.filter((m) => m === 'push')).toHaveLength(1)
		})
	})

	describe('landImplement: slice host merges through the reserved merge worktree', () => {
		test('ready + projectRoot merges the slice branch into the Change branch from __merge-slice without checking it out', async () => {
			const { mkdtemp, rm } = await import('node:fs/promises')
			const { tmpdir } = await import('node:os')
			const path = await import('node:path')
			const projectRoot = await mkdtemp(path.join(tmpdir(), 'trowel-phase-merge-'))
			try {
				const { deps, calls, storageState, logs } = makePhaseDeps()
				deps.projectRoot = projectRoot

				const outcome = await landImplement(deps, slice, { verdict: 'ready', commits: 1 }, ctx)

				const mergeWorktreePath = path.join(projectRoot, '.trowel', 'worktrees', 'pid', '__merge-slice')
				expect(outcome).toBe('done')
				expect(calls.map((c) => c.method)).not.toContain('checkout')
				expect(calls).toContainEqual({ method: 'worktreeAdd', args: [mergeWorktreePath, 'origin/change-branch'] })
				expect(calls).toContainEqual({ method: 'mergeNoFfIn', args: [mergeWorktreePath, 'change-pid/slice-42-a-slice', { noVerify: false }] })
				expect(calls).toContainEqual({ method: 'pushHeadTo', args: [mergeWorktreePath, 'change-branch'] })
				expect(calls).toContainEqual({ method: 'updateLocalBranchRef', args: ['change-branch', 'pushed-head'] })
				expect(storageState.closedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
				expect(logs.some((l) => l.includes('merged change-pid/slice-42-a-slice into change-branch; slice branch retained for Cleanup'))).toBe(true)
			} finally {
				await rm(projectRoot, { recursive: true, force: true })
			}
		})

		test('failed worktree merge reports the preserved __merge-slice path and does not finalize the slice', async () => {
			const { mkdtemp, rm } = await import('node:fs/promises')
			const { tmpdir } = await import('node:os')
			const path = await import('node:path')
			const projectRoot = await mkdtemp(path.join(tmpdir(), 'trowel-phase-merge-fail-'))
			try {
				const boom = new Error('merge conflict')
				const { deps, calls, storageState } = makePhaseDeps()
				deps.projectRoot = projectRoot
				deps.git.mergeNoFfIn = async (worktreePath, branch, opts) => {
					calls.push({ method: 'mergeNoFfIn', args: [worktreePath, branch, opts] })
					throw boom
				}

				const mergeWorktreePath = path.join(projectRoot, '.trowel', 'worktrees', 'pid', '__merge-slice')
				await expect(landImplement(deps, slice, { verdict: 'ready', commits: 1 }, ctx)).rejects.toThrow(`Merge worktree preserved at ${mergeWorktreePath}`)
				expect(storageState.closedAt).toBeNull()
				expect(calls.map((c) => c.method)).not.toContain('updateLocalBranchRef')
			} finally {
				await rm(projectRoot, { recursive: true, force: true })
			}
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
