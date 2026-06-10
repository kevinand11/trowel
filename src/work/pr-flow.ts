import type { ClassifiedSlice, SlicePrState } from './slice-types.ts'
import type { FeedbackEntry } from './verdict.ts'
import type { Slice } from '../storages/types.ts'
import type { GhOps } from '../utils/gh-ops.ts'
import type { GitOps } from '../utils/git-ops.ts'

type EnrichedSlice = Slice & Pick<ClassifiedSlice, 'prState' | 'needsRevision'>

/**
 * PR-flow orchestration that sits above `GhOps`. Single-call `gh` primitives
 * (`openDraftPr`, `markPrReady`, `findPrNumber`) used to live here; they now live as
 * typed methods on `GhOps` and callers invoke them directly. What remains is
 * multi-step orchestration: PR-state enrichment, slice-branch naming, and feedback merging.
 */

/** Canonical per-slice branch name (storage-agnostic), once assigned. */
function sliceBranchFor(_changeId: string, slice: Slice): string | null {
	return slice.sliceBranch
}

function assignedBranches(slices: Slice[], changeId: string): string[] {
	return slices.map((s) => sliceBranchFor(changeId, s)).filter((branch): branch is string => branch !== null)
}

/**
 * Enrich non-finalized slices with their `prState`. Open PRs are fetched in one bulk call;
 * branches without an open PR are checked for a merged PR so the Slice can enter `landed`.
 */
export async function enrichSlicesFromOpenPrs(gh: GhOps, changeId: string, slices: Slice[], opts: { needsRevisionLabel?: string } = {}): Promise<EnrichedSlice[]> {
	const activeSlices = slices.filter((s) => s.closedAt === null)
	if (activeSlices.length === 0) return slices.map(defaultPrFacts)
	const branches = assignedBranches(activeSlices, changeId)
	const openPrsByBranch = await getOpenPrsByBranch(gh, branches)
	return Promise.all(slices.map(async (s) => enrichSliceFromPrs(gh, changeId, s, openPrsByBranch, opts)))
}

async function enrichSliceFromPrs(gh: GhOps, changeId: string, slice: Slice, openPrsByBranch: Map<string, OpenPrForState>, opts: { needsRevisionLabel?: string }): Promise<EnrichedSlice> {
	if (slice.closedAt !== null) return defaultPrFacts(slice)
	const branch = sliceBranchFor(changeId, slice)
	if (branch === null) return { ...slice, prState: null, needsRevision: false }
	const openPr = openPrsByBranch.get(branch)
	if (openPr !== undefined) return enrichSliceFromOpenPr(slice, openPr, opts)
	return { ...slice, prState: await mergedPrState(gh, branch), needsRevision: false }
}

/**
 * Bulk-query open PRs and map each requested branch to its `SlicePrState`. One `gh pr list`
 * regardless of branch count.
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

async function mergedPrState(gh: GhOps, branch: string): Promise<SlicePrState> {
	const pr = await gh.findAnyPrByHead(branch)
	return pr?.state === 'MERGED' ? 'merged' : null
}

function initialPrStateMap(branches: string[]): Map<string, SlicePrState> {
	return new Map(branches.map((b) => [b, null]))
}

type OpenPrForState = Awaited<ReturnType<GhOps['listOpenPrs']>>[number]

function enrichSliceFromOpenPr(slice: Slice, pr: OpenPrForState, opts: { needsRevisionLabel?: string }): EnrichedSlice {
	return { ...slice, prState: prStateForOpenPr(pr), needsRevision: prNeedsRevision(pr, opts.needsRevisionLabel ?? 'needs-revision') }
}

function defaultPrFacts(slice: Slice): EnrichedSlice {
	return { ...slice, prState: null, needsRevision: false }
}

function prStateForOpenPr(pr: OpenPrForState): SlicePrState {
	return pr.isDraft ? 'draft' : 'ready'
}

function prNeedsRevision(pr: OpenPrForState, label: string): boolean {
	return hasNeedsRevisionPrLabel(pr, label) || pr.reviewDecision === 'CHANGES_REQUESTED'
}

function hasNeedsRevisionPrLabel(pr: OpenPrForState, label: string): boolean {
	return pr.labels?.some((entry) => entry.name === label) ?? false
}

/**
 * Fetch a PR's reviewer feedback as a merged, time-sorted list. Combines line
 * comments, PR-level review summaries, and PR thread comments — three `gh`
 * round-trips, mapped to the shared `FeedbackEntry` shape.
 */
