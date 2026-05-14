import path from 'node:path'

import { loadConfig } from '../config.ts'
import { getStorage } from '../storages/registry.ts'
import type { ClassifiedSlice, Storage, StorageDeps, PrdSummary } from '../storages/types.ts'
import { classifySlices, type Bucket } from '../utils/bucket.ts'
import { realGhRunner } from '../utils/gh-runner.ts'
import { resolveBaseBranch } from '../utils/git.ts'

const BUCKET_ORDER: Bucket[] = ['done', 'needs-revision', 'in-flight', 'blocked', 'ready', 'draft']

export type PrdState = 'open' | 'closed' | 'all'

type PrdListRow = {
	summary: PrdSummary
	state: 'OPEN' | 'CLOSED'
	slices: ClassifiedSlice[]
}

function renderList(rows: PrdListRow[], filter: PrdState): string {
	if (rows.length === 0) {
		return filter === 'all' ? 'No PRDs found.\n' : `No ${filter} PRDs.\n`
	}
	const lines: string[] = []
	for (const row of rows) {
		const counts: Record<Bucket, number> = {
			done: 0,
			'needs-revision': 0,
			'in-flight': 0,
			blocked: 0,
			ready: 0,
			draft: 0,
		}
		for (const s of row.slices) counts[s.bucket]++
		const summary = row.slices.length === 0 ? '(no slices)' : formatCounts(counts)
		const idCol = row.summary.id.padEnd(8)
		const stateCol = row.state.padEnd(8)
		const titleCol = row.summary.title.padEnd(48)
		lines.push(`${idCol}  ${stateCol}  ${titleCol}  ${summary}`)
	}
	return `${lines.join('\n')}\n`
}

function formatCounts(counts: Record<Bucket, number>): string {
	return BUCKET_ORDER.filter((b) => counts[b] > 0)
		.map((b) => `${counts[b]} ${b}`)
		.join(' · ')
}

type ListRuntime = {
	storage: Storage
	stdout: (s: string) => void
}

async function runListPrds(filter: PrdState, rt: ListRuntime): Promise<void> {
	const summaries = await rt.storage.listPrds({ state: filter })
	// Storages return unsorted; sort newest-first here. See ADR `storage-behavior-separation` step 4.
	const sorted = [...summaries].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
	const rows: PrdListRow[] = await Promise.all(
		sorted.map(async (summary) => {
			const slices = classifySlices(await rt.storage.findSlices(summary.id))
			const found = await rt.storage.findPrd(summary.id)
			const state: 'OPEN' | 'CLOSED' = found?.state ?? 'OPEN'
			return { summary, state, slices }
		}),
	)
	rt.stdout(renderList(rows, filter))
}

export async function list(filter: PrdState, opts: { storage?: string }): Promise<void> {
	const { config, projectRoot } = await loadConfig()
	if (!projectRoot) {
		process.stderr.write('trowel list: no project root found\n')
		process.exit(1)
	}
	const storageKind = opts.storage ?? config.storage
	const baseBranch = await resolveBaseBranch(projectRoot)
	const storageDeps: StorageDeps = {
		gh: realGhRunner,
		repoRoot: projectRoot,
		projectRoot,
		baseBranch,
		prdsDir: path.resolve(projectRoot, config.docs.prdsDir),
		labels: config.labels,
		closeOptions: config.close,
		// list is read-only: no git, no confirm, no log needed.
	}
	const storage = getStorage(storageKind, storageDeps)
	try {
		await runListPrds(filter, {
			storage,
			stdout: (s) => process.stdout.write(s),
		})
	} catch (error) {
		process.stderr.write(`trowel list: ${(error as Error).message}\n`)
		process.exit(1)
	}
}

