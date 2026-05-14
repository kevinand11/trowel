import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { exec } from '../utils/shell.ts'

/**
 * Test-only helpers. Centralise the mkdtemp + `git init` + identity + initial-commit
 * boilerplate that was duplicated across `git-ops`, `worktrees`, `turn`, and file storage
 * tests. Imported dynamically from inside `import.meta.vitest` blocks; not used in
 * production code paths.
 */

export type TestRepo = {
	root: string
	cleanup(): Promise<void>
}

export type TestRepoWithBare = {
	work: string
	bare: string
	cleanup(): Promise<void>
}

export type SetupTestRepoOptions = {
	/** Extra local branches to create off the initial commit. Default: []. */
	branches?: string[]
	/** Directory prefix passed to `mkdtemp`. Default: 'trowel-test-'. */
	prefix?: string
	/**
	 * Initial commit shape:
	 * - `'readme'` (default): writes `README.md` with body `x\n` and commits it.
	 * - `'empty'`: commits an empty tree (`--allow-empty`).
	 */
	initialCommit?: 'readme' | 'empty'
}

/**
 * Initialise a real on-disk git repo with one initial commit and optional extra branches.
 * `root` is the canonical (realpath-resolved) path — important on macOS where `tmpdir()`
 * resolves through `/private/var/...`. Tests must call `cleanup()` from `afterEach`.
 */
export async function setupTestRepo(options: SetupTestRepoOptions = {}): Promise<TestRepo> {
	const prefix = options.prefix ?? 'trowel-test-'
	const initialCommit = options.initialCommit ?? 'readme'
	const branches = options.branches ?? []

	const raw = await mkdtemp(path.join(tmpdir(), prefix))
	const root = await realpath(raw)

	await exec('git', ['-C', root, 'init', '-q', '-b', 'main'])
	await exec('git', ['-C', root, 'config', 'user.email', 't@t.t'])
	await exec('git', ['-C', root, 'config', 'user.name', 'T'])

	if (initialCommit === 'readme') {
		await writeFile(path.join(root, 'README.md'), 'x\n')
		await exec('git', ['-C', root, 'add', '.'])
		await exec('git', ['-C', root, 'commit', '-q', '-m', 'init'])
	} else {
		await exec('git', ['-C', root, 'commit', '-q', '--allow-empty', '-m', 'init'])
	}

	for (const branch of branches) {
		await exec('git', ['-C', root, 'branch', branch])
	}

	return {
		root,
		cleanup: async () => {
			await rm(root, { recursive: true, force: true })
		},
	}
}

export type SetupTestRepoWithBareOptions = {
	prefix?: string
}

/**
 * Initialise a working repo plus a bare "remote" with `origin` wired up. The initial
 * commit is empty (mirrors what file-storage tests need); main is pushed upstream.
 * Cleanup tears down both directories.
 */
export async function setupTestRepoWithBare(options: SetupTestRepoWithBareOptions = {}): Promise<TestRepoWithBare> {
	const prefix = options.prefix ?? 'trowel-test-'
	const bare = await mkdtemp(path.join(tmpdir(), `${prefix}bare-`))
	await exec('git', ['init', '--bare', '-q', '-b', 'main', bare])
	const work = await mkdtemp(path.join(tmpdir(), `${prefix}work-`))
	await exec('git', ['-C', work, 'init', '-q', '-b', 'main'])
	await exec('git', ['-C', work, 'config', 'user.email', 't@t.t'])
	await exec('git', ['-C', work, 'config', 'user.name', 'T'])
	await exec('git', ['-C', work, 'remote', 'add', 'origin', bare])
	await exec('git', ['-C', work, 'commit', '-q', '--allow-empty', '-m', 'init'])
	await exec('git', ['-C', work, 'push', '-q', '-u', 'origin', 'main'])
	return {
		work,
		bare,
		cleanup: async () => {
			await rm(work, { recursive: true, force: true })
			await rm(bare, { recursive: true, force: true })
		},
	}
}

if (import.meta.vitest) {
	const { describe, test, expect } = import.meta.vitest
	const { stat } = await import('node:fs/promises')

	describe('setupTestRepo', () => {
		test('initialises a repo on main with one commit and a README', async () => {
			const repo = await setupTestRepo()
			try {
				const branch = (await exec('git', ['-C', repo.root, 'rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim()
				expect(branch).toBe('main')
				const log = (await exec('git', ['-C', repo.root, 'log', '--oneline'])).stdout.trim()
				expect(log).toMatch(/init$/)
				const readmeStat = await stat(path.join(repo.root, 'README.md'))
				expect(readmeStat.isFile()).toBe(true)
			} finally {
				await repo.cleanup()
			}
		})

		test('creates each branch in opts.branches', async () => {
			const repo = await setupTestRepo({ branches: ['feature-a', 'feature-b'] })
			try {
				const branches = (await exec('git', ['-C', repo.root, 'branch'])).stdout
				expect(branches).toContain('feature-a')
				expect(branches).toContain('feature-b')
			} finally {
				await repo.cleanup()
			}
		})

		test('initialCommit:"empty" skips the README write', async () => {
			const repo = await setupTestRepo({ initialCommit: 'empty' })
			try {
				await expect(stat(path.join(repo.root, 'README.md'))).rejects.toThrow()
				const log = (await exec('git', ['-C', repo.root, 'log', '--oneline'])).stdout.trim()
				expect(log).toMatch(/init$/)
			} finally {
				await repo.cleanup()
			}
		})

		test('cleanup removes the temp dir', async () => {
			const repo = await setupTestRepo()
			await repo.cleanup()
			await expect(stat(repo.root)).rejects.toThrow()
		})
	})

	describe('setupTestRepoWithBare', () => {
		test('initialises work + bare with main pushed upstream', async () => {
			const f = await setupTestRepoWithBare()
			try {
				const remotes = (await exec('git', ['-C', f.work, 'remote', '-v'])).stdout
				expect(remotes).toContain(f.bare)
				const remoteHeads = (await exec('git', ['-C', f.work, 'ls-remote', '--heads', 'origin'])).stdout
				expect(remoteHeads).toContain('refs/heads/main')
			} finally {
				await f.cleanup()
			}
		})

		test('cleanup removes both directories', async () => {
			const f = await setupTestRepoWithBare()
			await f.cleanup()
			await expect(stat(f.work)).rejects.toThrow()
			await expect(stat(f.bare)).rejects.toThrow()
		})
	})
}
