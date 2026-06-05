import type { Slice } from '../storages/types.ts'
import type { ClassifiedSlice, SlicePrState, SliceState } from '../work/slice-types.ts'

export type { SliceState }

type ClassifyInput = {
	closedAt: string | null
	implementedAt: string | null
	auditedAt: string | null
	readyForAgent: boolean
	needsRevision: boolean
	prState: SlicePrState
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
 *   needs-revision   needsRevision (derived from PR review surface)
 *   awaiting-review  open non-draft PR
 *   blocked          unmetDepIds.length > 0
 *   audited          auditedAt !== null
 *   implemented      implementedAt !== null
 *   in-flight        open draft PR with no process milestone
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
	{ state: 'awaiting-review', matches: (s) => s.prState === 'ready' },
	{ state: 'blocked', matches: (_s, ctx) => ctx.unmetDepIds.length > 0 },
	{ state: 'audited', matches: (s) => s.auditedAt !== null },
	{ state: 'implemented', matches: (s) => s.implementedAt !== null },
	{ state: 'in-flight', matches: (s) => s.prState === 'draft' },
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
export function classifySlices(slices: Array<Slice & Partial<Pick<ClassifiedSlice, 'prState' | 'needsRevision'>>>): ClassifiedSlice[] {
	const doneIds = new Set(slices.filter((s) => s.closedAt !== null).map((s) => s.id))
	return slices.map((s) => {
		const slice = { ...s, prState: s.prState ?? null, needsRevision: s.needsRevision ?? false }
		const unmetDepIds = slice.blockedBy.filter((d) => !doneIds.has(d))
		return { ...slice, state: classify(slice, { unmetDepIds }) }
	})
}

if (import.meta.vitest) {
	const { describe, test, expect } = import.meta.vitest

	const base: ClassifyInput = { closedAt: null, implementedAt: null, auditedAt: null, readyForAgent: false, needsRevision: false, prState: null }
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

		test('open non-draft PR (no needsRevision) → awaiting-review (even with deps / ready)', () => {
			expect(classify({ ...base, readyForAgent: true, prState: 'ready' }, { unmetDepIds: ['x'] })).toBe('awaiting-review')
		})

		test('draft PR with implementedAt remains implemented for loop processing', () => {
			expect(classify({ ...base, implementedAt: '2026-06-04T00:00:00.000Z', prState: 'draft' }, noCtx)).toBe('implemented')
		})

		test('draft PR without process milestone → in-flight', () => {
			expect(classify({ ...base, readyForAgent: true, prState: 'draft' }, noCtx)).toBe('in-flight')
		})

		test('unmet deps (no PR, no needsRevision) → blocked (even with ready)', () => {
			expect(classify({ ...base, readyForAgent: true }, { unmetDepIds: ['x'] })).toBe('blocked')
		})

		test('auditedAt → audited when no stronger signal applies', () => {
			expect(classify({ ...base, implementedAt: '2026-06-04T00:00:00.000Z', auditedAt: '2026-06-04T00:01:00.000Z', readyForAgent: true }, noCtx)).toBe('audited')
		})

		test('implementedAt → implemented when no stronger signal applies', () => {
			expect(classify({ ...base, implementedAt: '2026-06-04T00:00:00.000Z', readyForAgent: true }, noCtx)).toBe('implemented')
		})

		test('readyForAgent (no PR, no deps, no process milestones, no needsRevision) → open', () => {
			expect(classify({ ...base, readyForAgent: true }, noCtx)).toBe('open')
		})

		test('catch-all → draft', () => {
			expect(classify(base, noCtx)).toBe('draft')
		})
	})
}
