import type { SliceState } from './slice-state.ts'

export const SLICE_STATE_ORDER: SliceState[] = ['done', 'landed', 'needs-revision', 'in-flight', 'blocked', 'open', 'draft']

export function emptySliceStateCounts(): Record<SliceState, number> {
	return {
		done: 0,
		landed: 0,
		'needs-revision': 0,
		'in-flight': 0,
		blocked: 0,
		open: 0,
		draft: 0,
	}
}

export function formatSliceStateCounts(counts: Record<SliceState, number>): string {
	return SLICE_STATE_ORDER.filter((state) => counts[state] > 0)
		.map((state) => `${counts[state]} ${state}`)
		.join(' · ')
}
