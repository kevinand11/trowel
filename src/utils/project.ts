import { access } from 'node:fs/promises'
import path from 'node:path'

async function exists(p: string): Promise<boolean> {
	try {
		await access(p)
		return true
	} catch {
		return false
	}
}

/**
 * Walk up from `cwd` to the nearest `.trowel/` (preferred) or `.git/` (fallback).
 * Returns the resolved project root, or null if neither is found.
 */
export async function resolveProjectRoot(cwd: string): Promise<string | null> {
	let dir = path.resolve(cwd)
	while (true) {
		const managedOwner = await managedWorktreeOwner(dir)
		if (managedOwner) return managedOwner
		if (await exists(path.join(dir, '.trowel'))) return dir
		if (await exists(path.join(dir, '.git'))) return dir
		const parent = path.dirname(dir)
		if (parent === dir) return null
		dir = parent
	}
}

async function managedWorktreeOwner(dir: string): Promise<string | null> {
	const parts = managedWorktreeParts(dir)
	if (!parts) return null
	return (await exists(path.join(parts.owner, '.trowel'))) ? parts.owner : null
}

function managedWorktreeParts(dir: string): { owner: string; worktreeKind: string } | null {
	const resolved = path.resolve(dir)
	const marker = `${path.sep}.trowel${path.sep}worktrees${path.sep}`
	const markerIndex = resolved.indexOf(marker)
	if (markerIndex === -1) return null
	const worktreeKind = resolved.slice(markerIndex + marker.length).split(path.sep)[0]!
	return isManagedWorktreeKind(worktreeKind) ? { owner: resolved.slice(0, markerIndex), worktreeKind } : null
}

function isManagedWorktreeKind(kind: string): boolean {
	return kind === 'changes' || kind === 'lanes'
}

if (import.meta.vitest) {
	const { describe, test, expect, beforeEach, afterEach } = import.meta.vitest
	const { mkdtemp, mkdir, rm } = await import('node:fs/promises')
	const { tmpdir } = await import('node:os')

	describe('resolveProjectRoot', () => {
		let root: string

		beforeEach(async () => {
			root = await mkdtemp(path.join(tmpdir(), 'trowel-project-'))
		})
		afterEach(async () => {
			await rm(root, { recursive: true, force: true })
		})

		test('returns the dir containing .git/ when found at cwd', async () => {
			await mkdir(path.join(root, '.git'))
			const resolved = await resolveProjectRoot(root)
			expect(resolved).toBe(root)
		})

		test('returns the dir containing .trowel/ when found at cwd', async () => {
			await mkdir(path.join(root, '.trowel'))
			const resolved = await resolveProjectRoot(root)
			expect(resolved).toBe(root)
		})

		test('walks up to find an ancestor containing .git/', async () => {
			await mkdir(path.join(root, '.git'))
			const nested = path.join(root, 'a', 'b', 'c')
			await mkdir(nested, { recursive: true })
			const resolved = await resolveProjectRoot(nested)
			expect(resolved).toBe(root)
		})

		test('prefers a closer .trowel/ over a farther .git/', async () => {
			await mkdir(path.join(root, '.git'))
			const sub = path.join(root, 'pkg')
			await mkdir(path.join(sub, '.trowel'), { recursive: true })
			const resolved = await resolveProjectRoot(sub)
			expect(resolved).toBe(sub)
		})

		test('resolves from a managed lane worktree back to the owning project root', async () => {
			await mkdir(path.join(root, '.git'))
			await mkdir(path.join(root, '.trowel'))
			const lane = path.join(root, '.trowel', 'worktrees', 'lanes', '17', 'src')
			await mkdir(path.join(lane, '.git'), { recursive: true })
			const resolved = await resolveProjectRoot(lane)
			expect(resolved).toBe(root)
		})

		test('resolves from a managed Change worktree back to the owning project root', async () => {
			await mkdir(path.join(root, '.git'))
			await mkdir(path.join(root, '.trowel'))
			const worktree = path.join(root, '.trowel', 'worktrees', 'changes', '3', 'branch', 'src')
			await mkdir(path.join(worktree, '.git'), { recursive: true })
			const resolved = await resolveProjectRoot(worktree)
			expect(resolved).toBe(root)
		})

		test('returns null when no .trowel/ or .git/ is found in any ancestor', async () => {
			// `root` is a fresh tmpdir; ancestors above tmpdir are unlikely to have .git/.
			// To make this deterministic, we resolve from a deep subpath inside root.
			const deep = path.join(root, 'x', 'y')
			await mkdir(deep, { recursive: true })
			const resolved = await resolveProjectRoot(deep)
			// Either null OR a real ancestor (if the test machine has .git somewhere above tmpdir).
			// Accept null as the canonical outcome; otherwise verify it's not inside `root`.
			if (resolved !== null) {
				expect(resolved.startsWith(root)).toBe(false)
			}
		})
	})
}
