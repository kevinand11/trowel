import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

import lockfile from 'proper-lockfile'

/**
 * Run `fn` while holding trowel's project-wide mutation lock at
 * `<projectRoot>/.trowel/lock`. Mutating orchestrators acquire this around the smallest coherent
 * operation that mutates trowel-managed state; read-only commands (`status`, `list`, `config`,
 * `doctor`) do not.
 *
 * The lock is not reentrant. Storage implementations do not acquire it; callers must avoid nested
 * lock acquisition by placing the lock at the coherent operation boundary. Cross-process and
 * cross-async-context contention uses `proper-lockfile`: on contention, retries with backoff for
 * ~5 s and then throws `Error('trowel busy: another command holds the lock')`. Stale locks (no
 * mtime refresh for 30 s) are reclaimed transparently. See ADR
 * `2026-05-17-file-storage-deterministic-shared-ids.md` and later amendments.
 */
export async function withMutationLock<T>(projectRoot: string, fn: () => Promise<T>): Promise<T> {
	const key = path.resolve(projectRoot)
	const release = await acquireMutationLock(key)
	try {
		return await fn()
	} finally {
		await release()
	}
}

async function acquireMutationLock(key: string): Promise<() => Promise<void>> {
	const trowelDir = path.join(key, '.trowel')
	const lockPath = path.join(trowelDir, 'lock')
	await mkdir(trowelDir, { recursive: true })
	// proper-lockfile locks against an existing path; ensure the target file exists so the lock can
	// pin to it without us racing the create step.
	await ensureFile(lockPath)
	try {
		return await lockfile.lock(lockPath, {
			retries: { retries: 50, minTimeout: 50, maxTimeout: 200, factor: 1.2 },
			stale: 30_000,
		})
	} catch (err) {
		throw mutationLockError(err)
	}
}

function mutationLockError(err: unknown): Error {
	if ((err as { code?: string }).code === 'ELOCKED') return new Error('trowel busy: another command holds the lock')
	return err as Error
}

async function ensureFile(p: string): Promise<void> {
	try {
		await writeFile(p, '', { flag: 'wx' })
	} catch (err) {
		if ((err as { code?: string }).code === 'EEXIST') return
		throw err
	}
}

if (import.meta.vitest) {
	const { describe, test, expect, afterEach } = import.meta.vitest
	const { mkdtemp, rm, readdir } = await import('node:fs/promises')
	const { tmpdir } = await import('node:os')

	const tempDirs: string[] = []

	async function makeProjectRoot(): Promise<string> {
		const dir = await mkdtemp(path.join(tmpdir(), 'trowel-lock-'))
		tempDirs.push(dir)
		return dir
	}

	afterEach(async () => {
		while (tempDirs.length > 0) {
			const d = tempDirs.pop()!
			await rm(d, { recursive: true, force: true })
		}
	})

	describe('withMutationLock', () => {
		test('runs fn and returns its result when uncontended', async () => {
			const root = await makeProjectRoot()
			const result = await withMutationLock(root, async () => 42)
			expect(result).toBe(42)
			// `.trowel/lock` file is left behind (target of the lock); the `.lock` sibling is cleared.
			const after = await readdir(path.join(root, '.trowel'))
			expect(after).toContain('lock')
			expect(after).not.toContain('lock.lock')
		})

		test('releases the lock even when fn throws', async () => {
			const root = await makeProjectRoot()
			await expect(
				withMutationLock(root, async () => {
					throw new Error('boom')
				}),
			).rejects.toThrow(/boom/)
			// A second acquisition succeeds → release ran in finally.
			const result = await withMutationLock(root, async () => 'ok')
			expect(result).toBe('ok')
		})

		test('serialises overlapping invocations against the same project root', async () => {
			const root = await makeProjectRoot()
			const log: string[] = []
			const slow = withMutationLock(root, async () => {
				log.push('A-start')
				await new Promise((r) => setTimeout(r, 80))
				log.push('A-end')
			})
			// Fire the second one slightly after so it definitely finds the lock held.
			await new Promise((r) => setTimeout(r, 10))
			const fast = withMutationLock(root, async () => {
				log.push('B-start')
				log.push('B-end')
			})
			await Promise.all([slow, fast])
			expect(log).toEqual(['A-start', 'A-end', 'B-start', 'B-end'])
		})
	})
}
