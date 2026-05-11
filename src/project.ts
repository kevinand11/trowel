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
		if ((await exists(path.join(dir, '.trowel'))) || (await exists(path.join(dir, '.git')))) {
			return dir
		}
		const parent = path.dirname(dir)
		if (parent === dir) return null
		dir = parent
	}
}
