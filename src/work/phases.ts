import { fetchPrFeedback, findPrNumber, markPrReady, openDraftPr } from './pr-flow.ts'
import type { SandboxIn, SandboxOut } from './verdict.ts'
import type { PhaseCtx, PhaseOutcome, PreparedPhase, Slice, Storage } from '../storages/types.ts'
import type { GhRunner } from '../utils/gh-runner.ts'
import type { GitOps } from '../utils/git-ops.ts'
import { slug as slugify } from '../utils/slug.ts'

/**
 * Dependency bag for the loop-level phase primitives. The loop builds this once per run from
 * its own `LoopDeps`; per-phase commands (`trowel implement`, etc.) build it ad-hoc.
 *
 * See ADR `storage-behavior-separation`: phase logic lives in the loop, not on `Storage`.
 * Storage exposes CRUD + capabilities; the phase functions branch on
 * `deps.storage.capabilities.prFlow` to pick file-shape vs issue-shape behavior.
 */
export type PhaseDeps = {
	storage: Storage
	git: GitOps
	gh: GhRunner
	log: (msg: string) => void
}

function sliceBranchFor(prdId: string, slice: Slice): string {
	return `prd-${prdId}/slice-${slice.id}-${slugify(slice.title)}`
}

function requirePrFlow(storage: Storage, role: 'review' | 'address'): void {
	if (!storage.capabilities.prFlow) {
		throw new Error(`${role} requires capability 'prFlow'; storage '${storage.name}' does not declare it`)
	}
}

async function ghOrThrow(gh: GhRunner, args: string[]): Promise<string> {
	const r = await gh(args)
	if (!r.ok) throw r.error
	return r.stdout
}

/**
 * Prepare the implementer sandbox.
 *
 * - `prFlow: false` (file shape): implementer runs on the integration branch directly — no per-slice
 *   branch (commits land in-place via push at land time).
 * - `prFlow: true` (issue shape): create a per-slice remote branch from the integration branch and
 *   fetch it so the worktree can check it out.
 */
export async function prepareImplement(deps: PhaseDeps, slice: Slice, ctx: PhaseCtx): Promise<PreparedPhase> {
	if (!deps.storage.capabilities.prFlow) {
		return {
			branch: ctx.integrationBranch,
			sandboxIn: { slice: { id: slice.id, title: slice.title, body: slice.body } },
		}
	}
	const branch = sliceBranchFor(ctx.prdId, slice)
	await deps.git.createRemoteBranch(branch, ctx.integrationBranch)
	await deps.git.fetch(branch)
	return {
		branch,
		sandboxIn: { slice: { id: slice.id, title: slice.title, body: slice.body } },
	}
}

/**
 * Apply the implementer's verdict.
 *
 * Verdict dispatch (both shapes):
 * - `partial` → return `'partial'`, no side effects.
 * - `no-work-needed` → clear `readyForAgent` via storage, return `'no-work'`.
 *
 * `ready` handling diverges:
 * - `prFlow: false`: push the integration branch, close the slice in storage, return `'done'`.
 * - `prFlow: true` + `usePrs: true`: push the slice branch, open a draft PR, return `'progress'`.
 *   The next loop iteration's `findSlices` will see the PR and dispatch the reviewer.
 * - `prFlow: true` + `usePrs: false`: push the slice branch, host-side merge `--no-ff` into the
 *   integration branch, push and delete the slice branch, close the sub-issue, return `'done'`.
 */
export async function landImplement(deps: PhaseDeps, slice: Slice, verdict: SandboxOut, ctx: PhaseCtx): Promise<PhaseOutcome> {
	const tag = `[work prd-${ctx.prdId} slice-${slice.id}]`
	if (verdict.verdict === 'partial') return 'partial'
	if (verdict.verdict === 'no-work-needed') {
		await deps.storage.updateSlice(ctx.prdId, slice.id, { readyForAgent: false })
		deps.log(`${tag} no-work-needed: cleared readyForAgent`)
		return 'no-work'
	}
	if (verdict.verdict !== 'ready') return 'partial'

	if (!deps.storage.capabilities.prFlow) {
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
		await openDraftPr(deps.gh, slice, branch, ctx.integrationBranch)
		deps.log(`${tag} opened draft PR for ${branch}`)
		return 'progress'
	}

	// usePrs: false → host-side merge-and-close.
	await deps.git.checkout(ctx.integrationBranch)
	await deps.git.mergeNoFf(branch)
	await deps.git.push(ctx.integrationBranch)
	await deps.git.deleteRemoteBranch(branch)
	deps.log(`${tag} merged ${branch} into ${ctx.integrationBranch}; deleted slice branch`)
	await ghOrThrow(deps.gh, ['issue', 'close', slice.id])
	deps.log(`${tag} closed sub-issue #${slice.id}`)
	return 'done'
}

