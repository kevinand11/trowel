import { cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'

import type { GitOps } from '../utils/git-ops.ts'
import { slug } from '../utils/slug.ts'

export async function ensureTrowelDir(projectRoot: string): Promise<void> {
	const trowelDir = path.join(projectRoot, '.trowel')
	await mkdir(trowelDir, { recursive: true })
	const gitignorePath = path.join(trowelDir, '.gitignore')
	const required = ['worktrees/', 'logs/']
	let existing: string | null = null
	try {
		existing = await readFile(gitignorePath, 'utf8')
	} catch {
		existing = null
	}
	if (existing === null) {
		await writeFile(gitignorePath, `${required.join('\n')}\n`)
		return
	}
	const presentLines = new Set(existing.split('\n').map((line) => line.trim()))
	const missing = required.filter((entry) => !presentLines.has(entry))
	if (missing.length === 0) return
	const sep = existing.length > 0 && !existing.endsWith('\n') ? '\n' : ''
	await writeFile(gitignorePath, `${existing}${sep}${missing.join('\n')}\n`)
}

export type TurnWorktree = { worktreePath: string; branch: string; prdId: string }

export function worktreePathFor(projectRoot: string, prdId: string, branch: string): string {
	return path.join(projectRoot, '.trowel', 'worktrees', prdId, slug(branch))
}

export async function ensureWorktree(args: {
	prdId: string
	branch: string
	projectRoot: string
	copyToWorktree: string[]
	git: GitOps
	log?: (m: string) => void
}): Promise<TurnWorktree> {
	const worktreePath = worktreePathFor(args.projectRoot, args.prdId, args.branch)
	const wt: TurnWorktree = { worktreePath, branch: args.branch, prdId: args.prdId }

	const existing = (await args.git.worktreeList()).find((w) => w.path === worktreePath)
	if (existing) {
		if (existing.branch === args.branch) return wt
		await destroyWorktree(wt, args.git)
	} else if (await pathExists(worktreePath)) {
		await rm(worktreePath, { recursive: true, force: true })
	}

	await mkdir(path.dirname(worktreePath), { recursive: true })
	await args.git.worktreeAdd(worktreePath, args.branch)

	for (const entry of args.copyToWorktree) {
		const src = path.join(args.projectRoot, entry)
		const dst = path.join(worktreePath, entry)
		try {
			await mkdir(path.dirname(dst), { recursive: true })
			await cp(src, dst, { recursive: true })
		} catch (e) {
			args.log?.(`ensureWorktree: failed to copy ${entry} into ${worktreePath}: ${(e as Error).message}`)
		}
	}

	return wt
}

export async function resetWorktree(wt: TurnWorktree, git: GitOps): Promise<void> {
	await git.restoreAll(wt.worktreePath)
	await git.cleanUntracked(wt.worktreePath)
}

export async function destroyWorktree(wt: TurnWorktree, git: GitOps): Promise<void> {
	try {
		await git.worktreeRemove(wt.worktreePath, { force: true })
	} catch {
		// fall through to fs cleanup
	}
	await rm(wt.worktreePath, { recursive: true, force: true })
}

export async function sweepOrphanWorktrees(args: {
	projectRoot: string
	orphanCheck: (prdId: string, branch: string) => Promise<boolean>
	cleanupAge: string
	git: GitOps
	now?: Date
}): Promise<void> {
	const minAgeMs = parseDurationMs(args.cleanupAge)
	const now = (args.now ?? new Date()).getTime()
	const root = path.join(args.projectRoot, '.trowel', 'worktrees')
	const list = await args.git.worktreeList()
	for (const w of list) {
		if (!w.path.startsWith(`${root}${path.sep}`)) continue
		const rel = path.relative(root, w.path)
		const parts = rel.split(path.sep)
		if (parts.length < 2) continue
		const [prdId, branchSlug] = parts
		const s = await stat(w.path).catch(() => null)
		if (!s) continue
		if (now - s.mtimeMs < minAgeMs) continue
		const branch = w.branch ?? branchSlug
		if (!(await args.orphanCheck(prdId, branch))) continue
		await destroyWorktree({ worktreePath: w.path, branch, prdId }, args.git)
	}
}

async function pathExists(p: string): Promise<boolean> {
	try {
		await stat(p)
		return true
	} catch {
		return false
	}
}

export function parseDurationMs(input: string): number {
	const m = /^(\d+)\s*(ms|s|m|h|d)$/i.exec(input.trim())
	if (!m) throw new Error(`invalid duration: ${input}`)
	const n = parseInt(m[1], 10)
	const unit = m[2].toLowerCase()
	const factor: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }
	return n * factor[unit]
}