if (import.meta.vitest) {
	const { describe, test, expect } = import.meta.vitest

	function fakeSlice(overrides: Partial<ClassifiedSlice> = {}): ClassifiedSlice {
		return {
			id: 's1',
			title: 'A slice',
			body: '',
			state: 'OPEN',
			readyForAgent: true,
			needsRevision: false,
			bucket: 'ready',
			blockedBy: [],
			prState: null,
			branchAhead: false,
			...overrides,
		}
	}

	describe('renderList', () => {
		test('renders one open PRD with bucket counts', () => {
			const rows: PrdListRow[] = [
				{
					summary: { id: 'ab12cd', title: 'Add SSO', branch: 'prd/ab12cd-add-sso', createdAt: '2026-05-13T00:00:00.000Z' },
					state: 'OPEN',
					slices: [fakeSlice({ id: 's1', bucket: 'done' })],
				},
			]
			const out = renderList(rows, 'open')
			expect(out).toContain('ab12cd')
			expect(out).toContain('OPEN')
			expect(out).toContain('Add SSO')
			expect(out).toContain('1 done')
		})

		test('renders buckets in canonical order with empty ones omitted', () => {
			const rows: PrdListRow[] = [
				{
					summary: { id: 'p1', title: 'T', branch: 'b', createdAt: '2026-05-13T00:00:00.000Z' },
					state: 'OPEN',
					slices: [
						fakeSlice({ id: '1', bucket: 'ready' }),
						fakeSlice({ id: '2', bucket: 'done' }),
						fakeSlice({ id: '3', bucket: 'done' }),
						fakeSlice({ id: '4', bucket: 'blocked' }),
					],
				},
			]
			const out = renderList(rows, 'open')
			// Canonical: done · needs-revision · in-flight · blocked · ready · draft. Empties omitted.
			expect(out).toContain('2 done · 1 blocked · 1 ready')
			expect(out).not.toContain('needs-revision')
			expect(out).not.toContain('in-flight')
			expect(out).not.toContain('draft')
			// Ordering check: 'done' appears before 'blocked' which appears before 'ready'
			const doneIdx = out.indexOf('done')
			const blockedIdx = out.indexOf('blocked')
			const readyIdx = out.indexOf('ready')
			expect(doneIdx).toBeLessThan(blockedIdx)
			expect(blockedIdx).toBeLessThan(readyIdx)
		})

		test('empty list message is state-aware', () => {
			expect(renderList([], 'open')).toContain('No open PRDs')
			expect(renderList([], 'closed')).toContain('No closed PRDs')
			expect(renderList([], 'all')).toContain('No PRDs found')
		})

		test('CLOSED state renders for closed PRDs', () => {
			const rows: PrdListRow[] = [
				{
					summary: { id: 'ef34gh', title: 'Old work', branch: 'prd/ef34gh-old-work', createdAt: '2026-05-13T00:00:00.000Z' },
					state: 'CLOSED',
					slices: [fakeSlice({ id: 's1', bucket: 'done' })],
				},
			]
			expect(renderList(rows, 'all')).toContain('CLOSED')
		})
	})

	describe('runListPrds', () => {
		function fakeStorage(overrides: Partial<Storage>): Storage {
			return {
				name: 'fake',
				createPrd: async () => {
					throw new Error('nyi')
				},
				branchForExisting: async () => {
					throw new Error('nyi')
				},
				findPrd: async () => null,
				listPrds: async () => [],
				closePrd: async () => {},
				createSlice: async () => {
					throw new Error('nyi')
				},
				findSlices: async () => [],
				updateSlice: async () => {},
				...overrides,
			}
		}

		test('passes the filter through to storage.listPrds', async () => {
			let receivedState: PrdState | null = null
			const storage = fakeStorage({
				listPrds: async (opts) => {
					receivedState = opts.state
					return []
				},
			})
			const captured: string[] = []
			await runListPrds('closed', { storage, stdout: (s) => captured.push(s) })
			expect(receivedState).toBe('closed')
		})

		test('sorts PRDs newest-first by createdAt, regardless of the order the storage returned', async () => {
			const storage = fakeStorage({
				// Returned in the "wrong" order (oldest first) so the test proves the consumer sort flips it.
				listPrds: async () => [
					{ id: 'older', title: 'Older', branch: 'b/older', createdAt: '2026-05-10T00:00:00.000Z' },
					{ id: 'newer', title: 'Newer', branch: 'b/newer', createdAt: '2026-05-13T00:00:00.000Z' },
				],
				findPrd: async (id) => ({ id, title: id, branch: `b/${id}`, state: 'OPEN' }),
				findSlices: async () => [],
			})
			const captured: string[] = []
			await runListPrds('open', { storage, stdout: (s) => captured.push(s) })
			const text = captured.join('')
			expect(text.indexOf('newer')).toBeLessThan(text.indexOf('older'))
		})

		test('aborts the whole command when one findSlices rejects', async () => {
			const storage = fakeStorage({
				listPrds: async () => [
					{ id: 'a', title: 'A', branch: 'b/a', createdAt: '2026-05-12T00:00:00.000Z' },
					{ id: 'b', title: 'B', branch: 'b/b', createdAt: '2026-05-13T00:00:00.000Z' },
				],
				findPrd: async (id) => ({ id, title: id, branch: `b/${id}`, state: 'OPEN' }),
				findSlices: async (prdId) => {
					if (prdId === 'b') throw new Error('rate limited')
					return []
				},
			})
			await expect(runListPrds('open', { storage, stdout: () => {} })).rejects.toThrow(/rate limited/)
		})
	})
}
