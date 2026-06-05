import { parseSemver, tryExec, type ShellResult } from './shell.ts'
import type { ShipMergeMethod } from '../storages/types.ts'

/**
 * Single canonical surface for every `gh` operation trowel performs. Parallel
 * to `GitOps` (`src/utils/git-ops.ts`): callers consume named typed methods,
 * tests stub a partial `GhOps` rather than mocking arg arrays.
 */

type GhRunner = (args: string[]) => Promise<ShellResult>

type VersionInfo = { installed: boolean; version?: string }

export type IssueState = 'open' | 'closed'

export type IssueSummary = {
	number: number
	title: string
	createdAt: string
	body: string
	state: IssueState
	closedAt: string | null
}

export type IssueRecord = {
	internalId: number
	number: number
	title: string
	state: IssueState
	body: string
	createdAt: string
	closedAt?: string | null
}

export type CreatedIssue = {
	number: number
	internalId: number
	title: string
	url: string
}

export type CreatedPr = {
	number: number
	headRefName: string
	isDraft: boolean
	url: string
}

type ApiIssue = {
	id: number
	number: number
	title: string
	state: IssueState
	body: string | null
	created_at?: string
	closed_at?: string | null
	html_url?: string
}

type ApiPull = {
	number: number
	state: string
	draft?: boolean
	html_url?: string
	head?: { ref?: string }
}

type ApiReview = {
	user: { login: string }
	submitted_at: string
	body: string
	state: 'COMMENTED' | 'CHANGES_REQUESTED' | 'APPROVED'
}

type ApiIssueComment = {
	user: { login: string }
	created_at: string
	body: string
}

/**
 * Raw shape returned by the `repos/{owner}/{repo}/issues/{n}/sub_issues` endpoint.
 * Exposed as the GhOps boundary type so callers can map to their own domain shape.
 */
export type RawSubIssue = {
	number: number
	title: string
	body: string
	state: IssueState
	closed_at?: string | null
	closedAt?: string | null
	labels: Array<{ name: string }>
	issue_dependencies_summary?: { total_blocked_by?: number }
}

export type BlockerEntry = { id: number; number: number }

export type PrSummary = {
	number: number
	headRefName: string
	isDraft: boolean
	url?: string
	labels?: Array<{ name: string }>
	reviewDecision?: 'CHANGES_REQUESTED' | 'APPROVED' | 'REVIEW_REQUIRED' | string | null
}

export type LineCommentRaw = {
	user: { login: string }
	created_at: string
	body: string
	path: string
	line: number
}

export type ReviewRaw = {
	author: { login: string }
	submittedAt: string
	body: string
	state: 'COMMENTED' | 'CHANGES_REQUESTED' | 'APPROVED'
}

export type ThreadCommentRaw = {
	author: { login: string }
	createdAt: string
	body: string
}

export type GhOps = {
	// Environment
	detectVersion(): Promise<VersionInfo>
	isAuthenticated(): Promise<boolean>

	// Issues
	createIssue(opts: { title: string; body: string; labels?: string[] }): Promise<CreatedIssue>
	viewIssue(issueNumber: number): Promise<IssueRecord>
	listIssues(opts: { label: string; state: 'open' | 'closed' | 'all' }): Promise<IssueSummary[]>
	closeIssue(issueNumber: number, opts?: { comment?: string }): Promise<void>
	reopenIssue(issueNumber: number): Promise<void>
	editIssueBody(issueNumber: number, body: string): Promise<void>
	editIssueLabels(issueNumber: number, opts: { add?: string[]; remove?: string[] }): Promise<void>

	// Sub-issues & blocker deps
	listSubIssues(issueNumber: number): Promise<RawSubIssue[]>
	addSubIssue(issueNumber: number, internalId: number): Promise<void>
	listBlockedBy(issueNumber: number): Promise<BlockerEntry[]>
	addBlockedBy(issueNumber: number, internalId: number): Promise<void>
	removeBlockedBy(issueNumber: number, internalId: number): Promise<void>

	// PRs
	createDraftPr(opts: { title: string; head: string; base: string; body: string }): Promise<CreatedPr>
	markPrReady(prNumber: number): Promise<void>
	findPrNumberByHead(head: string): Promise<number>
	listOpenPrs(opts?: { base?: string }): Promise<PrSummary[]>
	/**
	 * Look up the most recent PR for `head` regardless of state. Returns null when no PR exists.
	 * Used by state computation to detect that a Close-out PR has been merged on GitHub.
	 */
	findAnyPrByHead(head: string): Promise<{ number: number; state: 'OPEN' | 'CLOSED' | 'MERGED' } | null>
	closePr(prNumber: number, opts?: { comment?: string }): Promise<void>
	mergePr(prNumber: number, method: ShipMergeMethod): Promise<void>

	// PR feedback
	fetchPrLineComments(prNumber: number): Promise<LineCommentRaw[]>
	fetchPrReviews(prNumber: number): Promise<ReviewRaw[]>
	fetchPrThread(prNumber: number): Promise<ThreadCommentRaw[]>
}

