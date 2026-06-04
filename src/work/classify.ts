import type { ClassifySliceConfig, ResumeState, Slice } from '../storages/types.ts'

/**
 * Decide what the loop should do next for this slice. Pure: reads computed Slice state,
 * PR state, and config flags only.
 *
 * Predicates evaluated top-to-bottom (first match wins):
 *
 *   done       state === 'done'
 *   done       state === 'draft'
 *   finalize   state === 'landed'
 *   blocked    state === 'blocked'
 *   address    state === 'needs-revision'
 *   done       prState === 'ready'
 *   done       prState === 'draft' && !config.review        (review opt-out)
 *   review     prState === 'draft'
 *   implement  state === 'open'
 */
type ResumeRule = {
	state: ResumeState
	matches: (slice: Slice, config: ClassifySliceConfig) => boolean
}

const RESUME_RULES: ResumeRule[] = [
	{ state: 'done', matches: (slice) => slice.state === 'done' },
	{ state: 'done', matches: (slice) => slice.state === 'draft' },
	{ state: 'finalize', matches: (slice) => slice.state === 'landed' },
	{ state: 'blocked', matches: (slice) => slice.state === 'blocked' },
	{ state: 'address', matches: (slice) => slice.state === 'needs-revision' },
	{ state: 'done', matches: (slice) => slice.prState === 'ready' },
	{ state: 'done', matches: (slice, config) => slice.prState === 'draft' && !config.review },
	{ state: 'review', matches: (slice) => slice.prState === 'draft' },
	{ state: 'implement', matches: (slice) => slice.state === 'open' },
]

export function classify(slice: Slice, config: ClassifySliceConfig): ResumeState {
	return RESUME_RULES.find((rule) => rule.matches(slice, config))?.state ?? 'done'
}

if (import.meta.vitest) {
	const { describe, test, expect } = import.meta.vitest

	function makeSlice(overrides: Partial<Slice> = {}): Slice {
		return {
			id: 's1',
			title: 't',
			body: 'b',
			state: 'open',
			closedAt: null,
			readyForAgent: true,
			needsRevision: false,
			blockedBy: [],
			sliceBranch: 'change-p1/slice-s1-t',
			prState: null,
			...overrides,
		}
	}

	describe('classify', () => {
		test('done → done', () => {
			expect(classify(makeSlice({ state: 'done', closedAt: '2026-06-04T00:00:00.000Z' }), { usePrs: true, review: true, perSliceBranches: true })).toBe('done')
		})

		test('draft → done (slice is waiting on the user)', () => {
			expect(classify(makeSlice({ state: 'draft', readyForAgent: false }), { usePrs: false, review: false, perSliceBranches: true })).toBe('done')
		})

		test('landed → finalize', () => {
			expect(classify(makeSlice({ state: 'landed', prState: 'merged' }), { usePrs: true, review: true, perSliceBranches: true })).toBe('finalize')
		})

		test('prState ready → done (awaiting human merge)', () => {
			expect(classify(makeSlice({ state: 'in-flight', prState: 'ready' }), { usePrs: true, review: true, perSliceBranches: true })).toBe('done')
		})

		test('prState draft with review: false → done (review opt-out: loop stops at the draft PR)', () => {
			expect(classify(makeSlice({ state: 'in-flight', prState: 'draft' }), { usePrs: true, review: false, perSliceBranches: true })).toBe('done')
		})

		test('prState draft with review: true → review (agent reviewer fires)', () => {
			expect(classify(makeSlice({ state: 'in-flight', prState: 'draft' }), { usePrs: true, review: true, perSliceBranches: true })).toBe('review')
		})

		test('blocked → blocked', () => {
			expect(classify(makeSlice({ state: 'blocked', blockedBy: ['s0'] }), { usePrs: true, review: true, perSliceBranches: true })).toBe('blocked')
		})

		test('needs-revision with a draft PR and review: true → address', () => {
			expect(classify(makeSlice({ state: 'needs-revision', needsRevision: true, prState: 'draft' }), { usePrs: true, review: true, perSliceBranches: true })).toBe('address')
		})

		test('open slice with no PR yet → implement', () => {
			expect(classify(makeSlice(), { usePrs: true, review: true, perSliceBranches: true })).toBe('implement')
		})
	})
}
