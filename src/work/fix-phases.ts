import { runCloseOut } from './close-out.ts'
import { fetchPrFeedback } from './pr-flow.ts'
import type { TurnIn, TurnOut } from './verdict.ts'
import type { Role } from '../prompts/load.ts'
import type { DeleteBranchPolicy, FixRecord, Storage } from '../storages/types.ts'
import type { GhOps } from '../utils/gh-ops.ts'
import type { GitOps } from '../utils/git-ops.ts'
import { withMutationLock } from '../utils/mutation-lock.ts'

/**
 * Phase machinery for **Fixes** — the slice-without-PRD entity introduced in ADR
 * `2026-05-17-fix-entity-unified-close-out.md`. Mirrors the slice phases in `phases.ts` with two
 * differences: the working branch is `fix/<id>-<slug>` (no Integration branch, based on the Fix's
 * targetBranch), and the implementer's `ready` verdict routes through Close-out (Fix has no slice
 * → integration step).
 */

export type FixPhaseConfig = {
	usePrs: boolean
	review: boolean
	mergeNoVerify: boolean
	deleteBranch: DeleteBranchPolicy
}

export type FixPhaseDeps = {
	storage: Storage
	git: GitOps
	gh: GhOps
	log: (msg: string) => void
	config: FixPhaseConfig
	projectRoot?: string
}

export type FixResume = 'done' | 'implement' | 'review' | 'address'

export function classifyFix(fix: FixRecord, config: { usePrs: boolean; review: boolean }): FixResume {
	if (fix.state === 'CLOSED') return 'done'
	if (config.usePrs && config.review) {
		if (fix.needsRevision) return 'address'
		if (fix.prState === 'draft' && fix.readyForAgent) return 'review'
	}
	if (fix.readyForAgent) return 'implement'
	return 'done'
}

function withLock<T>(deps: FixPhaseDeps, fn: () => Promise<T>): Promise<T> {
	if (!deps.projectRoot) return fn()
	return withMutationLock(deps.projectRoot, fn)
}

export async function prepareFixImplement(_deps: FixPhaseDeps, fix: FixRecord): Promise<{ branch: string; turnIn: TurnIn }> {
	// The fix branch is created at `createFix` time; nothing to do here beyond emitting it.
	return {
		branch: fix.branch,
		turnIn: { slice: { id: fix.id, title: fix.title, body: fix.body } },
	}
}

export async function prepareFixReview(deps: FixPhaseDeps, fix: FixRecord): Promise<{ branch: string; turnIn: TurnIn }> {
	const prNumber = await deps.gh.findPrNumberByHead(fix.branch)
	return {
		branch: fix.branch,
		turnIn: { slice: { id: fix.id, title: fix.title, body: fix.body }, pr: { number: prNumber, branch: fix.branch } },
	}
}

export async function prepareFixAddress(deps: FixPhaseDeps, fix: FixRecord): Promise<{ branch: string; turnIn: TurnIn }> {
	const prNumber = await deps.gh.findPrNumberByHead(fix.branch)
	const feedback = await fetchPrFeedback(deps.gh, prNumber)
	return {
		branch: fix.branch,
		turnIn: { slice: { id: fix.id, title: fix.title, body: fix.body }, pr: { number: prNumber, branch: fix.branch }, feedback },
	}
}

export type FixOutcome = 'done' | 'progress' | 'partial' | 'no-work'

export async function landFixImplement(deps: FixPhaseDeps, fix: FixRecord, verdict: TurnOut): Promise<FixOutcome> {
	const tag = `[work fix-${fix.id}]`
	if (verdict.verdict === 'partial') return 'partial'
	if (verdict.verdict === 'no-work-needed') {
		return withLock(deps, async () => {
			const targetBranch = await targetBranchForFix(deps, fix)
			const ahead = await deps.git.commitsAhead(fix.branch, targetBranch)
			if (ahead > 0) {
				deps.log(`${tag} no-work-needed but fix branch has ${ahead} unmerged commit(s); treating as ready`)
				await deps.git.push(fix.branch)
				await runCloseOut(
					{ kind: 'fix', id: fix.id, branch: fix.branch, targetBranch, title: fix.title },
					{
						storage: deps.storage,
						git: deps.git,
						gh: deps.gh,
						log: deps.log,
						config: { usePrs: deps.config.usePrs, deleteBranch: deps.config.deleteBranch, mergeNoVerify: deps.config.mergeNoVerify },
						projectRoot: deps.projectRoot,
					},
				)
				return 'done'
			}
			await deps.storage.updateFix(fix.id, { readyForAgent: false })
			deps.log(`${tag} no-work-needed: cleared readyForAgent`)
			return 'no-work'
		})
	}
	if (verdict.verdict !== 'ready') return 'partial'

	return withLock(deps, async () => {
		await deps.git.push(fix.branch)
		deps.log(`${tag} pushed ${fix.branch}`)

		if (deps.config.usePrs) {
			// Open the draft PR; Close-out (further down the loop) will mark it ready once the loop
			// converges. Under `review: true` the reviewer/addresser phases run first.
			await deps.gh.createDraftPr({
				title: fix.title,
				head: fix.branch,
				base: await targetBranchForFix(deps, fix),
				body: `Closes #${fix.id}`,
			})
			deps.log(`${tag} opened draft PR for ${fix.branch}`)
			return 'progress'
		}

		// usePrs: false — Close-out host-merges fix → targetBranch and writes Fix CLOSED.
		await runCloseOut(
			{ kind: 'fix', id: fix.id, branch: fix.branch, targetBranch: await targetBranchForFix(deps, fix), title: fix.title },
			{
				storage: deps.storage,
				git: deps.git,
				gh: deps.gh,
				log: deps.log,
				config: { usePrs: false, deleteBranch: deps.config.deleteBranch, mergeNoVerify: deps.config.mergeNoVerify },
				projectRoot: deps.projectRoot,
			},
		)
		return 'done'
	})
}

