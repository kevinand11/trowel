import { exec, parseSemver, tryExec } from './shell.ts'

type VersionInfo = { installed: boolean; version?: string }

export type MergeConflictPreflight =
	| { ok: true }
	| { ok: false; files: string[]; messages: string }

/**
 * Single canonical surface for every git operation trowel performs against
 * a project's repo. See ADR `2026-05-13-unified-gitops-via-module-factory`.
 */
export type GitOps = {
	// Environment
	detectVersion(): Promise<VersionInfo>
	supportsMergeConflictPreflight(): Promise<boolean>
	// phase-method ops (consumed by Storage implementations)
	fetch(branch: string): Promise<void>
	push(branch: string): Promise<void>
	checkout(branch: string): Promise<void>
	mergeNoFf(branch: string, opts?: { noVerify?: boolean }): Promise<void>
	mergeAbort(): Promise<void>
	mergeNoFfIn(worktreePath: string, branch: string, opts?: { noVerify?: boolean }): Promise<void>
	mergeAbortIn(worktreePath: string): Promise<void>
	mergeConflictPreflight(destinationRef: string, sourceRef: string, cwd?: string): Promise<MergeConflictPreflight>
	deleteRemoteBranch(branch: string): Promise<void>
	remoteBranchExists(branch: string): Promise<boolean>
	createRemoteBranch(newBranch: string, baseBranch: string): Promise<void>
	// file storage's createChange uses these for Change branch creation
	createLocalBranch(name: string, baseBranch: string): Promise<void>
	pushSetUpstream(branch: string): Promise<void>
	fastForward(ref: string): Promise<void>
	// host-side close cleanup (consumed by `src/commands/abort/index.ts`)
	currentBranch(): Promise<string>
	baseBranch(): Promise<string>
	branchExists(branch: string): Promise<boolean>
	localBranchExists(branch: string): Promise<boolean>
	isMerged(branch: string, baseBranch: string): Promise<boolean>
	commitsAhead(branch: string, baseBranch: string): Promise<number>
	commitDate(ref: string, worktreePath?: string): Promise<string>
	listLocalBranches(): Promise<string[]>
	deleteBranch(branch: string): Promise<void>
	resolveRef(ref: string, worktreePath?: string): Promise<string>
	checkoutDetached(worktreePath: string, ref: string): Promise<void>
	resetHard(worktreePath: string, ref: string): Promise<void>
	pushHeadTo(worktreePath: string, branch: string): Promise<void>
	updateLocalBranchRef(branch: string, ref: string): Promise<void>
	// worktree primitives (consumed by src/work/worktrees.ts for per-Turn worktrees)
	worktreeAdd(worktreePath: string, branch: string): Promise<void>
	worktreeAddNewBranch(worktreePath: string, branch: string, baseRef: string): Promise<void>
	worktreeRemove(worktreePath: string, opts?: { force?: boolean }): Promise<void>
	worktreeList(): Promise<Array<{ path: string; branch: string | null; head: string }>>
	restoreAll(worktreePath: string): Promise<void>
	cleanUntracked(worktreePath: string): Promise<void>
	cleanAll(worktreePath: string): Promise<void>
	isWorkingTreeCleanIn(worktreePath: string): Promise<boolean>
	statusShortIn(worktreePath: string): Promise<string>
	isAncestor(ancestorRef: string, descendantRef: string): Promise<boolean>
	// host-side workflow ops (consumed by `runStart` in `src/commands/start.ts`)
	isWorkingTreeClean(): Promise<boolean>
	statusShort(): Promise<string>
	stashPush(opts: { includeUntracked: boolean }): Promise<void>
	stashPop(): Promise<void>
}

// Branch-stable inspection surface for entity read commands. These methods may fetch
// remote refs, but they cannot checkout, create, or delete local branches.
export type ReadOnlyGitFacts = Pick<GitOps, 'baseBranch' | 'branchExists' | 'commitsAhead' | 'fetch' | 'isMerged' | 'remoteBranchExists'>

