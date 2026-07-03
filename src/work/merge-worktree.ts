import { mkdir, realpath } from 'node:fs/promises'
import path from 'node:path'

import { requireMergeConflictPreflight, type ConfirmMergeConflict } from './merge-conflict-preflight.ts'
import { pathExists } from '../utils/fs.ts'
import type { GitOps } from '../utils/git-ops.ts'

export const MERGE_CHANGE_WORKTREE = '__merge-change'
export const MERGE_SLICE_WORKTREE = '__merge-slice'

export type MergeWorktree = {
	worktreePath: string
	changeId: string
	reservation: string
	destinationBranch: string
	destinationRef: string
}

type PrepareMergeWorktreeArgs = {
	projectRoot: string
	changeId: string
	reservation: string
	destinationBranch: string
	sourceBranch: string
	git: GitOps
	log?: (msg: string) => void
	confirmMergeConflict?: ConfirmMergeConflict
}

type RunDetachedMergeArgs = {
	worktree: MergeWorktree
	sourceBranch: string
	git: GitOps
	mergeNoVerify: boolean
}

type MergeWithWorktreeArgs = PrepareMergeWorktreeArgs & {
	mergeNoVerify: boolean
}

export async function mergeBranchIntoDestinationWithWorktree(args: MergeWithWorktreeArgs): Promise<MergeWorktree> {
	const worktree = await prepareMergeWorktree(args)
	try {
		await runDetachedMerge(argsForDetachedMerge(args, worktree))
		return worktree
	} catch (error) {
		throw mergeWorktreeError(error, worktree.worktreePath)
	}
}

function argsForDetachedMerge(args: MergeWithWorktreeArgs, worktree: MergeWorktree): RunDetachedMergeArgs {
	return { worktree, sourceBranch: args.sourceBranch, git: args.git, mergeNoVerify: args.mergeNoVerify }
}

async function prepareMergeWorktree(args: PrepareMergeWorktreeArgs): Promise<MergeWorktree> {
	const worktree = mergeWorktreeFor(args)
	await assertDestinationSafe(args.git, args.destinationBranch, worktree.worktreePath)
	await preflightMergeWorktree(args, worktree)
	try {
		await ensurePreparedMergeWorktree(args.git, worktree, args.log)
		return worktree
	} catch (error) {
		throw mergeWorktreeError(error, worktree.worktreePath)
	}
}

async function preflightMergeWorktree(args: PrepareMergeWorktreeArgs, worktree: MergeWorktree): Promise<void> {
	await requireMergeConflictPreflight({
		git: args.git,
		destinationRef: worktree.destinationRef,
		sourceRef: args.sourceBranch,
		destinationBranch: args.destinationBranch,
		sourceBranch: args.sourceBranch,
		mergeLocation: worktree.worktreePath,
		confirm: args.confirmMergeConflict,
	})
}

function mergeWorktreeFor(args: Pick<PrepareMergeWorktreeArgs, 'projectRoot' | 'changeId' | 'reservation' | 'destinationBranch'>): MergeWorktree {
	return {
		worktreePath: path.join(args.projectRoot, '.trowel', 'worktrees', 'changes', args.changeId, args.reservation),
		changeId: args.changeId,
		reservation: args.reservation,
		destinationBranch: args.destinationBranch,
		destinationRef: remoteRef(args.destinationBranch),
	}
}

async function assertDestinationSafe(git: GitOps, destinationBranch: string, reservedWorktreePath: string): Promise<void> {
	await assertRemoteDestinationExists(git, destinationBranch)
	await assertLocalDestinationNotAhead(git, destinationBranch)
	await assertLocalDestinationNotCheckedOut(git, destinationBranch, reservedWorktreePath)
}

async function assertRemoteDestinationExists(git: GitOps, destinationBranch: string): Promise<void> {
	if (!(await git.remoteBranchExists(destinationBranch))) throw new Error(`remote destination branch origin/${destinationBranch} does not exist; aborting before preparing merge worktree`)
	await git.fetch(destinationBranch)
	await git.resolveRef(remoteRef(destinationBranch))
}

