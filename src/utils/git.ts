import { exec, tryExec } from './shell.ts'

export async function isCleanWorkingTree(cwd: string): Promise<boolean> {
	const unstaged = await tryExec('git', ['-C', cwd, 'diff', '--quiet'])
	const staged = await tryExec('git', ['-C', cwd, 'diff', '--cached', '--quiet'])
	return unstaged.ok && staged.ok
}

export async function currentBranch(cwd: string): Promise<string | null> {
	const result = await tryExec('git', ['-C', cwd, 'symbolic-ref', '--short', 'HEAD'])
	if (!result.ok) return null
	return result.stdout.trim()
}

export async function findGitRoot(cwd: string): Promise<string | null> {
	const result = await tryExec('git', ['-C', cwd, 'rev-parse', '--show-toplevel'])
	if (!result.ok) return null
	return result.stdout.trim()
}

export async function gitRemoteUrl(cwd: string, remote = 'origin'): Promise<string | null> {
	const result = await tryExec('git', ['-C', cwd, 'remote', 'get-url', remote])
	if (!result.ok) return null
	return result.stdout.trim()
}

export async function fetch(cwd: string, remote: string, ref: string): Promise<void> {
	await exec('git', ['-C', cwd, 'fetch', remote, ref])
}

export async function listOpenBranchesMatching(cwd: string, pattern: string): Promise<string[]> {
	const result = await tryExec('git', ['-C', cwd, 'ls-remote', '--heads', 'origin', pattern])
	if (!result.ok) return []
	return result.stdout
		.split('\n')
		.map((line) => line.trim())
		.filter(Boolean)
		.map((line) => line.split('refs/heads/')[1] ?? '')
		.filter(Boolean)
}

export async function branchTouchedFiles(cwd: string, branch: string, base: string): Promise<string[]> {
	const result = await tryExec('git', ['-C', cwd, 'diff', '--name-only', `${base}...${branch}`])
	if (!result.ok) return []
	return result.stdout.split('\n').map((s) => s.trim()).filter(Boolean)
}

if (import.meta.vitest) {
	const { describe, test, expect, beforeEach, afterEach } = import.meta.vitest
	const path = await import('node:path')
	const { mkdtemp, rm, writeFile } = await import('node:fs/promises')
	const { tmpdir } = await import('node:os')

	describe('git helpers (real git on tmp repos)', () => {
		let repo: string

		beforeEach(async () => {
			repo = await mkdtemp(path.join(tmpdir(), 'trowel-git-'))
			await exec('git', ['-C', repo, 'init', '-q', '-b', 'main'])
			await exec('git', ['-C', repo, 'config', 'user.email', 't@t.t'])
			await exec('git', ['-C', repo, 'config', 'user.name', 'T'])
			await writeFile(path.join(repo, 'README.md'), 'x\n')
			await exec('git', ['-C', repo, 'add', '.'])
			await exec('git', ['-C', repo, 'commit', '-q', '-m', 'init'])
		})
		afterEach(async () => {
			await rm(repo, { recursive: true, force: true })
		})

		test('findGitRoot returns the repo toplevel', async () => {
			const { realpath } = await import('node:fs/promises')
			expect(await findGitRoot(repo)).toBe(await realpath(repo))
		})

		test('findGitRoot returns null outside a repo', async () => {
			const outside = await mkdtemp(path.join(tmpdir(), 'trowel-not-git-'))
			try {
				expect(await findGitRoot(outside)).toBeNull()
			} finally {
				await rm(outside, { recursive: true, force: true })
			}
		})

		test('currentBranch returns the current branch name', async () => {
			expect(await currentBranch(repo)).toBe('main')
		})

		test('currentBranch returns null outside a repo', async () => {
			const outside = await mkdtemp(path.join(tmpdir(), 'trowel-not-git-'))
			try {
				expect(await currentBranch(outside)).toBeNull()
			} finally {
				await rm(outside, { recursive: true, force: true })
			}
		})

		test('isCleanWorkingTree is true when no uncommitted changes', async () => {
			expect(await isCleanWorkingTree(repo)).toBe(true)
		})

		test('isCleanWorkingTree is false when there are unstaged changes', async () => {
			await writeFile(path.join(repo, 'README.md'), 'changed\n')
			expect(await isCleanWorkingTree(repo)).toBe(false)
		})

		test('isCleanWorkingTree is false when there are staged changes', async () => {
			await writeFile(path.join(repo, 'new.txt'), 'staged\n')
			await exec('git', ['-C', repo, 'add', 'new.txt'])
			expect(await isCleanWorkingTree(repo)).toBe(false)
		})

		test('gitRemoteUrl returns null when no origin remote exists', async () => {
			expect(await gitRemoteUrl(repo)).toBeNull()
		})
	})
}
