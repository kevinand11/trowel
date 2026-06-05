import { MERGE_SLICE_WORKTREE, mergeBranchIntoDestinationWithWorktree } from './merge-worktree.ts'
import { fetchPrFeedback } from './pr-flow.ts'
import type { TurnIn, TurnOut } from './verdict.ts'
import type { Slice, Storage } from '../storages/types.ts'
import type { PhaseCtx, PhaseOutcome, PreparedPhase } from './types.ts'
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
 * workflow flags (`ship.pr`, `work.audit`, `work.perSliceBranches`), not on a storage capability.
 */
export type PhaseDeps = {
	storage: Storage
	git: GitOps
	gh: GhOps
	log: (msg: string) => void
	mergeNoVerify: boolean
	projectRoot?: string
	needsRevisionLabel?: string
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
	const branch = slice.sliceBranch ?? (await assignSliceBranch(deps, slice, ctx))
	// Preserve the assigned branch for landImplement in this same Turn; durable identity is already
	// stored through updateSliceMetadata above.
	slice.sliceBranch = branch
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
	throw new Error(
		`stored Slice branch '${branch}' for Slice '${slice.id}' is missing on origin; create or restore the branch before running work for Change '${ctx.changeId}'`,
	)
}

function assertPrHeadCanTargetChangeBranch(slice: Slice, ctx: PhaseCtx, branch: string): void {
	if (!ctx.config.pr || branch !== ctx.changeBranch) return
	throw new Error(
		`Slice '${slice.id}' stores Slice branch '${branch}', which equals Change branch '${ctx.changeBranch}'; config.ship.pr cannot open a Slice PR with the same head and base`,
	)
}

/**
 * Apply the implementer's verdict. A `ready` verdict records the Implementer milestone but does
 * not immediately integrate the Slice. The loop refetches, exposes the computed `implemented`
 * state, then either runs Auditing or performs host integration in a later step.
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
	return !ctx.config.pr && sliceBranchFor(slice) !== ctx.changeBranch
}

async function landImplementReady(deps: PhaseDeps, slice: Slice, ctx: PhaseCtx, commits: number): Promise<PhaseOutcome> {
	const branch = sliceBranchFor(slice)
	const tag = `[work change-${ctx.changeId} slice-${slice.id}]`
	await pushSliceBranchIfNeeded(deps, branch, commits, tag)
	await markSliceImplemented(deps, ctx.changeId, slice.id, tag)
	return 'progress'
}

async function markSliceImplemented(deps: PhaseDeps, changeId: string, sliceId: string, tag: string): Promise<void> {
	await deps.storage.updateSlice(changeId, sliceId, { implementedAt: new Date().toISOString() })
	deps.log(`${tag} recorded implementedAt`)
}

async function finalizeSlice(deps: PhaseDeps, changeId: string, sliceId: string): Promise<void> {
	await deps.storage.updateSlice(changeId, sliceId, { closedAt: new Date().toISOString() })
}

export async function integrateSlice(deps: PhaseDeps, slice: Slice, ctx: PhaseCtx): Promise<PhaseOutcome> {
	return withPhaseLock(deps, () => integrateSliceLocked(deps, slice, ctx))
}

async function integrateSliceLocked(deps: PhaseDeps, slice: Slice, ctx: PhaseCtx): Promise<PhaseOutcome> {
	const branch = sliceBranchFor(slice)
	if (ctx.config.pr && branch !== ctx.changeBranch) return openReadySlicePr(deps, slice, ctx, branch)
	if (branch === ctx.changeBranch) return closeDirectStoredSliceBranch(deps, slice, ctx, branch)
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

async function openReadySlicePr(deps: PhaseDeps, slice: Slice, ctx: PhaseCtx, branch: string): Promise<PhaseOutcome> {
	assertPrHeadCanTargetChangeBranch(slice, ctx, branch)
	const tag = `[work change-${ctx.changeId} slice-${slice.id}]`
	if (slice.prState === 'draft') {
		const prNumber = await deps.gh.findPrNumberByHead(branch)
		await deps.gh.markPrReady(prNumber)
		deps.log(`${tag} marked existing draft PR #${prNumber} for ${branch} ready for merge`)
		return 'progress'
	}
	const pr = await deps.gh.createDraftPr({ title: slice.title, head: branch, base: ctx.changeBranch, body: `Closes #${slice.id}` })
	await deps.gh.markPrReady(pr.number)
	deps.log(`${tag} opened PR #${pr.number} for ${branch} and marked it ready for merge`)
	return 'progress'
}

export async function prepareAudit(_deps: PhaseDeps, slice: Slice, ctx: PhaseCtx): Promise<PreparedPhase> {
	const branch = sliceBranchFor(slice)
	const turnIn: TurnIn = {
		slice: { id: slice.id, title: slice.title, body: slice.body },
		changeBranch: ctx.changeBranch,
	}
	return { branch, turnIn }
}

export async function landAudit(deps: PhaseDeps, slice: Slice, verdict: TurnOut, ctx: PhaseCtx): Promise<PhaseOutcome> {
	return withPhaseLock(deps, () => landAuditLocked(deps, slice, verdict, ctx))
}

async function landAuditLocked(deps: PhaseDeps, slice: Slice, verdict: TurnOut, ctx: PhaseCtx): Promise<PhaseOutcome> {
	if (verdict.verdict === 'partial') return 'partial'
	if (verdict.verdict !== 'ready') return 'partial'
	const branch = sliceBranchFor(slice)
	const tag = `[work change-${ctx.changeId} slice-${slice.id}]`
	await pushSliceBranchIfNeeded(deps, branch, verdict.commits, tag)
	await deps.storage.updateSlice(ctx.changeId, slice.id, { auditedAt: new Date().toISOString() })
	deps.log(`${tag} recorded auditedAt`)
	return 'progress'
}

/**
 * Prepare the Reviewer Turn. Requires an open PR (calls `findPrNumber` + `fetchPrFeedback`;
 * both throw if no PR exists for the Slice branch).
 *
 * Reviewer work is tied to PR review feedback: the loop dispatches `review` when PR enrichment
 * computes the Slice state as `needs-revision`.
 */
