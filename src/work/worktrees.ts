import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { exec } from '../utils/shell.ts'

export async function addWorktree(repoRoot: string, worktreePath: string, branch: string): Promise<void> {
	await mkdir(path.dirname(worktreePath), { recursive: true })
	await exec('git', ['-C', repoRoot, 'worktree', 'add', '-q', worktreePath, branch])
}

export async function removeWorktree(repoRoot: string, worktreePath: string): Promise<void> {
	await exec('git', ['-C', repoRoot, 'worktree', 'remove', '--force', worktreePath])
}

export async function pruneStaleWorktrees(repoRoot: string, worktreesDir: string, before: Date): Promise<void> {
	let prdDirs: string[]
	try {
		prdDirs = await readdir(worktreesDir)
	} catch {
		return
	}
	for (const prd of prdDirs) {
		const prdPath = path.join(worktreesDir, prd)
		let entries: string[]
		try {
			entries = await readdir(prdPath)
		} catch {
			continue
		}
		for (const entry of entries) {
			const wtPath = path.join(prdPath, entry)
			let mtime: Date
			try {
				mtime = (await stat(wtPath)).mtime
			} catch {
				continue
			}
			if (mtime >= before) continue
			try {
				await removeWorktree(repoRoot, wtPath)
			} catch {
				// Worktree may already be orphaned (not registered with git). Best-effort cleanup.
			}
		}
	}
}

export async function ensureTrowelDir(projectRoot: string): Promise<void> {
	const trowelDir = path.join(projectRoot, '.trowel')
	await mkdir(trowelDir, { recursive: true })
	const gitignorePath = path.join(trowelDir, '.gitignore')
	let existing: string | null = null
	try {
		existing = await readFile(gitignorePath, 'utf8')
	} catch {
		existing = null
	}
	if (existing === null) {
		await writeFile(gitignorePath, 'worktrees/\n')
		return
	}
	const hasEntry = existing.split('\n').some((line) => line.trim() === 'worktrees/')
	if (hasEntry) return
	const sep = existing.length > 0 && !existing.endsWith('\n') ? '\n' : ''
	await writeFile(gitignorePath, `${existing}${sep}worktrees/\n`)
}

