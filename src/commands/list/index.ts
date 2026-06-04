import type { StorageKind } from '../../storages/registry.ts'
import type { ClassifiedSlice, ChangeSummary, Storage } from '../../storages/types.ts'
import { emptyBucketCounts, formatBucketCounts } from '../../utils/bucket-format.ts'
import type { Bucket } from '../../utils/bucket.ts'
import { createGh } from '../../utils/gh-ops.ts'
import { withMutationLock } from '../../utils/mutation-lock.ts'
import { reconcileEntity } from '../../work/reconcile.ts'
import { classifySlicesForChange } from '../../work/slice-buckets.ts'
import { buildStorage, exitOnCommandError, loadCommandBase } from '../runtime.ts'

export type ListState = 'open' | 'closed' | 'all'

type ChangeListRow = {
	summary: ChangeSummary
	state: 'OPEN' | 'CLOSED'
	slices: ClassifiedSlice[]
}

function renderList(rows: ChangeListRow[], filter: ListState): string {
	if (rows.length === 0) return emptyChangeListMessage(filter)
	return `${rows.map(renderChangeListRow).join('\n')}\n`
}

function emptyChangeListMessage(filter: ListState): string {
	return filter === 'all' ? 'No Changes found.\n' : `No ${filter} Changes.\n`
}

function renderChangeListRow(row: ChangeListRow): string {
	const idCol = row.summary.id.padEnd(8)
	const stateCol = row.state.padEnd(8)
	const titleCol = row.summary.title.padEnd(48)
	return `${idCol}  ${stateCol}  ${titleCol}  ${changeSliceSummary(row.slices)}`
}

function changeSliceSummary(slices: ClassifiedSlice[]): string {
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
	return [...summaries].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

async function runListChanges(filter: ListState, rt: ListRuntime): Promise<void> {
	const sorted = newestFirst(await rt.storage.listChanges({ state: filter }))
	const rows: ChangeListRow[] = await Promise.all(
		sorted.map(async (summary) => {
			const slices = await classifySlicesForChange({ storage: rt.storage, gh: rt.gh, changeId: summary.id, usePrs: rt.usePrs })
			const found = await rt.storage.findChange(summary.id)
			const state: 'OPEN' | 'CLOSED' = found?.state ?? 'OPEN'
			return { summary, state, slices }
		}),
	)
	rt.stdout(renderList(rows, filter))
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

async function reconcileListedEntities(filter: ListState, storage: Storage, gh: ReturnType<typeof createGh>): Promise<void> {
	const summaries = await storage.listChanges({ state: filter })
	for (const s of summaries) await reconcileEntity({ kind: 'change', id: s.id, branch: s.branch }, { storage, gh })
}

export async function list(filter: ListState, opts: { storage?: string }): Promise<void> {
	const { rt, projectRoot, storage, gh } = await buildListRuntime(opts)
	await exitOnCommandError('list', () =>
		withMutationLock(projectRoot, async () => {
			await reconcileListedEntities(filter, storage, gh)
			await runListChanges(filter, rt)
		}),
	)
}

if (import.meta.vitest) {
	const { describe, test, expect } = import.meta.vitest
	const { recordingGhOps } = await import('../../test-utils/gh-ops-recorder.ts')
	const { fakeSliceStorage } = await import('../../test-utils/storage-fixtures.ts')

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
		test('renders one open Change with bucket counts', () => {
			const rows: ChangeListRow[] = [
				{
					summary: { id: 'ab12cd', title: 'Add SSO', branch: 'change/ab12cd-add-sso', createdAt: '2026-05-13T00:00:00.000Z' },
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

		test('empty open Change list has friendly message', () => {
			expect(renderList([], 'open')).toBe('No open Changes.\n')
		})
	})

	describe('runListChanges', () => {
		function storageWith(summaries: ChangeSummary[], slices: ClassifiedSlice[]): Storage {
			return fakeSliceStorage(slices, null, {
				findChange: async (id) => summaries.find((s) => s.id === id) ? { id, branch: 'b', title: 't', state: 'OPEN' } : null,
				listChanges: async () => summaries,
			})
		}

		test('sorts newest first', async () => {
			let out = ''
			const { gh } = recordingGhOps()
			await runListChanges('open', {
				storage: storageWith([
					{ id: '1', title: 'Old', branch: 'b1', createdAt: '2026-01-01T00:00:00Z' },
					{ id: '2', title: 'New', branch: 'b2', createdAt: '2026-02-01T00:00:00Z' },
				], []),
				gh,
				usePrs: false,
				stdout: (s) => { out = s },
			})
			expect(out.indexOf('2')).toBeLessThan(out.indexOf('1'))
		})
	})
}