export async function prepareReview(deps: PhaseDeps, slice: Slice, _ctx: PhaseCtx): Promise<PreparedPhase> {
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
 * Apply the Reviewer's verdict. Requires an open PR for the Slice branch.
 *
 * - `ready` → push feedback-response commits (if any), clear the PR needs-revision label. Returns `'progress'`.
 * - `no-work-needed` → clear the PR needs-revision label without pushing. Returns `'no-work'`; loop drops the
 *   Slice for this run.
 * - `partial` → return `'partial'`, no side effects.
 */
export async function landReview(deps: PhaseDeps, slice: Slice, verdict: TurnOut, ctx: PhaseCtx): Promise<PhaseOutcome> {
	return withPhaseLock(deps, async () => landReviewLocked(deps, slice, verdict, ctx))
}

async function landReviewLocked(deps: PhaseDeps, slice: Slice, verdict: TurnOut, ctx: PhaseCtx): Promise<PhaseOutcome> {
	const tag = `[work change-${ctx.changeId} slice-${slice.id}]`
	const branch = sliceBranchFor(slice)
	if (verdict.verdict === 'partial') return 'partial'
	if (verdict.verdict === 'ready') return landReviewReady(deps, verdict, branch, tag)
	if (verdict.verdict === 'no-work-needed') return landReviewNoWorkNeeded(deps, branch, tag)
	return 'partial'
}

async function landReviewReady(deps: PhaseDeps, verdict: TurnOut, branch: string, tag: string): Promise<PhaseOutcome> {
	await pushSliceBranchIfNeeded(deps, branch, verdict.commits, tag)
	await clearSliceNeedsRevision(deps, branch, tag)
	return 'progress'
}

async function landReviewNoWorkNeeded(deps: PhaseDeps, branch: string, tag: string): Promise<PhaseOutcome> {
	await clearSliceNeedsRevision(deps, branch, tag, 'no-work-needed: ')
	return 'no-work'
}

async function clearSliceNeedsRevision(deps: PhaseDeps, branch: string, tag: string, prefix = ''): Promise<void> {
	const prNumber = await deps.gh.findPrNumberByHead(branch)
	const label = deps.needsRevisionLabel ?? 'needs-revision'
	await deps.gh.editIssueLabels(prNumber, { remove: [label] })
	deps.log(`${tag} ${prefix}cleared PR needs-revision`)
}

if (import.meta.vitest) {
	const { describe, test, expect } = import.meta.vitest

	type GitCall = { method: string; args: unknown[] }

	function makePhaseDeps(
		overrides: {
			mergeNoFfThrows?: Error
			mergeNoVerify?: boolean
			remoteBranchExists?: (b: string) => boolean
			branchExists?: (b: string) => boolean
			commitsAhead?: number
		} = {},
	): {
		deps: PhaseDeps
		calls: GitCall[]
		storageState: { closedAt: string | null; implementedAt: string | null; auditedAt: string | null; sliceBranch: string | null }
		logs: string[]
	} {
		const calls: GitCall[] = []
		const logs: string[] = []
		const storageState = {
			closedAt: null as string | null,
			implementedAt: null as string | null,
			auditedAt: null as string | null,
			sliceBranch: null as string | null,
		}
		const recorded =
			(method: string) =>
			(...args: unknown[]) => {
				calls.push({ method, args })
				return Promise.resolve()
			}
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
			fastForward: recorded('fastForward'),
			currentBranch: async () => 'change-branch',
			baseBranch: async () => 'main',
			branchExists: async (b) => (overrides.branchExists ? overrides.branchExists(b) : true),
			localBranchExists: async (b) => (overrides.branchExists ? overrides.branchExists(b) : true),
			isMerged: async () => false,
			commitsAhead: async (branch, base) => {
				calls.push({ method: 'commitsAhead', args: [branch, base] })
				return overrides.commitsAhead ?? 0
			},
			listLocalBranches: async () => [],
			deleteBranch: recorded('deleteBranch'),
			resolveRef: async (ref, worktreePath) => {
				calls.push({ method: 'resolveRef', args: [ref, worktreePath] })
				return ref === 'HEAD' ? 'pushed-head' : ref
			},
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
			createSlice: async () => ({
				id: 's',
				title: '',
				body: '',
				state: 'draft',
				closedAt: null,
				implementedAt: null,
				auditedAt: null,
				readyForAgent: false,
				needsRevision: false,
				blockedBy: [],
				sliceBranch: 'change-p/slice-s',
				prState: null,
			}),
			findSlices: async () => [],
			updateSlice: async (_p, _s, patch) => {
				if (patch.closedAt !== undefined) storageState.closedAt = patch.closedAt
				if (patch.implementedAt !== undefined) storageState.implementedAt = patch.implementedAt
				if (patch.auditedAt !== undefined) storageState.auditedAt = patch.auditedAt
			},
			updateSliceMetadata: async (_p, _s, patch) => {
				calls.push({ method: 'updateSliceMetadata', args: [_p, _s, patch] })
				if (patch.sliceBranch !== undefined) storageState.sliceBranch = patch.sliceBranch
			},
		}
		const gh: GhOps = {
			createDraftPr: async (opts) => {
				calls.push({ method: 'createDraftPr', args: [opts] })
				return { number: 132, headRefName: opts.head, isDraft: true, url: '#132' }
			},
			findPrNumberByHead: async (head) => {
				calls.push({ method: 'findPrNumberByHead', args: [head] })
				return 132
			},
			editIssueLabels: async (id, patch) => {
				calls.push({ method: 'editIssueLabels', args: [id, patch] })
			},
			markPrReady: async (prNumber) => {
				calls.push({ method: 'markPrReady', args: [prNumber] })
			},
		} as GhOps
		const deps: PhaseDeps = {
			storage,
			git,
			gh,
			log: (m) => {
				logs.push(m)
			},
			mergeNoVerify: overrides.mergeNoVerify ?? false,
		}
		return { deps, calls, storageState, logs }
	}

	const slice: Slice = {
		id: '42',
		title: 'A slice',
		body: 'b',
		state: 'open',
		closedAt: null,
		implementedAt: null,
		auditedAt: null,
		readyForAgent: true,
		needsRevision: false,
		blockedBy: [],
		sliceBranch: 'change-pid/slice-42-a-slice',
		prState: null,
	}
	const ctx: PhaseCtx = {
		changeId: 'pid',
		changeBranch: 'change-branch',
		config: { pr: false, audit: false, perSliceBranches: true },
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
			await expect(prepareImplement(deps, slice, ctx)).rejects.toThrow(
				/stored Slice branch 'change-pid\/slice-42-a-slice'.*missing on origin/,
			)
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

		test('pr:true allows a stored Slice branch equal to the Change branch; later Auditing/PR integration is skipped', async () => {
			const { deps } = makePhaseDeps()
			const shared = { ...slice, sliceBranch: 'change-branch' }
			const prep = await prepareImplement(deps, shared, { ...ctx, config: { pr: true, audit: false, perSliceBranches: true } })
			expect(prep.branch).toBe('change-branch')
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
			const prep = await prepareImplement(deps, unassigned, { ...ctx, config: { pr: false, audit: false, perSliceBranches: false } })
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
			const outcome = await landImplement(
				deps,
				shared,
				{ verdict: 'no-work-needed', notes: 'done', commits: 0 },
				{ ...ctx, config: { ...ctx.config, perSliceBranches: false } },
			)
			expect(outcome).toBe('no-work')
			expect(calls.map((c) => c.method)).not.toContain('mergeNoFf')
		})
	})

	describe('landImplement: stored branch landing', () => {
		test('ready records implementedAt without finalizing', async () => {
			const { deps, calls, storageState } = makePhaseDeps()
			const shared = { ...slice, sliceBranch: 'change-branch' }
			const outcome = await landImplement(
				deps,
				shared,
				{ verdict: 'ready', commits: 1 },
				{ ...ctx, config: { ...ctx.config, perSliceBranches: false } },
			)
			expect(outcome).toBe('progress')
			expect(calls).toContainEqual({ method: 'push', args: ['change-branch'] })
			expect(calls.map((c) => c.method)).not.toContain('mergeNoFf')
			expect(storageState.closedAt).toBeNull()
			expect(storageState.implementedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
		})

		test('pr:true with stored Slice branch equal to Change branch records implementedAt without same-head PR failure', async () => {
			const { deps, storageState } = makePhaseDeps()
			const shared = { ...slice, sliceBranch: 'change-branch' }
			const outcome = await landImplement(
				deps,
				shared,
				{ verdict: 'ready', commits: 1 },
				{ ...ctx, config: { pr: true, audit: false, perSliceBranches: true } },
			)
			expect(outcome).toBe('progress')
			expect(storageState.implementedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
		})
	})

	describe('integrateSlice: host-merge failure recovery', () => {
		test('happy path: mergeNoFf succeeds → no mergeAbort call', async () => {
			const { deps, calls, storageState } = makePhaseDeps()
			const outcome = await integrateSlice(deps, slice, ctx)
			expect(outcome).toBe('done')
			expect(calls.find((c) => c.method === 'mergeAbort')).toBeUndefined()
			expect(storageState.closedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
		})

		test('mergeNoFf throws → mergeAbort runs, error re-thrown, push and deleteRemoteBranch NOT reached', async () => {
			const boom = new Error('commit-msg hook rejected the merge')
			const { deps, calls } = makePhaseDeps({ mergeNoFfThrows: boom })
			await expect(integrateSlice(deps, slice, ctx)).rejects.toThrow(boom)
			const methods = calls.map((c) => c.method)
			expect(methods).toContain('mergeAbort')
			expect(methods.indexOf('mergeAbort')).toBeGreaterThan(methods.indexOf('mergeNoFf'))
			expect(methods).not.toContain('deleteRemoteBranch')
			expect(methods.filter((m) => m === 'push')).toHaveLength(0)
		})
	})

	describe('integrateSlice: Slice PR readiness', () => {
		test('ship.pr true opens a draft Slice PR and marks it ready for a distinct Slice branch', async () => {
			const { deps, calls, storageState } = makePhaseDeps()
			const outcome = await integrateSlice(deps, slice, { ...ctx, config: { pr: true, audit: false, perSliceBranches: true } })
			expect(outcome).toBe('progress')
			expect(calls).toContainEqual({
				method: 'createDraftPr',
				args: [{ title: 'A slice', head: 'change-pid/slice-42-a-slice', base: 'change-branch', body: 'Closes #42' }],
			})
			expect(calls).toContainEqual({ method: 'markPrReady', args: [132] })
			expect(storageState.closedAt).toBeNull()
		})

		test('ship.pr true readies an existing draft Slice PR instead of creating a duplicate', async () => {
			const { deps, calls, storageState } = makePhaseDeps()
			const outcome = await integrateSlice(
				deps,
				{ ...slice, prState: 'draft' },
				{ ...ctx, config: { pr: true, audit: true, perSliceBranches: true } },
			)
			expect(outcome).toBe('progress')
			expect(calls.map((c) => c.method)).not.toContain('createDraftPr')
			expect(calls).toContainEqual({ method: 'markPrReady', args: [132] })
			expect(storageState.closedAt).toBeNull()
		})
	})

	describe('integrateSlice: slice host merges through the reserved merge worktree', () => {
		test('projectRoot merges the slice branch into the Change branch from __merge-slice without checking it out', async () => {
			const { mkdtemp, rm } = await import('node:fs/promises')
			const { tmpdir } = await import('node:os')
			const path = await import('node:path')
			const projectRoot = await mkdtemp(path.join(tmpdir(), 'trowel-phase-merge-'))
			try {
				const { deps, calls, storageState, logs } = makePhaseDeps()
				deps.projectRoot = projectRoot

				const outcome = await integrateSlice(deps, slice, ctx)

				const mergeWorktreePath = path.join(projectRoot, '.trowel', 'worktrees', 'pid', '__merge-slice')
				expect(outcome).toBe('done')
				expect(calls.map((c) => c.method)).not.toContain('checkout')
				expect(calls).toContainEqual({ method: 'worktreeAdd', args: [mergeWorktreePath, 'origin/change-branch'] })
				expect(calls).toContainEqual({
					method: 'mergeNoFfIn',
					args: [mergeWorktreePath, 'change-pid/slice-42-a-slice', { noVerify: false }],
				})
				expect(calls).toContainEqual({ method: 'pushHeadTo', args: [mergeWorktreePath, 'change-branch'] })
				expect(calls).toContainEqual({ method: 'updateLocalBranchRef', args: ['change-branch', 'pushed-head'] })
				expect(storageState.closedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
				expect(
					logs.some((l) =>
						l.includes('merged change-pid/slice-42-a-slice into change-branch; slice branch retained for Cleanup'),
					),
				).toBe(true)
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
				await expect(integrateSlice(deps, slice, ctx)).rejects.toThrow(`Merge worktree preserved at ${mergeWorktreePath}`)
				expect(storageState.closedAt).toBeNull()
				expect(calls.map((c) => c.method)).not.toContain('updateLocalBranchRef')
			} finally {
				await rm(projectRoot, { recursive: true, force: true })
			}
		})
	})

	describe('landAudit', () => {
		test('ready pushes auditor commits and records auditedAt', async () => {
			const { deps, calls, storageState } = makePhaseDeps()
			const prep = await prepareAudit(deps, slice, ctx)
			expect(prep).toMatchObject({ branch: 'change-pid/slice-42-a-slice', turnIn: { changeBranch: 'change-branch' } })
			const outcome = await landAudit(deps, slice, { verdict: 'ready', commits: 2 }, ctx)
			expect(outcome).toBe('progress')
			expect(calls).toContainEqual({ method: 'push', args: ['change-pid/slice-42-a-slice'] })
			expect(storageState.auditedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
		})
	})

	describe('prepareReview: PR feedback response', () => {
		test('fetches PR feedback for the Reviewer Turn', async () => {
			const { deps, calls } = makePhaseDeps()
			deps.gh.fetchPrLineComments = async (prNumber) => {
				calls.push({ method: 'fetchPrLineComments', args: [prNumber] })
				return []
			}
			deps.gh.fetchPrReviews = async (prNumber) => {
				calls.push({ method: 'fetchPrReviews', args: [prNumber] })
				return []
			}
			deps.gh.fetchPrThread = async (prNumber) => {
				calls.push({ method: 'fetchPrThread', args: [prNumber] })
				return []
			}
			const prep = await prepareReview(deps, { ...slice, needsRevision: true }, ctx)
			expect(prep.turnIn).toMatchObject({ pr: { number: 132, branch: 'change-pid/slice-42-a-slice' }, feedback: [] })
			expect(calls).toContainEqual({ method: 'fetchPrReviews', args: [132] })
		})
	})

	describe('landReview: clears needs-revision PR signal', () => {
		test('ready clears matching PR label so enrichment does not requeue review', async () => {
			const { deps, calls } = makePhaseDeps()
			await landReview(
				deps,
				{ ...slice, needsRevision: true },
				{ verdict: 'ready', commits: 5 },
				{ ...ctx, config: { pr: true, audit: true, perSliceBranches: true } },
			)
			expect(calls).toContainEqual({ method: 'editIssueLabels', args: [132, { remove: ['needs-revision'] }] })
		})

		test('no-work-needed clears matching PR label so enrichment does not requeue review', async () => {
			const { deps, calls } = makePhaseDeps()
			await landReview(
				deps,
				{ ...slice, needsRevision: true },
				{ verdict: 'no-work-needed', commits: 0 },
				{ ...ctx, config: { pr: true, audit: true, perSliceBranches: true } },
			)
			expect(calls).toContainEqual({ method: 'editIssueLabels', args: [132, { remove: ['needs-revision'] }] })
		})
	})

	describe('integrateSlice: passes mergeNoVerify through to mergeNoFf opts', () => {
		test('mergeNoVerify: false → mergeNoFf called with { noVerify: false }', async () => {
			const { deps, calls } = makePhaseDeps({ mergeNoVerify: false })
			await integrateSlice(deps, slice, ctx)
			const merge = calls.find((c) => c.method === 'mergeNoFf')!
			expect(merge.args[1]).toEqual({ noVerify: false })
		})

		test('mergeNoVerify: true → mergeNoFf called with { noVerify: true }', async () => {
			const { deps, calls } = makePhaseDeps({ mergeNoVerify: true })
			await integrateSlice(deps, slice, ctx)
			const merge = calls.find((c) => c.method === 'mergeNoFf')!
			expect(merge.args[1]).toEqual({ noVerify: true })
		})
	})
}
