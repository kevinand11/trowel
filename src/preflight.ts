import path from 'node:path'

import type { Config } from './schema.ts'
import { ghIsAuthenticated } from './utils/gh.ts'
import { currentBranch, fetch, isCleanWorkingTree } from './utils/git.ts'

export type PreflightFailure = {
	check: string
	message: string
}

export async function runPreflight(opts: { config: Config; projectRoot: string | null }): Promise<PreflightFailure[]> {
	const failures: PreflightFailure[] = []
	const { config, projectRoot } = opts

	if (config.preconditions.requireGitRoot && !projectRoot) {
		failures.push({ check: 'git-root', message: 'No `.trowel/` or `.git/` found in any ancestor; trowel requires a recognised project root.' })
	}

	if (config.preconditions.requireCleanTree && projectRoot) {
		const clean = await isCleanWorkingTree(projectRoot)
		if (!clean) {
			failures.push({ check: 'clean-tree', message: 'Working tree has uncommitted changes. Stash or commit first.' })
		}
	}

	if (config.preconditions.requireGhAuth) {
		const authed = await ghIsAuthenticated()
		if (!authed) {
			failures.push({ check: 'gh-auth', message: '`gh` is not authenticated. Run `gh auth login` first.' })
		}
	}

	return failures
}

export async function captureBranch(cwd: string): Promise<string | null> {
	return currentBranch(cwd)
}

export async function fetchBase(cwd: string, baseBranch: string): Promise<void> {
	await fetch(cwd, 'origin', baseBranch)
}

export type CollisionReport = {
	branch: string
	files: string[]
}

// Cross-PRD collision detection: stub for v0. Full implementation lands with storages,
// which know which branches to scan and how to identify "this PRD's branch".
export async function detectCollisions(_opts: { config: Config; projectRoot: string }): Promise<CollisionReport[]> {
	return []
}

if (import.meta.vitest) {
	const { describe, test, expect, beforeEach, afterEach } = import.meta.vitest
	const { mkdtemp, rm, writeFile } = await import('node:fs/promises')
	const { tmpdir } = await import('node:os')
	const { exec } = await import('./utils/shell.ts')
	const { defaultConfig, mergePartial } = await import('./schema.ts')

	const allChecksOff = (): Config =>
		mergePartial(defaultConfig, {
			preconditions: { requireCleanTree: false, requireGitRoot: false, requireGhAuth: false },
		})

	describe('runPreflight', () => {
		test('returns [] when no preconditions are required', async () => {
			const failures = await runPreflight({ config: allChecksOff(), projectRoot: null })
			expect(failures).toEqual([])
		})

		test('flags `git-root` when requireGitRoot is true and projectRoot is null', async () => {
			const cfg = mergePartial(allChecksOff(), { preconditions: { requireGitRoot: true } })
			const failures = await runPreflight({ config: cfg, projectRoot: null })
			expect(failures.map((f) => f.check)).toEqual(['git-root'])
		})

		test('does not flag `git-root` when projectRoot is present', async () => {
			const cfg = mergePartial(allChecksOff(), { preconditions: { requireGitRoot: true } })
			const failures = await runPreflight({ config: cfg, projectRoot: '/some/root' })
			expect(failures.find((f) => f.check === 'git-root')).toBeUndefined()
		})
	})

	describe('runPreflight clean-tree check', () => {
		let project: string

		beforeEach(async () => {
			project = await mkdtemp(path.join(tmpdir(), 'trowel-preflight-'))
			await exec('git', ['-C', project, 'init', '-q'])
			await exec('git', ['-C', project, 'config', 'user.email', 'test@example.com'])
			await exec('git', ['-C', project, 'config', 'user.name', 'Test'])
			await writeFile(path.join(project, 'README.md'), 'initial\n')
			await exec('git', ['-C', project, 'add', '.'])
			await exec('git', ['-C', project, 'commit', '-q', '-m', 'init'])
		})
		afterEach(async () => {
			await rm(project, { recursive: true, force: true })
		})

		test('passes when working tree is clean', async () => {
			const cfg = mergePartial(allChecksOff(), { preconditions: { requireCleanTree: true } })
			const failures = await runPreflight({ config: cfg, projectRoot: project })
			expect(failures.find((f) => f.check === 'clean-tree')).toBeUndefined()
		})

		test('flags `clean-tree` when there are uncommitted changes', async () => {
			await writeFile(path.join(project, 'dirty.txt'), 'unstaged\n')
			await exec('git', ['-C', project, 'add', 'dirty.txt'])
			const cfg = mergePartial(allChecksOff(), { preconditions: { requireCleanTree: true } })
			const failures = await runPreflight({ config: cfg, projectRoot: project })
			expect(failures.map((f) => f.check)).toEqual(['clean-tree'])
		})
	})

	describe('captureBranch', () => {
		test('returns null when cwd is not a git repo', async () => {
			const dir = await mkdtemp(path.join(tmpdir(), 'trowel-cap-'))
			try {
				const branch = await captureBranch(dir)
				expect(branch).toBeNull()
			} finally {
				await rm(dir, { recursive: true, force: true })
			}
		})
	})

	describe('detectCollisions', () => {
		test('returns [] (v0 stub)', async () => {
			const cfg = allChecksOff()
			const result = await detectCollisions({ config: cfg, projectRoot: '/some/root' })
			expect(result).toEqual([])
		})
	})
}
