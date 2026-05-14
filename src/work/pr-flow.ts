import type { FeedbackEntry } from './verdict.ts'
import type { SlicePrState, Slice } from '../storages/types.ts'
import type { GhRunner } from '../utils/gh-runner.ts'
import { slug as slugify } from '../utils/slug.ts'

/**
 * PR-flow primitives the loop and phase functions call through. All take `gh` first so they're
 * testable with a recording stub. See ADR `storage-behavior-separation` step 4.
 */

async function ghOrThrow(gh: GhRunner, args: string[]): Promise<string> {
	const r = await gh(args)
	if (!r.ok) throw r.error
	return r.stdout
}

/**
 * Canonical per-slice branch name for `prFlow: true` storages. The implementer creates this
 * branch; subsequent `findPrNumber` / `getPrStates` calls look up PRs against it.
 */
export function sliceBranchFor(prdId: string, slice: Slice): string {
	return `prd-${prdId}/slice-${slice.id}-${slugify(slice.title)}`
}

/**
 * Enrich slices with their `prState` via one bulk `gh pr list`. Storages with `prFlow: true`
 * return `prState: null` from `findSlices`; the loop calls this to populate the field before
 * classification and reconciliation. No-op for empty slice lists.
 */
export async function enrichSlicePrStates(gh: GhRunner, prdId: string, slices: Slice[]): Promise<Slice[]> {
	const openSlices = slices.filter((s) => s.state === 'OPEN')
	if (openSlices.length === 0) return slices
	const branches = openSlices.map((s) => sliceBranchFor(prdId, s))
	const stateByBranch = await getPrStates(gh, branches)
	return slices.map((s) => {
		if (s.state !== 'OPEN') return s
		const branch = sliceBranchFor(prdId, s)
		return { ...s, prState: stateByBranch.get(branch) ?? null }
	})
}

/**
 * Open a draft PR for the slice's branch against the integration branch. Used by the
 * implementer (after a successful land) and by `reconcileSlices` (to heal a branch-ahead-no-PR
 * slice from a prior killed run).
 */
export async function openDraftPr(gh: GhRunner, slice: Slice, sliceBranch: string, integrationBranch: string): Promise<void> {
	await ghOrThrow(gh, [
		'pr', 'create', '--draft',
		'--title', slice.title,
		'--head', sliceBranch,
		'--base', integrationBranch,
		'--body', `Closes #${slice.id}`,
	])
}

/**
 * Mark a draft PR as ready for review. Used by the reviewer when its verdict is `ready`.
 */
export async function markPrReady(gh: GhRunner, prNumber: number): Promise<void> {
	await ghOrThrow(gh, ['pr', 'ready', String(prNumber)])
}

/**
 * Look up the PR number for an open PR whose head matches `sliceBranch`. Throws if no PR exists.
 * Used by the reviewer and addresser to build `turnIn.pr`.
 */
export async function findPrNumber(gh: GhRunner, sliceBranch: string): Promise<number> {
	const out = await ghOrThrow(gh, ['pr', 'list', '--head', sliceBranch, '--json', 'number', '--jq', '.[0].number'])
	const trimmed = out.trim()
	if (!trimmed) throw new Error(`no PR found for head '${sliceBranch}'`)
	return Number.parseInt(trimmed, 10)
}

/**
 * Bulk-query open PRs and map each requested branch to its `SlicePrState`. One `gh pr list`
 * regardless of branch count — preserves the call-efficiency the issue storage previously had
 * inline in `findSlices`.
 *
 * Returns `'draft'` for branches with an open PR (the only case the issue storage detected
 * historically). `'ready'` and `'merged'` will need their own queries; we'll add them when the
 * loop needs to distinguish them. For branches with no open PR, the map value is `null`.
 */
export async function getPrStates(gh: GhRunner, branches: string[]): Promise<Map<string, SlicePrState>> {
	const result = new Map<string, SlicePrState>()
	for (const b of branches) result.set(b, null)
	if (branches.length === 0) return result
	const out = await ghOrThrow(gh, ['pr', 'list', '--state', 'open', '--json', 'headRefName'])
	const prs = JSON.parse(out) as Array<{ headRefName: string }>
	const openBranches = new Set(prs.map((p) => p.headRefName))
	for (const b of branches) {
		if (openBranches.has(b)) result.set(b, 'draft')
	}
	return result
}

