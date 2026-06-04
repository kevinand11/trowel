import { cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'

import type { GitOps } from '../utils/git-ops.ts'
import { slug } from '../utils/slug.ts'

const REQUIRED_TROWEL_GITIGNORE_ENTRIES = ['worktrees/', 'logs/']

export async function ensureTrowelDir(projectRoot: string): Promise<void> {
	const trowelDir = path.join(projectRoot, '.trowel')
	await mkdir(trowelDir, { recursive: true })
	await ensureTrowelGitignore(path.join(trowelDir, '.gitignore'))
}

async function ensureTrowelGitignore(gitignorePath: string): Promise<void> {
	const existing = await readOptionalFile(gitignorePath)
	if (existing === null) {
		await writeGitignoreEntries(gitignorePath, REQUIRED_TROWEL_GITIGNORE_ENTRIES)
		return
	}
	const missing = missingGitignoreEntries(existing, REQUIRED_TROWEL_GITIGNORE_ENTRIES)
	if (missing.length > 0) await appendGitignoreEntries(gitignorePath, existing, missing)
}

async function readOptionalFile(filePath: string): Promise<string | null> {
	try {
		return await readFile(filePath, 'utf8')
	} catch {
		return null
	}
}

async function writeGitignoreEntries(gitignorePath: string, entries: string[]): Promise<void> {
	await writeFile(gitignorePath, `${entries.join('\n')}\n`)
}

function missingGitignoreEntries(existing: string, required: string[]): string[] {
	const presentLines = new Set(existing.split('\n').map((line) => line.trim()))
	return required.filter((entry) => !presentLines.has(entry))
}

async function appendGitignoreEntries(gitignorePath: string, existing: string, entries: string[]): Promise<void> {
	const sep = gitignoreAppendSeparator(existing)
	await writeFile(gitignorePath, `${existing}${sep}${entries.join('\n')}\n`)
}

function gitignoreAppendSeparator(existing: string): string {
	return existing.length > 0 && !existing.endsWith('\n') ? '\n' : ''
}

export type TurnWorktree = { worktreePath: string; branch: string; changeId: string }
type GitWorktree = Awaited<ReturnType<GitOps['worktreeList']>>[number]

function worktreePathFor(projectRoot: string, changeId: string, branch: string): string {
	return path.join(projectRoot, '.trowel', 'worktrees', changeId, slug(branch))
}

export async function ensureWorktree(args: {
	changeId: string
	branch: string
	projectRoot: string
	copyToWorktree: string[]
	git: GitOps
	log?: (m: string) => void
}): Promise<TurnWorktree> {
	const worktreePath = worktreePathFor(args.projectRoot, args.changeId, args.branch)
	const wt: TurnWorktree = { worktreePath, branch: args.branch, changeId: args.changeId }

	const existing = await findRegisteredWorktree(args.git, worktreePath)
	if (existing) return reuseRegisteredWorktree(existing, wt)
	await assertNoStaleWorktreePath(worktreePath)

	await createWorktree(wt, args.git)
	await copyWorktreeEntries(args.projectRoot, wt.worktreePath, args.copyToWorktree, args.log)
	return wt
}

async function findRegisteredWorktree(git: GitOps, worktreePath: string): Promise<GitWorktree | undefined> {
	return (await git.worktreeList()).find((w) => w.path === worktreePath)
}

function reuseRegisteredWorktree(existing: GitWorktree, wt: TurnWorktree): TurnWorktree {
	if (existing.branch === wt.branch) return wt
	throw new Error(`worktree path '${wt.worktreePath}' is registered for branch '${existing.branch ?? '(detached)'}', expected '${wt.branch}'; run Change ship or abort Cleanup, or move the worktree aside`)
}

async function assertNoStaleWorktreePath(worktreePath: string): Promise<void> {
	if (await pathExists(worktreePath)) throw new Error(`worktree path '${worktreePath}' already exists but is not a registered git worktree; run Change ship or abort Cleanup, or move it aside`)
}

async function createWorktree(wt: TurnWorktree, git: GitOps): Promise<void> {
	await mkdir(path.dirname(wt.worktreePath), { recursive: true })
	await git.worktreeAdd(wt.worktreePath, wt.branch)
}

async function copyWorktreeEntries(projectRoot: string, worktreePath: string, entries: string[], log?: (m: string) => void): Promise<void> {
	for (const entry of entries) await copyWorktreeEntry(projectRoot, worktreePath, entry, log)
}

async function copyWorktreeEntry(projectRoot: string, worktreePath: string, entry: string, log?: (m: string) => void): Promise<void> {
	const src = path.join(projectRoot, entry)
	const dst = path.join(worktreePath, entry)
	try {
		await mkdir(path.dirname(dst), { recursive: true })
		await cp(src, dst, { recursive: true })
	} catch (e) {
		log?.(`ensureWorktree: failed to copy ${entry} into ${worktreePath}: ${(e as Error).message}`)
	}
}

export async function resetWorktree(wt: TurnWorktree, git: GitOps): Promise<void> {
	await git.restoreAll(wt.worktreePath)
	await git.cleanUntracked(wt.worktreePath)
}

async function destroyWorktree(wt: TurnWorktree, git: GitOps): Promise<void> {
	try {
		await git.worktreeRemove(wt.worktreePath, { force: true })
	} catch {
		// fall through to fs cleanup
	}
	await rm(wt.worktreePath, { recursive: true, force: true })
}

export async function sweepOrphanWorktrees(args: {
	projectRoot: string
	orphanCheck: (changeId: string, branch: string) => Promise<boolean>
	cleanupAge: string
	git: GitOps
	now?: Date
}): Promise<void> {
	const minAgeMs = parseDurationMs(args.cleanupAge)
	const now = (args.now ?? new Date()).getTime()
	const root = path.join(args.projectRoot, '.trowel', 'worktrees')
	for (const w of await args.git.worktreeList()) await sweepWorktreeIfOrphan(args, root, minAgeMs, now, w)
}

async function sweepWorktreeIfOrphan(args: { orphanCheck: (changeId: string, branch: string) => Promise<boolean>; git: GitOps }, root: string, minAgeMs: number, now: number, w: GitWorktree): Promise<void> {
	const candidate = await orphanWorktreeCandidate(root, minAgeMs, now, w)
	if (!candidate) return
	if (!(await args.orphanCheck(candidate.changeId, candidate.branch))) return
	await destroyWorktree(candidate, args.git)
}

async function orphanWorktreeCandidate(root: string, minAgeMs: number, now: number, w: GitWorktree): Promise<TurnWorktree | null> {
	if (!isUnderWorktreeRoot(root, w.path)) return null
	return candidateInsideWorktreeRoot(root, minAgeMs, now, w)
}

async function candidateInsideWorktreeRoot(root: string, minAgeMs: number, now: number, w: GitWorktree): Promise<TurnWorktree | null> {
	const ids = worktreeIdsFromPath(root, w.path)
	if (!ids) return null
	if (!(await worktreeOldEnough(w.path, minAgeMs, now))) return null
	return { worktreePath: w.path, changeId: ids.changeId, branch: worktreeBranch(w, ids.branchSlug) }
}

function worktreeBranch(w: GitWorktree, branchSlug: string): string {
	return w.branch ?? branchSlug
}

function isUnderWorktreeRoot(root: string, worktreePath: string): boolean {
	return worktreePath.startsWith(`${root}${path.sep}`)
}

function worktreeIdsFromPath(root: string, worktreePath: string): { changeId: string; branchSlug: string } | null {
	const parts = path.relative(root, worktreePath).split(path.sep)
	if (parts.length < 2) return null
	return { changeId: parts[0]!, branchSlug: parts[1]! }
}

async function worktreeOldEnough(worktreePath: string, minAgeMs: number, now: number): Promise<boolean> {
	const s = await stat(worktreePath).catch(() => null)
	return s !== null && now - s.mtimeMs >= minAgeMs
}

async function pathExists(p: string): Promise<boolean> {
	try {
		await stat(p)
		return true
	} catch {
		return false
	}
}

function parseDurationMs(input: string): number {
	const m = /^(\d+)\s*(ms|s|m|h|d)$/i.exec(input.trim())
	if (!m) throw new Error(`invalid duration: ${input}`)
	const n = parseInt(m[1], 10)
	const unit = m[2].toLowerCase()
	const factor: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }
	return n * factor[unit]
}

