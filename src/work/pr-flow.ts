import type { FeedbackEntry } from './verdict.ts'
import type { SlicePrState, Slice } from '../storages/types.ts'
import type { GhOps } from '../utils/gh-ops.ts'
import { slug as slugify } from '../utils/slug.ts'

/**
 * PR-flow orchestration that sits above `GhOps`. Single-call `gh` primitives
 * (`openDraftPr`, `markPrReady`, `findPrNumber`) used to live here; they now live as
 * typed methods on `GhOps` and callers invoke them directly. What remains is
 * multi-step orchestration: bulk PR-state enrichment, slice-branch naming, and
 * feedback merging.
 */

/**
 * Canonical per-slice branch name (storage-agnostic). The implementer creates this
 * branch; subsequent `gh.findPrNumberByHead` / `getPrStates` calls look up PRs against it.
 */
function sliceBranchFor(prdId: string, slice: Slice): string {
	return `prd-${prdId}/slice-${slice.id}-${slugify(slice.title)}`
}

/**
 * Enrich slices with their `prState` via one bulk `gh pr list`. Storages return raw slices
 * with `prState: null`; the loop calls this when `config.work.usePrs` is true to populate the
 * field before classification and reconciliation. No-op for empty slice lists.
 */
export async function enrichSlicePrStates(gh: GhOps, prdId: string, slices: Slice[]): Promise<Slice[]> {
	const openSlices = slices.filter((s) => s.state === 'OPEN')
	if (openSlices.length === 0) return slices
	const branches = openSlices.map((s) => sliceBranchFor(prdId, s))
	const prsByBranch = await getOpenPrsByBranch(gh, branches)
	return slices.map((s) => {
		if (s.state !== 'OPEN') return s
		const pr = prsByBranch.get(sliceBranchFor(prdId, s))
		return pr === undefined ? { ...s, prState: null } : enrichSliceFromOpenPr(s, pr)
	})
}

/**
 * Bulk-query open PRs and map each requested branch to its `SlicePrState`. One `gh pr list`
 * regardless of branch count — preserves the call-efficiency the issue storage previously had
 * inline in `findSlices`.
 *
 * Returns `'draft'` for branches with an open draft PR and `'ready'` for branches with an open
 * non-draft PR. For branches with no open PR, the map value is `null`.
 */
async function getPrStates(gh: GhOps, branches: string[]): Promise<Map<string, SlicePrState>> {
	const result = initialPrStateMap(branches)
	for (const [branch, pr] of await getOpenPrsByBranch(gh, branches)) result.set(branch, prStateForOpenPr(pr))
	return result
}

async function getOpenPrsByBranch(gh: GhOps, branches: string[]): Promise<Map<string, OpenPrForState>> {
	const result = new Map<string, OpenPrForState>()
	if (branches.length === 0) return result
	const requested = new Set(branches)
	for (const pr of await gh.listOpenPrs()) if (requested.has(pr.headRefName)) result.set(pr.headRefName, pr)
	return result
}

function initialPrStateMap(branches: string[]): Map<string, SlicePrState> {
	return new Map(branches.map((b) => [b, null]))
}

type OpenPrForState = Awaited<ReturnType<GhOps['listOpenPrs']>>[number]

function enrichSliceFromOpenPr(slice: Slice, pr: OpenPrForState): Slice {
	return { ...slice, prState: prStateForOpenPr(pr), needsRevision: slice.needsRevision || hasNeedsRevisionPrLabel(pr) }
}

function prStateForOpenPr(pr: OpenPrForState): SlicePrState {
	return pr.isDraft ? 'draft' : 'ready'
}

function hasNeedsRevisionPrLabel(pr: OpenPrForState): boolean {
	return pr.labels?.some((label) => label.name === 'needs-revision') ?? false
}

/**
 * Fetch a PR's reviewer feedback as a merged, time-sorted list. Combines line
 * comments, PR-level review summaries, and PR thread comments — three `gh`
 * round-trips, mapped to the shared `FeedbackEntry` shape.
 */