export function branchStableGitFacts(git: GitOps): ReadOnlyGitFacts {
	return {
		baseBranch: git.baseBranch,
		branchExists: git.branchExists,
		commitsAhead: git.commitsAhead,
		fetch: git.fetch,
		isMerged: git.isMerged,
		remoteBranchExists: git.remoteBranchExists,
	}
}

export function branchStableGitOps(git: GitOps): GitOps {
	return {
		detectVersion: git.detectVersion,
		supportsMergeConflictPreflight: git.supportsMergeConflictPreflight,
		fetch: git.fetch,
		push: forbiddenGitMutation('push'),
		checkout: forbiddenGitMutation('checkout'),
		mergeNoFf: forbiddenGitMutation('mergeNoFf'),
		mergeAbort: forbiddenGitMutation('mergeAbort'),
		mergeNoFfIn: forbiddenGitMutation('mergeNoFfIn'),
		mergeAbortIn: forbiddenGitMutation('mergeAbortIn'),
		mergeConflictPreflight: git.mergeConflictPreflight,
		deleteRemoteBranch: forbiddenGitMutation('deleteRemoteBranch'),
		remoteBranchExists: git.remoteBranchExists,
		createRemoteBranch: forbiddenGitMutation('createRemoteBranch'),
		createLocalBranch: forbiddenGitMutation('createLocalBranch'),
		pushSetUpstream: forbiddenGitMutation('pushSetUpstream'),
		fastForward: forbiddenGitMutation('fastForward'),
		currentBranch: git.currentBranch,
		baseBranch: git.baseBranch,
		branchExists: git.branchExists,
		localBranchExists: git.localBranchExists,
		isMerged: git.isMerged,
		commitsAhead: git.commitsAhead,
		commitDate: git.commitDate,
		listLocalBranches: git.listLocalBranches,
		deleteBranch: forbiddenGitMutation('deleteBranch'),
		resolveRef: git.resolveRef,
		checkoutDetached: forbiddenGitMutation('checkoutDetached'),
		resetHard: forbiddenGitMutation('resetHard'),
		pushHeadTo: forbiddenGitMutation('pushHeadTo'),
		updateLocalBranchRef: forbiddenGitMutation('updateLocalBranchRef'),
		worktreeAdd: forbiddenGitMutation('worktreeAdd'),
		worktreeAddNewBranch: forbiddenGitMutation('worktreeAddNewBranch'),
		worktreeRemove: forbiddenGitMutation('worktreeRemove'),
		worktreeList: git.worktreeList,
		restoreAll: forbiddenGitMutation('restoreAll'),
		cleanUntracked: forbiddenGitMutation('cleanUntracked'),
		cleanAll: forbiddenGitMutation('cleanAll'),
		isWorkingTreeCleanIn: git.isWorkingTreeCleanIn,
		statusShortIn: git.statusShortIn,
		isAncestor: git.isAncestor,
		isWorkingTreeClean: git.isWorkingTreeClean,
		statusShort: git.statusShort,
		stashPush: forbiddenGitMutation('stashPush'),
		stashPop: forbiddenGitMutation('stashPop'),
	}
}

function forbiddenGitMutation(name: string): (...args: unknown[]) => Promise<never> {
	return async () => {
		throw new Error(`git.${name} is not allowed during entity read commands`)
	}
}

function mergeTreeErrorOutput(error: Error): { code: number | null; output: string } {
	const details = error as { code?: unknown; stdout?: unknown; stderr?: unknown }
	const code = typeof details.code === 'number' ? details.code : null
	const stdout = typeof details.stdout === 'string' ? details.stdout : ''
	const stderr = typeof details.stderr === 'string' ? details.stderr : ''
	return { code, output: `${stdout}\n${stderr}`.trim() }
}

function parseMergeConflictFiles(output: string): string[] {
	const lines = output.split('\n')
	const files: string[] = []
	for (const line of lines.slice(isObjectIdLine(lines[0]) ? 1 : 0)) {
		const trimmed = line.trim()
		if (!trimmed) break
		files.push(trimmed)
	}
	return [...new Set(files)]
}