if (import.meta.vitest) {
	const { describe, test, expect, beforeEach, afterEach } = import.meta.vitest
	const { exec } = await import('../utils/shell.ts')
	const { createRepoGit } = await import('../utils/git-ops.ts')
	const { mkdir: fsMkdir, mkdtemp, readFile: fsReadFile, rm: fsRm, writeFile: fsWriteFile, stat: fsStat, realpath } = await import('node:fs/promises')
	const { tmpdir } = await import('node:os')

	describe('ensureTrowelDir', () => {
		let projectRoot: string
		beforeEach(async () => {
			projectRoot = await mkdtemp(path.join(tmpdir(), 'trowel-ensure-'))
		})
		afterEach(async () => {
			await fsRm(projectRoot, { recursive: true, force: true })
		})

		test('creates .trowel/ and .trowel/.gitignore with worktrees/ and logs/ entries when both are missing', async () => {
			await ensureTrowelDir(projectRoot)
			const gitignore = await fsReadFile(path.join(projectRoot, '.trowel', '.gitignore'), 'utf8')
			expect(gitignore).toContain('worktrees/')
			expect(gitignore).toContain('logs/')
		})

		test('idempotent: a second call does not clobber lines that are already correct', async () => {
			await ensureTrowelDir(projectRoot)
			const handEdited = 'worktrees/\nlogs/\n# my custom comment\nbuild/\n'
			await fsWriteFile(path.join(projectRoot, '.trowel', '.gitignore'), handEdited)
			await ensureTrowelDir(projectRoot)
			const gitignore = await fsReadFile(path.join(projectRoot, '.trowel', '.gitignore'), 'utf8')
			expect(gitignore).toBe(handEdited)
		})

		test('appends missing required entries to a hand-edited .gitignore', async () => {
			await fsMkdir(path.join(projectRoot, '.trowel'), { recursive: true })
			await fsWriteFile(path.join(projectRoot, '.trowel', '.gitignore'), 'build/\n')
			await ensureTrowelDir(projectRoot)
			const gitignore = await fsReadFile(path.join(projectRoot, '.trowel', '.gitignore'), 'utf8')
			expect(gitignore).toContain('build/')
			expect(gitignore).toContain('worktrees/')
			expect(gitignore).toContain('logs/')
		})

		test('appends missing entries when existing .gitignore lacks a trailing newline', async () => {
			await fsMkdir(path.join(projectRoot, '.trowel'), { recursive: true })
			await fsWriteFile(path.join(projectRoot, '.trowel', '.gitignore'), 'build/')
			await ensureTrowelDir(projectRoot)
			const gitignore = await fsReadFile(path.join(projectRoot, '.trowel', '.gitignore'), 'utf8')
			expect(gitignore).toMatch(/^build\/\n/)
			expect(gitignore).toContain('worktrees/')
			expect(gitignore).toContain('logs/')
			expect(gitignore.endsWith('\n')).toBe(true)
		})

		test('writes a fresh .gitignore when .trowel/ already exists but .gitignore does not', async () => {
			await fsMkdir(path.join(projectRoot, '.trowel'), { recursive: true })
			await ensureTrowelDir(projectRoot)
			const gitignore = await fsReadFile(path.join(projectRoot, '.trowel', '.gitignore'), 'utf8')
			expect(gitignore).toContain('worktrees/')
			expect(gitignore).toContain('logs/')
		})

		test('appends only the missing entry when .gitignore already has one of the required lines', async () => {
			await fsMkdir(path.join(projectRoot, '.trowel'), { recursive: true })
			await fsWriteFile(path.join(projectRoot, '.trowel', '.gitignore'), 'worktrees/\n')
			await ensureTrowelDir(projectRoot)
			const gitignore = await fsReadFile(path.join(projectRoot, '.trowel', '.gitignore'), 'utf8')
			expect(gitignore.match(/^worktrees\/$/gm)).toHaveLength(1)
			expect(gitignore).toContain('logs/')
		})
	})

	describe('parseDurationMs', () => {
		test('parses h/m/s/d/ms units', () => {
			expect(parseDurationMs('24h')).toBe(24 * 3_600_000)
			expect(parseDurationMs('30m')).toBe(30 * 60_000)
			expect(parseDurationMs('45s')).toBe(45_000)
			expect(parseDurationMs('2d')).toBe(2 * 86_400_000)
			expect(parseDurationMs('500ms')).toBe(500)
		})
		test('throws on unparseable input', () => {
			expect(() => parseDurationMs('not-a-duration')).toThrow()
		})
	})

	describe('ensureWorktree / resetWorktree / destroyWorktree / sweepOrphanWorktrees (real git)', () => {
		let projectRoot: string
		let git: GitOps

		beforeEach(async () => {
			const raw = await mkdtemp(path.join(tmpdir(), 'trowel-wt-'))
			projectRoot = await realpath(raw)
			await exec('git', ['-C', projectRoot, 'init', '-q', '-b', 'main'])
			await exec('git', ['-C', projectRoot, 'config', 'user.email', 't@t.t'])
			await exec('git', ['-C', projectRoot, 'config', 'user.name', 'T'])
			await fsWriteFile(path.join(projectRoot, 'README.md'), 'x\n')
			await exec('git', ['-C', projectRoot, 'add', '.'])
			await exec('git', ['-C', projectRoot, 'commit', '-q', '-m', 'init'])
			await exec('git', ['-C', projectRoot, 'branch', 'feature-a'])
			await exec('git', ['-C', projectRoot, 'branch', 'feature-b'])
			git = createRepoGit(projectRoot)
		})
		afterEach(async () => {
			if (projectRoot) await fsRm(projectRoot, { recursive: true, force: true })
		})

		test('ensureWorktree creates a new worktree at .trowel/worktrees/<prdId>/<slug>/', async () => {
			const wt = await ensureWorktree({ prdId: 'p1', branch: 'feature-a', projectRoot, copyToWorktree: [], git })
			expect(wt.worktreePath).toBe(path.join(projectRoot, '.trowel', 'worktrees', 'p1', 'feature-a'))
			const s = await fsStat(path.join(wt.worktreePath, 'README.md'))
			expect(s.isFile()).toBe(true)
		})

		test('ensureWorktree is idempotent: second call reuses the existing worktree', async () => {
			const first = await ensureWorktree({ prdId: 'p1', branch: 'feature-a', projectRoot, copyToWorktree: [], git })
			const second = await ensureWorktree({ prdId: 'p1', branch: 'feature-a', projectRoot, copyToWorktree: [], git })
			expect(second.worktreePath).toBe(first.worktreePath)
			const list = await git.worktreeList()
			const matches = list.filter((w) => w.path === first.worktreePath)
			expect(matches).toHaveLength(1)
		})

		test('ensureWorktree copies copyToWorktree entries on first creation', async () => {
			await fsWriteFile(path.join(projectRoot, '.env.local'), 'SECRET=1\n')
			const wt = await ensureWorktree({ prdId: 'p1', branch: 'feature-a', projectRoot, copyToWorktree: ['.env.local'], git })
			const copied = await fsReadFile(path.join(wt.worktreePath, '.env.local'), 'utf8')
			expect(copied).toBe('SECRET=1\n')
		})

		test('resetWorktree discards uncommitted changes but preserves gitignored files', async () => {
			const wt = await ensureWorktree({ prdId: 'p1', branch: 'feature-a', projectRoot, copyToWorktree: [], git })
			await fsWriteFile(path.join(wt.worktreePath, '.gitignore'), 'keep/\n')
			await fsMkdir(path.join(wt.worktreePath, 'keep'), { recursive: true })
			await fsWriteFile(path.join(wt.worktreePath, 'keep', 'a.txt'), 'gitignored\n')
			await fsWriteFile(path.join(wt.worktreePath, 'README.md'), 'dirty\n')
			await resetWorktree(wt, git)
			expect(await fsReadFile(path.join(wt.worktreePath, 'README.md'), 'utf8')).toBe('x\n')
			const keepStat = await fsStat(path.join(wt.worktreePath, 'keep', 'a.txt'))
			expect(keepStat.isFile()).toBe(true)
		})

		test('destroyWorktree removes the worktree from git and from disk; second call is idempotent', async () => {
			const wt = await ensureWorktree({ prdId: 'p1', branch: 'feature-a', projectRoot, copyToWorktree: [], git })
			await fsWriteFile(path.join(wt.worktreePath, 'dirty.txt'), 'leftover\n')
			await destroyWorktree(wt, git)
			expect((await git.worktreeList()).find((w) => w.path === wt.worktreePath)).toBeUndefined()
			await expect(fsStat(wt.worktreePath)).rejects.toThrow()
			await destroyWorktree(wt, git)
		})

		test('sweepOrphanWorktrees removes orphans older than cleanupAge and keeps active ones', async () => {
			const wtOrphan = await ensureWorktree({ prdId: 'p1', branch: 'feature-a', projectRoot, copyToWorktree: [], git })
			const wtActive = await ensureWorktree({ prdId: 'p1', branch: 'feature-b', projectRoot, copyToWorktree: [], git })

			await sweepOrphanWorktrees({
				projectRoot,
				git,
				cleanupAge: '24h',
				now: new Date(Date.now() + 48 * 3_600_000),
				orphanCheck: async (prdId, branch) => prdId === 'p1' && branch === 'feature-a',
			})

			expect((await git.worktreeList()).find((w) => w.path === wtOrphan.worktreePath)).toBeUndefined()
			expect((await git.worktreeList()).find((w) => w.path === wtActive.worktreePath)).toBeDefined()
		})

		test('sweepOrphanWorktrees skips worktrees younger than cleanupAge even when orphanCheck says orphan', async () => {
			const wt = await ensureWorktree({ prdId: 'p1', branch: 'feature-a', projectRoot, copyToWorktree: [], git })
			await sweepOrphanWorktrees({
				projectRoot,
				git,
				cleanupAge: '24h',
				now: new Date(),
				orphanCheck: async () => true,
			})
			expect((await git.worktreeList()).find((w) => w.path === wt.worktreePath)).toBeDefined()
		})
	})
}
