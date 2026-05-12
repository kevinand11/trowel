import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

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

		test('creates .trowel/ and .trowel/.gitignore with worktrees/ and logs/ entries when both are missing', async () => {
			await ensureTrowelDir(projectRoot)
			const gitignore = await readFile(path.join(projectRoot, '.trowel', '.gitignore'), 'utf8')
			expect(gitignore).toContain('worktrees/')
			expect(gitignore).toContain('logs/')
		})

		test('idempotent: a second call does not clobber lines that are already correct', async () => {
			await ensureTrowelDir(projectRoot)
			const handEdited = 'worktrees/\nlogs/\n# my custom comment\nbuild/\n'
			await writeFile(path.join(projectRoot, '.trowel', '.gitignore'), handEdited)
			await ensureTrowelDir(projectRoot)
			const gitignore = await readFile(path.join(projectRoot, '.trowel', '.gitignore'), 'utf8')
			expect(gitignore).toBe(handEdited)
		})

		test('appends missing required entries to a hand-edited .gitignore', async () => {
			await mkdir(path.join(projectRoot, '.trowel'), { recursive: true })
			await writeFile(path.join(projectRoot, '.trowel', '.gitignore'), 'build/\n')
			await ensureTrowelDir(projectRoot)
			const gitignore = await readFile(path.join(projectRoot, '.trowel', '.gitignore'), 'utf8')
			expect(gitignore).toContain('build/')
			expect(gitignore).toContain('worktrees/')
			expect(gitignore).toContain('logs/')
		})

		test('appends missing entries when existing .gitignore lacks a trailing newline', async () => {
			await mkdir(path.join(projectRoot, '.trowel'), { recursive: true })
			await writeFile(path.join(projectRoot, '.trowel', '.gitignore'), 'build/')
			await ensureTrowelDir(projectRoot)
			const gitignore = await readFile(path.join(projectRoot, '.trowel', '.gitignore'), 'utf8')
			expect(gitignore).toMatch(/^build\/\n/)
			expect(gitignore).toContain('worktrees/')
			expect(gitignore).toContain('logs/')
			expect(gitignore.endsWith('\n')).toBe(true)
		})

		test('writes a fresh .gitignore when .trowel/ already exists but .gitignore does not', async () => {
			await mkdir(path.join(projectRoot, '.trowel'), { recursive: true })
			await ensureTrowelDir(projectRoot)
			const gitignore = await readFile(path.join(projectRoot, '.trowel', '.gitignore'), 'utf8')
			expect(gitignore).toContain('worktrees/')
			expect(gitignore).toContain('logs/')
		})

		test('appends only the missing entry when .gitignore already has one of the required lines', async () => {
			await mkdir(path.join(projectRoot, '.trowel'), { recursive: true })
			await writeFile(path.join(projectRoot, '.trowel', '.gitignore'), 'worktrees/\n')
			await ensureTrowelDir(projectRoot)
			const gitignore = await readFile(path.join(projectRoot, '.trowel', '.gitignore'), 'utf8')
			expect(gitignore.match(/^worktrees\/$/gm)).toHaveLength(1) // no duplicate
			expect(gitignore).toContain('logs/')
		})
	})
}
