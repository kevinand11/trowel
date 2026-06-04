import type { ClassifiedSlice, ChangeRecord, SliceState } from '../../storages/types.ts'
import { emptySliceStateCounts, formatSliceStateCounts, SLICE_STATE_ORDER } from '../../utils/slice-state-format.ts'

export function renderStatus(change: ChangeRecord, slices: ClassifiedSlice[]): string {
	const counts = stateCountsFor(slices)
	const lines = [
		`Change ${change.id}  ${change.title}`,
		`State:   ${change.state}`,
		`Branch:  ${change.branch}`,
	]
	if (change.targetBranch) lines.push(`Target:  ${change.targetBranch}`)
	lines.push('', `Slices:  ${formatSliceStateCounts(counts) || '(no slices)'}`)
	lines.push(...renderStateSections(slices))
	return `${lines.join('\n')}\n`
}

export function renderStatusSlice(change: ChangeRecord, slice: ClassifiedSlice, siblings: ClassifiedSlice[]): string {
	const lines: string[] = []
	lines.push(`Slice ${slice.id}  ${slice.title}`)
	lines.push(`Change:  ${change.id}  ${change.title}`)
	lines.push(`State:   ${slice.state}`)
	lines.push(`closed-at:       ${slice.closedAt ?? '(none)'}`)
	lines.push(`ready-for-agent: ${slice.readyForAgent}`)
	lines.push(`needs-revision:  ${slice.needsRevision}`)
	lines.push(...blockedByLines(slice, siblings))
	return `${lines.join('\n')}\n`
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

function blockedByLines(slice: ClassifiedSlice, siblings: ClassifiedSlice[]): string[] {
	if (slice.blockedBy.length === 0) return []
	const byId = bySliceId(siblings)
	return ['', 'Blocked by:', ...slice.blockedBy.map((id) => blockedByLine(id, byId))]
}

function blockedByLine(id: string, byId: Map<string, ClassifiedSlice>): string {
	const dep = byId.get(id)
	return dep ? `  ${id.padEnd(6)}  ${dep.state.padEnd(14)}  ${dep.title}` : `  ${id.padEnd(6)}  (not found)`
}
