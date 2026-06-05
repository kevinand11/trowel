import { MERGE_CHANGE_WORKTREE, mergeBranchIntoDestinationWithWorktree } from './merge-worktree.ts'
import type { DeleteBranchPolicy, Storage } from '../storages/types.ts'
import type { GhOps } from '../utils/gh-ops.ts'
import type { GitOps } from '../utils/git-ops.ts'

/**
 * Terminal step that ships a closeable Change. Branches on `config.ship.pr`:
 *
 * - `pr: true` — opens a PR from the entity branch against the entity's targetBranch (if one
 *   doesn't already exist), then marks it ready. The Change remains unfinalized until Ship later
 *   observes the merged PR as a landed state and runs Finalization.
 * - `pr: false` — host-merges the entity branch into the entity's targetBranch from a
 *   reserved detached merge worktree when projectRoot is available, then runs Finalization
 *   immediately.
 *
 * Branch deletion under `pr: false` is gated by `config.abort.deleteBranch`. The `'prompt'`
 * policy coerces to `'never'` in this auto context (runLoop is non-interactive).
 */
export type CloseOutEntity = {
	kind: 'change'
	id: string
	changeBranch: string
	targetBranch: string
	title: string
}

export type CloseOutConfig = {
	pr: boolean
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
	const targetBranch = entity.targetBranch
	return deps.config.pr ? closeOutViaPr(entity, deps, targetBranch, tag) : closeOutViaMerge(entity, deps, targetBranch, tag)
}

async function closeOutViaPr(entity: CloseOutEntity, deps: CloseOutDeps, targetBranch: string, tag: string): Promise<void> {
	const prNumber = await ensureCloseOutPr(entity, deps, targetBranch, tag)
	if (prNumber === null) return
	await markCloseOutPrReady(prNumber, deps, tag)
	deps.log(`${tag} marked PR #${prNumber} ready; awaiting merge`)
}

async function ensureCloseOutPr(entity: CloseOutEntity, deps: CloseOutDeps, targetBranch: string, tag: string): Promise<number | null> {
	const existing = await deps.gh.findAnyPrByHead(entity.changeBranch).catch(() => null)
	if (!existing) return createCloseOutPr(entity, deps, targetBranch, tag)
	if (existing.state !== 'OPEN') {
		deps.log(`${tag} PR #${existing.number} state ${existing.state}; nothing to mark ready`)
		return null
	}
	return existing.number
}

async function createCloseOutPr(entity: CloseOutEntity, deps: CloseOutDeps, targetBranch: string, tag: string): Promise<number> {
	const pr = await deps.gh.createDraftPr({ title: entity.title, head: entity.changeBranch, base: targetBranch, body: bodyFor(entity) })
	deps.log(`${tag} opened PR #${pr.number} ${entity.changeBranch} → ${targetBranch}`)
	return pr.number
}

async function markCloseOutPrReady(prNumber: number, deps: CloseOutDeps, tag: string): Promise<void> {
	await deps.gh.markPrReady(prNumber).catch((e: Error) => {
		deps.log(`${tag} markPrReady #${prNumber} failed (already ready or no permission): ${e.message}`)
	})
}

async function closeOutViaMerge(entity: CloseOutEntity, deps: CloseOutDeps, targetBranch: string, tag: string): Promise<void> {
	await mergeCloseOutBranch(entity, deps, targetBranch)
	deps.log(`${tag} host-merged ${entity.changeBranch} into ${targetBranch}`)
	await finalizeEntity(entity, deps)
	deps.log(`${tag} finalized Change`)
	await deleteAutoBranchIfAllowed(entity, deps, tag)
}

async function mergeCloseOutBranch(entity: CloseOutEntity, deps: CloseOutDeps, targetBranch: string): Promise<void> {
	if (deps.projectRoot) {
		await mergeBranchIntoDestinationWithWorktree({
			projectRoot: deps.projectRoot,
			changeId: entity.id,
			reservation: MERGE_CHANGE_WORKTREE,
			destinationBranch: targetBranch,
			sourceBranch: entity.changeBranch,
			git: deps.git,
			mergeNoVerify: deps.config.mergeNoVerify,
			log: deps.log,
		})
		return
	}
	await legacyMergeCloseOutBranch(entity, deps, targetBranch)
}

async function legacyMergeCloseOutBranch(entity: CloseOutEntity, deps: CloseOutDeps, targetBranch: string): Promise<void> {
	const current = await deps.git.currentBranch()
	await deps.git.checkout(targetBranch)
	try {
		await deps.git.mergeNoFf(entity.changeBranch, { noVerify: deps.config.mergeNoVerify })
	} catch (e) {
		await deps.git.mergeAbort()
		await restoreAfterFailedCloseOutMerge(current, targetBranch, deps)
		throw e
	}
	await deps.git.push(targetBranch)
}

async function restoreAfterFailedCloseOutMerge(current: string, targetBranch: string, deps: CloseOutDeps): Promise<void> {
	if (current !== targetBranch && (await deps.git.branchExists(current))) await deps.git.checkout(current)
}