function isObjectIdLine(line: string | undefined): boolean {
	return /^[0-9a-f]{40,64}$/.test(line?.trim() ?? '')
}

function preflightUnavailableError(destinationRef: string, sourceRef: string, cause: Error): Error {
	const { output } = mergeTreeErrorOutput(cause)
	const suffix = output ? `\n${output}` : ''
	return new Error(`merge conflict preflight is unavailable for '${sourceRef}' into '${destinationRef}'; upgrade Git to a version that supports 'git merge-tree --write-tree'.${suffix}`)
}

export function createRepoGit(projectRoot: string): GitOps {
	const gitOrThrow = async (args: string[], cwd = projectRoot): Promise<string> => {
		const r = await tryExec('git', ['-C', cwd, ...args])
		if (!r.ok) throw r.error
		return r.stdout
	}

	return {
		detectVersion: async () => {
			const r = await tryExec('git', ['--version'])
			if (!r.ok) return { installed: false }
			return { installed: true, version: parseSemver(`${r.stdout}\n${r.stderr}`) }
		},
		supportsMergeConflictPreflight: async () => {
			const r = await tryExec('git', ['merge-tree', '-h'])
			const output = r.ok ? `${r.stdout}\n${r.stderr}` : mergeTreeErrorOutput(r.error).output
			return /--write-tree/.test(output)
		},
		fetch: async (b) => {
			await gitOrThrow(['fetch', '-q', 'origin', b])
		},
		push: async (b) => {
			await gitOrThrow(['push', '-q', 'origin', b])
		},
		checkout: async (b) => {
			await gitOrThrow(['checkout', '-q', b])
		},
		mergeNoFf: async (b, opts) => {
			const args = ['merge', '--no-ff', '-q']
			if (opts?.noVerify) args.push('--no-verify')
			args.push(b)
			await gitOrThrow(args)
		},
		mergeAbort: async () => {
			await gitOrThrow(['merge', '--abort'])
		},
		mergeNoFfIn: async (worktreePath, b, opts) => {
			const args = ['merge', '--no-ff', '-q']
			if (opts?.noVerify) args.push('--no-verify')
			args.push(b)
			await gitOrThrow(args, worktreePath)
		},
		mergeAbortIn: async (worktreePath) => {
			await gitOrThrow(['merge', '--abort'], worktreePath)
		},
		mergeConflictPreflight: async (destinationRef, sourceRef, cwd = projectRoot) => {
			const r = await tryExec('git', ['-C', cwd, 'merge-tree', '--write-tree', '--messages', '--name-only', destinationRef, sourceRef])
			if (r.ok) return { ok: true }
			const { code, output } = mergeTreeErrorOutput(r.error)
			if (code !== 1) throw preflightUnavailableError(destinationRef, sourceRef, r.error)
			return { ok: false, files: parseMergeConflictFiles(output), messages: output }
		},
		deleteRemoteBranch: async (b) => {
			await gitOrThrow(['push', '-q', 'origin', `:${b}`])
		},
		remoteBranchExists: async (b) => {
			const remote = await tryExec('git', ['-C', projectRoot, 'ls-remote', '--heads', 'origin', b])
			return remote.ok && remote.stdout.trim() !== ''
		},
		createRemoteBranch: async (newBranch, baseBranch) => {
			await gitOrThrow(['fetch', '-q', 'origin', baseBranch])
			await gitOrThrow(['push', '-q', 'origin', `refs/remotes/origin/${baseBranch}:refs/heads/${newBranch}`])
		},
		createLocalBranch: async (name, baseBranch) => {
			await gitOrThrow(['checkout', '-q', '-b', name, baseBranch])
		},
		pushSetUpstream: async (b) => {
			await gitOrThrow(['push', '-q', '-u', 'origin', b])
		},
		fastForward: async (ref) => {
			await gitOrThrow(['merge', '--ff-only', '-q', ref])
		},
		currentBranch: async () => {
			const r = await tryExec('git', ['-C', projectRoot, 'rev-parse', '--abbrev-ref', 'HEAD'])
			return r.ok ? r.stdout.trim() : ''
		},
		baseBranch: async () => {
			const result = await tryExec('git', ['-C', projectRoot, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])
			if (!result.ok) return 'main'
			const trimmed = result.stdout.trim()
			if (!trimmed) return 'main'
			return trimmed.startsWith('origin/') ? trimmed.slice('origin/'.length) : trimmed
		},
		branchExists: async (b) => {
			const local = await tryExec('git', ['-C', projectRoot, 'branch', '--list', b])
			if (local.ok && local.stdout.trim() !== '') return true
			const remote = await tryExec('git', ['-C', projectRoot, 'ls-remote', '--heads', 'origin', b])
			return remote.ok && remote.stdout.trim() !== ''
		},
		localBranchExists: async (b) => {
			const local = await tryExec('git', ['-C', projectRoot, 'branch', '--list', b])
			return local.ok && local.stdout.trim() !== ''
		},
		isMerged: async (b, base) => {
			const r = await tryExec('git', ['-C', projectRoot, 'merge-base', '--is-ancestor', b, `origin/${base}`])
			return r.ok
		},
		commitsAhead: async (b, base) => {
			const r = await tryExec('git', ['-C', projectRoot, 'rev-list', '--count', `${base}..${b}`])
			if (!r.ok) return 0
			const n = parseInt(r.stdout.trim(), 10)
			return Number.isFinite(n) ? n : 0
		},
		commitDate: async (ref, worktreePath) => (await gitOrThrow(['log', '-1', '--format=%cI', ref], worktreePath)).trim(),
		listLocalBranches: async () => {
			const r = await tryExec('git', ['-C', projectRoot, 'branch', '--format=%(refname:short)'])
			if (!r.ok) return []
			return r.stdout.split('\n').map((line) => line.trim()).filter(Boolean)
		},
		deleteBranch: async (b) => {
			await tryExec('git', ['-C', projectRoot, 'branch', '-q', '-D', b])
		},
		resolveRef: async (ref, worktreePath) => (await gitOrThrow(['rev-parse', '--verify', ref], worktreePath)).trim(),
		checkoutDetached: async (worktreePath, ref) => {
			await gitOrThrow(['checkout', '-q', '--detach', ref], worktreePath)
		},
		resetHard: async (worktreePath, ref) => {
			await gitOrThrow(['reset', '--hard', '-q', ref], worktreePath)
		},
		pushHeadTo: async (worktreePath, branch) => {
			await gitOrThrow(['push', '-q', 'origin', `HEAD:refs/heads/${branch}`], worktreePath)
		},
		updateLocalBranchRef: async (branch, ref) => {
			await gitOrThrow(['update-ref', `refs/heads/${branch}`, ref])
		},
		worktreeAdd: async (worktreePath, branch) => {
			await gitOrThrow(['worktree', 'add', worktreePath, branch])
		},
		worktreeAddNewBranch: async (worktreePath, branch, baseRef) => {
			await gitOrThrow(['worktree', 'add', '-b', branch, worktreePath, baseRef])
		},
		worktreeRemove: async (worktreePath, opts) => {
			const args = ['worktree', 'remove']
			if (opts?.force) args.push('--force')
			args.push(worktreePath)
			await gitOrThrow(args)
		},
		worktreeList: async () => {
			const stdout = await gitOrThrow(['worktree', 'list', '--porcelain'])
			return parseWorktreePorcelain(stdout)
		},
		restoreAll: async (worktreePath) => {
			await gitOrThrow(['restore', '--staged', '--worktree', '.'], worktreePath)
		},
		cleanUntracked: async (worktreePath) => {
			await gitOrThrow(['clean', '-fd'], worktreePath)
		},
		cleanAll: async (worktreePath) => {
			await gitOrThrow(['clean', '-fdx'], worktreePath)
		},
		isWorkingTreeCleanIn: async (worktreePath) => {
			const stdout = await gitOrThrow(['status', '--porcelain'], worktreePath)
			return stdout.trim() === ''
		},
		statusShortIn: async (worktreePath) => gitOrThrow(['status', '--short'], worktreePath),
		isAncestor: async (ancestorRef, descendantRef) => {
			const r = await tryExec('git', ['-C', projectRoot, 'merge-base', '--is-ancestor', ancestorRef, descendantRef])
			return r.ok
		},
		isWorkingTreeClean: async () => {
			const stdout = await gitOrThrow(['status', '--porcelain'])
			return stdout.trim() === ''
		},
		statusShort: async () => gitOrThrow(['status', '--short']),
		stashPush: async ({ includeUntracked }) => {
			const args = ['stash', 'push']
			if (includeUntracked) args.push('--include-untracked')
			await gitOrThrow(args)
		},
		stashPop: async () => {
			await gitOrThrow(['stash', 'pop'])
		},
	}
}