export async function landFixReview(deps: FixPhaseDeps, fix: FixRecord, verdict: TurnOut): Promise<FixOutcome> {
	const tag = `[work fix-${fix.id}]`
	if (verdict.verdict === 'partial') return 'partial'

	return withLock(deps, async () => {
		if (verdict.verdict === 'ready') {
			if (verdict.commits > 0) {
				await deps.git.push(fix.branch)
				deps.log(`${tag} pushed ${fix.branch}`)
			}
			const prNumber = await deps.gh.findPrNumberByHead(fix.branch)
			await deps.gh.markPrReady(prNumber)
			deps.log(`${tag} marked PR #${prNumber} ready for merge`)
			return 'progress'
		}
		if (verdict.verdict === 'needs-revision') {
			if (verdict.commits > 0) {
				await deps.git.push(fix.branch)
				deps.log(`${tag} pushed ${fix.branch}`)
			}
			await deps.storage.updateFix(fix.id, { needsRevision: true })
			deps.log(`${tag} flagged needsRevision`)
			return 'progress'
		}
		return 'partial'
	})
}

export async function landFixAddress(deps: FixPhaseDeps, fix: FixRecord, verdict: TurnOut): Promise<FixOutcome> {
	const tag = `[work fix-${fix.id}]`
	if (verdict.verdict === 'partial') return 'partial'

	return withLock(deps, async () => {
		if (verdict.verdict === 'ready') {
			if (verdict.commits > 0) {
				await deps.git.push(fix.branch)
				deps.log(`${tag} pushed ${fix.branch}`)
			}
			await deps.storage.updateFix(fix.id, { needsRevision: false })
			deps.log(`${tag} cleared needsRevision`)
			return 'progress'
		}
		if (verdict.verdict === 'no-work-needed') {
			await deps.storage.updateFix(fix.id, { needsRevision: false })
			deps.log(`${tag} no-work-needed: cleared needsRevision`)
			return 'no-work'
		}
		return 'partial'
	})
}

async function targetBranchForFix(deps: FixPhaseDeps, fix: FixRecord): Promise<string> {
	return fix.targetBranch ?? await deps.git.baseBranch()
}

export function callFixPrepare(role: Role, deps: FixPhaseDeps, fix: FixRecord): Promise<{ branch: string; turnIn: TurnIn }> {
	if (role === 'implement') return prepareFixImplement(deps, fix)
	if (role === 'review') return prepareFixReview(deps, fix)
	return prepareFixAddress(deps, fix)
}

export function callFixLand(role: Role, deps: FixPhaseDeps, fix: FixRecord, verdict: TurnOut): Promise<FixOutcome> {
	if (role === 'implement') return landFixImplement(deps, fix, verdict)
	if (role === 'review') return landFixReview(deps, fix, verdict)
	return landFixAddress(deps, fix, verdict)
}

if (import.meta.vitest) {
	const { describe, test, expect } = import.meta.vitest
	const { recordingGhOps } = await import('../test-utils/gh-ops-recorder.ts')

	function fakeStorage(): Storage {
		return {
			createPrd: async () => ({ id: 'p', branch: 'p' }),
			findPrd: async () => null,
			listPrds: async () => [],
			closePrd: async () => {},
			createSlice: async () => { throw new Error('not used') },
			findSlices: async () => [],
			findSlice: async () => null,
			updateSlice: async () => {},
			createFix: async () => ({ id: 'f', branch: 'f' }),
			findFix: async () => null,
			listFixes: async () => [],
			updateFix: async () => {},
			closeFix: async () => {},
		}
	}

	function fakeGit(): GitOps {
		return {
			currentBranch: async () => 'work',
			baseBranch: async () => { throw new Error('baseBranch should not be used when Fix has targetBranch') },
			branchExists: async () => true,
			isMerged: async () => false,
			checkout: async () => {},
			deleteBranch: async () => {},
			deleteRemoteBranch: async () => {},
			fetch: async () => {},
			push: async () => {},
			mergeNoFf: async () => {},
			mergeAbort: async () => {},
			createRemoteBranch: async () => {},
			createLocalBranch: async () => {},
			pushSetUpstream: async () => {},
			worktreeAdd: async () => {},
			worktreeRemove: async () => {},
			worktreeList: async () => [],
			restoreAll: async () => {},
			cleanUntracked: async () => {},
			isWorkingTreeClean: async () => true,
			stashPush: async () => {},
			stashPop: async () => {},
			commitsAhead: async () => 0,
			detectVersion: async () => ({ installed: true, version: '0.0.0' }),
		}
	}

	describe('landFixImplement', () => {
		test('opens draft PRs against the Fix targetBranch', async () => {
			const { gh, calls } = recordingGhOps()
			const deps: FixPhaseDeps = {
				storage: fakeStorage(),
				git: fakeGit(),
				gh,
				log: () => {},
				config: { usePrs: true, review: false, mergeNoVerify: false, deleteBranch: 'never' },
			}
			const fix: FixRecord = {
				id: '5',
				branch: 'fix/5-x',
				targetBranch: 'hotfix/base',
				title: 'X',
				body: 'body',
				state: 'OPEN',
				readyForAgent: true,
				needsRevision: false,
				blockedBy: [],
				prState: null,
			}

			await expect(landFixImplement(deps, fix, { verdict: 'ready', commits: 1 })).resolves.toBe('progress')

			expect(calls).toContainEqual(['createDraftPr', {
				title: 'X',
				head: 'fix/5-x',
				base: 'hotfix/base',
				body: 'Closes #5',
			}])
		})
	})
}