export type ReviewFeedback = {
	feedback: FeedbackEntry[]
	hasFreshFeedback: boolean
	headCommitTime: string
}

export async function fetchFreshnessMarkedPrFeedback(gh: GhOps, git: GitOps, prNumber: number, branch: string): Promise<ReviewFeedback> {
	const [feedback, headCommitTime] = await Promise.all([fetchPrFeedback(gh, prNumber), prHeadCommitTime(git, branch)])
	const headTime = parseTimestamp(headCommitTime, 'PR branch head commit time')
	const marked = feedback.map((entry) => ({ ...entry, fresh: parseOptionalTimestamp(entry.createdAt) >= headTime }))
	return { feedback: marked, hasFreshFeedback: marked.some((entry) => entry.fresh), headCommitTime }
}

function parseTimestamp(value: string, label: string): number {
	const time = Date.parse(value)
	if (!Number.isFinite(time)) throw new Error(`invalid ${label}: ${value}`)
	return time
}

function parseOptionalTimestamp(value: string): number {
	const time = Date.parse(value)
	return Number.isFinite(time) ? time : Number.NEGATIVE_INFINITY
}

async function prHeadCommitTime(git: GitOps, branch: string): Promise<string> {
	await git.fetch(branch)
	return git.commitDate(`origin/${branch}`)
}

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
		fresh: true,
	}))
	const reviewEntries: FeedbackEntry[] = reviewsRaw
		.filter((r) => r.body.length > 0)
		.map((r) => ({
			kind: 'review',
			author: r.author.login,
			createdAt: r.submittedAt,
			body: r.body,
			state: r.state,
			fresh: true,
		}))
	const threadEntries: FeedbackEntry[] = threadRaw.map((c) => ({
		kind: 'thread',
		author: c.author.login,
		createdAt: c.createdAt,
		body: c.body,
		fresh: true,
	}))
	return [...lineEntries, ...reviewEntries, ...threadEntries].sort((a, b) => a.createdAt.localeCompare(b.createdAt))
}