export async function fetchPrFeedback(gh: GhOps, prNumber: number): Promise<FeedbackEntry[]> {
	const [lineRaw, reviewsRaw, threadRaw] = await Promise.all([
		gh.fetchPrLineComments(prNumber),
		gh.fetchPrReviews(prNumber),
		gh.fetchPrThread(prNumber),
	])

	const lineEntries: FeedbackEntry[] = lineRaw.map((c) => ({
		kind: 'line',
		author: c.user.login,
		createdAt: c.created_at,
		body: c.body,
		path: c.path,
		line: c.line,
		resolved: false,
	}))
	const reviewEntries: FeedbackEntry[] = reviewsRaw
		.filter((r) => r.body.length > 0)
		.map((r) => ({
			kind: 'review',
			author: r.author.login,
			createdAt: r.submittedAt,
			body: r.body,
			state: r.state,
		}))
	const threadEntries: FeedbackEntry[] = threadRaw.map((c) => ({
		kind: 'thread',
		author: c.author.login,
		createdAt: c.createdAt,
		body: c.body,
	}))
	return [...lineEntries, ...reviewEntries, ...threadEntries].sort((a, b) => a.createdAt.localeCompare(b.createdAt))
}

if (import.meta.vitest) {
	const { describe, test, expect } = import.meta.vitest
	const { recordingGhOps } = await import('../test-utils/gh-ops-recorder.ts')

	describe('enrichSlicePrStates', () => {
		const makeSlice = (overrides: Partial<Slice> = {}): Slice => ({
			id: '57', title: 'Implement Parser', body: 'b',
			state: 'OPEN', readyForAgent: true, needsRevision: false,
			blockedBy: [], prState: null,
			...overrides,
		})

		test('populates prState=draft for slices whose slice branch has an open draft PR; leaves others null', async () => {
			const { gh } = recordingGhOps({
				listOpenPrs: async () => [{ number: 1, headRefName: 'prd-42/slice-57-implement-parser', isDraft: true }],
			})
			const slices = [makeSlice({ id: '57', title: 'Implement Parser' }), makeSlice({ id: '58', title: 'Wire CLI' })]
			const out = await enrichSlicePrStates(gh, '42', slices)
			expect(out[0]!.prState).toBe('draft')
			expect(out[1]!.prState).toBeNull()
		})

		test('populates prState=ready for slices whose slice branch has an open non-draft PR', async () => {
			const { gh } = recordingGhOps({
				listOpenPrs: async () => [{ number: 1, headRefName: 'prd-42/slice-57-implement-parser', isDraft: false }],
			})
			const slices = [makeSlice({ id: '57', title: 'Implement Parser' })]
			const out = await enrichSlicePrStates(gh, '42', slices)
			expect(out[0]!.prState).toBe('ready')
		})

		test('copies an open PR needs-revision label into slice needsRevision', async () => {
			const { gh } = recordingGhOps({
				listOpenPrs: async () => [{ number: 1, headRefName: 'prd-42/slice-57-implement-parser', isDraft: false, labels: [{ name: 'needs-revision' }] }],
			})
			const slices = [makeSlice({ id: '57', title: 'Implement Parser', needsRevision: false })]
			const out = await enrichSlicePrStates(gh, '42', slices)
			expect(out[0]!).toMatchObject({ prState: 'ready', needsRevision: true })
		})

		test('skips the gh call when no OPEN slices exist (CLOSED slices alone → no enrichment)', async () => {
			const { gh, calls } = recordingGhOps()
			const out = await enrichSlicePrStates(gh, '42', [makeSlice({ state: 'CLOSED' })])
			expect(calls).toEqual([])
			expect(out[0]!.prState).toBeNull()
		})

		test('leaves CLOSED slices untouched even when other OPEN slices trigger the gh call', async () => {
			const { gh } = recordingGhOps({ listOpenPrs: async () => [] })
			const slices = [makeSlice({ id: '57', state: 'CLOSED', prState: 'merged' }), makeSlice({ id: '58' })]
			const out = await enrichSlicePrStates(gh, '42', slices)
			expect(out[0]!.prState).toBe('merged')
			expect(out[1]!.prState).toBeNull()
		})
	})

	describe('getPrStates', () => {
		test('batches one listOpenPrs call and maps each branch to draft/ready/null', async () => {
			const { gh, calls } = recordingGhOps({
				listOpenPrs: async () => [
					{ number: 1, headRefName: 'prd-142/slice-145-session-middleware', isDraft: true },
					{ number: 2, headRefName: 'prd-142/slice-146-other', isDraft: false },
				],
			})
			const out = await getPrStates(gh, ['prd-142/slice-145-session-middleware', 'prd-142/slice-146-other', 'prd-142/slice-147-missing'])
			expect(out.get('prd-142/slice-145-session-middleware')).toBe('draft')
			expect(out.get('prd-142/slice-146-other')).toBe('ready')
			expect(out.get('prd-142/slice-147-missing')).toBeNull()
			expect(calls.filter((c) => c[0] === 'listOpenPrs')).toHaveLength(1)
		})

		test('empty branch list → no gh call, returns empty map', async () => {
			const { gh, calls } = recordingGhOps()
			const out = await getPrStates(gh, [])
			expect(out.size).toBe(0)
			expect(calls).toEqual([])
		})
	})

	describe('fetchPrFeedback', () => {
		test('returns all three kinds merged and sorted by createdAt ascending', async () => {
			const { gh } = recordingGhOps({
				fetchPrLineComments: async () => [
					{ user: { login: 'a' }, created_at: '2026-05-11T12:00:00Z', body: 'line late', path: 'a.ts', line: 1 },
				],
				fetchPrReviews: async () => [
					{ author: { login: 'b' }, submittedAt: '2026-05-11T10:00:00Z', body: 'review early', state: 'COMMENTED' },
				],
				fetchPrThread: async () => [
					{ author: { login: 'c' }, createdAt: '2026-05-11T11:00:00Z', body: 'thread middle' },
				],
			})
			const out = await fetchPrFeedback(gh, 168)
			expect(out).toHaveLength(3)
			expect(out.map((e) => e.body)).toEqual(['review early', 'thread middle', 'line late'])
		})

		test('returns thread comments as `thread` entries', async () => {
			const { gh } = recordingGhOps({
				fetchPrLineComments: async () => [],
				fetchPrReviews: async () => [],
				fetchPrThread: async () => [
					{ author: { login: 'reviewer-c' }, createdAt: '2026-05-11T12:00:00Z', body: 'free-form thread comment' },
				],
			})
			const out = await fetchPrFeedback(gh, 168)
			expect(out).toEqual([{
				kind: 'thread',
				author: 'reviewer-c',
				createdAt: '2026-05-11T12:00:00Z',
				body: 'free-form thread comment',
			}])
		})

		test('returns review summaries as `review` entries (with state)', async () => {
			const { gh } = recordingGhOps({
				fetchPrLineComments: async () => [],
				fetchPrReviews: async () => [
					{ author: { login: 'reviewer-b' }, submittedAt: '2026-05-11T11:00:00Z', body: 'overall approach is wrong', state: 'CHANGES_REQUESTED' },
				],
				fetchPrThread: async () => [],
			})
			const out = await fetchPrFeedback(gh, 168)
			expect(out).toEqual([{
				kind: 'review',
				author: 'reviewer-b',
				createdAt: '2026-05-11T11:00:00Z',
				body: 'overall approach is wrong',
				state: 'CHANGES_REQUESTED',
			}])
		})

		test('returns line comments as `line` entries', async () => {
			const { gh } = recordingGhOps({
				fetchPrLineComments: async () => [
					{ user: { login: 'reviewer-a' }, created_at: '2026-05-11T10:00:00Z', body: 'extract this into a helper', path: 'src/foo.ts', line: 42 },
				],
				fetchPrReviews: async () => [],
				fetchPrThread: async () => [],
			})
			const out = await fetchPrFeedback(gh, 168)
			expect(out).toMatchObject([{
				kind: 'line',
				author: 'reviewer-a',
				createdAt: '2026-05-11T10:00:00Z',
				body: 'extract this into a helper',
				path: 'src/foo.ts',
				line: 42,
			}])
		})

		test('drops review summaries with empty body', async () => {
			const { gh } = recordingGhOps({
				fetchPrLineComments: async () => [],
				fetchPrReviews: async () => [
					{ author: { login: 'r' }, submittedAt: 't', body: '', state: 'COMMENTED' },
				],
				fetchPrThread: async () => [],
			})
			expect(await fetchPrFeedback(gh, 1)).toEqual([])
		})
	})
}
