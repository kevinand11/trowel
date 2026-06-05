import type { ChangeSummary, Storage } from '../../storages/types.ts'
import { classifyChange } from '../../utils/change-state.ts'
import { createGh } from '../../utils/gh-ops.ts'
import { branchStableGitFacts, branchStableGitOps, type ReadOnlyGitFacts } from '../../utils/git-ops.ts'
import { emptySliceStateCounts, formatSliceStateCounts } from '../../utils/slice-state-format.ts'
import type { ChangeState } from '../../work/change-types.ts'
import { classifySlicesForChange } from '../../work/slice-states.ts'
import type { ClassifiedSlice, SliceState } from '../../work/slice-types.ts'
import { buildStorage, loadCommandBase } from '../runtime.ts'

type ListRuntime = { storage: Storage; pr: boolean; gh: ReturnType<typeof createGh>; git: ReadOnlyGitFacts }
type ChangeListRow = ChangeSummary & { state: ChangeState; slices: ClassifiedSlice[] }

export async function list(opts: { storage?: string } = {}): Promise<void> {
	const base = await loadCommandBase('change list')
	const git = branchStableGitOps(base.git)
	const storage = buildStorage({ ...base, git }, opts.storage ?? base.config.storage)
	const rows = await listChangeRows({ storage, pr: base.config.ship.pr, gh: base.gh, git: branchStableGitFacts(git) })
	for (const row of rows) process.stdout.write(`${formatChangeRow(row)}\n`)
}

