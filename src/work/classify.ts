import type { ClassifySliceConfig, ResumeState, Slice } from '../storages/types.ts'

/**
 * Decide what the loop should do next for this slice. Pure: reads computed Slice state,
 * PR state, stored branch identity, and config flags only.
 */
type ResumeRule = {
	state: ResumeState
	matches: (slice: Slice, config: ClassifySliceConfig, changeBranch: string) => boolean
}

const RESUME_RULES: ResumeRule[] = [
	{ state: 'done', matches: (slice) => slice.state === 'done' },
	{ state: 'done', matches: (slice) => slice.state === 'draft' },
	{ state: 'finalize', matches: (slice) => slice.state === 'landed' },
	{ state: 'blocked', matches: (slice) => slice.state === 'blocked' },
	{ state: 'address', matches: (slice) => slice.state === 'needs-revision' },
	{ state: 'done', matches: (slice) => slice.prState === 'ready' },
	{ state: 'done', matches: (slice, config) => slice.prState === 'draft' && !config.audit },
	{ state: 'review', matches: (slice) => slice.prState === 'draft' },
	{ state: 'integrate', matches: (slice) => slice.state === 'audited' },
	{ state: 'audit', matches: (slice, config, changeBranch) => slice.state === 'implemented' && auditApplies(slice, config, changeBranch) },
	{ state: 'integrate', matches: (slice) => slice.state === 'implemented' },
	{ state: 'implement', matches: (slice) => slice.state === 'open' },
]

function auditApplies(slice: Slice, config: ClassifySliceConfig, changeBranch: string): boolean {
	return config.audit && slice.sliceBranch !== null && slice.sliceBranch !== changeBranch && slice.auditedAt === null
}

export function classify(slice: Slice, config: ClassifySliceConfig, changeBranch: string): ResumeState {
	return RESUME_RULES.find((rule) => rule.matches(slice, config, changeBranch))?.state ?? 'done'
}

if (import.meta.vitest) {
	const { describe, test, expect } = import.meta.vitest

	const config: ClassifySliceConfig = { usePrs: true, audit: true, perSliceBranches: true }

	function makeSlice(overrides: Partial<Slice> = {}): Slice {
		return {
			id: 's1',
			title: 't',
			body: 'b',
			state: 'open',
			closedAt: null,
			implementedAt: null,
			auditedAt: null,
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
			expect(classify(makeSlice({ state: 'done', closedAt: '2026-06-04T00:00:00.000Z' }), config, 'change-branch')).toBe('done')
		})

		test('draft → done (slice is waiting on the user)', () => {
			expect(classify(makeSlice({ state: 'draft', readyForAgent: false }), config, 'change-branch')).toBe('done')
		})

		test('landed → finalize', () => {
			expect(classify(makeSlice({ state: 'landed', prState: 'merged' }), config, 'change-branch')).toBe('finalize')
		})

		test('prState ready → done (awaiting human merge)', () => {
			expect(classify(makeSlice({ state: 'in-flight', prState: 'ready' }), config, 'change-branch')).toBe('done')
		})

		test('prState draft → review (legacy draft PR review path)', () => {
			expect(classify(makeSlice({ state: 'in-flight', prState: 'draft' }), config, 'change-branch')).toBe('review')
		})

		test('blocked → blocked', () => {
			expect(classify(makeSlice({ state: 'blocked', blockedBy: ['s0'] }), config, 'change-branch')).toBe('blocked')
		})

		test('needs-revision with a draft PR → address', () => {
			expect(classify(makeSlice({ state: 'needs-revision', needsRevision: true, prState: 'draft' }), config, 'change-branch')).toBe('address')
		})

		test('implemented distinct Slice branch + work.audit → audit', () => {
			expect(classify(makeSlice({ state: 'implemented', implementedAt: '2026-06-04T00:00:00.000Z' }), config, 'change-branch')).toBe('audit')
		})

		test('implemented shared branch + work.audit → integrate (Auditing silently skipped)', () => {
			expect(classify(makeSlice({ state: 'implemented', implementedAt: '2026-06-04T00:00:00.000Z', sliceBranch: 'change-branch' }), config, 'change-branch')).toBe('integrate')
		})

		test('implemented distinct Slice branch + work.audit false → integrate', () => {
			expect(classify(makeSlice({ state: 'implemented', implementedAt: '2026-06-04T00:00:00.000Z' }), { ...config, audit: false }, 'change-branch')).toBe('integrate')
		})

		test('audited → integrate', () => {
			expect(classify(makeSlice({ state: 'audited', implementedAt: '2026-06-04T00:00:00.000Z', auditedAt: '2026-06-04T00:01:00.000Z' }), config, 'change-branch')).toBe('integrate')
		})

		test('open slice with no PR yet → implement', () => {
			expect(classify(makeSlice(), config, 'change-branch')).toBe('implement')
		})
	})
}
