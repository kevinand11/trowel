import type { FeedbackEntry } from './verdict.ts'
import type { GhRunner } from '../utils/gh-runner.ts'

export type FeedbackDeps = {
	gh: GhRunner
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

async function ghJson<T>(deps: FeedbackDeps, args: string[]): Promise<T> {
	const res = await deps.gh(args)
	if (!res.ok) throw new Error(`gh ${args.join(' ')} failed: ${res.error.message}`)
	return JSON.parse(res.stdout) as T
}

type ThreadCommentRaw = {
	author: { login: string }
	createdAt: string
	body: string
}

export async function fetchPrFeedback(prNumber: number, deps: FeedbackDeps): Promise<FeedbackEntry[]> {
	const lineRaw = await ghJson<LineCommentRaw[]>(deps, ['api', `repos/{owner}/{repo}/pulls/${prNumber}/comments`])
	const reviewsRaw = await ghJson<{ reviews: ReviewRaw[] }>(deps, ['pr', 'view', String(prNumber), '--json', 'reviews'])
	const threadRaw = await ghJson<{ comments: ThreadCommentRaw[] }>(deps, ['pr', 'view', String(prNumber), '--json', 'comments'])

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

	const emptyJson = (stdout: string) => ({ ok: true as const, stdout, stderr: '' })

	describe('fetchPrFeedback', () => {
		test('returns all three kinds merged and sorted by createdAt ascending', async () => {
			const { gh } = makeGh([
				{
					match: (a) => a[0] === 'api' && a[1]!.endsWith('/comments'),
					respond: emptyJson(
						JSON.stringify([
							{ user: { login: 'a' }, created_at: '2026-05-11T12:00:00Z', body: 'line late', path: 'a.ts', line: 1 },
						]),
					),
				},
				{
					match: (a) => a[0] === 'pr' && a[1] === 'view' && a.includes('reviews'),
					respond: emptyJson(
						JSON.stringify({
							reviews: [{ author: { login: 'b' }, submittedAt: '2026-05-11T10:00:00Z', body: 'review early', state: 'COMMENTED' }],
						}),
					),
				},
				{
					match: (a) => a[0] === 'pr' && a[1] === 'view' && a.includes('comments'),
					respond: emptyJson(
						JSON.stringify({
							comments: [{ author: { login: 'c' }, createdAt: '2026-05-11T11:00:00Z', body: 'thread middle' }],
						}),
					),
				},
			])

			const out = await fetchPrFeedback(168, { gh })
			expect(out).toHaveLength(3)
			expect(out.map((e) => e.body)).toEqual(['review early', 'thread middle', 'line late'])
		})

		test('fetches PR thread comments and returns each as a `thread` FeedbackEntry', async () => {
			const { gh } = makeGh([
				{
					match: (a) => a[0] === 'api' && a[1]!.includes('/pulls/') && a[1]!.endsWith('/comments'),
					respond: emptyJson('[]'),
				},
				{
					match: (a) => a[0] === 'pr' && a[1] === 'view' && a.includes('reviews'),
					respond: emptyJson('{"reviews":[]}'),
				},
				{
					match: (a) => a[0] === 'pr' && a[1] === 'view' && a.includes('comments'),
					respond: emptyJson(
						JSON.stringify({
							comments: [
								{
									author: { login: 'reviewer-c' },
									createdAt: '2026-05-11T12:00:00Z',
									body: 'free-form thread comment',
								},
							],
						}),
					),
				},
			])

			const out = await fetchPrFeedback(168, { gh })
			expect(out).toHaveLength(1)
			expect(out[0]).toEqual({
				kind: 'thread',
				author: 'reviewer-c',
				createdAt: '2026-05-11T12:00:00Z',
				body: 'free-form thread comment',
			})
		})

		test('fetches PR review summaries and returns each as a `review` FeedbackEntry', async () => {
			const { gh } = makeGh([
				{
					match: (a) => a[0] === 'api' && a[1]!.includes('/pulls/') && a[1]!.endsWith('/comments'),
					respond: emptyJson('[]'),
				},
				{
					match: (a) => a[0] === 'pr' && a[1] === 'view' && a.includes('reviews'),
					respond: emptyJson(
						JSON.stringify({
							reviews: [
								{
									author: { login: 'reviewer-b' },
									submittedAt: '2026-05-11T11:00:00Z',
									body: 'overall approach is wrong',
									state: 'CHANGES_REQUESTED',
								},
							],
						}),
					),
				},
				{
					match: (a) => a[0] === 'pr' && a[1] === 'view' && a.includes('comments'),
					respond: emptyJson('{"comments":[]}'),
				},
			])

			const out = await fetchPrFeedback(168, { gh })
			expect(out).toHaveLength(1)
			expect(out[0]).toEqual({
				kind: 'review',
				author: 'reviewer-b',
				createdAt: '2026-05-11T11:00:00Z',
				body: 'overall approach is wrong',
				state: 'CHANGES_REQUESTED',
			})
		})

		test('fetches one line-level review comment and returns it as a `line` FeedbackEntry', async () => {
			const { gh } = makeGh([
				{
					match: (a) => a[0] === 'api' && a[1]!.includes('/pulls/') && a[1]!.endsWith('/comments'),
					respond: emptyJson(
						JSON.stringify([
							{
								user: { login: 'reviewer-a' },
								created_at: '2026-05-11T10:00:00Z',
								body: 'extract this into a helper',
								path: 'src/foo.ts',
								line: 42,
							},
						]),
					),
				},
				{
					match: (a) => a[0] === 'pr' && a[1] === 'view' && a.includes('reviews'),
					respond: emptyJson('{"reviews":[]}'),
				},
				{
					match: (a) => a[0] === 'pr' && a[1] === 'view' && a.includes('comments'),
					respond: emptyJson('{"comments":[]}'),
				},
			])

			const out = await fetchPrFeedback(168, { gh })
			expect(out).toHaveLength(1)
			expect(out[0]).toMatchObject({
				kind: 'line',
				author: 'reviewer-a',
				createdAt: '2026-05-11T10:00:00Z',
				body: 'extract this into a helper',
				path: 'src/foo.ts',
				line: 42,
			})
		})
	})
}
