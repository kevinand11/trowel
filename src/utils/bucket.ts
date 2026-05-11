/**
 * Slice lifecycle bucket. See ADR `backend-owns-slice-bucket-classification`.
 */
export type Bucket = 'done' | 'needs-revision' | 'in-flight' | 'blocked' | 'ready' | 'draft'

export type ClassifyInput = {
	state: 'OPEN' | 'CLOSED'
	readyForAgent: boolean
	needsRevision: boolean
}

export type ClassifyContext = {
	/** Backends without a PR concept (e.g. file) always pass false here. */
	hasOpenPr: boolean
	/** Ids of dep targets that are not in the `done` bucket. */
	unmetDepIds: string[]
}

/**
 * Predicates evaluated top-to-bottom (first match wins):
 *
 *   done             state === 'CLOSED'
 *   needs-revision   OPEN + needsRevision
 *   in-flight        OPEN + hasOpenPr
 *   blocked          OPEN + unmetDepIds.length > 0
 *   ready            OPEN + readyForAgent (none of the above)
 *   draft            OPEN (catch-all)
 */
export function classify(s: ClassifyInput, ctx: ClassifyContext): Bucket {
	if (s.state === 'CLOSED') return 'done'
	if (s.needsRevision) return 'needs-revision'
	if (ctx.hasOpenPr) return 'in-flight'
	if (ctx.unmetDepIds.length > 0) return 'blocked'
	if (s.readyForAgent) return 'ready'
	return 'draft'
}

if (import.meta.vitest) {
	const { describe, test, expect } = import.meta.vitest

	const base: ClassifyInput = { state: 'OPEN', readyForAgent: false, needsRevision: false }
	const noCtx: ClassifyContext = { hasOpenPr: false, unmetDepIds: [] }

	describe('classify', () => {
		test('CLOSED → done (regardless of other signals)', () => {
			expect(classify({ ...base, state: 'CLOSED', needsRevision: true, readyForAgent: true }, { ...noCtx, hasOpenPr: true, unmetDepIds: ['x'] })).toBe(
				'done',
			)
		})

		test('OPEN + needsRevision → needs-revision (even with PR / deps / ready)', () => {
			expect(classify({ ...base, needsRevision: true, readyForAgent: true }, { hasOpenPr: true, unmetDepIds: ['x'] })).toBe('needs-revision')
		})

		test('OPEN + hasOpenPr (no needsRevision) → in-flight (even with deps / ready)', () => {
			expect(classify({ ...base, readyForAgent: true }, { hasOpenPr: true, unmetDepIds: ['x'] })).toBe('in-flight')
		})

		test('OPEN + unmet deps (no PR, no needsRevision) → blocked (even with ready)', () => {
			expect(classify({ ...base, readyForAgent: true }, { hasOpenPr: false, unmetDepIds: ['x'] })).toBe('blocked')
		})

		test('OPEN + readyForAgent (no PR, no deps, no needsRevision) → ready', () => {
			expect(classify({ ...base, readyForAgent: true }, noCtx)).toBe('ready')
		})

		test('OPEN catch-all → draft', () => {
			expect(classify(base, noCtx)).toBe('draft')
		})
	})
}
