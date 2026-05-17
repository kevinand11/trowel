import { parseSemver, tryExec, type ShellResult } from './shell.ts'

/**
 * Single canonical surface for every `gh` operation trowel performs. Parallel
 * to `GitOps` (`src/utils/git-ops.ts`): callers consume named typed methods,
 * tests stub a partial `GhOps` rather than mocking arg arrays.
 */

type GhRunner = (args: string[]) => Promise<ShellResult>

type VersionInfo = { installed: boolean; version?: string }

export type IssueState = 'OPEN' | 'CLOSED'

export type IssueSummary = {
	number: number
	title: string
	createdAt: string
}

export type IssueRecord = {
	number: number
	title: string
	state: string
}

/**
 * Raw shape returned by the `repos/{owner}/{repo}/issues/{n}/sub_issues` endpoint.
 * Exposed as the GhOps boundary type so callers can map to their own domain shape.
 */
export type RawSubIssue = {
	number: number
	title: string
	body: string
	state: string
	labels: Array<{ name: string }>
	issue_dependencies_summary?: { total_blocked_by?: number }
}

export type BlockerEntry = { id: number; number: number }

export type PrSummary = {
	number: number
	headRefName: string
	url?: string
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
	createIssue(opts: { title: string; body: string; labels?: string[] }): Promise<string>
	viewIssue(id: string): Promise<IssueRecord | null>
	getIssueState(id: string): Promise<string | null>
	listIssues(opts: { label: string; state: 'open' | 'closed' | 'all' }): Promise<IssueSummary[]>
	closeIssue(id: string, opts?: { comment?: string }): Promise<void>
	reopenIssue(id: string): Promise<void>
	editIssueLabels(id: string, opts: { add?: string[]; remove?: string[] }): Promise<void>

	// Sub-issues & blocker deps
	listSubIssues(prdId: string): Promise<RawSubIssue[]>
	getIssueInternalId(issueNumber: string): Promise<string>
	addSubIssue(prdId: string, internalId: string): Promise<void>
	listBlockedBy(issueId: string): Promise<BlockerEntry[]>
	addBlockedBy(issueId: string, internalId: string): Promise<void>
	removeBlockedBy(issueId: string, internalId: string): Promise<void>

	// PRs
	createDraftPr(opts: { title: string; head: string; base: string; body: string }): Promise<void>
	markPrReady(prNumber: number): Promise<void>
	findPrNumberByHead(head: string): Promise<number>
	listOpenPrs(opts?: { base?: string }): Promise<PrSummary[]>

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
			const args = ['issue', 'create', '--title', title, '--body', body]
			for (const label of labels) args.push('--label', label)
			const out = await ghOrThrow(args)
			return out
		},
		async viewIssue(id) {
			const r = await runner(['issue', 'view', id, '--json', 'number,title,state'])
			if (!r.ok) return null
			return JSON.parse(r.stdout) as IssueRecord
		},
		async getIssueState(id) {
			const r = await runner(['issue', 'view', id, '--json', 'state'])
			if (!r.ok) return null
			const parsed = JSON.parse(r.stdout) as { state: string }
			return parsed.state
		},
		async listIssues({ label, state }) {
			const out = await ghOrThrow(['issue', 'list', '--label', label, '--state', state, '--json', 'number,title,createdAt'])
			return JSON.parse(out) as IssueSummary[]
		},
		async closeIssue(id, opts) {
			const args = ['issue', 'close', id]
			if (opts?.comment !== undefined) args.push('--comment', opts.comment)
			await ghOrThrow(args)
		},
		async reopenIssue(id) {
			await ghOrThrow(['issue', 'reopen', id])
		},
		async editIssueLabels(id, { add = [], remove = [] }) {
			for (const label of add) await ghOrThrow(['issue', 'edit', id, '--add-label', label])
			for (const label of remove) await ghOrThrow(['issue', 'edit', id, '--remove-label', label])
		},

		async listSubIssues(prdId) {
			const out = await ghOrThrow(['api', '--paginate', `repos/{owner}/{repo}/issues/${prdId}/sub_issues`])
			return JSON.parse(out) as RawSubIssue[]
		},
		async getIssueInternalId(issueNumber) {
			const out = await ghOrThrow(['api', `repos/{owner}/{repo}/issues/${issueNumber}`, '--jq', '.id'])
			return out.trim()
		},
		async addSubIssue(prdId, internalId) {
			await ghOrThrow(['api', '-X', 'POST', `repos/{owner}/{repo}/issues/${prdId}/sub_issues`, '-F', `sub_issue_id=${internalId}`])
		},
		async listBlockedBy(issueId) {
			const out = await ghOrThrow(['api', '--paginate', `repos/{owner}/{repo}/issues/${issueId}/dependencies/blocked_by`])
			return JSON.parse(out) as BlockerEntry[]
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
			await ghOrThrow(['pr', 'create', '--draft', '--title', title, '--head', head, '--base', base, '--body', body])
		},
		async markPrReady(prNumber) {
			await ghOrThrow(['pr', 'ready', String(prNumber)])
		},
		async findPrNumberByHead(head) {
			const out = await ghOrThrow(['pr', 'list', '--head', head, '--json', 'number', '--jq', '.[0].number'])
			const trimmed = out.trim()
			if (!trimmed) throw new Error(`no PR found for head '${head}'`)
			return Number.parseInt(trimmed, 10)
		},
		async listOpenPrs(opts) {
			const args = ['pr', 'list', '--state', 'open', '--json', 'number,headRefName,url']
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
			const wrapped = await ghJson<{ reviews: ReviewRaw[] }>(['pr', 'view', String(prNumber), '--json', 'reviews'])
			return wrapped.reviews
		},
		async fetchPrThread(prNumber) {
			const wrapped = await ghJson<{ comments: ThreadCommentRaw[] }>(['pr', 'view', String(prNumber), '--json', 'comments'])
			return wrapped.comments
		},
	}
}

