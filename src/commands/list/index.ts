import type { StorageKind } from '../../storages/registry.ts'
import type { ClassifiedSlice, ChangeSummary, SliceState, Storage } from '../../storages/types.ts'
import { createGh } from '../../utils/gh-ops.ts'
import { emptySliceStateCounts, formatSliceStateCounts } from '../../utils/slice-state-format.ts'
import { classifySlicesForChange } from '../../work/slice-states.ts'
import { buildStorage, loadCommandBase } from '../runtime.ts'

export type ListState = 'open' | 'closed' | 'all'

type ListRuntime = { storage: Storage; usePrs: boolean; gh: ReturnType<typeof createGh>; state: ListState }
type ChangeListRow = ChangeSummary & { state: string; slices: ClassifiedSlice[] }

export async function list(state: ListState = 'open', opts: { storage?: string } = {}): Promise<void> {
	const base = await loadCommandBase('change list')
	const storage = buildStorage(base, (opts.storage as StorageKind | undefined) ?? base.config.storage)
	const rows = await listChangeRows({ storage, usePrs: base.config.work.usePrs, gh: base.gh, state })
	for (const row of rows) process.stdout.write(`${formatChangeRow(row)}\n`)
}

function formatChangeRow(row: ChangeListRow): string {
	const idCol = row.id.padEnd(6)
	const stateCol = row.state.padEnd(8)
	const titleCol = row.title.padEnd(24)
	return `${idCol}  ${stateCol}  ${titleCol}  ${changeSliceSummary(row.slices)}`
}

function changeSliceSummary(slices: ClassifiedSlice[]): string {
	return slices.length === 0 ? '(no slices)' : formatSliceStateCounts(stateCounts(slices))
}

function stateCounts(slices: ClassifiedSlice[]): Record<SliceState, number> {
	const counts = emptySliceStateCounts()
	for (const s of slices) counts[s.state]++
	return counts
}

async function listChangeRows(rt: ListRuntime): Promise<ChangeListRow[]> {
	const summaries = await rt.storage.listChanges({ state: rt.state })
	const rows = await Promise.all(summaries.map((summary) => listChangeRow(rt, summary)))
	return rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

async function listChangeRow(rt: ListRuntime, summary: ChangeSummary): Promise<ChangeListRow> {
	const change = await rt.storage.findChange(summary.id)
	const slices = await classifySlicesForChange({ storage: rt.storage, gh: rt.gh, changeId: summary.id, usePrs: rt.usePrs })
	return { ...summary, state: change?.state ?? 'UNKNOWN', slices }
}

if (import.meta.vitest) {
	const { describe, test, expect } = import.meta.vitest
	const { fakeSliceStorage } = await import('../../test-utils/storage-fixtures.ts')
	const { recordingGhOps } = await import('../../test-utils/gh-ops-recorder.ts')

	function fakeSlice(overrides: Partial<ClassifiedSlice> = {}): ClassifiedSlice {
		return {
			id: 's1',
			title: 'Slice',
			body: '',
			state: 'open',
			closedAt: null,
			readyForAgent: true,
			needsRevision: false,
			blockedBy: [],
			prState: null,
			...overrides,
		}
	}

	describe('list rendering', () => {
		test('renders one open Change with state counts', () => {
			const out = formatChangeRow({
				id: '1',
				title: 'Add parser',
				branch: 'change-1-add-parser',
				createdAt: '2026-05-12T00:00:00Z',
				state: 'OPEN',
				slices: [fakeSlice({ id: 's1', state: 'done', closedAt: '2026-06-04T00:00:00.000Z' })],
			})
			expect(out).toContain('1')
			expect(out).toContain('OPEN')
			expect(out).toContain('Add parser')
			expect(out).toContain('1 done')
		})

		test('empty slice list prints no slices marker', () => {
			expect(changeSliceSummary([])).toBe('(no slices)')
		})

		test('state summary follows configured order', () => {
			expect(changeSliceSummary([
				fakeSlice({ id: 'd', state: 'done', closedAt: 'x' }),
				fakeSlice({ id: 'o', state: 'open' }),
				fakeSlice({ id: 'l', state: 'landed', prState: 'merged' }),
			])).toBe('1 done · 1 landed · 1 open')
		})
	})

	describe('listChangeRows', () => {
		function storageWith(summaries: ChangeSummary[], slices: ClassifiedSlice[]): Storage {
			return fakeSliceStorage(slices, null, {
				listChanges: async () => summaries,
				findChange: async (id) => ({ id, branch: `change-${id}`, title: id, state: 'OPEN' }),
			})
		}

		test('sorts newest first by createdAt', async () => {
			const { gh } = recordingGhOps()
			const rows = await listChangeRows({
				storage: storageWith([
					{ id: 'old', title: 'Old', branch: 'change-old', createdAt: '2026-05-01T00:00:00Z' },
					{ id: 'new', title: 'New', branch: 'change-new', createdAt: '2026-05-02T00:00:00Z' },
				], []),
				usePrs: false,
				gh,
				state: 'all',
			})
			expect(rows.map((r) => r.id)).toEqual(['new', 'old'])
		})
	})
}