type LineCommentRaw = {
	user: { login: string }
	created_at: string
	body: string
	path: string
	line: number
}

type ReviewRaw = {
	author: { login: string }
	submittedAt: string
	body: string
	state: 'COMMENTED' | 'CHANGES_REQUESTED' | 'APPROVED'
}

type ThreadCommentRaw = {
	author: { login: string }
	createdAt: string
	body: string
}

async function ghJson<T>(gh: GhRunner, args: string[]): Promise<T> {
	const res = await gh(args)
	if (!res.ok) throw new Error(`gh ${args.join(' ')} failed: ${res.error.message}`)
	return JSON.parse(res.stdout) as T
}

/**
 * Fetch a PR's reviewer feedback as a merged, time-sorted list. Combines:
 * - GitHub's pull-request line comments (`api repos/{owner}/{repo}/pulls/N/comments`)
 * - PR-level review summaries (`pr view N --json reviews`)
 * - PR thread comments (`pr view N --json comments`)
 *
 * Previously in `src/work/feedback.ts`; consolidated here as one of the PR-flow primitives.
 */
export async function fetchPrFeedback(gh: GhRunner, prNumber: number): Promise<FeedbackEntry[]> {
	const lineRaw = await ghJson<LineCommentRaw[]>(gh, ['api', `repos/{owner}/{repo}/pulls/${prNumber}/comments`])
	const reviewsRaw = await ghJson<{ reviews: ReviewRaw[] }>(gh, ['pr', 'view', String(prNumber), '--json', 'reviews'])
	const threadRaw = await ghJson<{ comments: ThreadCommentRaw[] }>(gh, ['pr', 'view', String(prNumber), '--json', 'comments'])

	const lineEntries: FeedbackEntry[] = lineRaw.map((c) => ({
		kind: 'line',
		author: c.user.login,
		createdAt: c.created_at,
		body: c.body,
		path: c.path,
		line: c.line,
		resolved: false,
	}))
	const reviewEntries: FeedbackEntry[] = reviewsRaw.reviews
		.filter((r) => r.body.length > 0)
		.map((r) => ({
			kind: 'review',
			author: r.author.login,
			createdAt: r.submittedAt,
			body: r.body,
			state: r.state,
		}))
	const threadEntries: FeedbackEntry[] = threadRaw.comments.map((c) => ({
		kind: 'thread',
		author: c.author.login,
		createdAt: c.createdAt,
		body: c.body,
	}))
	return [...lineEntries, ...reviewEntries, ...threadEntries].sort((a, b) => a.createdAt.localeCompare(b.createdAt))
}

