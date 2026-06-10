import type { Change } from '../../storages/types.ts'
import type { CloseOutPrFacts } from '../../utils/change-state.ts'
import { emptySliceStateCounts, formatSliceStateCounts, SLICE_STATE_ORDER } from '../../utils/slice-state-format.ts'
import type { ChangeState } from '../../work/change-types.ts'
import type { ClassifiedSlice, SliceState } from '../../work/slice-types.ts'

export type StatusChange = Change & { state: ChangeState; closeOutPr?: CloseOutPrFacts | null }

export function renderStatus(change: StatusChange, slices: ClassifiedSlice[]): string {
	const counts = stateCountsFor(slices)
	const lines = [
		`Change ${change.id}  ${change.title}`,
		`State:               ${change.state}`,
		`Target branch:       ${change.targetBranch}`,
		`Change branch:       ${change.changeBranch}`,
		`Guidance:            ${stateGuidance(change)}`,
	]
	lines.push('', `Slices:  ${formatSliceStateCounts(counts) || '(no slices)'}`)
	lines.push(...renderStateSections(slices))
	return `${lines.join('\n')}\n`
}

function stateGuidance(change: StatusChange): string {
	const ship = `trowel change ship ${change.id}`
	const work = `trowel change work ${change.id}`
	switch (change.state) {
		case 'done':
			return 'shipped and finalized; no further work needed'
		case 'landed':
			return `merged to Target branch but not finalized; run ${ship}`
		case 'aborted':
			return 'aborted; run cleanup again only if local worktrees/branches remain'
		case 'needs-revision':
			return `Close-out PR needs revision; run ${work}`
		case 'awaiting-review':
			if (change.closeOutPr?.isDraft) return `Close-out PR #${change.closeOutPr.number} is draft; make it ready or close it before retrying`
			return 'Close-out PR is awaiting review or merge; run ship when mergeable'
		case 'ready':
			return `all Slices are done; run ${ship}`
		case 'open':
			return `work remains; run ${work}`
	}
}

function stateCountsFor(slices: ClassifiedSlice[]): Record<SliceState, number> {
	const counts = emptySliceStateCounts()
	for (const s of slices) counts[s.state]++
	return counts
}

function renderStateSections(slices: ClassifiedSlice[]): string[] {
	const lines: string[] = []
	const sliceById = bySliceId(slices)
	for (const state of SLICE_STATE_ORDER) appendStateSection(lines, state, slices, sliceById)
	return lines
}

function appendStateSection(lines: string[], state: SliceState, slices: ClassifiedSlice[], sliceById: Map<string, ClassifiedSlice>): void {
	const inState = slices.filter((s) => s.state === state)
	if (inState.length === 0) return
	lines.push(`  ${state}`)
	for (const s of inState) lines.push(renderSliceSummaryLine(s, sliceById))
}

function renderSliceSummaryLine(s: ClassifiedSlice, sliceById: Map<string, ClassifiedSlice>): string {
	const right = rightColumn(s, sliceById)
	return `    ${s.id.padEnd(6)}  ${s.title}${right}`
}

function bySliceId(slices: ClassifiedSlice[]): Map<string, ClassifiedSlice> {
	return new Map(slices.map((s) => [s.id, s]))
}

function rightColumn(s: ClassifiedSlice, byId: Map<string, ClassifiedSlice>): string {
	if (s.state !== 'blocked') return ''
	const unmet = unmetBlockers(s, byId)
	return unmet.length > 0 ? `  blocked by: ${unmet.join(', ')}` : ''
}

function unmetBlockers(s: ClassifiedSlice, byId: Map<string, ClassifiedSlice>): string[] {
	return s.blockedBy.filter((id) => {
		const dep = byId.get(id)
		return !dep || dep.state !== 'done'
	})
}

if (import.meta.vitest) {
	const { describe, test, expect } = import.meta.vitest

	describe('renderStatus', () => {
		const change: StatusChange = {
			id: '26',
			title: 'Parser',
			body: '',
			createdAt: '2026-01-01T00:00:00.000Z',
			closedAt: null,
			targetBranch: 'main',
			changeBranch: 'change-26-parser',
			state: 'awaiting-review',
		}

		test('shows draft Close-out PR guidance when available', () => {
			const out = renderStatus({ ...change, closeOutPr: { number: 130, state: 'OPEN', isDraft: true } }, [])
			expect(out).toContain('Close-out PR #130 is draft; make it ready or close it before retrying')
		})
	})
}

