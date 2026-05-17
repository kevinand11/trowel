import type { DeleteBranchPolicy, Storage } from '../storages/types.ts'
import type { GhOps } from '../utils/gh-ops.ts'
import type { GitOps } from '../utils/git-ops.ts'
import { withMutationLock } from '../utils/mutation-lock.ts'

/**
 * Unified terminal step that ships a closeable PRD or Fix. See ADR
 * `2026-05-17-fix-entity-unified-close-out.md`. Branches on `config.work.usePrs`:
 *
 * - `usePrs: true` — opens a PR from the entity branch against `baseBranch` (if one doesn't
 *   already exist), then marks it ready. Entity stays OPEN; **Reconciliation** flips OPEN →
 *   CLOSED when GitHub reports the PR merged.
 * - `usePrs: false` — host-merges the entity branch into `baseBranch` via `git merge --no-ff`,
 *   then writes CLOSED on the storage record immediately.
 *
 * Branch deletion under `usePrs: false` is gated by `config.close.deleteBranch`. The `'prompt'`
 * policy coerces to `'never'` in this auto context (runLoop is non-interactive).
 */
export type CloseOutEntity = {
	kind: 'prd' | 'fix'
	id: string
	branch: string
	title: string
}

export type CloseOutConfig = {
	usePrs: boolean
	deleteBranch: DeleteBranchPolicy
	mergeNoVerify: boolean
}

export type CloseOutDeps = {
	storage: Storage
	git: GitOps
	gh: GhOps
	log: (msg: string) => void
	config: CloseOutConfig
	projectRoot?: string
}

export async function runCloseOut(entity: CloseOutEntity, deps: CloseOutDeps): Promise<void> {
	const tag = `[close-out ${entity.kind}-${entity.id}]`
	const baseBranch = await deps.git.baseBranch()

	if (deps.config.usePrs) {
		return withLock(deps, async () => {
			const existing = await deps.gh.findAnyPrByHead(entity.branch).catch(() => null)
			let prNumber: number
			if (!existing) {
				await deps.gh.createDraftPr({
					title: entity.title,
					head: entity.branch,
					base: baseBranch,
					body: bodyFor(entity),
				})
				prNumber = await deps.gh.findPrNumberByHead(entity.branch)
				deps.log(`${tag} opened PR #${prNumber} ${entity.branch} → ${baseBranch}`)
			} else {
				prNumber = existing.number
				if (existing.state !== 'OPEN') {
					deps.log(`${tag} PR #${prNumber} state ${existing.state}; nothing to mark ready`)
					return
				}
			}
			await deps.gh.markPrReady(prNumber).catch((e: Error) => {
				deps.log(`${tag} markPrReady #${prNumber} failed (already ready or no permission): ${e.message}`)
			})
			deps.log(`${tag} marked PR #${prNumber} ready; awaiting merge`)
		})
	}

	return withLock(deps, async () => {
		const current = await deps.git.currentBranch()
		await deps.git.checkout(baseBranch)
		try {
			await deps.git.mergeNoFf(entity.branch, { noVerify: deps.config.mergeNoVerify })
		} catch (e) {
			await deps.git.mergeAbort()
			if (current !== baseBranch && (await deps.git.branchExists(current))) {
				await deps.git.checkout(current)
			}
			throw e
		}
		await deps.git.push(baseBranch)
		deps.log(`${tag} host-merged ${entity.branch} into ${baseBranch}`)

		if (entity.kind === 'prd') await deps.storage.closePrd(entity.id)
		else await deps.storage.closeFix(entity.id)
		deps.log(`${tag} marked CLOSED`)

		const policy = autoDeletePolicy(deps.config.deleteBranch)
		if (policy === 'always') {
			await deps.git.deleteBranch(entity.branch)
			deps.log(`${tag} deleted ${entity.branch}`)
		}
	})
}

function bodyFor(entity: CloseOutEntity): string {
	return entity.kind === 'fix' ? `Closes #${entity.id}` : `Closes PRD ${entity.id}`
}

/**
 * The 'prompt' policy is interactive — runLoop runs unattended, so we coerce it to 'never' here.
 * Manual `trowel close <kind> <id>` retains the full prompt behaviour.
 */
function autoDeletePolicy(p: DeleteBranchPolicy): DeleteBranchPolicy {
	return p === 'prompt' ? 'never' : p
}

function withLock<T>(deps: CloseOutDeps, fn: () => Promise<T>): Promise<T> {
	if (!deps.projectRoot) return fn()
	return withMutationLock(deps.projectRoot, fn)
}