if (import.meta.vitest) {
	const { describe, test, expect, beforeEach, afterEach } = import.meta.vitest
	const { mkdir, mkdtemp, readFile, rm, writeFile } = await import('node:fs/promises')
	const { tmpdir } = await import('node:os')

	describe('ensureTrowelDir', () => {
		let projectRoot: string
		beforeEach(async () => {
			projectRoot = await mkdtemp(path.join(tmpdir(), 'trowel-ensure-'))
		})
		afterEach(async () => {
			await rm(projectRoot, { recursive: true, force: true })
		})

		test('creates .trowel/ and .trowel/.gitignore with worktrees/ entry when both are missing', async () => {
			await ensureTrowelDir(projectRoot)
			const gitignore = await readFile(path.join(projectRoot, '.trowel', '.gitignore'), 'utf8')
			expect(gitignore).toBe('worktrees/\n')
		})

		test('idempotent: a second call does not clobber the existing .gitignore', async () => {
			await ensureTrowelDir(projectRoot)
			const handEdited = 'worktrees/\n# my custom comment\nbuild/\n'
			await writeFile(path.join(projectRoot, '.trowel', '.gitignore'), handEdited)
			await ensureTrowelDir(projectRoot)
			const gitignore = await readFile(path.join(projectRoot, '.trowel', '.gitignore'), 'utf8')
			expect(gitignore).toBe(handEdited)
		})

		test('appends worktrees/ to a hand-edited .gitignore that does not contain it', async () => {
			await mkdir(path.join(projectRoot, '.trowel'), { recursive: true })
			await writeFile(path.join(projectRoot, '.trowel', '.gitignore'), 'build/\n')
			await ensureTrowelDir(projectRoot)
			const gitignore = await readFile(path.join(projectRoot, '.trowel', '.gitignore'), 'utf8')
			expect(gitignore).toBe('build/\nworktrees/\n')
		})

		test('appends worktrees/ when .gitignore is missing a trailing newline', async () => {
			await mkdir(path.join(projectRoot, '.trowel'), { recursive: true })
			await writeFile(path.join(projectRoot, '.trowel', '.gitignore'), 'build/')
			await ensureTrowelDir(projectRoot)
			const gitignore = await readFile(path.join(projectRoot, '.trowel', '.gitignore'), 'utf8')
			expect(gitignore).toBe('build/\nworktrees/\n')
		})

		test('writes a fresh .gitignore when .trowel/ already exists but .gitignore does not', async () => {
			await mkdir(path.join(projectRoot, '.trowel'), { recursive: true })
			await ensureTrowelDir(projectRoot)
			const gitignore = await readFile(path.join(projectRoot, '.trowel', '.gitignore'), 'utf8')
			expect(gitignore).toBe('worktrees/\n')
		})
	})

	describe('addWorktree', () => {
		let repoRoot: string
		beforeEach(async () => {
			repoRoot = await mkdtemp(path.join(tmpdir(), 'trowel-wt-'))
			await exec('git', ['-C', repoRoot, 'init', '-q', '-b', 'main'])
			await exec('git', ['-C', repoRoot, 'config', 'user.email', 't@t.t'])
			await exec('git', ['-C', repoRoot, 'config', 'user.name', 'T'])
			await exec('git', ['-C', repoRoot, 'commit', '-q', '--allow-empty', '-m', 'init'])
			await exec('git', ['-C', repoRoot, 'branch', 'feature'])
		})
		afterEach(async () => {
			await rm(repoRoot, { recursive: true, force: true })
		})

		test('creates a worktree at the given path checked out to the given branch', async () => {
			const wtPath = path.join(repoRoot, '.trowel', 'worktrees', 'abc', 'wt')
			await addWorktree(repoRoot, wtPath, 'feature')
			const { stdout: head } = await exec('git', ['-C', wtPath, 'rev-parse', '--abbrev-ref', 'HEAD'])
			expect(head.trim()).toBe('feature')
		})
	})

	describe('removeWorktree', () => {
		let repoRoot: string
		beforeEach(async () => {
			repoRoot = await mkdtemp(path.join(tmpdir(), 'trowel-wt-rm-'))
			await exec('git', ['-C', repoRoot, 'init', '-q', '-b', 'main'])
			await exec('git', ['-C', repoRoot, 'config', 'user.email', 't@t.t'])
			await exec('git', ['-C', repoRoot, 'config', 'user.name', 'T'])
			await exec('git', ['-C', repoRoot, 'commit', '-q', '--allow-empty', '-m', 'init'])
			await exec('git', ['-C', repoRoot, 'branch', 'feature'])
		})
		afterEach(async () => {
			await rm(repoRoot, { recursive: true, force: true })
		})

		test('removes a previously-added worktree, leaving no record in `git worktree list`', async () => {
			const wtPath = path.join(repoRoot, '.trowel', 'worktrees', 'abc', 'wt')
			await addWorktree(repoRoot, wtPath, 'feature')
			await removeWorktree(repoRoot, wtPath)
			const { stdout: list } = await exec('git', ['-C', repoRoot, 'worktree', 'list', '--porcelain'])
			expect(list).not.toContain('refs/heads/feature')
		})
	})

	describe('pruneStaleWorktrees', () => {
		let repoRoot: string
		beforeEach(async () => {
			repoRoot = await mkdtemp(path.join(tmpdir(), 'trowel-wt-prune-'))
			await exec('git', ['-C', repoRoot, 'init', '-q', '-b', 'main'])
			await exec('git', ['-C', repoRoot, 'config', 'user.email', 't@t.t'])
			await exec('git', ['-C', repoRoot, 'config', 'user.name', 'T'])
			await exec('git', ['-C', repoRoot, 'commit', '-q', '--allow-empty', '-m', 'init'])
			await exec('git', ['-C', repoRoot, 'branch', 'old'])
			await exec('git', ['-C', repoRoot, 'branch', 'fresh'])
		})
		afterEach(async () => {
			await rm(repoRoot, { recursive: true, force: true })
		})

		test('removes worktrees whose mtime is older than `before`, leaving newer ones in place', async () => {
			const wtDir = path.join(repoRoot, '.trowel', 'worktrees')
			const oldWt = path.join(wtDir, 'prd-1', 'old')
			const freshWt = path.join(wtDir, 'prd-1', 'fresh')
			await addWorktree(repoRoot, oldWt, 'old')
			await addWorktree(repoRoot, freshWt, 'fresh')

			const { utimes } = await import('node:fs/promises')
			const oldTime = new Date(Date.now() - 48 * 60 * 60 * 1000) // 48h ago
			await utimes(oldWt, oldTime, oldTime)

			const before = new Date(Date.now() - 24 * 60 * 60 * 1000) // 24h threshold
			await pruneStaleWorktrees(repoRoot, wtDir, before)

			const { stdout: list } = await exec('git', ['-C', repoRoot, 'worktree', 'list', '--porcelain'])
			expect(list).not.toContain('refs/heads/old')
			expect(list).toContain('refs/heads/fresh')
		})
	})
}

