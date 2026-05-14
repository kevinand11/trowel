import { exec, tryExec } from './shell.ts'

/**
 * Single canonical surface for every git operation trowel performs against
 * a project's repo. See ADR `2026-05-13-unified-gitops-via-module-factory`.
 */
export type GitOps = {
	// phase-method ops (consumed by Storage implementations)
	fetch(branch: string): Promise<void>
	push(branch: string): Promise<void>
	checkout(branch: string): Promise<void>
	mergeNoFf(branch: string): Promise<void>
	deleteRemoteBranch(branch: string): Promise<void>
	createRemoteBranch(newBranch: string, baseBranch: string): Promise<void>
	// file storage's createPrd uses these for integration-branch creation
	createLocalBranch(name: string, baseBranch: string): Promise<void>
	pushSetUpstream(branch: string): Promise<void>
	// host-side close cleanup (consumed by `runClose` in `src/commands/close.ts`)
	currentBranch(): Promise<string>
	baseBranch(): Promise<string>
	branchExists(branch: string): Promise<boolean>
	isMerged(branch: string, baseBranch: string): Promise<boolean>
	deleteBranch(branch: string): Promise<void>
	// worktree primitives (consumed by src/work/worktrees.ts for per-Turn worktrees)
	worktreeAdd(worktreePath: string, branch: string): Promise<void>
	worktreeRemove(worktreePath: string, opts?: { force?: boolean }): Promise<void>
	worktreeList(): Promise<Array<{ path: string; branch: string | null; head: string }>>
	restoreAll(worktreePath: string): Promise<void>
	cleanUntracked(worktreePath: string): Promise<void>
}

export function createRepoGit(projectRoot: string): GitOps {
	const gitOrThrow = async (args: string[], cwd = projectRoot): Promise<string> => {
		const r = await tryExec('git', ['-C', cwd, ...args])
		if (!r.ok) throw r.error
		return r.stdout
	}

	return {
		fetch: async (b) => {
			await gitOrThrow(['fetch', '-q', 'origin', b])
		},
		push: async (b) => {
			await gitOrThrow(['push', '-q', 'origin', b])
		},
		checkout: async (b) => {
			await gitOrThrow(['checkout', '-q', b])
		},
		mergeNoFf: async (b) => {
			await gitOrThrow(['merge', '--no-ff', '-q', b])
		},
		deleteRemoteBranch: async (b) => {
			await gitOrThrow(['push', '-q', 'origin', `:${b}`])
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
		isMerged: async (b, base) => {
			const r = await tryExec('git', ['-C', projectRoot, 'merge-base', '--is-ancestor', b, `origin/${base}`])
			return r.ok
		},
		deleteBranch: async (b) => {
			await tryExec('git', ['-C', projectRoot, 'branch', '-q', '-D', b])
			await tryExec('git', ['-C', projectRoot, 'push', '-q', 'origin', `:${b}`])
		},
		worktreeAdd: async (worktreePath, branch) => {
			await gitOrThrow(['worktree', 'add', worktreePath, branch])
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
	}
}

function parseWorktreePorcelain(stdout: string): Array<{ path: string; branch: string | null; head: string }> {
	const result: Array<{ path: string; branch: string | null; head: string }> = []
	let current: { path?: string; branch: string | null; head?: string } = { branch: null }
	for (const line of stdout.split('\n')) {
		if (line.startsWith('worktree ')) {
			if (current.path && current.head) result.push({ path: current.path, branch: current.branch, head: current.head })
			current = { path: line.slice('worktree '.length).trim(), branch: null }
		} else if (line.startsWith('HEAD ')) {
			current.head = line.slice('HEAD '.length).trim()
		} else if (line.startsWith('branch ')) {
			const ref = line.slice('branch '.length).trim()
			current.branch = ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref
		} else if (line.startsWith('detached')) {
			current.branch = null
		}
	}
	if (current.path && current.head) result.push({ path: current.path, branch: current.branch, head: current.head })
	return result
}

if (import.meta.vitest) {
	const { describe, test, expect, beforeEach, afterEach } = import.meta.vitest
	const path = await import('node:path')
	const { mkdtemp, rm, writeFile, readFile, stat, mkdir } = await import('node:fs/promises')
	const { tmpdir } = await import('node:os')
	const { realpath } = await import('node:fs/promises')

	describe('GitOps worktree primitives (real git on tmp repos)', () => {
		let repo: string
		let git: GitOps

		beforeEach(async () => {
			const raw = await mkdtemp(path.join(tmpdir(), 'trowel-gitops-'))
			repo = await realpath(raw)
			await exec('git', ['-C', repo, 'init', '-q', '-b', 'main'])
			await exec('git', ['-C', repo, 'config', 'user.email', 't@t.t'])
			await exec('git', ['-C', repo, 'config', 'user.name', 'T'])
			await writeFile(path.join(repo, 'README.md'), 'x\n')
			await exec('git', ['-C', repo, 'add', '.'])
			await exec('git', ['-C', repo, 'commit', '-q', '-m', 'init'])
			await exec('git', ['-C', repo, 'branch', 'feature'])
			git = createRepoGit(repo)
		})
		afterEach(async () => {
			if (repo) await rm(repo, { recursive: true, force: true })
		})

		test('worktreeAdd checks out the branch at a new worktree path', async () => {
			const wtPath = path.join(repo, '.trowel-wt-test')
			await git.worktreeAdd(wtPath, 'feature')
			const s = await stat(path.join(wtPath, 'README.md'))
			expect(s.isFile()).toBe(true)
			const branch = (await exec('git', ['-C', wtPath, 'rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim()
			expect(branch).toBe('feature')
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