if (import.meta.vitest) {
	const { describe, test, expect } = import.meta.vitest
	const { recordingGhOps } = await import('../test-utils/gh-ops-recorder.ts')

	function fakeStorage(overrides: Partial<Storage> = {}): { storage: Storage; closed: { prd: string[]; fix: string[] } } {
		const closed = { prd: [] as string[], fix: [] as string[] }
		const storage: Storage = {
			createPrd: async () => ({ id: 'x', branch: 'x' }),
			findPrd: async () => null,
			listPrds: async () => [],
			closePrd: async (id) => { closed.prd.push(id) },
			createSlice: async () => { throw new Error('nyi') },
			findSlices: async () => [],
			findSlice: async () => null,
			updateSlice: async () => {},
			createFix: async () => ({ id: 'x', branch: 'x' }),
			findFix: async () => null,
			listFixes: async () => [],
			updateFix: async () => {},
			closeFix: async (id) => { closed.fix.push(id) },
			...overrides,
		}
		return { storage, closed }
	}

	function fakeGit(): { git: GitOps; calls: string[] } {
		const calls: string[] = []
		const git: GitOps = {
			currentBranch: async () => 'work',
			baseBranch: async () => 'main',
			branchExists: async () => true,
			isMerged: async () => false,
			checkout: async (b) => { calls.push(`checkout(${b})`) },
			deleteBranch: async (b) => { calls.push(`deleteBranch(${b})`) },
			deleteRemoteBranch: async () => {},
			fetch: async () => {},
			push: async (b) => { calls.push(`push(${b})`) },
			mergeNoFf: async (b) => { calls.push(`mergeNoFf(${b})`) },
			mergeAbort: async () => { calls.push('mergeAbort') },
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
		return { git, calls }
	}

	describe('runCloseOut', () => {
		test('Fix + usePrs:false: host-merges to base, marks Fix CLOSED, deletes branch on always', async () => {
			const { storage, closed } = fakeStorage()
			const { git, calls } = fakeGit()
			const { gh } = recordingGhOps()
			await runCloseOut(
				{ kind: 'fix', id: '5', branch: 'fix/5-x', title: 'X' },
				{ storage, git, gh, log: () => {}, config: { usePrs: false, deleteBranch: 'always', mergeNoVerify: false } },
			)
			expect(calls).toEqual(['checkout(main)', 'mergeNoFf(fix/5-x)', 'push(main)', 'deleteBranch(fix/5-x)'])
			expect(closed.fix).toEqual(['5'])
		})

		test('PRD + usePrs:false: host-merges integration to base, marks PRD CLOSED, retains branch on never', async () => {
			const { storage, closed } = fakeStorage()
			const { git, calls } = fakeGit()
			const { gh } = recordingGhOps()
			await runCloseOut(
				{ kind: 'prd', id: '3', branch: '3-feat', title: 'Feat' },
				{ storage, git, gh, log: () => {}, config: { usePrs: false, deleteBranch: 'never', mergeNoVerify: false } },
			)
			expect(calls.find((c) => c.startsWith('deleteBranch'))).toBeUndefined()
			expect(closed.prd).toEqual(['3'])
		})

		test('prompt policy is coerced to never in auto Close-out', async () => {
			const { storage } = fakeStorage()
			const { git, calls } = fakeGit()
			const { gh } = recordingGhOps()
			await runCloseOut(
				{ kind: 'fix', id: '5', branch: 'fix/5-x', title: 'X' },
				{ storage, git, gh, log: () => {}, config: { usePrs: false, deleteBranch: 'prompt', mergeNoVerify: false } },
			)
			expect(calls.find((c) => c.startsWith('deleteBranch'))).toBeUndefined()
		})

		test('Fix + usePrs:true, PR exists open: marks ready, does not create', async () => {
			const { storage, closed } = fakeStorage()
			const { git } = fakeGit()
			const { gh, calls } = recordingGhOps({
				findAnyPrByHead: async () => ({ number: 11, state: 'OPEN' }),
			})
			await runCloseOut(
				{ kind: 'fix', id: '5', branch: 'fix/5-x', title: 'X' },
				{ storage, git, gh, log: () => {}, config: { usePrs: true, deleteBranch: 'always', mergeNoVerify: false } },
			)
			expect(calls.find((c) => c[0] === 'createDraftPr')).toBeUndefined()
			expect(calls).toContainEqual(['markPrReady', 11])
			expect(closed.fix).toEqual([])
		})

		test('PRD + usePrs:true, PR does not exist: creates draft then marks ready', async () => {
			const { storage } = fakeStorage()
			const { git } = fakeGit()
			const { gh, calls } = recordingGhOps({
				findAnyPrByHead: async () => null,
				findPrNumberByHead: async () => 22,
			})
			await runCloseOut(
				{ kind: 'prd', id: '3', branch: '3-feat', title: 'Feat' },
				{ storage, git, gh, log: () => {}, config: { usePrs: true, deleteBranch: 'never', mergeNoVerify: false } },
			)
			expect(calls.find((c) => c[0] === 'createDraftPr')).toBeDefined()
			expect(calls).toContainEqual(['markPrReady', 22])
		})

		test('Fix + usePrs:true, PR already merged: no-op (reconciliation owns CLOSED)', async () => {
			const { storage, closed } = fakeStorage()
			const { git } = fakeGit()
			const { gh, calls } = recordingGhOps({
				findAnyPrByHead: async () => ({ number: 11, state: 'MERGED' }),
			})
			await runCloseOut(
				{ kind: 'fix', id: '5', branch: 'fix/5-x', title: 'X' },
				{ storage, git, gh, log: () => {}, config: { usePrs: true, deleteBranch: 'always', mergeNoVerify: false } },
			)
			expect(calls.find((c) => c[0] === 'markPrReady')).toBeUndefined()
			expect(closed.fix).toEqual([])
		})
	})
}