async function assertLocalDestinationNotAhead(git: GitOps, destinationBranch: string): Promise<void> {
	if (!(await git.localBranchExists(destinationBranch))) return
	const remote = remoteRef(destinationBranch)
	const ahead = await git.commitsAhead(destinationBranch, remote)
	const behind = await git.commitsAhead(remote, destinationBranch)
	if (ahead > 0 && behind > 0) throw new Error(`local destination branch '${destinationBranch}' has diverged from origin/${destinationBranch}; resolve it before host-owned merge`)
	if (ahead > 0) throw new Error(`local destination branch '${destinationBranch}' is ${ahead} commit(s) ahead of origin/${destinationBranch}; push or reset it before host-owned merge`)
}

async function assertLocalDestinationNotCheckedOut(git: GitOps, destinationBranch: string, reservedWorktreePath: string): Promise<void> {
	if (!(await git.localBranchExists(destinationBranch))) return
	const checkedOut = (await git.worktreeList()).find((w) => w.branch === destinationBranch && w.path !== reservedWorktreePath)
	if (checkedOut) throw new Error(`local destination branch '${destinationBranch}' is checked out at '${checkedOut.path}'; switch that worktree away before host-owned merge`)
}

async function ensurePreparedMergeWorktree(git: GitOps, worktree: MergeWorktree, log?: (msg: string) => void): Promise<void> {
	const existing = await findRegisteredWorktree(git, worktree.worktreePath)
	if (existing) {
		log?.(`Warning: reusing existing merge worktree at ${worktree.worktreePath}; resetting it before merge.`)
		await resetMergeWorktree(git, worktree)
		return
	}
	await assertNoStaleWorktreePath(worktree.worktreePath)
	await mkdir(path.dirname(worktree.worktreePath), { recursive: true })
	await git.worktreeAdd(worktree.worktreePath, worktree.destinationRef)
}

async function findRegisteredWorktree(git: GitOps, worktreePath: string): Promise<Awaited<ReturnType<GitOps['worktreeList']>>[number] | undefined> {
	for (const w of await git.worktreeList()) {
		if (await samePath(w.path, worktreePath)) return w
	}
	return undefined
}

async function samePath(a: string, b: string): Promise<boolean> {
	if (path.resolve(a) === path.resolve(b)) return true
	const [realA, realB] = await Promise.all([realpath(a).catch(() => null), realpath(b).catch(() => null)])
	return realA !== null && realA === realB
}

async function assertNoStaleWorktreePath(worktreePath: string): Promise<void> {
	if (await pathExists(worktreePath)) throw new Error(`merge worktree path '${worktreePath}' already exists but is not a registered git worktree; move it aside before retrying`)
}

async function resetMergeWorktree(git: GitOps, worktree: MergeWorktree): Promise<void> {
	await git.mergeAbortIn(worktree.worktreePath).catch(() => undefined)
	await git.checkoutDetached(worktree.worktreePath, worktree.destinationRef)
	await git.resetHard(worktree.worktreePath, worktree.destinationRef)
	await git.cleanAll(worktree.worktreePath)
}

async function runDetachedMerge(args: RunDetachedMergeArgs): Promise<void> {
	await args.git.mergeNoFfIn(args.worktree.worktreePath, args.sourceBranch, { noVerify: args.mergeNoVerify })
	await args.git.pushHeadTo(args.worktree.worktreePath, args.worktree.destinationBranch)
	const pushedHead = await args.git.resolveRef('HEAD', args.worktree.worktreePath)
	await args.git.updateLocalBranchRef(args.worktree.destinationBranch, pushedHead)
}

function mergeWorktreeError(error: unknown, worktreePath: string): Error {
	const message = error instanceof Error ? error.message : String(error)
	return new Error(`${message}\nMerge worktree preserved at ${worktreePath}`)
}

function remoteRef(branch: string): string {
	return `origin/${branch}`
}