export function createGh(runner: GhRunner = (args) => tryExec('gh', args)): GhOps {
	async function ghOrThrow(args: string[]): Promise<string> {
		const r = await runner(args)
		if (!r.ok) throw r.error
		return r.stdout
	}

	async function ghJson<T>(args: string[]): Promise<T> {
		const r = await runner(args)
		if (!r.ok) throw new Error(`gh ${args.join(' ')} failed: ${r.error.message}`)
		return JSON.parse(r.stdout) as T
	}

	async function ghPaginatedArray<T>(args: string[]): Promise<T[]> {
		return parsePaginatedArray<T>(await ghOrThrow(args))
	}

	return {
		async detectVersion() {
			const r = await runner(['--version'])
			if (!r.ok) return { installed: false }
			return { installed: true, version: parseSemver(`${r.stdout}\n${r.stderr}`) }
		},
		async isAuthenticated() {
			const r = await runner(['auth', 'status'])
			return r.ok
		},

		async createIssue({ title, body, labels = [] }) {
			const issue = await ghJson<ApiIssue>([
				'api',
				'-X',
				'POST',
				'repos/{owner}/{repo}/issues',
				'-f',
				`title=${title}`,
				'-f',
				`body=${body}`,
				...labelFields(labels),
			])
			return {
				number: issue.number,
				internalId: issue.id,
				title: issue.title,
				url: issue.html_url ?? `#${issue.number}`,
			}
		},
		async viewIssue(id) {
			const issue = await ghJson<ApiIssue>(['api', `repos/{owner}/{repo}/issues/${id}`])
			return {
				internalId: issue.id,
				number: issue.number,
				title: issue.title,
				state: issue.state,
				body: issue.body ?? '',
				createdAt: issue.created_at ?? '',
				closedAt: issue.closed_at ?? null,
			}
		},
		async listIssues({ label, state }) {
			const issues = await ghPaginatedArray<ApiIssue>([
				'api',
				'--paginate',
				'--slurp',
				'-X',
				'GET',
				'repos/{owner}/{repo}/issues',
				'-f',
				`labels=${label}`,
				'-f',
				`state=${state}`,
				'-F',
				'per_page=100',
			])
			return issues.map((issue) => ({
				number: issue.number,
				title: issue.title,
				createdAt: issue.created_at ?? '',
				body: issue.body ?? '',
				state: issue.state,
				closedAt: issue.closed_at ?? null,
			}))
		},
		async closeIssue(id, opts) {
			if (opts?.comment !== undefined)
				await ghOrThrow(['api', '-X', 'POST', `repos/{owner}/{repo}/issues/${id}/comments`, '-f', `body=${opts.comment}`])
			await ghOrThrow(['api', '-X', 'PATCH', `repos/{owner}/{repo}/issues/${id}`, '-f', 'state=closed'])
		},
		async reopenIssue(id) {
			await ghOrThrow(['api', '-X', 'PATCH', `repos/{owner}/{repo}/issues/${id}`, '-f', 'state=open'])
		},
		async editIssueBody(id, body) {
			await ghOrThrow(['api', '-X', 'PATCH', `repos/{owner}/{repo}/issues/${id}`, '-f', `body=${body}`])
		},
		async editIssueLabels(id, { add = [], remove = [] }) {
			if (add.length > 0) await ghOrThrow(['api', '-X', 'POST', `repos/{owner}/{repo}/issues/${id}/labels`, ...labelFields(add)])
			for (const label of remove)
				await ghOrThrow(['api', '-X', 'DELETE', `repos/{owner}/{repo}/issues/${id}/labels/${encodeURIComponent(label)}`])
		},

		async listSubIssues(changeId) {
			return ghPaginatedArray<RawSubIssue>(['api', '--paginate', '--slurp', `repos/{owner}/{repo}/issues/${changeId}/sub_issues`])
		},
		async addSubIssue(changeId, internalId) {
			await ghOrThrow(['api', '-X', 'POST', `repos/{owner}/{repo}/issues/${changeId}/sub_issues`, '-F', `sub_issue_id=${internalId}`])
		},
		async listBlockedBy(issueId) {
			return ghPaginatedArray<BlockerEntry>([
				'api',
				'--paginate',
				'--slurp',
				`repos/{owner}/{repo}/issues/${issueId}/dependencies/blocked_by`,
			])
		},
		async addBlockedBy(issueId, internalId) {
			await ghOrThrow([
				'api',
				'-X',
				'POST',
				`repos/{owner}/{repo}/issues/${issueId}/dependencies/blocked_by`,
				'-F',
				`issue_id=${internalId}`,
			])
		},
		async removeBlockedBy(issueId, internalId) {
			await ghOrThrow(['api', '-X', 'DELETE', `repos/{owner}/{repo}/issues/${issueId}/dependencies/blocked_by/${internalId}`])
		},

		async createDraftPr({ title, head, base, body }) {
			const pr = await ghJson<ApiPull>([
				'api',
				'-X',
				'POST',
				'repos/{owner}/{repo}/pulls',
				'-f',
				`title=${title}`,
				'-f',
				`head=${head}`,
				'-f',
				`base=${base}`,
				'-f',
				`body=${body}`,
				'-F',
				'draft=true',
			])
			return { number: pr.number, headRefName: pr.head?.ref ?? '', isDraft: pr.draft ?? false, url: pr.html_url ?? `#${pr.number}` }
		},
		async markPrReady(prNumber) {
			await ghOrThrow(['pr', 'ready', String(prNumber)])
		},
		async findPrNumberByHead(head) {
			const prs = await ghJson<Array<{ number: number }>>(['pr', 'list', '--head', head, '--json', 'number'])
			const pr = prs[0]
			if (!pr) throw new Error(`no PR found for head '${head}'`)
			return pr.number
		},
		async findAnyPrByHead(head) {
			const r = await runner(['pr', 'list', '--head', head, '--state', 'all', '--json', 'number,state'])
			return r.ok ? parseAnyPrByHeadList(r.stdout) : null
		},
		async closePr(prNumber, opts) {
			if (opts?.comment !== undefined)
				await ghOrThrow(['api', '-X', 'POST', `repos/{owner}/{repo}/issues/${prNumber}/comments`, '-f', `body=${opts.comment}`])
			await ghOrThrow(['api', '-X', 'PATCH', `repos/{owner}/{repo}/pulls/${prNumber}`, '-f', 'state=closed'])
		},
		async mergePr(prNumber, method) {
			await ghOrThrow(['api', '-X', 'PUT', `repos/{owner}/{repo}/pulls/${prNumber}/merge`, '-f', `merge_method=${method}`])
		},
		async listOpenPrs(opts) {
			const args = ['pr', 'list', '--state', 'open', '--json', 'number,headRefName,isDraft,url,labels,reviewDecision']
			if (opts?.base !== undefined) {
				args.splice(2, 0, '--base', opts.base)
			}
			const out = await ghOrThrow(args)
			return JSON.parse(out) as PrSummary[]
		},

		async fetchPrLineComments(prNumber) {
			return ghJson<LineCommentRaw[]>(['api', `repos/{owner}/{repo}/pulls/${prNumber}/comments`])
		},
		async fetchPrReviews(prNumber) {
			const reviews = await ghJson<ApiReview[]>(['api', `repos/{owner}/{repo}/pulls/${prNumber}/reviews`])
			return reviews.map((review) => ({
				author: { login: review.user.login },
				submittedAt: review.submitted_at,
				body: review.body,
				state: review.state,
			}))
		},
		async fetchPrThread(prNumber) {
			const comments = await ghJson<ApiIssueComment[]>(['api', `repos/{owner}/{repo}/issues/${prNumber}/comments`])
			return comments.map((comment) => ({ author: { login: comment.user.login }, createdAt: comment.created_at, body: comment.body }))
		},
	}
}