/**
 * Prepare the reviewer sandbox. Requires `prFlow`: classify never returns 'review' for a
 * file-shape slice (`prState` is always `null`), but per-phase commands (`trowel review`) bypass
 * the classifier and surface this throw.
 *
 * Looks up the slice branch's PR number so the reviewer prompt has `{pr.number, pr.branch}` to
 * fetch the diff and post comments against.
 */
export async function prepareReview(deps: PhaseDeps, slice: Slice, ctx: PhaseCtx): Promise<PreparedPhase> {
	requirePrFlow(deps.storage, 'review')
	const branch = sliceBranchFor(ctx.prdId, slice)
	const prNumber = await findPrNumber(deps.gh, branch)
	const sandboxIn: SandboxIn = {
		slice: { id: slice.id, title: slice.title, body: slice.body },
		pr: { number: prNumber, branch },
	}
	return { branch, sandboxIn }
}

/**
 * Apply the reviewer's verdict. Requires `prFlow`.
 *
 * - `ready` → push review commits (if any), then `gh pr ready` to flip the PR out of draft. The
 *   slice's `prState` becomes 'ready' on next `findSlices`; classify routes to 'done'. Returns
 *   `'progress'` so the inner step-cap loop refetches.
 * - `needs-revision` → push review commits, flip `needsRevision: true` via storage. Next iteration
 *   classifies to 'address'. Returns `'progress'`.
 * - `partial` → return `'partial'`, no side effects.
 */
export async function landReview(deps: PhaseDeps, slice: Slice, verdict: SandboxOut, ctx: PhaseCtx): Promise<PhaseOutcome> {
	requirePrFlow(deps.storage, 'review')
	const tag = `[work prd-${ctx.prdId} slice-${slice.id}]`
	if (verdict.verdict === 'partial') return 'partial'
	const branch = sliceBranchFor(ctx.prdId, slice)

	if (verdict.verdict === 'ready') {
		if (verdict.commits > 0) {
			await deps.git.push(branch)
			deps.log(`${tag} pushed ${branch}`)
		}
		const prNumber = await findPrNumber(deps.gh, branch)
		await markPrReady(deps.gh, prNumber)
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
 * Prepare the addresser sandbox. Requires `prFlow`.
 *
 * Same PR-discovery as the reviewer plus a `fetchPrFeedback` call so the addresser prompt has the
 * reviewer's comments in `sandboxIn.feedback`.
 */
export async function prepareAddress(deps: PhaseDeps, slice: Slice, ctx: PhaseCtx): Promise<PreparedPhase> {
	requirePrFlow(deps.storage, 'address')
	const branch = sliceBranchFor(ctx.prdId, slice)
	const prNumber = await findPrNumber(deps.gh, branch)
	const feedback = await fetchPrFeedback(deps.gh, prNumber)
	const sandboxIn: SandboxIn = {
		slice: { id: slice.id, title: slice.title, body: slice.body },
		pr: { number: prNumber, branch },
		feedback,
	}
	return { branch, sandboxIn }
}

/**
 * Apply the addresser's verdict. Requires `prFlow`.
 *
 * - `ready` → push fixup commits (if any), clear `needsRevision` via storage. The next iteration
 *   classifies back to 'review' (draft PR still open). Returns `'progress'`.
 * - `no-work-needed` → clear `needsRevision` without pushing. Returns `'no-work'`; loop drops the
 *   slice for this run.
 * - `partial` → return `'partial'`, no side effects.
 */
export async function landAddress(deps: PhaseDeps, slice: Slice, verdict: SandboxOut, ctx: PhaseCtx): Promise<PhaseOutcome> {
	requirePrFlow(deps.storage, 'address')
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