type WorktreeEntry = { path: string; branch: string | null; head: string }
type PartialWorktreeEntry = { path?: string; branch: string | null; head?: string }

function parseWorktreePorcelain(stdout: string): WorktreeEntry[] {
	const result: WorktreeEntry[] = []
	let current = emptyWorktreeEntry()
	for (const line of stdout.split('\n')) current = applyWorktreeLine(result, current, line)
	pushCompleteWorktree(result, current)
	return result
}

function emptyWorktreeEntry(): PartialWorktreeEntry {
	return { branch: null }
}

type WorktreeLineHandler = {
	prefix: string
	apply: (result: WorktreeEntry[], current: PartialWorktreeEntry, line: string) => PartialWorktreeEntry
}

const WORKTREE_LINE_HANDLERS: WorktreeLineHandler[] = [
	{ prefix: 'worktree ', apply: startWorktreeEntry },
	{ prefix: 'HEAD ', apply: setWorktreeHead },
	{ prefix: 'branch ', apply: setWorktreeBranch },
	{ prefix: 'detached', apply: detachWorktreeBranch },
]

function applyWorktreeLine(result: WorktreeEntry[], current: PartialWorktreeEntry, line: string): PartialWorktreeEntry {
	const handler = WORKTREE_LINE_HANDLERS.find((h) => line.startsWith(h.prefix))
	return handler ? handler.apply(result, current, line) : current
}

