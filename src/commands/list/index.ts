import type { StorageKind } from '../../storages/registry.ts'
import type { ClassifiedSlice, FixSummary, PrdSummary, Storage } from '../../storages/types.ts'
import { emptyBucketCounts, formatBucketCounts } from '../../utils/bucket-format.ts'
import type { Bucket } from '../../utils/bucket.ts'
import { createGh } from '../../utils/gh-ops.ts'
import { withMutationLock } from '../../utils/mutation-lock.ts'
import { reconcileEntity } from '../../work/reconcile.ts'
import { classifySlicesForPrd } from '../../work/slice-buckets.ts'
import { buildStorage, exitOnCommandError, loadCommandBase } from '../runtime.ts'

export type ListState = 'open' | 'closed' | 'all'

type PrdListRow = {
	summary: PrdSummary
	state: 'OPEN' | 'CLOSED'
	slices: ClassifiedSlice[]
}

function renderList(rows: PrdListRow[], filter: ListState): string {
	if (rows.length === 0) return emptyPrdListMessage(filter)
	return `${rows.map(renderPrdListRow).join('\n')}\n`
}

function emptyPrdListMessage(filter: ListState): string {
	return filter === 'all' ? 'No PRDs found.\n' : `No ${filter} PRDs.\n`
}

function renderPrdListRow(row: PrdListRow): string {
	const idCol = row.summary.id.padEnd(8)
	const stateCol = row.state.padEnd(8)
	const titleCol = row.summary.title.padEnd(48)
	return `${idCol}  ${stateCol}  ${titleCol}  ${prdSliceSummary(row.slices)}`
}

function prdSliceSummary(slices: ClassifiedSlice[]): string {
	return slices.length === 0 ? '(no slices)' : formatBucketCounts(bucketCounts(slices))
}

function bucketCounts(slices: ClassifiedSlice[]): Record<Bucket, number> {
	const counts: Record<Bucket, number> = emptyBucketCounts()
	for (const s of slices) counts[s.bucket]++
	return counts
}

type ListRuntime = {
	storage: Storage
	gh: ReturnType<typeof createGh>
	usePrs: boolean
	stdout: (s: string) => void
}