/**
 * Helper: turn the URL returned by `gh issue create` into the issue number string.
 * Lives here rather than in issue storage because the URL shape is a `gh` contract.
 */
export function parseGhIssueNumber(url: string): string {
	const trimmed = url.trim()
	const last = trimmed.split('/').pop() ?? ''
	if (!/^\d+$/.test(last)) throw new Error(`could not parse issue number from URL: ${trimmed}`)
	return last
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

	describe('parseGhIssueNumber', () => {
		test('extracts the trailing number from a typical gh-create URL', () => {
			expect(parseGhIssueNumber('https://github.com/o/r/issues/42\n')).toBe('42')
		})
		test('throws if the URL does not end in a number', () => {
			expect(() => parseGhIssueNumber('https://github.com/o/r/issues/x')).toThrow(/could not parse/)
		})
	})

	describe('createGh: issue methods', () => {
		test('createIssue interpolates title/body and one --label per entry, returns the URL stdout', async () => {
			const { runner, calls } = makeRunner([
				{ match: (a) => a[0] === 'issue' && a[1] === 'create', respond: ok('https://github.com/o/r/issues/7\n') },
			])
			const gh = createGh(runner)
			const url = await gh.createIssue({ title: 'T', body: 'B', labels: ['prd', 'urgent'] })
			expect(url).toBe('https://github.com/o/r/issues/7\n')
			expect(calls[0]).toEqual(['issue', 'create', '--title', 'T', '--body', 'B', '--label', 'prd', '--label', 'urgent'])
		})

		test('createIssue with no labels emits no --label flags', async () => {
			const { runner, calls } = makeRunner([
				{ match: (a) => a[0] === 'issue' && a[1] === 'create', respond: ok('https://github.com/o/r/issues/7\n') },
			])
			await createGh(runner).createIssue({ title: 'T', body: 'B' })
			expect(calls[0]).toEqual(['issue', 'create', '--title', 'T', '--body', 'B'])
		})

		test('viewIssue returns null when gh fails (issue not found)', async () => {
			const { runner } = makeRunner([{ match: () => true, respond: { ok: false, error: new Error('not found') } }])
			expect(await createGh(runner).viewIssue('42')).toBeNull()
		})

		test('viewIssue parses {number,title,state}', async () => {
			const { runner } = makeRunner([{ match: () => true, respond: ok(JSON.stringify({ number: 42, title: 'X', state: 'OPEN' })) }])
			expect(await createGh(runner).viewIssue('42')).toEqual({ number: 42, title: 'X', state: 'OPEN' })
		})

		test('closeIssue passes --comment when provided', async () => {
			const { runner, calls } = makeRunner([{ match: () => true, respond: ok() }])
			await createGh(runner).closeIssue('7', { comment: 'closed via trowel' })
			expect(calls[0]).toEqual(['issue', 'close', '7', '--comment', 'closed via trowel'])
		})

		test('closeIssue without --comment when comment is undefined', async () => {
			const { runner, calls } = makeRunner([{ match: () => true, respond: ok() }])
			await createGh(runner).closeIssue('7')
			expect(calls[0]).toEqual(['issue', 'close', '7'])
		})

		test('editIssueLabels emits one --add-label per add and one --remove-label per remove', async () => {
			const { runner, calls } = makeRunner([{ match: () => true, respond: ok() }])
			await createGh(runner).editIssueLabels('7', { add: ['a', 'b'], remove: ['c'] })
			expect(calls).toEqual([
				['issue', 'edit', '7', '--add-label', 'a'],
				['issue', 'edit', '7', '--add-label', 'b'],
				['issue', 'edit', '7', '--remove-label', 'c'],
			])
		})

		test('listIssues threads --label/--state through to gh and parses JSON', async () => {
			const { runner, calls } = makeRunner([
				{ match: () => true, respond: ok(JSON.stringify([{ number: 7, title: 't', createdAt: '2026-05-01T00:00:00Z' }])) },
			])
			const out = await createGh(runner).listIssues({ label: 'prd', state: 'open' })
			expect(out).toEqual([{ number: 7, title: 't', createdAt: '2026-05-01T00:00:00Z' }])
			expect(calls[0]).toEqual(['issue', 'list', '--label', 'prd', '--state', 'open', '--json', 'number,title,createdAt'])
		})
	})

	describe('createGh: sub-issue + blocker methods', () => {
		test('listSubIssues paginates and parses', async () => {
			const { runner, calls } = makeRunner([
				{ match: () => true, respond: ok(JSON.stringify([{ number: 1, title: 'a', body: '', state: 'open', labels: [] }])) },
			])
			await createGh(runner).listSubIssues('42')
			expect(calls[0]).toEqual(['api', '--paginate', 'repos/{owner}/{repo}/issues/42/sub_issues'])
		})

		test('getIssueInternalId trims whitespace from --jq output', async () => {
			const { runner, calls } = makeRunner([{ match: () => true, respond: ok('12345\n') }])
			const id = await createGh(runner).getIssueInternalId('57')
			expect(id).toBe('12345')
			expect(calls[0]).toEqual(['api', 'repos/{owner}/{repo}/issues/57', '--jq', '.id'])
		})

		test('addSubIssue POSTs with sub_issue_id form', async () => {
			const { runner, calls } = makeRunner([{ match: () => true, respond: ok() }])
			await createGh(runner).addSubIssue('42', '999')
			expect(calls[0]).toEqual(['api', '-X', 'POST', 'repos/{owner}/{repo}/issues/42/sub_issues', '-F', 'sub_issue_id=999'])
		})

		test('addBlockedBy POSTs with issue_id form', async () => {
			const { runner, calls } = makeRunner([{ match: () => true, respond: ok() }])
			await createGh(runner).addBlockedBy('57', '999')
			expect(calls[0]).toEqual(['api', '-X', 'POST', 'repos/{owner}/{repo}/issues/57/dependencies/blocked_by', '-F', 'issue_id=999'])
		})

		test('removeBlockedBy DELETEs the internal id', async () => {
			const { runner, calls } = makeRunner([{ match: () => true, respond: ok() }])
			await createGh(runner).removeBlockedBy('57', '999')
			expect(calls[0]).toEqual(['api', '-X', 'DELETE', 'repos/{owner}/{repo}/issues/57/dependencies/blocked_by/999'])
		})
	})

	describe('createGh: PR methods', () => {
		test('createDraftPr passes --draft and the four args', async () => {
			const { runner, calls } = makeRunner([{ match: () => true, respond: ok() }])
			await createGh(runner).createDraftPr({ title: 'T', head: 'h', base: 'b', body: 'body' })
			expect(calls[0]).toEqual(['pr', 'create', '--draft', '--title', 'T', '--head', 'h', '--base', 'b', '--body', 'body'])
		})

		test('markPrReady stringifies the number', async () => {
			const { runner, calls } = makeRunner([{ match: () => true, respond: ok() }])
			await createGh(runner).markPrReady(168)
			expect(calls[0]).toEqual(['pr', 'ready', '168'])
		})

		test('findPrNumberByHead returns parsed number', async () => {
			const { runner } = makeRunner([{ match: () => true, respond: ok('168\n') }])
			expect(await createGh(runner).findPrNumberByHead('feature/x')).toBe(168)
		})

		test('findPrNumberByHead throws when no PR matches', async () => {
			const { runner } = makeRunner([{ match: () => true, respond: ok('') }])
			await expect(createGh(runner).findPrNumberByHead('feature/x')).rejects.toThrow(/no PR found/)
		})

		test('listOpenPrs without base lists all open PRs', async () => {
			const { runner, calls } = makeRunner([{ match: () => true, respond: ok(JSON.stringify([{ number: 1, headRefName: 'a' }])) }])
			const out = await createGh(runner).listOpenPrs()
			expect(out).toEqual([{ number: 1, headRefName: 'a' }])
			expect(calls[0]).toEqual(['pr', 'list', '--state', 'open', '--json', 'number,headRefName,url'])
		})

		test('listOpenPrs with base filters by --base', async () => {
			const { runner, calls } = makeRunner([{ match: () => true, respond: ok('[]') }])
			await createGh(runner).listOpenPrs({ base: 'feature' })
			expect(calls[0]).toEqual(['pr', 'list', '--base', 'feature', '--state', 'open', '--json', 'number,headRefName,url'])
		})
	})

	describe('createGh: feedback methods', () => {
		test('fetchPrLineComments hits the pulls/{n}/comments endpoint', async () => {
			const { runner, calls } = makeRunner([{ match: () => true, respond: ok('[]') }])
			await createGh(runner).fetchPrLineComments(168)
			expect(calls[0]).toEqual(['api', 'repos/{owner}/{repo}/pulls/168/comments'])
		})

		test('fetchPrReviews unwraps the {reviews:[]} payload', async () => {
			const { runner } = makeRunner([
				{
					match: () => true,
					respond: ok(JSON.stringify({ reviews: [{ author: { login: 'r' }, submittedAt: 't', body: 'b', state: 'COMMENTED' }] })),
				},
			])
			const out = await createGh(runner).fetchPrReviews(168)
			expect(out).toEqual([{ author: { login: 'r' }, submittedAt: 't', body: 'b', state: 'COMMENTED' }])
		})

		test('fetchPrThread unwraps the {comments:[]} payload', async () => {
			const { runner } = makeRunner([
				{ match: () => true, respond: ok(JSON.stringify({ comments: [{ author: { login: 'r' }, createdAt: 't', body: 'b' }] })) },
			])
			const out = await createGh(runner).fetchPrThread(168)
			expect(out).toEqual([{ author: { login: 'r' }, createdAt: 't', body: 'b' }])
		})
	})
}
