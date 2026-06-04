import { readdir } from 'node:fs/promises'
import path from 'node:path'

/**
 * Allocate the next id from the file-storage shared pool. Scans every Change directory under
 * `changesDir`, every slice directory under each Change's `slices/`, and every Fix directory under
 * `fixesDir`. Finds the maximum positive integer prefix (the `42` in `42-some-slug/`) and
 * returns `max + 1`. Returns `1` when no existing entities are found.
 *
 * Compute-on-demand; no persisted counter. Callers must hold the **Mutation lock** so that the
 * scan + mkdir of the new entity directory happen atomically. See ADR
 * `2026-05-17-file-storage-deterministic-shared-ids.md` and
 * `2026-05-17-fix-entity-unified-close-out.md`.
 */
export async function allocateNextId(changesDir: string, fixesDir?: string): Promise<string> {
	const seen = await collectUsedIds(changesDir, fixesDir)
	return String(nextIdAfter(seen))
}

async function collectUsedIds(changesDir: string, fixesDir?: string): Promise<number[]> {
	const changeIds = await collectChangeAndSliceIds(changesDir)
	const fixIds = fixesDir ? await collectDirectoryIds(fixesDir) : []
	return [...changeIds, ...fixIds]
}

async function collectChangeAndSliceIds(changesDir: string): Promise<number[]> {
	const ids: number[] = []
	for (const changeEntry of await readdirSafe(changesDir)) {
		ids.push(...idFromName(changeEntry))
		ids.push(...(await collectDirectoryIds(path.join(changesDir, changeEntry, 'slices'))))
	}
	return ids
}

async function collectDirectoryIds(dir: string): Promise<number[]> {
	return (await readdirSafe(dir)).flatMap(idFromName)
}

function idFromName(name: string): number[] {
	const id = parseIntPrefix(name)
	return id === null ? [] : [id]
}

function nextIdAfter(ids: number[]): number {
	return ids.length === 0 ? 1 : Math.max(...ids) + 1
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