function newestFirst<T extends { createdAt: string }>(summaries: T[]): T[] {
	// Storages return unsorted; sort newest-first here. See ADR `storage-behavior-separation` step 4.
	return [...summaries].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

async function runListPrds(filter: ListState, rt: ListRuntime): Promise<void> {
	const sorted = newestFirst(await rt.storage.listPrds({ state: filter }))
	const rows: PrdListRow[] = await Promise.all(
		sorted.map(async (summary) => {
			const slices = await classifySlicesForPrd({ storage: rt.storage, gh: rt.gh, prdId: summary.id, usePrs: rt.usePrs })
			const found = await rt.storage.findPrd(summary.id)
			const state: 'OPEN' | 'CLOSED' = found?.state ?? 'OPEN'
			return { summary, state, slices }
		}),
	)
	rt.stdout(renderList(rows, filter))
}

type FixListRow = {
	summary: FixSummary
	state: 'OPEN' | 'CLOSED'
}

function renderFixList(rows: FixListRow[], filter: ListState): string {
	if (rows.length === 0) {
		return filter === 'all' ? 'No fixes found.\n' : `No ${filter} fixes.\n`
	}
	const lines = rows.map((row) => {
		const idCol = row.summary.id.padEnd(8)
		const stateCol = row.state.padEnd(8)
		const titleCol = row.summary.title.padEnd(48)
		return `${idCol}  ${stateCol}  ${titleCol}  ${row.summary.branch}`
	})
	return `${lines.join('\n')}\n`
}

async function runListFixes(filter: ListState, rt: ListRuntime): Promise<void> {
	const sorted = newestFirst(await rt.storage.listFixes({ state: filter }))
	const rows: FixListRow[] = await Promise.all(
		sorted.map(async (summary) => {
			const found = await rt.storage.findFix(summary.id)
			return { summary, state: found?.state ?? 'OPEN' as const }
		}),
	)
	rt.stdout(renderFixList(rows, filter))
}

async function buildListRuntime(opts: { storage?: string }): Promise<{ rt: ListRuntime; projectRoot: string; storage: Storage; gh: ReturnType<typeof createGh> }> {
	const base = await loadCommandBase('list')
	const storage = buildStorage(base, (opts.storage as StorageKind | undefined) ?? base.config.storage)
	return {
		rt: { storage, gh: base.gh, usePrs: base.config.work.usePrs, stdout: (s) => process.stdout.write(s) },
		projectRoot: base.projectRoot,
		storage,
		gh: base.gh,
	}
}

async function reconcileListedEntities(kind: 'prd' | 'fix', filter: ListState, storage: Storage, gh: ReturnType<typeof createGh>): Promise<void> {
	// Reconciliation may write CLOSED on entities whose Close-out PR merged on GitHub. Best-effort
	// per entity; failures are swallowed by reconcileEntity itself.
	const summaries = kind === 'prd' ? await storage.listPrds({ state: filter }) : await storage.listFixes({ state: filter })
	for (const s of summaries) {
		await reconcileEntity({ kind, id: s.id, branch: s.branch }, { storage, gh })
	}
}

async function runListedCommand(kind: 'prd' | 'fix', filter: ListState, opts: { storage?: string }): Promise<void> {
	const { rt, projectRoot, storage, gh } = await buildListRuntime(opts)
	await exitOnCommandError('list', () =>
		withMutationLock(projectRoot, async () => {
			await reconcileListedEntities(kind, filter, storage, gh)
			await (kind === 'prd' ? runListPrds(filter, rt) : runListFixes(filter, rt))
		}),
	)
}

export async function list(filter: ListState, opts: { storage?: string }): Promise<void> {
	await runListedCommand('prd', filter, opts)
}

export async function listFix(filter: ListState, opts: { storage?: string }): Promise<void> {
	await runListedCommand('fix', filter, opts)
}

if (import.meta.vitest) {
	const { describe, test, expect } = import.meta.vitest
	const { recordingGhOps } = await import('../../test-utils/gh-ops-recorder.ts')

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
			expect(out).toContain('2 done · 1 blocked · 1 ready')
			expect(out).not.toContain('needs-revision')
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

	describe('renderFixList', () => {
		test('renders one open fix', () => {
			const out = renderFixList([
				{ summary: { id: '5', title: 'Tabs render wrong', branch: 'fix/5-tabs-render-wrong', createdAt: '2026-05-17T00:00:00Z' }, state: 'OPEN' },
			], 'open')
			expect(out).toContain('5')
			expect(out).toContain('OPEN')
			expect(out).toContain('Tabs render wrong')
			expect(out).toContain('fix/5-tabs-render-wrong')
		})

		test('empty list message is state-aware', () => {
			expect(renderFixList([], 'open')).toContain('No open fixes')
			expect(renderFixList([], 'closed')).toContain('No closed fixes')
			expect(renderFixList([], 'all')).toContain('No fixes found')
		})
	})

	describe('runListPrds', () => {
		function fakeStorage(overrides: Partial<Storage>): Storage {
			return {
				createPrd: async () => { throw new Error('nyi') },
				findPrd: async () => null,
				listPrds: async () => [],
				closePrd: async () => {},
				createSlice: async () => { throw new Error('nyi') },
				findSlices: async () => [],
				findSlice: async () => null,
				updateSlice: async () => {},
				createFix: async () => { throw new Error('nyi') },
				findFix: async () => null,
				listFixes: async () => [],
				updateFix: async () => {},
				closeFix: async () => {},
				...overrides,
			}
		}

		test('passes the filter through to storage.listPrds', async () => {
			let receivedState: ListState | null = null
			const storage = fakeStorage({
				listPrds: async (opts) => {
					receivedState = opts.state
					return []
				},
			})
			const { gh } = recordingGhOps()
			const captured: string[] = []
			await runListPrds('closed', { storage, gh, usePrs: false, stdout: (s) => captured.push(s) })
			expect(receivedState).toBe('closed')
		})

		test('sorts PRDs newest-first by createdAt, regardless of the order the storage returned', async () => {
			const storage = fakeStorage({
				listPrds: async () => [
					{ id: 'older', title: 'Older', branch: 'b/older', createdAt: '2026-05-10T00:00:00.000Z' },
					{ id: 'newer', title: 'Newer', branch: 'b/newer', createdAt: '2026-05-13T00:00:00.000Z' },
				],
				findPrd: async (id) => ({ id, title: id, branch: `b/${id}`, state: 'OPEN' }),
				findSlices: async () => [],
			})
			const { gh } = recordingGhOps()
			const captured: string[] = []
			await runListPrds('open', { storage, gh, usePrs: false, stdout: (s) => captured.push(s) })
			const text = captured.join('')
			expect(text.indexOf('newer')).toBeLessThan(text.indexOf('older'))
		})

		test('usePrs:true counts a ready storage slice with an open PR as in-flight', async () => {
			const storage = fakeStorage({
				listPrds: async () => [{ id: '123', title: 'Paginated Reads', branch: '123-paginated-reads', createdAt: '2026-05-13T00:00:00.000Z' }],
				findPrd: async (id) => ({ id, title: 'Paginated Reads', branch: '123-paginated-reads', state: 'OPEN' }),
				findSlices: async () => [{ id: '124', title: 'Read query-shape validation', body: '', state: 'OPEN', readyForAgent: true, needsRevision: false, blockedBy: [], prState: null }],
			})
			const { gh } = recordingGhOps({
				listOpenPrs: async () => [{ number: 130, headRefName: 'prd-123/slice-124-read-query-shape-validation', isDraft: false }],
			})
			const captured: string[] = []
			await runListPrds('open', { storage, gh, usePrs: true, stdout: (s) => captured.push(s) })
			expect(captured.join('')).toContain('1 in-flight')
			expect(captured.join('')).not.toContain('1 ready')
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
			const { gh } = recordingGhOps()
			await expect(runListPrds('open', { storage, gh, usePrs: false, stdout: () => {} })).rejects.toThrow(/rate limited/)
		})
	})
}