if (import.meta.vitest) {
	const { describe, test, expect } = import.meta.vitest

	type GhStub = { match: (args: string[]) => boolean; respond: { ok: true; stdout: string; stderr: string } | { ok: false; error: Error } }

	function makeGh(stubs: GhStub[]): { gh: GhRunner; calls: string[][] } {
		const calls: string[][] = []
		const gh: GhRunner = async (args) => {
			calls.push(args)
			const match = stubs.find((s) => s.match(args))
			if (!match) throw new Error(`unmatched gh call: ${args.join(' ')}`)
			return match.respond
		}
		return { gh, calls }
	}

	const okJson = (stdout: string) => ({ ok: true as const, stdout, stderr: '' })

	describe('openDraftPr', () => {
		test('issues `gh pr create --draft` with title/head/base/body, body closes the sub-issue', async () => {
			const { gh, calls } = makeGh([
				{ match: (a) => a[0] === 'pr' && a[1] === 'create', respond: okJson('') },
			])
			const slice: Slice = {
				id: '145', title: 'Session Middleware', body: 'b',
				state: 'OPEN', readyForAgent: true, needsRevision: false,
				blockedBy: [], prState: null, branchAhead: false,
			}
			await openDraftPr(gh, slice, 'prd-142/slice-145-session-middleware', 'prds-issue-142')
			expect(calls[0]).toEqual([
				'pr', 'create', '--draft',
				'--title', 'Session Middleware',
				'--head', 'prd-142/slice-145-session-middleware',
				'--base', 'prds-issue-142',
				'--body', 'Closes #145',
			])
		})

		test('throws when gh fails', async () => {
			const gh: GhRunner = async () => ({ ok: false, error: new Error('rate limited') })
			const slice: Slice = {
				id: '1', title: 't', body: 'b', state: 'OPEN', readyForAgent: true,
				needsRevision: false, blockedBy: [], prState: null, branchAhead: false,
			}
			await expect(openDraftPr(gh, slice, 'b', 'integration')).rejects.toThrow(/rate limited/)
		})
	})

	describe('markPrReady', () => {
		test('issues `gh pr ready <number>`', async () => {
			const { gh, calls } = makeGh([{ match: (a) => a[0] === 'pr' && a[1] === 'ready', respond: okJson('') }])
			await markPrReady(gh, 168)
			expect(calls[0]).toEqual(['pr', 'ready', '168'])
		})
	})

	describe('findPrNumber', () => {
		test('parses the number from `gh pr list --head <branch>`', async () => {
			const { gh } = makeGh([{ match: (a) => a[0] === 'pr' && a[1] === 'list', respond: okJson('168\n') }])
			expect(await findPrNumber(gh, 'feature/x')).toBe(168)
		})

		test('throws when no PR matches', async () => {
			const { gh } = makeGh([{ match: (a) => a[0] === 'pr' && a[1] === 'list', respond: okJson('') }])
			await expect(findPrNumber(gh, 'feature/x')).rejects.toThrow(/no PR found for head 'feature\/x'/)
		})
	})

	describe('enrichSlicePrStates', () => {
		const makeSlice = (overrides: Partial<Slice> = {}): Slice => ({
			id: '57', title: 'Implement Parser', body: 'b',
			state: 'OPEN', readyForAgent: true, needsRevision: false,
			blockedBy: [], prState: null, branchAhead: false,
			...overrides,
		})

		test('populates prState=draft for slices whose slice branch has an open PR; leaves others null', async () => {
			const { gh } = makeGh([
				{ match: (a) => a[0] === 'pr' && a[1] === 'list', respond: okJson(JSON.stringify([{ headRefName: 'prd-42/slice-57-implement-parser' }])) },
			])
			const slices = [makeSlice({ id: '57', title: 'Implement Parser' }), makeSlice({ id: '58', title: 'Wire CLI' })]
			const out = await enrichSlicePrStates(gh, '42', slices)
			expect(out[0]!.prState).toBe('draft')
			expect(out[1]!.prState).toBeNull()
		})

		test('skips the gh call when no OPEN slices exist (CLOSED slices alone → no enrichment)', async () => {
			const { gh, calls } = makeGh([])
			const out = await enrichSlicePrStates(gh, '42', [makeSlice({ state: 'CLOSED' })])
			expect(calls).toEqual([])
			expect(out[0]!.prState).toBeNull()
		})

		test('leaves CLOSED slices untouched even when other OPEN slices trigger the gh call', async () => {
			const { gh } = makeGh([
				{ match: (a) => a[0] === 'pr' && a[1] === 'list', respond: okJson('[]') },
			])
			const slices = [makeSlice({ id: '57', state: 'CLOSED', prState: 'merged' }), makeSlice({ id: '58' })]
			const out = await enrichSlicePrStates(gh, '42', slices)
			expect(out[0]!.prState).toBe('merged')
			expect(out[1]!.prState).toBeNull()
		})
	})

	describe('getPrStates', () => {
		test('batches one `gh pr list` and maps each branch to draft/null', async () => {
			const { gh, calls } = makeGh([
				{
					match: (a) => a[0] === 'pr' && a[1] === 'list',
					respond: okJson(JSON.stringify([{ headRefName: 'prd-142/slice-145-session-middleware' }])),
				},
			])
			const out = await getPrStates(gh, ['prd-142/slice-145-session-middleware', 'prd-142/slice-146-other'])
			expect(out.get('prd-142/slice-145-session-middleware')).toBe('draft')
			expect(out.get('prd-142/slice-146-other')).toBeNull()
			expect(calls.filter((c) => c[0] === 'pr' && c[1] === 'list')).toHaveLength(1)
		})

		test('empty branch list → no gh call, returns empty map', async () => {
			const { gh, calls } = makeGh([])
			const out = await getPrStates(gh, [])
			expect(out.size).toBe(0)
			expect(calls).toEqual([])
		})
	})

	describe('fetchPrFeedback', () => {
		test('returns all three kinds merged and sorted by createdAt ascending', async () => {
			const { gh } = makeGh([
				{
					match: (a) => a[0] === 'api' && a[1]!.endsWith('/comments'),
					respond: okJson(JSON.stringify([
						{ user: { login: 'a' }, created_at: '2026-05-11T12:00:00Z', body: 'line late', path: 'a.ts', line: 1 },
					])),
				},
				{
					match: (a) => a[0] === 'pr' && a[1] === 'view' && a.includes('reviews'),
					respond: okJson(JSON.stringify({
						reviews: [{ author: { login: 'b' }, submittedAt: '2026-05-11T10:00:00Z', body: 'review early', state: 'COMMENTED' }],
					})),
				},
				{
					match: (a) => a[0] === 'pr' && a[1] === 'view' && a.includes('comments'),
					respond: okJson(JSON.stringify({
						comments: [{ author: { login: 'c' }, createdAt: '2026-05-11T11:00:00Z', body: 'thread middle' }],
					})),
				},
			])
			const out = await fetchPrFeedback(gh, 168)
			expect(out).toHaveLength(3)
			expect(out.map((e) => e.body)).toEqual(['review early', 'thread middle', 'line late'])
		})

		test('returns thread comments as `thread` entries', async () => {
			const { gh } = makeGh([
				{ match: (a) => a[0] === 'api' && a[1]!.includes('/pulls/') && a[1]!.endsWith('/comments'), respond: okJson('[]') },
				{ match: (a) => a[0] === 'pr' && a[1] === 'view' && a.includes('reviews'), respond: okJson('{"reviews":[]}') },
				{
					match: (a) => a[0] === 'pr' && a[1] === 'view' && a.includes('comments'),
					respond: okJson(JSON.stringify({
						comments: [{ author: { login: 'reviewer-c' }, createdAt: '2026-05-11T12:00:00Z', body: 'free-form thread comment' }],
					})),
				},
			])
			const out = await fetchPrFeedback(gh, 168)
			expect(out).toEqual([{
				kind: 'thread',
				author: 'reviewer-c',
				createdAt: '2026-05-11T12:00:00Z',
				body: 'free-form thread comment',
			}])
		})

		test('returns review summaries as `review` entries (with state)', async () => {
			const { gh } = makeGh([
				{ match: (a) => a[0] === 'api' && a[1]!.includes('/pulls/') && a[1]!.endsWith('/comments'), respond: okJson('[]') },
				{
					match: (a) => a[0] === 'pr' && a[1] === 'view' && a.includes('reviews'),
					respond: okJson(JSON.stringify({
						reviews: [{ author: { login: 'reviewer-b' }, submittedAt: '2026-05-11T11:00:00Z', body: 'overall approach is wrong', state: 'CHANGES_REQUESTED' }],
					})),
				},
				{ match: (a) => a[0] === 'pr' && a[1] === 'view' && a.includes('comments'), respond: okJson('{"comments":[]}') },
			])
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
			const { gh } = makeGh([
				{
					match: (a) => a[0] === 'api' && a[1]!.includes('/pulls/') && a[1]!.endsWith('/comments'),
					respond: okJson(JSON.stringify([
						{ user: { login: 'reviewer-a' }, created_at: '2026-05-11T10:00:00Z', body: 'extract this into a helper', path: 'src/foo.ts', line: 42 },
					])),
				},
				{ match: (a) => a[0] === 'pr' && a[1] === 'view' && a.includes('reviews'), respond: okJson('{"reviews":[]}') },
				{ match: (a) => a[0] === 'pr' && a[1] === 'view' && a.includes('comments'), respond: okJson('{"comments":[]}') },
			])
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
	})
}