if (import.meta.vitest) {
	const { describe, test, expect, beforeEach, afterEach } = import.meta.vitest
	const { createRepoGit } = await import('../utils/git-ops.ts')
	const { setupTestRepo } = await import('../test-utils/git-repo.ts')
	const { mkdir: fsMkdir, mkdtemp, readFile: fsReadFile, rm: fsRm, writeFile: fsWriteFile, stat: fsStat } = await import('node:fs/promises')
	const { tmpdir } = await import('node:os')

	describe('ensureTrowelDir', () => {
		let projectRoot: string
		beforeEach(async () => {
			projectRoot = await mkdtemp(path.join(tmpdir(), 'trowel-ensure-'))
		})
		afterEach(async () => {
			await fsRm(projectRoot, { recursive: true, force: true })
		})

		async function expectGitignoreHasRequiredEntries(): Promise<string> {
			await ensureTrowelDir(projectRoot)
			const gitignore = await fsReadFile(path.join(projectRoot, '.trowel', '.gitignore'), 'utf8')
			expect(gitignore).toContain('worktrees/')
			expect(gitignore).toContain('logs/')
			return gitignore
		}

		test('creates .trowel/ and .trowel/.gitignore with worktrees/ and logs/ entries when both are missing', async () => {
			await expectGitignoreHasRequiredEntries()
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
			await expectGitignoreHasRequiredEntries()
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
		let cleanupRepo: () => Promise<void>

		beforeEach(async () => {
			const r = await setupTestRepo({ prefix: 'trowel-wt-', branches: ['feature-a', 'feature-b'] })
			projectRoot = r.root
			cleanupRepo = r.cleanup
			git = createRepoGit(projectRoot)
		})
		afterEach(async () => {
			if (cleanupRepo) await cleanupRepo()
		})

		test('ensureWorktree creates a new worktree at .trowel/worktrees/<changeId>/<slug>/', async () => {
			const wt = await ensureWorktree({ changeId: 'p1', branch: 'feature-a', projectRoot, copyToWorktree: [], git })
			expect(wt.worktreePath).toBe(path.join(projectRoot, '.trowel', 'worktrees', 'p1', 'feature-a'))
			const s = await fsStat(path.join(wt.worktreePath, 'README.md'))
			expect(s.isFile()).toBe(true)
		})

		test('ensureWorktree is idempotent: second call reuses the existing worktree', async () => {
			const first = await ensureWorktree({ changeId: 'p1', branch: 'feature-a', projectRoot, copyToWorktree: [], git })
			const second = await ensureWorktree({ changeId: 'p1', branch: 'feature-a', projectRoot, copyToWorktree: [], git })
			expect(second.worktreePath).toBe(first.worktreePath)
			const list = await git.worktreeList()
			const matches = list.filter((w) => w.path === first.worktreePath)
			expect(matches).toHaveLength(1)
		})

		test('ensureWorktree copies copyToWorktree entries on first creation', async () => {
			await fsWriteFile(path.join(projectRoot, '.env.local'), 'SECRET=1\n')
			const wt = await ensureWorktree({ changeId: 'p1', branch: 'feature-a', projectRoot, copyToWorktree: ['.env.local'], git })
			const copied = await fsReadFile(path.join(wt.worktreePath, '.env.local'), 'utf8')
			expect(copied).toBe('SECRET=1\n')
		})

		test('ensureWorktree refuses a registered worktree path for a different branch without removing it', async () => {
			const wtPath = path.join(projectRoot, '.trowel', 'worktrees', 'p1', 'feature-a')
			await fsMkdir(path.dirname(wtPath), { recursive: true })
			await git.worktreeAdd(wtPath, 'feature-b')
			await expect(ensureWorktree({ changeId: 'p1', branch: 'feature-a', projectRoot, copyToWorktree: [], git })).rejects.toThrow(/registered for branch 'feature-b'/)
			expect((await git.worktreeList()).find((w) => w.path === wtPath)).toBeDefined()
			expect((await fsStat(wtPath)).isDirectory()).toBe(true)
		})

		test('ensureWorktree refuses a stale path without deleting it', async () => {
			const wtPath = path.join(projectRoot, '.trowel', 'worktrees', 'p1', 'feature-a')
			await fsMkdir(wtPath, { recursive: true })
			await fsWriteFile(path.join(wtPath, 'keep.txt'), 'do not delete\n')
			await expect(ensureWorktree({ changeId: 'p1', branch: 'feature-a', projectRoot, copyToWorktree: [], git })).rejects.toThrow(/already exists/)
			expect(await fsReadFile(path.join(wtPath, 'keep.txt'), 'utf8')).toBe('do not delete\n')
		})

		test('resetWorktree discards uncommitted changes but preserves gitignored files', async () => {
			const wt = await ensureWorktree({ changeId: 'p1', branch: 'feature-a', projectRoot, copyToWorktree: [], git })
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
			const wt = await ensureWorktree({ changeId: 'p1', branch: 'feature-a', projectRoot, copyToWorktree: [], git })
			await fsWriteFile(path.join(wt.worktreePath, 'dirty.txt'), 'leftover\n')
			await destroyWorktree(wt, git)
			expect((await git.worktreeList()).find((w) => w.path === wt.worktreePath)).toBeUndefined()
			await expect(fsStat(wt.worktreePath)).rejects.toThrow()
			await destroyWorktree(wt, git)
		})

		test('sweepOrphanWorktrees removes orphans older than cleanupAge and keeps active ones', async () => {
			const wtOrphan = await ensureWorktree({ changeId: 'p1', branch: 'feature-a', projectRoot, copyToWorktree: [], git })
			const wtActive = await ensureWorktree({ changeId: 'p1', branch: 'feature-b', projectRoot, copyToWorktree: [], git })

			await sweepOrphanWorktrees({
				projectRoot,
				git,
				cleanupAge: '24h',
				now: new Date(Date.now() + 48 * 3_600_000),
				orphanCheck: async (changeId, branch) => changeId === 'p1' && branch === 'feature-a',
			})

			expect((await git.worktreeList()).find((w) => w.path === wtOrphan.worktreePath)).toBeUndefined()
			expect((await git.worktreeList()).find((w) => w.path === wtActive.worktreePath)).toBeDefined()
		})

		test('sweepOrphanWorktrees skips worktrees younger than cleanupAge even when orphanCheck says orphan', async () => {
			const wt = await ensureWorktree({ changeId: 'p1', branch: 'feature-a', projectRoot, copyToWorktree: [], git })
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
