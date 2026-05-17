import { readdir } from 'node:fs/promises'
import path from 'node:path'

/**
 * Allocate the next id from the file-storage shared pool. Scans every PRD directory under
 * `prdsDir` and every slice directory under each PRD's `slices/`, finds the maximum positive
 * integer prefix (the `42` in `42-some-slug/`), and returns `max + 1`. Returns `1` when no
 * existing entities are found.
 *
 * Compute-on-demand; no persisted counter. Callers must hold the **Mutation lock** so that the
 * scan + mkdir of the new entity directory happen atomically. See ADR
 * `2026-05-17-file-storage-deterministic-shared-ids.md`.
 */
export async function allocateNextId(prdsDir: string): Promise<string> {
	const seen: number[] = []
	const prdEntries = await readdirSafe(prdsDir)
	for (const prdEntry of prdEntries) {
		const n = parseIntPrefix(prdEntry)
		if (n !== null) seen.push(n)
		const sliceEntries = await readdirSafe(path.join(prdsDir, prdEntry, 'slices'))
		for (const sliceEntry of sliceEntries) {
			const m = parseIntPrefix(sliceEntry)
			if (m !== null) seen.push(m)
		}
	}
	const next = seen.length === 0 ? 1 : Math.max(...seen) + 1
	return String(next)
}

async function readdirSafe(dir: string): Promise<string[]> {
	try {
		return await readdir(dir)
	} catch {
		return []
	}
}

function parseIntPrefix(name: string): number | null {
	const m = /^(\d+)-/.exec(name)
	if (!m) return null
	const n = Number(m[1])
	return Number.isSafeInteger(n) && n > 0 ? n : null
}