function setWorktreeHead(_result: WorktreeEntry[], current: PartialWorktreeEntry, line: string): PartialWorktreeEntry {
	return { ...current, head: line.slice('HEAD '.length).trim() }
}

function setWorktreeBranch(_result: WorktreeEntry[], current: PartialWorktreeEntry, line: string): PartialWorktreeEntry {
	return { ...current, branch: normalizeBranchRef(line.slice('branch '.length).trim()) }
}

function detachWorktreeBranch(_result: WorktreeEntry[], current: PartialWorktreeEntry): PartialWorktreeEntry {
	return { ...current, branch: null }
}

function startWorktreeEntry(result: WorktreeEntry[], current: PartialWorktreeEntry, line: string): PartialWorktreeEntry {
	pushCompleteWorktree(result, current)
	return { path: line.slice('worktree '.length).trim(), branch: null }
}

function pushCompleteWorktree(result: WorktreeEntry[], current: PartialWorktreeEntry): void {
	if (current.path && current.head) result.push({ path: current.path, branch: current.branch, head: current.head })
}

function normalizeBranchRef(ref: string): string {
	return ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref
}

if (import.meta.vitest) {
	const { describe, test, expect, beforeEach, afterEach } = import.meta.vitest
	const path = await import('node:path')
	const { writeFile, readFile, stat, mkdir } = await import('node:fs/promises')
	const { setupTestRepo } = await import('../test-utils/git-repo.ts')
	const { noopGitOps } = await import('../test-utils/git-ops-fixtures.ts')

	describe('branchStableGitOps', () => {
		test('allows branch-stable fact reads but rejects checkout/create/delete operations', async () => {
			const calls: string[] = []
			const git = branchStableGitOps(noopGitOps({
				fetch: async (branch) => { calls.push(`fetch(${branch})`) },
				remoteBranchExists: async (branch) => {
					calls.push(`remoteBranchExists(${branch})`)
					return true
				},
			}))

			await git.fetch('change-1')
			expect(await git.remoteBranchExists('change-1')).toBe(true)
			await expect(git.checkout('change-1')).rejects.toThrow(/git\.checkout is not allowed/)
			await expect(git.createLocalBranch('change-1', 'main')).rejects.toThrow(/git\.createLocalBranch is not allowed/)
			await expect(git.deleteBranch('change-1')).rejects.toThrow(/git\.deleteBranch is not allowed/)
			expect(calls).toEqual(['fetch(change-1)', 'remoteBranchExists(change-1)'])
		})
	})

	describe('GitOps environment probe', () => {
		test('detectVersion reports installed:true and parses the semver from real `git --version`', async () => {
			const git = createRepoGit(process.cwd())
			const v = await git.detectVersion()
			expect(v.installed).toBe(true)
			expect(v.version).toMatch(/^\d+\.\d+\.\d+$/)
		})
	})

	describe('GitOps worktree primitives (real git on tmp repos)', () => {
		let repo: string
		let git: GitOps
		let cleanupRepo: () => Promise<void>

		beforeEach(async () => {
			const r = await setupTestRepo({ prefix: 'trowel-gitops-', branches: ['feature'] })
			repo = r.root
			cleanupRepo = r.cleanup
			git = createRepoGit(repo)
		})
		afterEach(async () => {
			if (cleanupRepo) await cleanupRepo()
		})

		test('worktreeAdd checks out the branch at a new worktree path', async () => {
			const wtPath = path.join(repo, '.trowel-wt-test')
			await git.worktreeAdd(wtPath, 'feature')
			const s = await stat(path.join(wtPath, 'README.md'))
			expect(s.isFile()).toBe(true)
			const branch = (await exec('git', ['-C', wtPath, 'rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim()
			expect(branch).toBe('feature')
		})

		test('worktreeAddNewBranch creates a new branch from a base ref', async () => {
			const wtPath = path.join(repo, '.trowel-new-branch-test')
			await git.worktreeAddNewBranch(wtPath, 'lane-1-test', 'HEAD')
			const branch = (await exec('git', ['-C', wtPath, 'rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim()
			expect(branch).toBe('lane-1-test')
		})

		test('isWorkingTreeCleanIn and statusShortIn inspect arbitrary worktrees', async () => {
			const wtPath = path.join(repo, '.trowel-clean-test')
			await git.worktreeAddNewBranch(wtPath, 'lane-2-test', 'HEAD')
			expect(await git.isWorkingTreeCleanIn(wtPath)).toBe(true)
			await writeFile(path.join(wtPath, 'dirty.txt'), 'dirty\n')
			expect(await git.isWorkingTreeCleanIn(wtPath)).toBe(false)
			expect(await git.statusShortIn(wtPath)).toContain('dirty.txt')
		})

		test('isAncestor reports local ancestry', async () => {
			await exec('git', ['-C', repo, 'checkout', '-q', 'feature'])
			await writeFile(path.join(repo, 'feature.txt'), 'feature\n')
			await exec('git', ['-C', repo, 'add', 'feature.txt'])
			await exec('git', ['-C', repo, 'commit', '-q', '-m', 'advance feature'])
			expect(await git.isAncestor('main', 'feature')).toBe(true)
			expect(await git.isAncestor('feature', 'main')).toBe(false)
		})

		test('mergeConflictPreflight reports clean branch merges without mutating the worktree', async () => {
			await exec('git', ['-C', repo, 'checkout', '-q', '-b', 'clean-source'])
			await writeFile(path.join(repo, 'clean.txt'), 'clean\n')
			await exec('git', ['-C', repo, 'add', 'clean.txt'])
			await exec('git', ['-C', repo, 'commit', '-q', '-m', 'clean source'])
			await exec('git', ['-C', repo, 'checkout', '-q', 'main'])

			expect(await git.mergeConflictPreflight('main', 'clean-source')).toEqual({ ok: true })
			expect((await exec('git', ['-C', repo, 'status', '--short'])).stdout).toBe('')
		})

		test('mergeConflictPreflight returns conflicting paths without mutating the worktree', async () => {
			await exec('git', ['-C', repo, 'checkout', '-q', '-b', 'conflict-source'])
			await writeFile(path.join(repo, 'README.md'), 'source\n')
			await exec('git', ['-C', repo, 'commit', '-am', 'source edit', '-q'])
			await exec('git', ['-C', repo, 'checkout', '-q', 'main'])
			await writeFile(path.join(repo, 'README.md'), 'destination\n')
			await exec('git', ['-C', repo, 'commit', '-am', 'destination edit', '-q'])

			const preflight = await git.mergeConflictPreflight('main', 'conflict-source')

			expect(preflight).toMatchObject({ ok: false, files: ['README.md'] })
			if (!preflight.ok) expect(preflight.messages).toContain('CONFLICT')
			expect((await exec('git', ['-C', repo, 'status', '--short'])).stdout).toBe('')
		})

		test('worktreeList includes the primary repo and any added worktrees', async () => {
			const wtPath = path.join(repo, '.trowel-wt-test')
			await git.worktreeAdd(wtPath, 'feature')
			const list = await git.worktreeList()
			const primary = list.find((w) => w.path === repo)
			const added = list.find((w) => w.path === wtPath)
			expect(primary?.branch).toBe('main')
			expect(added?.branch).toBe('feature')
			expect(added?.head).toMatch(/^[0-9a-f]{40}$/)
		})

		test('worktreeRemove removes a clean worktree without --force', async () => {
			const wtPath = path.join(repo, '.trowel-wt-test')
			await git.worktreeAdd(wtPath, 'feature')
			await git.worktreeRemove(wtPath)
			const list = await git.worktreeList()
			expect(list.find((w) => w.path === wtPath)).toBeUndefined()
		})

		test('worktreeRemove with force removes a dirty worktree', async () => {
			const wtPath = path.join(repo, '.trowel-wt-test')
			await git.worktreeAdd(wtPath, 'feature')
			await writeFile(path.join(wtPath, 'README.md'), 'dirty\n')
			await git.worktreeRemove(wtPath, { force: true })
			const list = await git.worktreeList()
			expect(list.find((w) => w.path === wtPath)).toBeUndefined()
		})

		test('restoreAll discards staged and unstaged changes inside a worktree', async () => {
			const wtPath = path.join(repo, '.trowel-wt-test')
			await git.worktreeAdd(wtPath, 'feature')
			await writeFile(path.join(wtPath, 'README.md'), 'unstaged\n')
			await writeFile(path.join(wtPath, 'staged.txt'), 'staged\n')
			await exec('git', ['-C', wtPath, 'add', 'staged.txt'])
			await git.restoreAll(wtPath)
			const readme = await readFile(path.join(wtPath, 'README.md'), 'utf8')
			expect(readme).toBe('x\n')
			// `restore --staged --worktree` unstages and resets tracked files; the new untracked staged.txt
			// remains because it was never tracked. cleanUntracked handles that case (next test).
		})

		test('cleanUntracked removes untracked files and directories but preserves gitignored', async () => {
			const wtPath = path.join(repo, '.trowel-wt-test')
			await git.worktreeAdd(wtPath, 'feature')
			await writeFile(path.join(wtPath, '.gitignore'), 'keep-me/\n')
			await mkdir(path.join(wtPath, 'keep-me'), { recursive: true })
			await writeFile(path.join(wtPath, 'keep-me', 'a.txt'), 'gitignored\n')
			await writeFile(path.join(wtPath, 'untracked.txt'), 'untracked\n')
			await git.cleanUntracked(wtPath)
			const keptStat = await stat(path.join(wtPath, 'keep-me', 'a.txt'))
			expect(keptStat.isFile()).toBe(true)
			await expect(stat(path.join(wtPath, 'untracked.txt'))).rejects.toThrow()
		})
	})
}
