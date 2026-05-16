import type { ClassifiedSlice, ClassifySliceConfig, ResumeState } from '../storages/types.ts'

/**
 * Decide what the loop should do next for this slice. Pure: reads slice fields, bucket, and
 * config flags only.
 *
 * Previously implemented per-storage (`Storage.classifySlice`); consolidated as a free function
 * since the issue-storage predicate is a superset of the file-storage predicate — on file slices
 * `prState` is always `null`, so the prState branches fall through with no behavior change. See
 * ADR `storage-behavior-separation`.
 *
 * Predicates evaluated top-to-bottom (first match wins):
 *
 *   done       state === 'CLOSED'
 *   done       !readyForAgent
 *   done       prState === 'merged' || prState === 'ready'
 *   done       prState === 'draft' && !config.review        (review opt-out)
 *   blocked    bucket === 'blocked'
 *   address    needsRevision
 *   review     prState === 'draft'
 *   implement  (catch-all)
 */
export function classify(slice: ClassifiedSlice, config: ClassifySliceConfig): ResumeState {
	if (slice.state === 'CLOSED') return 'done'
	if (!slice.readyForAgent) return 'done'
	if (slice.prState === 'merged' || slice.prState === 'ready') return 'done'
	if (slice.prState === 'draft' && !config.review) return 'done'
	if (slice.bucket === 'blocked') return 'blocked'
	if (slice.needsRevision) return 'address'
	if (slice.prState === 'draft') return 'review'
	return 'implement'
}

if (import.meta.vitest) {
	const { describe, test, expect } = import.meta.vitest

	function makeSlice(overrides: Partial<ClassifiedSlice> = {}): ClassifiedSlice {
		return {
			id: 's1',
			title: 't',
			body: 'b',
			state: 'OPEN',
			readyForAgent: true,
			needsRevision: false,
			bucket: 'ready',
			blockedBy: [],
			prState: null,
			...overrides,
		}
	}

	describe('classify', () => {
		test('CLOSED → done', () => {
			expect(classify(makeSlice({ state: 'CLOSED', bucket: 'done' }), { usePrs: true, review: true, perSliceBranches: true })).toBe('done')
		})

		test('!readyForAgent → done (slice is a draft waiting on the user)', () => {
			expect(classify(makeSlice({ readyForAgent: false, bucket: 'draft' }), { usePrs: false, review: false, perSliceBranches: true })).toBe('done')
		})

		test('prState merged → done', () => {
			expect(classify(makeSlice({ prState: 'merged' }), { usePrs: true, review: true, perSliceBranches: true })).toBe('done')
		})

		test('prState ready → done (awaiting human merge)', () => {
			expect(classify(makeSlice({ prState: 'ready' }), { usePrs: true, review: true, perSliceBranches: true })).toBe('done')
		})

		test('prState draft with review: false → done (review opt-out: loop stops at the draft PR)', () => {
			expect(classify(makeSlice({ prState: 'draft' }), { usePrs: true, review: false, perSliceBranches: true })).toBe('done')
		})

		test('prState draft with review: true → review (agent reviewer fires)', () => {
			expect(classify(makeSlice({ prState: 'draft' }), { usePrs: true, review: true, perSliceBranches: true })).toBe('review')
		})

		test('blocked bucket → blocked (takes precedence over implement, after the done short-circuits)', () => {
			expect(classify(makeSlice({ bucket: 'blocked', blockedBy: ['s0'] }), { usePrs: true, review: true, perSliceBranches: true })).toBe('blocked')
		})

		test('needsRevision with a draft PR and review: true → address (addresser handles reviewer feedback)', () => {
			expect(classify(makeSlice({ needsRevision: true, prState: 'draft' }), { usePrs: true, review: true, perSliceBranches: true })).toBe('address')
		})

		test('open slice with no PR yet → implement', () => {
			expect(classify(makeSlice(), { usePrs: true, review: true, perSliceBranches: true })).toBe('implement')
		})

		test('file-storage shape (prState null, no PR concept): ready → implement; config flags inert', () => {
			expect(classify(makeSlice({ bucket: 'ready' }), { usePrs: false, review: false, perSliceBranches: true })).toBe('implement')
			expect(classify(makeSlice({ bucket: 'ready' }), { usePrs: true, review: true, perSliceBranches: true })).toBe('implement')
		})
	})
}