if (import.meta.vitest) {
	const { describe, test, expect } = import.meta.vitest
	const { recordingGhOps } = await import('../test-utils/gh-ops-recorder.ts')
	const { noopGitOps } = await import('../test-utils/git-ops-fixtures.ts')

	describe('enrichSlicesFromOpenPrs', () => {
		const makeSlice = (overrides: Partial<Slice> = {}): Slice => ({
			id: '57', title: 'Implement Parser', body: 'b',
			closedAt: null, implementedAt: null, auditedAt: null, readyForAgent: true,
			blockedBy: [], sliceBranch: `change-42/slice-${overrides.id ?? '57'}-implement-parser`,
			...overrides,
		})

		test('populates prState=draft for slices whose slice branch has an open draft PR; leaves others null', async () => {
			const { gh } = recordingGhOps({
				listOpenPrs: async () => [{ number: 1, headRefName: 'change-42/slice-57-implement-parser', isDraft: true }],
			})
			const slices = [makeSlice({ id: '57', title: 'Implement Parser' }), makeSlice({ id: '58', title: 'Wire CLI' })]
			const out = await enrichSlicesFromOpenPrs(gh, '42', slices)
			expect(out[0]!.prState).toBe('draft')
			expect(out[1]!.prState).toBeNull()
		})

		test('populates prState=ready for slices whose slice branch has an open non-draft PR', async () => {
			const { gh } = recordingGhOps({
				listOpenPrs: async () => [{ number: 1, headRefName: 'change-42/slice-57-implement-parser', isDraft: false }],
			})
			const out = await enrichSlicesFromOpenPrs(gh, '42', [makeSlice({ id: '57', title: 'Implement Parser' })])
			expect(out[0]!.prState).toBe('ready')
		})

		test('populates prState=merged for a merged slice PR with no open PR', async () => {
			const { gh } = recordingGhOps({
				listOpenPrs: async () => [],
				findAnyPrByHead: async () => ({ number: 1, state: 'MERGED' }),
			})
			const out = await enrichSlicesFromOpenPrs(gh, '42', [makeSlice()])
			expect(out[0]!.prState).toBe('merged')
		})

		test('derives needsRevision from an open PR needs-revision label', async () => {
			const { gh } = recordingGhOps({
				listOpenPrs: async () => [{ number: 1, headRefName: 'change-42/slice-57-implement-parser', isDraft: false, labels: [{ name: 'needs-revision' }] }],
			})
			const out = await enrichSlicesFromOpenPrs(gh, '42', [makeSlice({ id: '57', title: 'Implement Parser' })])
			expect(out[0]!).toMatchObject({ prState: 'ready', needsRevision: true })
		})

		test('derives needsRevision from an open PR review decision', async () => {
			const { gh } = recordingGhOps({
				listOpenPrs: async () => [{ number: 1, headRefName: 'change-42/slice-57-implement-parser', isDraft: false, reviewDecision: 'CHANGES_REQUESTED' }],
			})
			const out = await enrichSlicesFromOpenPrs(gh, '42', [makeSlice({ id: '57', title: 'Implement Parser' })])
			expect(out[0]!).toMatchObject({ prState: 'ready', needsRevision: true })
		})

		test('reports no needsRevision when no PR review signal exists', async () => {
			const { gh } = recordingGhOps({
				listOpenPrs: async () => [{ number: 1, headRefName: 'change-42/slice-57-implement-parser', isDraft: false, labels: [] }],
			})
			const out = await enrichSlicesFromOpenPrs(gh, '42', [makeSlice({ id: '57', title: 'Implement Parser' })])
			expect(out[0]!).toMatchObject({ prState: 'ready', needsRevision: false })
		})

		test('skips gh calls when no active slices exist', async () => {
			const { gh, calls } = recordingGhOps()
			const out = await enrichSlicesFromOpenPrs(gh, '42', [makeSlice({ closedAt: '2026-06-04T00:00:00.000Z' })])
			expect(calls).toEqual([])
			expect(out[0]!.prState).toBeNull()
		})
	})

	describe('getPrStates', () => {
		test('batches one listOpenPrs call and maps each branch to draft/ready/null', async () => {
			const { gh, calls } = recordingGhOps({
				listOpenPrs: async () => [
					{ number: 1, headRefName: 'change-142/slice-145-session-middleware', isDraft: true },
					{ number: 2, headRefName: 'change-142/slice-146-other', isDraft: false },
				],
			})
			const out = await getPrStates(gh, ['change-142/slice-145-session-middleware', 'change-142/slice-146-other', 'change-142/slice-147-missing'])
			expect(out.get('change-142/slice-145-session-middleware')).toBe('draft')
			expect(out.get('change-142/slice-146-other')).toBe('ready')
			expect(out.get('change-142/slice-147-missing')).toBeNull()
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
				fetchPrLineComments: async () => [{ user: { login: 'a' }, created_at: '2026-05-11T12:00:00Z', body: 'line late', path: 'a.ts', line: 1 }],
				fetchPrReviews: async () => [{ author: { login: 'b' }, submittedAt: '2026-05-11T10:00:00Z', body: 'review early', state: 'COMMENTED' }],
				fetchPrThread: async () => [{ author: { login: 'c' }, createdAt: '2026-05-11T11:00:00Z', body: 'thread middle' }],
			})
			const out = await fetchPrFeedback(gh, 168)
			expect(out).toHaveLength(3)
			expect(out.map((e) => e.body)).toEqual(['review early', 'thread middle', 'line late'])
		})

		test('returns thread comments as `thread` entries', async () => {
			const { gh } = recordingGhOps({
				fetchPrLineComments: async () => [],
				fetchPrReviews: async () => [],
				fetchPrThread: async () => [{ author: { login: 'reviewer-c' }, createdAt: '2026-05-11T12:00:00Z', body: 'free-form thread comment' }],
			})
			expect(await fetchPrFeedback(gh, 168)).toEqual([{ kind: 'thread', author: 'reviewer-c', createdAt: '2026-05-11T12:00:00Z', body: 'free-form thread comment', fresh: true }])
		})

		test('returns review summaries as `review` entries (with state)', async () => {
			const { gh } = recordingGhOps({
				fetchPrLineComments: async () => [],
				fetchPrReviews: async () => [{ author: { login: 'reviewer-b' }, submittedAt: '2026-05-11T11:00:00Z', body: 'overall approach is wrong', state: 'CHANGES_REQUESTED' }],
				fetchPrThread: async () => [],
			})
			expect(await fetchPrFeedback(gh, 168)).toEqual([{ kind: 'review', author: 'reviewer-b', createdAt: '2026-05-11T11:00:00Z', body: 'overall approach is wrong', state: 'CHANGES_REQUESTED', fresh: true }])
		})

		test('returns line comments as `line` entries', async () => {
			const { gh } = recordingGhOps({
				fetchPrLineComments: async () => [{ user: { login: 'reviewer-a' }, created_at: '2026-05-11T10:00:00Z', body: 'extract this into a helper', path: 'src/foo.ts', line: 42 }],
				fetchPrReviews: async () => [],
				fetchPrThread: async () => [],
			})
			expect(await fetchPrFeedback(gh, 168)).toMatchObject([{ kind: 'line', author: 'reviewer-a', createdAt: '2026-05-11T10:00:00Z', body: 'extract this into a helper', path: 'src/foo.ts', line: 42 }])
		})

		test('marks feedback fresh when created at or after branch head commit time', async () => {
			const { gh } = recordingGhOps({
				fetchPrLineComments: async () => [],
				fetchPrReviews: async () => [],
				fetchPrThread: async () => [
					{ author: { login: 'old' }, createdAt: '2026-05-11T09:59:59Z', body: 'old' },
					{ author: { login: 'same' }, createdAt: '2026-05-11T10:00:00Z', body: 'same' },
					{ author: { login: 'new' }, createdAt: '2026-05-11T10:00:01Z', body: 'new' },
				],
			})
			const git = noopGitOps({ commitDate: async () => '2026-05-11T10:00:00Z' })
			const out = await fetchFreshnessMarkedPrFeedback(gh, git, 168, 'feature')
			expect(out.hasFreshFeedback).toBe(true)
			expect(out.feedback.map((entry) => [entry.body, entry.fresh])).toEqual([
				['old', false],
				['same', true],
				['new', true],
			])
		})

		test('compares feedback and head commit timestamps by instant, not ISO string order', async () => {
			const { gh } = recordingGhOps({
				fetchPrLineComments: async () => [],
				fetchPrReviews: async () => [],
				fetchPrThread: async () => [{ author: { login: 'reviewer' }, createdAt: '2026-06-10T10:30:00Z', body: 'new in UTC' }],
			})
			const git = noopGitOps({ commitDate: async () => '2026-06-10T12:00:00+02:00' })
			const out = await fetchFreshnessMarkedPrFeedback(gh, git, 168, 'feature')
			expect(out.feedback).toMatchObject([{ body: 'new in UTC', fresh: true }])
			expect(out.hasFreshFeedback).toBe(true)
		})

		test('drops review summaries with empty body', async () => {
			const { gh } = recordingGhOps({
				fetchPrLineComments: async () => [],
				fetchPrReviews: async () => [{ author: { login: 'r' }, submittedAt: 't', body: '', state: 'COMMENTED' }],
				fetchPrThread: async () => [],
			})
			expect(await fetchPrFeedback(gh, 1)).toEqual([])
		})
	})
}