if (import.meta.vitest) {
	const { describe, test, expect, beforeEach, afterEach } = import.meta.vitest
	const { readFile, writeFile } = await import('node:fs/promises')
	const { exec } = await import('../utils/shell.ts')
	const { createRepoGit } = await import('../utils/git-ops.ts')
	const { noopGitOps } = await import('../test-utils/git-ops-fixtures.ts')
	const { setupTestRepoWithBare } = await import('../test-utils/git-repo.ts')

	type BareFixture = Awaited<ReturnType<typeof setupTestRepoWithBare>>

	describe('merge worktree safety checks', () => {
		function remoteDestinationGit(overrides: Partial<GitOps> = {}): GitOps {
			return noopGitOps({
				remoteBranchExists: async () => true,
				localBranchExists: async () => true,
				worktreeList: async () => [],
				...overrides,
			})
		}

		test('missing remote destination fails before preparing a merge worktree', async () => {
			const calls: string[] = []
			const git = noopGitOps({
				remoteBranchExists: async () => false,
				fetch: async (branch) => { calls.push(`fetch(${branch})`) },
				worktreeAdd: async (worktreePath, ref) => { calls.push(`worktreeAdd(${worktreePath},${ref})`) },
			})

			await expect(prepareMergeWorktree({ projectRoot: '/tmp/project', changeId: '42', reservation: MERGE_CHANGE_WORKTREE, destinationBranch: 'main', sourceBranch: 'change-42', git })).rejects.toThrow(/remote destination branch origin\/main does not exist/)
			expect(calls.find((call) => call.startsWith('worktreeAdd'))).toBeUndefined()
			expect(calls.find((call) => call.startsWith('fetch'))).toBeUndefined()
		})

		test('local destination ahead of remote is refused before preparing a merge worktree', async () => {
			const calls: string[] = []
			const git = remoteDestinationGit({
				commitsAhead: async (branch) => branch === 'main' ? 2 : 0,
				worktreeAdd: async () => { calls.push('worktreeAdd') },
			})

			await expect(prepareMergeWorktree({ projectRoot: '/tmp/project', changeId: '42', reservation: MERGE_CHANGE_WORKTREE, destinationBranch: 'main', sourceBranch: 'change-42', git })).rejects.toThrow(/ahead of origin\/main/)
			expect(calls).toEqual([])
		})

		test('local destination diverged from remote is refused before preparing a merge worktree', async () => {
			const git = remoteDestinationGit({
				commitsAhead: async () => 1,
				worktreeAdd: async () => { throw new Error('should not prepare') },
			})

			await expect(prepareMergeWorktree({ projectRoot: '/tmp/project', changeId: '42', reservation: MERGE_CHANGE_WORKTREE, destinationBranch: 'main', sourceBranch: 'change-42', git })).rejects.toThrow(/diverged from origin\/main/)
		})

		test('conflict preflight fails before preparing a merge worktree without confirmation', async () => {
			const calls: string[] = []
			const git = noopGitOps({
				remoteBranchExists: async () => true,
				localBranchExists: async () => false,
				mergeConflictPreflight: async () => ({ ok: false, files: ['README.md'], messages: 'CONFLICT (content): README.md' }),
				worktreeAdd: async () => { calls.push('worktreeAdd') },
			})

			await expect(prepareMergeWorktree({ projectRoot: '/tmp/project', changeId: '42', reservation: MERGE_CHANGE_WORKTREE, destinationBranch: 'main', sourceBranch: 'change-42', git })).rejects.toThrow(/README\.md/)
			expect(calls).toEqual([])
		})
	})

	describe('mergeBranchIntoDestinationWithWorktree (real git)', () => {
		let fixture: BareFixture
		let git: GitOps
		let logs: string[]

		beforeEach(async () => {
			fixture = await setupTestRepoWithBare({ prefix: 'trowel-merge-wt-' })
			git = createRepoGit(fixture.work)
			logs = []
		})

		afterEach(async () => {
			if (fixture) await fixture.cleanup()
		})

		test('creates a reserved detached worktree, merges from the destination tip, pushes HEAD, and updates the local destination ref', async () => {
			await createBranchCommit(fixture.work, 'change-42', 'feature.txt', 'feature\n')
			await exec('git', ['-C', fixture.work, 'checkout', '-q', 'change-42'])

			const result = await mergeBranchIntoDestinationWithWorktree({
				projectRoot: fixture.work,
				changeId: '42',
				reservation: MERGE_CHANGE_WORKTREE,
				destinationBranch: 'main',
				sourceBranch: 'change-42',
				git,
				mergeNoVerify: false,
				log: (msg) => logs.push(msg),
			})

			expect(result.worktreePath).toBe(path.join(fixture.work, '.trowel', 'worktrees', 'changes', '42', MERGE_CHANGE_WORKTREE))
			expect(await currentBranch(fixture.work)).toBe('change-42')
			expect((await findRegisteredWorktree(git, result.worktreePath))?.branch).toBeNull()
			expect(await readFile(path.join(result.worktreePath, 'feature.txt'), 'utf8')).toBe('feature\n')
			const remoteMain = await revParse(fixture.work, 'origin/main')
			const localMain = await revParse(fixture.work, 'main')
			const worktreeHead = await revParse(result.worktreePath, 'HEAD')
			expect(remoteMain).toBe(worktreeHead)
			expect(localMain).toBe(worktreeHead)
		})

		test('reuses an existing reserved worktree with a warning and clears failed merge state plus leftover files before retrying', async () => {
			await writeFile(path.join(fixture.work, 'conflict.txt'), 'base\n')
			await exec('git', ['-C', fixture.work, 'add', 'conflict.txt'])
			await exec('git', ['-C', fixture.work, 'commit', '-q', '-m', 'main adds conflict base'])
			await exec('git', ['-C', fixture.work, 'push', '-q', 'origin', 'main'])
			await createBranchCommit(fixture.work, 'conflict-source', 'conflict.txt', 'source\n')
			await exec('git', ['-C', fixture.work, 'checkout', '-q', '-b', 'driver', 'main'])
			await writeFile(path.join(fixture.work, 'conflict.txt'), 'dest\n')
			await exec('git', ['-C', fixture.work, 'commit', '-q', '-am', 'main diverges'])
			await exec('git', ['-C', fixture.work, 'push', '-q', 'origin', 'driver:main'])

			const args = { projectRoot: fixture.work, changeId: '42', reservation: MERGE_CHANGE_WORKTREE, destinationBranch: 'main', git, mergeNoVerify: false, log: (msg: string) => logs.push(msg), confirmMergeConflict: async () => true }
			await expect(mergeBranchIntoDestinationWithWorktree({ ...args, sourceBranch: 'conflict-source' })).rejects.toThrow(/Merge worktree preserved at/)
			const worktreePath = path.join(fixture.work, '.trowel', 'worktrees', 'changes', '42', MERGE_CHANGE_WORKTREE)
			expect(await revParseMaybe(worktreePath, 'MERGE_HEAD')).toMatch(/^[0-9a-f]{40}$/)
			await writeFile(path.join(worktreePath, 'leftover.txt'), 'remove me\n')

			await createBranchCommit(fixture.work, 'clean-source', 'clean.txt', 'clean\n', 'origin/main')
			await mergeBranchIntoDestinationWithWorktree({ ...args, sourceBranch: 'clean-source' })

			expect(logs.some((msg) => msg.includes('Warning: reusing existing merge worktree'))).toBe(true)
			expect(await revParseMaybe(worktreePath, 'MERGE_HEAD')).toBeNull()
			await expect(readFile(path.join(worktreePath, 'leftover.txt'), 'utf8')).rejects.toThrow()
			expect(await readFile(path.join(worktreePath, 'clean.txt'), 'utf8')).toBe('clean\n')
		})

		test('handles an absent local destination branch by creating it at the pushed merge result', async () => {
			await exec('git', ['-C', fixture.work, 'checkout', '-q', '-b', 'driver'])
			await exec('git', ['-C', fixture.work, 'branch', '-D', 'main'])
			await createBranchCommit(fixture.work, 'change-42', 'feature.txt', 'feature\n', 'origin/main')

			await mergeBranchIntoDestinationWithWorktree({
				projectRoot: fixture.work,
				changeId: '42',
				reservation: MERGE_CHANGE_WORKTREE,
				destinationBranch: 'main',
				sourceBranch: 'change-42',
				git,
				mergeNoVerify: false,
			})

			expect(await revParse(fixture.work, 'main')).toBe(await revParse(fixture.work, 'origin/main'))
		})
	})

	async function createBranchCommit(repo: string, branch: string, file: string, content: string, startPoint = 'HEAD'): Promise<void> {
		await exec('git', ['-C', repo, 'checkout', '-q', '-B', branch, startPoint])
		await writeFile(path.join(repo, file), content)
		await exec('git', ['-C', repo, 'add', file])
		await exec('git', ['-C', repo, 'commit', '-q', '-m', `commit ${file}`])
	}

	async function currentBranch(repo: string): Promise<string> {
		return (await exec('git', ['-C', repo, 'rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim()
	}

	async function revParse(repo: string, ref: string): Promise<string> {
		return (await exec('git', ['-C', repo, 'rev-parse', '--verify', ref])).stdout.trim()
	}

	async function revParseMaybe(repo: string, ref: string): Promise<string | null> {
		try {
			return await revParse(repo, ref)
		} catch {
			return null
		}
	}
}
