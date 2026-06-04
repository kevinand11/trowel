import type { Slice, SliceState } from '../storages/types.ts'

export type { SliceState }

type ClassifyInput = {
	closedAt: string | null
	readyForAgent: boolean
	needsRevision: boolean
	prState: Slice['prState']
}

type ClassifyContext = {
	/** Ids of dep targets that are not in the `done` state. */
	unmetDepIds: string[]
}

/**
 * Predicates evaluated top-to-bottom (first match wins):
 *
 *   done             closedAt !== null
 *   landed           prState === 'merged'
 *   needs-revision   needsRevision
 *   in-flight        open draft/ready PR
 *   blocked          unmetDepIds.length > 0
 *   open             readyForAgent
 *   draft            catch-all
 */
type SliceStateRule = {
	state: SliceState
	matches: (s: ClassifyInput, ctx: ClassifyContext) => boolean
}

const SLICE_STATE_RULES: SliceStateRule[] = [
	{ state: 'done', matches: (s) => s.closedAt !== null },
	{ state: 'landed', matches: (s) => s.prState === 'merged' },
	{ state: 'needs-revision', matches: (s) => s.needsRevision },
	{ state: 'in-flight', matches: (s) => s.prState === 'draft' || s.prState === 'ready' },
	{ state: 'blocked', matches: (_s, ctx) => ctx.unmetDepIds.length > 0 },
	{ state: 'open', matches: (s) => s.readyForAgent },
]

function classify(s: ClassifyInput, ctx: ClassifyContext): SliceState {
	return SLICE_STATE_RULES.find((rule) => rule.matches(s, ctx))?.state ?? 'draft'
}

/**
 * Return Slices with their computed lifecycle state. Storage and PR enrichment populate raw
 * signals (`closedAt`, readiness, revision, blocker, PR fields); this projection makes `state`
 * consistent anywhere the slice is rendered or dispatched.
 */
export function classifySlices(slices: Slice[]): Slice[] {
	const doneIds = new Set(slices.filter((s) => s.closedAt !== null).map((s) => s.id))
	return slices.map((s) => {
		const unmetDepIds = s.blockedBy.filter((d) => !doneIds.has(d))
		return { ...s, state: classify(s, { unmetDepIds }) }
	})
}

if (import.meta.vitest) {
	const { describe, test, expect } = import.meta.vitest

	const base: ClassifyInput = { closedAt: null, readyForAgent: false, needsRevision: false, prState: null }
	const noCtx: ClassifyContext = { unmetDepIds: [] }

	describe('classify', () => {
		test('closedAt → done (regardless of other signals)', () => {
			expect(classify({ ...base, closedAt: '2026-06-04T00:00:00.000Z', needsRevision: true, readyForAgent: true, prState: 'merged' }, { unmetDepIds: ['x'] })).toBe('done')
		})

		test('merged PR without closedAt → landed', () => {
			expect(classify({ ...base, prState: 'merged', needsRevision: true, readyForAgent: true }, { unmetDepIds: ['x'] })).toBe('landed')
		})

		test('needsRevision → needs-revision (even with PR / deps / ready)', () => {
			expect(classify({ ...base, needsRevision: true, readyForAgent: true, prState: 'ready' }, { unmetDepIds: ['x'] })).toBe('needs-revision')
		})

		test('open PR (no needsRevision) → in-flight (even with deps / ready)', () => {
			expect(classify({ ...base, readyForAgent: true, prState: 'draft' }, { unmetDepIds: ['x'] })).toBe('in-flight')
		})

		test('unmet deps (no PR, no needsRevision) → blocked (even with ready)', () => {
			expect(classify({ ...base, readyForAgent: true }, { unmetDepIds: ['x'] })).toBe('blocked')
		})

		test('readyForAgent (no PR, no deps, no needsRevision) → open', () => {
			expect(classify({ ...base, readyForAgent: true }, noCtx)).toBe('open')
		})

		test('catch-all → draft', () => {
			expect(classify(base, noCtx)).toBe('draft')
		})
	})
}