function formatChangeRow(row: ChangeListRow): string {
	const idCol = row.id.padEnd(6)
	const stateCol = row.state.padEnd(9)
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
	const summaries = await rt.storage.listChanges({ state: 'all' })
	const rows = await Promise.all(summaries.map((summary) => listChangeRow(rt, summary)))
	return rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

async function listChangeRow(rt: ListRuntime, summary: ChangeSummary): Promise<ChangeListRow> {
	const change = await rt.storage.findChange(summary.id)
	const slices = await classifySlicesForChange({ storage: rt.storage, gh: rt.gh, changeId: summary.id, pr: rt.pr })
	return { ...summary, state: change ? await classifyChange(change, slices, { gh: rt.gh, git: rt.git }) : 'open', slices }
}

if (import.meta.vitest) {
	const { describe, test, expect } = import.meta.vitest
	const { fakeSliceStorage } = await import('../../test-utils/storage-fixtures.ts')
	const { recordingGhOps } = await import('../../test-utils/gh-ops-recorder.ts')
	const { noopGitOps } = await import('../../test-utils/git-ops-fixtures.ts')

	function fakeSlice(overrides: Partial<ClassifiedSlice> = {}): ClassifiedSlice {
		return {
			id: 's1',
			title: 'Slice',
			body: '',
			state: 'open',
			closedAt: null,
			implementedAt: null,
			auditedAt: null,
			readyForAgent: true,
			needsRevision: false,
			blockedBy: [],
			sliceBranch: `change-1/slice-${overrides.id ?? 's1'}-slice`,
			prState: null,
			...overrides,
		}
	}

	describe('list rendering', () => {
		test('renders one open Change with state counts', () => {
			const out = formatChangeRow({
				id: '1',
				title: 'Add parser',
				changeBranch: 'change-1-add-parser',
				createdAt: '2026-05-12T00:00:00Z',
				state: 'open',
				slices: [fakeSlice({ id: 's1', state: 'done', closedAt: '2026-06-04T00:00:00.000Z' })],
			})
			expect(out).toContain('1')
			expect(out).toContain('open')
			expect(out).toContain('Add parser')
			expect(out).toContain('1 done')
		})

		test('empty slice list prints no slices marker', () => {
			expect(changeSliceSummary([])).toBe('(no slices)')
		})

		test('state summary follows configured order', () => {
			expect(
				changeSliceSummary([
					fakeSlice({ id: 'd', state: 'done', closedAt: 'x' }),
					fakeSlice({ id: 'o', state: 'open' }),
					fakeSlice({ id: 'i', state: 'implemented', implementedAt: 'x' }),
					fakeSlice({ id: 'a', state: 'audited', implementedAt: 'x', auditedAt: 'y' }),
					fakeSlice({ id: 'l', state: 'landed', prState: 'merged' }),
				]),
			).toBe('1 done · 1 landed · 1 audited · 1 implemented · 1 open')
		})
	})

	describe('listChangeRows', () => {
		function storageWith(summaries: ChangeSummary[], slices: ClassifiedSlice[], listStates: string[]): Storage {
			return fakeSliceStorage(slices, null, {
				listChanges: async (opts) => {
					listStates.push(opts.state)
					return summaries
				},
				findChange: async (id) => ({
					id,
					changeBranch: `change-${id}`,
					targetBranch: 'fake-base',
					title: id,
					state: 'OPEN',
					closedAt: null,
				}),
			})
		}

		function branchSensitiveGit(calls: string[]) {
			return branchStableGitFacts(
				noopGitOps({
					remoteBranchExists: async (branch) => {
						calls.push(`remoteBranchExists(${branch})`)
						return true
					},
					fetch: async (branch) => {
						calls.push(`fetch(${branch})`)
					},
					commitsAhead: async (branch, base) => {
						calls.push(`commitsAhead(${branch},${base})`)
						return 0
					},
					checkout: async (branch) => {
						calls.push(`checkout(${branch})`)
						throw new Error('checkout must not run during change list')
					},
					createLocalBranch: async (branch, base) => {
						calls.push(`createLocalBranch(${branch},${base})`)
						throw new Error('createLocalBranch must not run during change list')
					},
					createRemoteBranch: async (branch, base) => {
						calls.push(`createRemoteBranch(${branch},${base})`)
						throw new Error('createRemoteBranch must not run during change list')
					},
					deleteBranch: async (branch) => {
						calls.push(`deleteBranch(${branch})`)
						throw new Error('deleteBranch must not run during change list')
					},
				}),
			)
		}

		test('sorts newest first by createdAt and requests all Changes', async () => {
			const { gh } = recordingGhOps()
			const listStates: string[] = []
			const rows = await listChangeRows({
				storage: storageWith(
					[
						{ id: 'old', title: 'Old', changeBranch: 'change-old', createdAt: '2026-05-01T00:00:00Z' },
						{ id: 'new', title: 'New', changeBranch: 'change-new', createdAt: '2026-05-02T00:00:00Z' },
					],
					[],
					listStates,
				),
				pr: false,
				gh,
				git: branchStableGitFacts(noopGitOps({ remoteBranchExists: async () => false, branchExists: async () => false })),
			})
			expect(rows.map((r) => r.id)).toEqual(['new', 'old'])
			expect(listStates).toEqual(['all'])
		})

		test('computes landed state through branch-stable git facts without mutating checkout', async () => {
			const { gh } = recordingGhOps({ findAnyPrByHead: async () => null })
			const listStates: string[] = []
			const gitCalls: string[] = []
			const slices = [fakeSlice({ state: 'done', closedAt: '2026-06-04T00:00:00.000Z', readyForAgent: false })]

			const rows = await listChangeRows({
				storage: storageWith(
					[{ id: '1', title: 'Done', changeBranch: 'change-1', createdAt: '2026-05-01T00:00:00Z' }],
					slices,
					listStates,
				),
				pr: false,
				gh,
				git: branchSensitiveGit(gitCalls),
			})

			expect(rows[0]?.state).toBe('landed')
			expect(gitCalls).toContain('remoteBranchExists(change-1)')
			expect(gitCalls).toContain('fetch(change-1)')
			expect(gitCalls).toContain('fetch(fake-base)')
			expect(gitCalls).toContain('commitsAhead(origin/change-1,origin/fake-base)')
			expect(gitCalls.filter((call) => /^(checkout|createLocalBranch|createRemoteBranch|deleteBranch)\(/.test(call))).toEqual([])
		})
	})
}