type AnyPrByHead = { number: number; state: 'OPEN' | 'CLOSED' | 'MERGED' }

function parseAnyPrByHeadList(stdout: string): AnyPrByHead | null {
	const prs = JSON.parse(stdout) as Array<{ number: number; state: string }>
	const pr = prs[0]
	return pr ? { number: pr.number, state: normalizePrState(pr.state) } : null
}

function normalizePrState(state: string): AnyPrByHead['state'] {
	const upper = state.toUpperCase()
	if (upper === 'MERGED') return 'MERGED'
	if (upper === 'CLOSED') return 'CLOSED'
	return 'OPEN'
}

function labelFields(labels: string[]): string[] {
	return labels.flatMap((label) => ['-f', `labels[]=${label}`])
}

function parsePaginatedArray<T>(stdout: string): T[] {
	const parsed = JSON.parse(stdout) as T[] | T[][]
	return Array.isArray(parsed[0]) ? (parsed as T[][]).flat() : (parsed as T[])
}

if (import.meta.vitest) {
	const { describe, test, expect } = import.meta.vitest

	type Stub = { match: (args: string[]) => boolean; respond: ShellResult | ((args: string[]) => ShellResult) }

	function makeRunner(stubs: Stub[]): { runner: GhRunner; calls: string[][] } {
		const calls: string[][] = []
		const runner: GhRunner = async (args) => {
			calls.push(args)
			const m = stubs.find((s) => s.match(args))
			if (!m) return { ok: false, error: new Error(`unmatched gh call: ${args.join(' ')}`) }
			return typeof m.respond === 'function' ? m.respond(args) : m.respond
		}
		return { runner, calls }
	}

	const ok = (stdout = ''): ShellResult => ({ ok: true, stdout, stderr: '' })

	describe('createGh: environment probes', () => {
		test('detectVersion parses the semver out of `gh --version` stdout', async () => {
			const { runner, calls } = makeRunner([{ match: (a) => a[0] === '--version', respond: ok('gh version 2.50.0 (2026-04-01)\n') }])
			const v = await createGh(runner).detectVersion()
			expect(v).toEqual({ installed: true, version: '2.50.0' })
			expect(calls[0]).toEqual(['--version'])
		})

		test('detectVersion reports installed:false when gh is not on PATH', async () => {
			const { runner } = makeRunner([{ match: (a) => a[0] === '--version', respond: { ok: false, error: new Error('ENOENT') } }])
			expect(await createGh(runner).detectVersion()).toEqual({ installed: false })
		})

		test('isAuthenticated returns true when `gh auth status` succeeds', async () => {
			const { runner, calls } = makeRunner([
				{ match: (a) => a[0] === 'auth' && a[1] === 'status', respond: ok('Logged in to github.com as user') },
			])
			expect(await createGh(runner).isAuthenticated()).toBe(true)
			expect(calls[0]).toEqual(['auth', 'status'])
		})

		test('isAuthenticated returns false when `gh auth status` fails', async () => {
			const { runner } = makeRunner([
				{ match: (a) => a[0] === 'auth' && a[1] === 'status', respond: { ok: false, error: new Error('not logged in') } },
			])
			expect(await createGh(runner).isAuthenticated()).toBe(false)
		})
	})

	describe('createGh: issue methods', () => {
		test('createIssue POSTs through gh api and returns structured issue ids', async () => {
			const { runner, calls } = makeRunner([
				{
					match: (a) => a[0] === 'api' && a.includes('repos/{owner}/{repo}/issues'),
					respond: ok(
						JSON.stringify({
							id: 7000,
							number: 7,
							title: 'T',
							html_url: 'https://github.com/o/r/issues/7',
							state: 'open',
							body: 'B',
						}),
					),
				},
			])
			const issue = await createGh(runner).createIssue({ title: 'T', body: 'B', labels: ['change', 'urgent'] })
			expect(issue).toEqual({ number: 7, internalId: 7000, title: 'T', url: 'https://github.com/o/r/issues/7' })
			expect(calls[0]).toEqual([
				'api',
				'-X',
				'POST',
				'repos/{owner}/{repo}/issues',
				'-f',
				'title=T',
				'-f',
				'body=B',
				'-f',
				'labels[]=change',
				'-f',
				'labels[]=urgent',
			])
		})

		test('createIssue with no labels omits label fields', async () => {
			const { runner, calls } = makeRunner([
				{
					match: () => true,
					respond: ok(
						JSON.stringify({
							id: 7000,
							number: 7,
							title: 'T',
							html_url: 'https://github.com/o/r/issues/7',
							state: 'open',
							body: 'B',
						}),
					),
				},
			])
			await createGh(runner).createIssue({ title: 'T', body: 'B' })
			expect(calls[0]).toEqual(['api', '-X', 'POST', 'repos/{owner}/{repo}/issues', '-f', 'title=T', '-f', 'body=B'])
		})

		test('viewIssue throws when gh api fails (issue not found)', async () => {
			const { runner } = makeRunner([{ match: () => true, respond: { ok: false, error: new Error('not found') } }])
			await expect(createGh(runner).viewIssue(42)).rejects.toThrow(/not found/)
		})

		test('viewIssue maps snake_case API fields to IssueRecord', async () => {
			const { runner, calls } = makeRunner([
				{
					match: () => true,
					respond: ok(JSON.stringify({ id: 4200, number: 42, title: 'X', state: 'open', body: null, created_at: '2026-01-01T00:00:00Z', closed_at: null })),
				},
			])
			expect(await createGh(runner).viewIssue(42)).toEqual({ number: 42, internalId: 4200, title: 'X', state: 'open', body: '', createdAt: '2026-01-01T00:00:00Z', closedAt: null })
			expect(calls[0]).toEqual(['api', 'repos/{owner}/{repo}/issues/42'])
		})

		test('closeIssue comments when provided, then patches state closed', async () => {
			const { runner, calls } = makeRunner([{ match: () => true, respond: ok('{}') }])
			await createGh(runner).closeIssue(7, { comment: 'closed via trowel' })
			expect(calls).toEqual([
				['api', '-X', 'POST', 'repos/{owner}/{repo}/issues/7/comments', '-f', 'body=closed via trowel'],
				['api', '-X', 'PATCH', 'repos/{owner}/{repo}/issues/7', '-f', 'state=closed'],
			])
		})

		test('closeIssue without comment only patches state closed', async () => {
			const { runner, calls } = makeRunner([{ match: () => true, respond: ok('{}') }])
			await createGh(runner).closeIssue(7)
			expect(calls).toEqual([['api', '-X', 'PATCH', 'repos/{owner}/{repo}/issues/7', '-f', 'state=closed']])
		})

		test('reopenIssue patches state open', async () => {
			const { runner, calls } = makeRunner([{ match: () => true, respond: ok('{}') }])
			await createGh(runner).reopenIssue(7)
			expect(calls[0]).toEqual(['api', '-X', 'PATCH', 'repos/{owner}/{repo}/issues/7', '-f', 'state=open'])
		})

		test('editIssueBody patches the issue body', async () => {
			const { runner, calls } = makeRunner([{ match: () => true, respond: ok('{}') }])
			await createGh(runner).editIssueBody(7, 'new body')
			expect(calls[0]).toEqual(['api', '-X', 'PATCH', 'repos/{owner}/{repo}/issues/7', '-f', 'body=new body'])
		})

		test('editIssueLabels adds labels in one API call and removes labels by encoded path segment', async () => {
			const { runner, calls } = makeRunner([{ match: () => true, respond: ok('{}') }])
			await createGh(runner).editIssueLabels(7, { add: ['a', 'b'], remove: ['needs review'] })
			expect(calls).toEqual([
				['api', '-X', 'POST', 'repos/{owner}/{repo}/issues/7/labels', '-f', 'labels[]=a', '-f', 'labels[]=b'],
				['api', '-X', 'DELETE', 'repos/{owner}/{repo}/issues/7/labels/needs%20review'],
			])
		})

		test('listIssues queries the issues API and maps paginated API fields', async () => {
			const { runner, calls } = makeRunner([
				{
					match: () => true,
					respond: ok(
						JSON.stringify([
							[{ id: 7000, number: 7, title: 't', state: 'open', created_at: '2026-05-01T00:00:00Z', body: null }],
						]),
					),
				},
			])
			const out = await createGh(runner).listIssues({ label: 'change', state: 'open' })
			expect(out).toEqual([{ number: 7, title: 't', createdAt: '2026-05-01T00:00:00Z', body: '', state: 'open', closedAt: null }])
			expect(calls[0]).toEqual([
				'api',
				'--paginate',
				'--slurp',
				'-X',
				'GET',
				'repos/{owner}/{repo}/issues',
				'-f',
				'labels=change',
				'-f',
				'state=open',
				'-F',
				'per_page=100',
			])
		})
	})

	describe('createGh: sub-issue + blocker methods', () => {
		test('listSubIssues paginates with --slurp and parses flattened pages', async () => {
			const { runner, calls } = makeRunner([
				{ match: () => true, respond: ok(JSON.stringify([[{ number: 1, title: 'a', body: '', state: 'open', labels: [] }]])) },
			])
			const issues = await createGh(runner).listSubIssues(42)
			expect(issues).toEqual([{ number: 1, title: 'a', body: '', state: 'open', labels: [] }])
			expect(calls[0]).toEqual(['api', '--paginate', '--slurp', 'repos/{owner}/{repo}/issues/42/sub_issues'])
		})

		test('addSubIssue POSTs with sub_issue_id form', async () => {
			const { runner, calls } = makeRunner([{ match: () => true, respond: ok() }])
			await createGh(runner).addSubIssue(42, 999)
			expect(calls[0]).toEqual(['api', '-X', 'POST', 'repos/{owner}/{repo}/issues/42/sub_issues', '-F', 'sub_issue_id=999'])
		})

		test('addBlockedBy POSTs with issue_id form', async () => {
			const { runner, calls } = makeRunner([{ match: () => true, respond: ok() }])
			await createGh(runner).addBlockedBy(57, 999)
			expect(calls[0]).toEqual(['api', '-X', 'POST', 'repos/{owner}/{repo}/issues/57/dependencies/blocked_by', '-F', 'issue_id=999'])
		})

		test('listBlockedBy paginates with --slurp and parses flattened pages', async () => {
			const { runner, calls } = makeRunner([{ match: () => true, respond: ok(JSON.stringify([[{ id: 999, number: 57 }]])) }])
			expect(await createGh(runner).listBlockedBy(58)).toEqual([{ id: 999, number: 57 }])
			expect(calls[0]).toEqual(['api', '--paginate', '--slurp', 'repos/{owner}/{repo}/issues/58/dependencies/blocked_by'])
		})

		test('removeBlockedBy DELETEs the internal id', async () => {
			const { runner, calls } = makeRunner([{ match: () => true, respond: ok() }])
			await createGh(runner).removeBlockedBy(57, 999)
			expect(calls[0]).toEqual(['api', '-X', 'DELETE', 'repos/{owner}/{repo}/issues/57/dependencies/blocked_by/999'])
		})
	})

	describe('createGh: PR methods', () => {
		test('createDraftPr POSTs through gh api and returns structured PR data', async () => {
			const { runner, calls } = makeRunner([
				{
					match: () => true,
					respond: ok(
						JSON.stringify({
							number: 12,
							draft: true,
							html_url: 'https://github.com/o/r/pull/12',
							head: { ref: 'h' },
							state: 'open',
						}),
					),
				},
			])
			const pr = await createGh(runner).createDraftPr({ title: 'T', head: 'h', base: 'b', body: 'body' })
			expect(pr).toEqual({ number: 12, headRefName: 'h', isDraft: true, url: 'https://github.com/o/r/pull/12' })
			expect(calls[0]).toEqual([
				'api',
				'-X',
				'POST',
				'repos/{owner}/{repo}/pulls',
				'-f',
				'title=T',
				'-f',
				'head=h',
				'-f',
				'base=b',
				'-f',
				'body=body',
				'-F',
				'draft=true',
			])
		})

		test('markPrReady stringifies the number', async () => {
			const { runner, calls } = makeRunner([{ match: () => true, respond: ok() }])
			await createGh(runner).markPrReady(168)
			expect(calls[0]).toEqual(['pr', 'ready', '168'])
		})

		test('findPrNumberByHead parses structured gh pr list JSON', async () => {
			const { runner, calls } = makeRunner([{ match: () => true, respond: ok(JSON.stringify([{ number: 168 }])) }])
			expect(await createGh(runner).findPrNumberByHead('feature/x')).toBe(168)
			expect(calls[0]).toEqual(['pr', 'list', '--head', 'feature/x', '--json', 'number'])
		})

		test('findPrNumberByHead throws when no PR matches', async () => {
			const { runner } = makeRunner([{ match: () => true, respond: ok('[]') }])
			await expect(createGh(runner).findPrNumberByHead('feature/x')).rejects.toThrow(/no PR found/)
		})

		test('listOpenPrs without base lists all open PRs', async () => {
			const { runner, calls } = makeRunner([
				{ match: () => true, respond: ok(JSON.stringify([{ number: 1, headRefName: 'a', isDraft: false }])) },
			])
			const out = await createGh(runner).listOpenPrs()
			expect(out).toEqual([{ number: 1, headRefName: 'a', isDraft: false }])
			expect(calls[0]).toEqual(['pr', 'list', '--state', 'open', '--json', 'number,headRefName,isDraft,url,labels,reviewDecision'])
		})

		test('listOpenPrs with base filters by --base', async () => {
			const { runner, calls } = makeRunner([{ match: () => true, respond: ok('[]') }])
			await createGh(runner).listOpenPrs({ base: 'feature' })
			expect(calls[0]).toEqual([
				'pr',
				'list',
				'--base',
				'feature',
				'--state',
				'open',
				'--json',
				'number,headRefName,isDraft,url,labels,reviewDecision',
			])
		})

		test('findAnyPrByHead parses the first structured PR across all states', async () => {
			const { runner, calls } = makeRunner([{ match: () => true, respond: ok(JSON.stringify([{ number: 12, state: 'MERGED' }])) }])
			expect(await createGh(runner).findAnyPrByHead('feature/x')).toEqual({ number: 12, state: 'MERGED' })
			expect(calls[0]).toEqual(['pr', 'list', '--head', 'feature/x', '--state', 'all', '--json', 'number,state'])
		})

		test('closePr comments when provided, then patches PR state closed', async () => {
			const { runner, calls } = makeRunner([{ match: () => true, respond: ok('{}') }])
			await createGh(runner).closePr(12, { comment: 'aborting' })
			expect(calls).toEqual([
				['api', '-X', 'POST', 'repos/{owner}/{repo}/issues/12/comments', '-f', 'body=aborting'],
				['api', '-X', 'PATCH', 'repos/{owner}/{repo}/pulls/12', '-f', 'state=closed'],
			])
		})

		test('mergePr uses the PR merge API with the configured method', async () => {
			const { runner, calls } = makeRunner([{ match: () => true, respond: ok('{}') }])
			await createGh(runner).mergePr(12, 'squash')
			expect(calls[0]).toEqual(['api', '-X', 'PUT', 'repos/{owner}/{repo}/pulls/12/merge', '-f', 'merge_method=squash'])
		})
	})

	describe('createGh: feedback methods', () => {
		test('fetchPrLineComments hits the pulls/{n}/comments endpoint', async () => {
			const { runner, calls } = makeRunner([{ match: () => true, respond: ok('[]') }])
			await createGh(runner).fetchPrLineComments(168)
			expect(calls[0]).toEqual(['api', 'repos/{owner}/{repo}/pulls/168/comments'])
		})

		test('fetchPrReviews maps pull review API fields', async () => {
			const { runner, calls } = makeRunner([
				{
					match: () => true,
					respond: ok(JSON.stringify([{ user: { login: 'r' }, submitted_at: 't', body: 'b', state: 'COMMENTED' }])),
				},
			])
			const out = await createGh(runner).fetchPrReviews(168)
			expect(out).toEqual([{ author: { login: 'r' }, submittedAt: 't', body: 'b', state: 'COMMENTED' }])
			expect(calls[0]).toEqual(['api', 'repos/{owner}/{repo}/pulls/168/reviews'])
		})

		test('fetchPrThread maps issue comment API fields', async () => {
			const { runner, calls } = makeRunner([
				{ match: () => true, respond: ok(JSON.stringify([{ user: { login: 'r' }, created_at: 't', body: 'b' }])) },
			])
			const out = await createGh(runner).fetchPrThread(168)
			expect(out).toEqual([{ author: { login: 'r' }, createdAt: 't', body: 'b' }])
			expect(calls[0]).toEqual(['api', 'repos/{owner}/{repo}/issues/168/comments'])
		})
	})
}