async function finalizeEntity(entity: CloseOutEntity, deps: CloseOutDeps): Promise<void> {
	await deps.storage.finalizeChange(entity.id)
}

async function deleteAutoBranchIfAllowed(entity: CloseOutEntity, deps: CloseOutDeps, tag: string): Promise<void> {
	if (autoDeletePolicy(deps.config.deleteBranch) !== 'always') return
	await deps.git.deleteBranch(entity.changeBranch)
	deps.log(`${tag} deleted ${entity.changeBranch}`)
}

function bodyFor(entity: CloseOutEntity): string {
	return `Closes Change ${entity.id}`
}

/**
 * The 'prompt' policy is interactive — runLoop runs unattended, so we coerce it to 'never' here.
 * Manual `trowel change abort <id>` retains full prompt behaviour.
 */
function autoDeletePolicy(p: DeleteBranchPolicy): DeleteBranchPolicy {
	return p === 'prompt' ? 'never' : p
}

if (import.meta.vitest) {
	const { describe, test, expect } = import.meta.vitest
	const { recordingGhOps } = await import('../test-utils/gh-ops-recorder.ts')
	const { noopGitOps } = await import('../test-utils/git-ops-fixtures.ts')

	function fakeStorage(overrides: Partial<Storage> = {}): { storage: Storage; closed: { change: string[] } } {
		const closed = { change: [] as string[] }
		const storage: Storage = {
			createChange: async () => ({ id: 'x', title: 'x' }),
			findChange: async () => null,
			listChanges: async () => [],
			finalizeChange: async (id) => {
				closed.change.push(id)
			},
			abortChange: async () => {},
			updateChangeMetadata: async () => {},
			createSlice: async () => {
				throw new Error('nyi')
			},
			findSlices: async () => [],
			setSliceReadyForAgent: async () => {},
			setSliceBlockers: async () => {},
			markSliceImplemented: async () => {},
			markSliceAudited: async () => {},
			finalizeSlice: async () => {},
			abortSlice: async () => {},
			updateSliceMetadata: async () => {},
			...overrides,
		}
		return { storage, closed }
	}

	function fakeGit(): { git: GitOps; calls: string[] } {
		const calls: string[] = []
		const git = noopGitOps({
			currentBranch: async () => 'work',
			baseBranch: async () => 'main',
			checkout: async (b) => {
				calls.push(`checkout(${b})`)
			},
			deleteBranch: async (b) => {
				calls.push(`deleteBranch(${b})`)
			},
			push: async (b) => {
				calls.push(`push(${b})`)
			},
			mergeNoFf: async (b) => {
				calls.push(`mergeNoFf(${b})`)
			},
			mergeAbort: async () => {
				calls.push('mergeAbort')
			},
		})
		return { git, calls }
	}

	describe('runCloseOut', () => {
		test('Change + pr:false: host-merges Change branch to targetBranch, finalizes the Change, retains branch on never', async () => {
			const { storage, closed } = fakeStorage()
			const { git, calls } = fakeGit()
			const { gh } = recordingGhOps()
			await runCloseOut(
				{ kind: 'change', id: '3', changeBranch: '3-feat', targetBranch: 'release/1.2', title: 'Feat' },
				{ storage, git, gh, log: () => {}, config: { pr: false, deleteBranch: 'never', mergeNoVerify: false } },
			)
			expect(calls).toContain('checkout(release/1.2)')
			expect(calls).toContain('push(release/1.2)')
			expect(calls.find((c) => c.startsWith('deleteBranch'))).toBeUndefined()
			expect(closed.change).toEqual(['3'])
		})

		test('prompt policy is coerced to never in auto Close-out', async () => {
			const { storage } = fakeStorage()
			const { git, calls } = fakeGit()
			const { gh } = recordingGhOps()
			await runCloseOut(
				{ kind: 'change', id: '5', changeBranch: 'change/5-x', targetBranch: 'main', title: 'X' },
				{ storage, git, gh, log: () => {}, config: { pr: false, deleteBranch: 'prompt', mergeNoVerify: false } },
			)
			expect(calls.find((c) => c.startsWith('deleteBranch'))).toBeUndefined()
		})

		test('Change + pr:true, PR does not exist: creates draft against targetBranch then marks ready', async () => {
			const { storage } = fakeStorage()
			const { git } = fakeGit()
			const { gh, calls } = recordingGhOps({
				findAnyPrByHead: async () => null,
				createDraftPr: async ({ head }) => ({ number: 22, headRefName: head, isDraft: true, url: '#22' }),
			})
			await runCloseOut(
				{ kind: 'change', id: '3', changeBranch: '3-feat', targetBranch: 'release/1.2', title: 'Feat' },
				{ storage, git, gh, log: () => {}, config: { pr: true, deleteBranch: 'never', mergeNoVerify: false } },
			)
			expect(calls.find((c) => c[0] === 'createDraftPr')).toEqual([
				'createDraftPr',
				{
					title: 'Feat',
					head: '3-feat',
					base: 'release/1.2',
					body: 'Closes Change 3',
				},
			])
			expect(calls).toContainEqual(['markPrReady', 22])
		})
	})
}
