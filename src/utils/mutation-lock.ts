import { AsyncLocalStorage } from 'node:async_hooks'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

import lockfile from 'proper-lockfile'

/**
 * Async-context store of project roots whose lock the current async stack holds. Inner calls to
 * `withMutationLock` consult this store: if the root is already in our context's set, the call is
 * reentrant and skips `proper-lockfile`. Different concurrent async contexts have their own sets,
 * so a `Promise.all` of two independent `withMutationLock` calls correctly serialises (only one
 * acquires the OS lock; the other waits and retries).
 */
const heldRoots = new AsyncLocalStorage<Set<string>>()

/**
 * Run `fn` while holding trowel's project-wide mutation lock at
 * `<projectRoot>/.trowel/lock`. Any command that mutates state (PRD/slice CRUD, branch ops,
 * `closePrd`) wraps its entry function in this; read-only commands (`status`, `list`, `config`,
 * `doctor`) do not.
 *
 * Reentrant per async context — nested `withMutationLock` calls on the same project root, in the
 * same async stack, are bookkeeping only, so command-layer wrappers and inner storage-method
 * wrappers compose without deadlocking. Cross-process and cross-async-context contention still
 * uses `proper-lockfile`: on contention, retries with backoff for ~5 s and then throws
 * `Error('trowel busy: another command holds the lock')`. Stale locks (no mtime refresh for 30 s)
 * are reclaimed transparently. See ADR `2026-05-17-file-storage-deterministic-shared-ids.md`.
 */
export async function withMutationLock<T>(projectRoot: string, fn: () => Promise<T>): Promise<T> {
	const key = path.resolve(projectRoot)
	const heldHere = heldRoots.getStore()
	if (heldHere && heldHere.has(key)) {
		return fn()
	}
	const trowelDir = path.join(key, '.trowel')
	const lockPath = path.join(trowelDir, 'lock')
	await mkdir(trowelDir, { recursive: true })
	// proper-lockfile locks against an existing path; ensure the target file exists so the lock can
	// pin to it without us racing the create step.
	await ensureFile(lockPath)
	let release: () => Promise<void>
	try {
		release = await lockfile.lock(lockPath, {
			retries: { retries: 50, minTimeout: 50, maxTimeout: 200, factor: 1.2 },
			stale: 30_000,
		})
	} catch (err) {
		if ((err as { code?: string }).code === 'ELOCKED') {
			throw new Error('trowel busy: another command holds the lock')
		}
		throw err
	}
	const nextSet = new Set(heldHere ?? [])
	nextSet.add(key)
	try {
		return await heldRoots.run(nextSet, fn)
	} finally {
		await release()
	}
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

		test('reentrant within the same process — nested calls do not deadlock', async () => {
			const root = await makeProjectRoot()
			const result = await withMutationLock(root, async () => withMutationLock(root, async () => withMutationLock(root, async () => 'nested-ok')))
			expect(result).toBe('nested-ok')
			// Lock is fully released after the outermost call exits.
			const after = await withMutationLock(root, async () => 'still-acquirable')
			expect(after).toBe('still-acquirable')
		})

		test('reentry releases the outer lock only when the outermost call exits', async () => {
			const root = await makeProjectRoot()
			let innerThrew = false
			await expect(
				withMutationLock(root, async () => {
					try {
						await withMutationLock(root, async () => {
							throw new Error('inner-fail')
						})
					} catch {
						innerThrew = true
					}
					// Outer is still held; we can still nest a sibling call.
					await withMutationLock(root, async () => undefined)
					throw new Error('outer-fail')
				}),
			).rejects.toThrow(/outer-fail/)
			expect(innerThrew).toBe(true)
			// Lock fully released after outer throw.
			const after = await withMutationLock(root, async () => 'fresh')
			expect(after).toBe('fresh')
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
