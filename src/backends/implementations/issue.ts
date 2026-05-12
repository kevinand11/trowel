import { classify } from '../../utils/bucket.ts'
import type { GhResult, GhRunner } from '../../utils/gh-runner.ts'
import { slug as slugify } from '../../utils/slug.ts'
import type { Backend, BackendDeps, BackendFactory, PrdRecord, PrdSpec, PrdSummary, Slice, SlicePatch, SliceSpec } from '../types.ts'

const DEFAULT_BRANCH_PREFIX = ''

/**
 * Compose the slice branch name (`prd-<prdId>/slice-<sliceId>-<slug>`) and create it
 * on the host: `gh issue develop` to register a linked branch with the issue, then
 * `git fetch origin <branch>` so the host has the ref locally before any worktree op.
 *
 * Returns the branch name on success. Idempotence with existing linked branches is
 * the caller's concern for now (a future cycle when the issue loop demands it).
 *
 * See ADR `afk-loop-asymmetric-across-backends` for why this lives outside the
 * Backend interface (issue-only operation; the loop imports it directly).
 */
export async function createSliceBranch(
	deps: { gh: GhRunner; gitFetch: (branch: string) => Promise<void> },
	prdId: string,
	sliceId: string,
	slug: string,
	integrationBranch: string,
): Promise<string> {
	const branch = `prd-${prdId}/slice-${sliceId}-${slug}`
	const result = await deps.gh(['issue', 'develop', sliceId, '--name', branch, '--base', integrationBranch])
	if (!result.ok) throw new Error(`gh issue develop failed: ${result.error.message}`)
	await deps.gitFetch(branch)
	return branch
}

export const createIssueBackend: BackendFactory = (deps: BackendDeps): Backend => {
	const prefix = deps.branchPrefix ?? DEFAULT_BRANCH_PREFIX

	function parseIssueNumberFromUrl(url: string): string {
		const trimmed = url.trim()
		const last = trimmed.split('/').pop() ?? ''
		if (!/^\d+$/.test(last)) throw new Error(`could not parse issue number from URL: ${trimmed}`)
		return last
	}

	async function gh(args: string[]): Promise<GhResult> {
		return deps.gh(args)
	}

	async function ghOrThrow(args: string[]): Promise<string> {
		const r = await gh(args)
		if (!r.ok) throw r.error
		return r.stdout
	}

	async function createPrd(spec: PrdSpec): Promise<{ id: string; branch: string }> {
		const createOut = await ghOrThrow(['issue', 'create', '--title', spec.title, '--body', spec.body, '--label', deps.labels.prd])
		const id = parseIssueNumberFromUrl(createOut)
		const branch = `${prefix}${id}-${slugify(spec.title)}`
		await ghOrThrow(['issue', 'develop', id, '--branch', branch, '--base', deps.baseBranch, '--checkout'])
		return { id, branch }
	}

	async function branchForExisting(id: string): Promise<string> {
		const listOut = await ghOrThrow(['issue', 'develop', '--list', id])
		const firstLine = listOut
			.split('\n')
			.map((l) => l.trim())
			.find(Boolean)
		if (firstLine) {
			const branch = firstLine.split(/\s+/)[0]
			if (branch) return branch
		}
		// Repair: no linked branch yet. Fetch title, compose, create.
		const viewOut = await ghOrThrow(['issue', 'view', id, '--json', 'title'])
		const parsed = JSON.parse(viewOut) as { title: string }
		const branch = `${prefix}${id}-${slugify(parsed.title)}`
		await ghOrThrow(['issue', 'develop', id, '--branch', branch, '--base', deps.baseBranch])
		return branch
	}

	async function fetchBlockedBy(sliceNumber: number): Promise<string[]> {
		const out = await ghOrThrow(['api', '--paginate', `repos/{owner}/{repo}/issues/${sliceNumber}/dependencies/blocked_by`])
		const blockers = JSON.parse(out) as Array<{ number: number }>
		return blockers.map((b) => String(b.number))
	}

	function stripBodyTrailer(body: string, prdId: string): string {
		const re = new RegExp(`\\s*\\n+\\s*Part of #${prdId}\\s*$`)
		return body.replace(re, '')
	}

	async function findSlices(prdId: string): Promise<Slice[]> {
		const out = await ghOrThrow(['api', '--paginate', `repos/{owner}/{repo}/issues/${prdId}/sub_issues`])
		const rawIssues = JSON.parse(out) as Array<{
			number: number
			title: string
			body: string
			state: string
			labels: Array<{ name: string }>
			issue_dependencies_summary?: { total_blocked_by?: number }
		}>
		const rawSlices: Array<Omit<Slice, 'bucket'>> = await Promise.all(
			rawIssues.map(async (s): Promise<Omit<Slice, 'bucket'>> => {
				const totalBlockedBy = s.issue_dependencies_summary?.total_blocked_by ?? 0
				const blockedBy = totalBlockedBy > 0 ? await fetchBlockedBy(s.number) : []
				return {
					id: String(s.number),
					title: s.title,
					body: stripBodyTrailer(s.body, prdId),
					state: (s.state === 'open' ? 'OPEN' : 'CLOSED') as Slice['state'],
					readyForAgent: s.labels.some((l) => l.name === deps.labels.readyForAgent),
					needsRevision: s.labels.some((l) => l.name === deps.labels.needsRevision),
					blockedBy,
					// TODO: populate when AFK-loop wiring lands. Currently the bucket
					// classifier still derives `hasOpenPr` from openPrBranches below.
					prState: null,
					branchAhead: false,
				}
			}),
		)

		// Bulk-query open PRs once. Build a set of head branches that have open PRs.
		// Used to mark slices as `in-flight` when their derived branch is among them.
		let openPrBranches = new Set<string>()
		if (rawSlices.some((s) => s.state === 'OPEN')) {
			const prListOut = await ghOrThrow(['pr', 'list', '--state', 'open', '--json', 'headRefName'])
			const prs = JSON.parse(prListOut) as Array<{ headRefName: string }>
			openPrBranches = new Set(prs.map((p) => p.headRefName))
		}

		const doneIds = new Set(rawSlices.filter((r) => r.state === 'CLOSED').map((r) => r.id))
		return rawSlices.map((r) => {
			const expectedBranch = `${prefix}${r.id}-${slugify(r.title)}`
			const hasOpenPr = openPrBranches.has(expectedBranch)
			const unmetDepIds = r.blockedBy.filter((d) => !doneIds.has(d))
			const bucket = classify(r, { hasOpenPr, unmetDepIds })
			return { ...r, bucket }
		})
	}

	async function createSlice(prdId: string, spec: SliceSpec): Promise<Slice> {
		const body = `${spec.body}\n\nPart of #${prdId}`
		const createOut = await ghOrThrow(['issue', 'create', '--title', spec.title, '--body', body])
		const sliceNumber = parseIssueNumberFromUrl(createOut)
		const internalIdOut = await ghOrThrow(['api', `repos/{owner}/{repo}/issues/${sliceNumber}`, '--jq', '.id'])
		const internalId = internalIdOut.trim()
		await ghOrThrow(['api', '-X', 'POST', `repos/{owner}/{repo}/issues/${prdId}/sub_issues`, '-F', `sub_issue_id=${internalId}`])

		for (const blockerNumber of spec.blockedBy) {
			const blockerInternalIdOut = await ghOrThrow(['api', `repos/{owner}/{repo}/issues/${blockerNumber}`, '--jq', '.id'])
			const blockerInternalId = blockerInternalIdOut.trim()
			await ghOrThrow(['api', '-X', 'POST', `repos/{owner}/{repo}/issues/${sliceNumber}/dependencies/blocked_by`, '-F', `issue_id=${blockerInternalId}`])
		}

		return {
			id: sliceNumber,
			title: spec.title,
			body: spec.body,
			state: 'OPEN',
			readyForAgent: false,
			needsRevision: false,
			bucket: spec.blockedBy.length > 0 ? 'blocked' : 'draft',
			blockedBy: [...spec.blockedBy],
			prState: null,
			branchAhead: false,
		}
	}

	async function close(id: string): Promise<void> {
		// Idempotent: if the issue is already closed, no-op.
		const viewResult = await gh(['issue', 'view', id, '--json', 'state'])
		if (viewResult.ok) {
			const parsed = JSON.parse(viewResult.stdout) as { state: string }
			if (parsed.state.toUpperCase() === 'CLOSED') return
		}
		const closeArgs = ['issue', 'close', id]
		if (deps.closeOptions.comment !== null) closeArgs.push('--comment', deps.closeOptions.comment)
		await ghOrThrow(closeArgs)
	}

	async function findPrd(id: string): Promise<PrdRecord | null> {
		const viewResult = await gh(['issue', 'view', id, '--json', 'number,title,state'])
		if (!viewResult.ok) return null
		const parsed = JSON.parse(viewResult.stdout) as { number: number; title: string; state: string }
		const branch = await branchForExisting(id)
		return {
			id: String(parsed.number),
			branch,
			title: parsed.title,
			state: parsed.state.toUpperCase() === 'OPEN' ? 'OPEN' : 'CLOSED',
		}
	}

	async function listPrds(opts: { state: 'open' | 'closed' | 'all' }): Promise<PrdSummary[]> {
		const out = await ghOrThrow(['issue', 'list', '--label', deps.labels.prd, '--state', opts.state, '--json', 'number,title'])
		const issues = JSON.parse(out) as Array<{ number: number; title: string }>
		const summaries: PrdSummary[] = []
		for (const issue of issues) {
			const id = String(issue.number)
			const branch = await branchForExisting(id)
			summaries.push({ id, title: issue.title, branch })
		}
		return summaries
	}

	return {
		name: 'issue',
		defaultBranchPrefix: DEFAULT_BRANCH_PREFIX,
		createPrd,
		branchForExisting,
		findPrd,
		listPrds,
		close,
		createSlice,
		findSlices,
		updateSlice,
	}

	async function updateSlice(_prdId: string, sliceId: string, patch: SlicePatch): Promise<void> {
		if (patch.readyForAgent !== undefined) {
			const flag = patch.readyForAgent ? '--add-label' : '--remove-label'
			await ghOrThrow(['issue', 'edit', sliceId, flag, deps.labels.readyForAgent])
		}
		if (patch.needsRevision !== undefined) {
			const flag = patch.needsRevision ? '--add-label' : '--remove-label'
			await ghOrThrow(['issue', 'edit', sliceId, flag, deps.labels.needsRevision])
		}
		if (patch.blockedBy !== undefined) {
			const currentOut = await ghOrThrow(['api', '--paginate', `repos/{owner}/{repo}/issues/${sliceId}/dependencies/blocked_by`])
			const current = JSON.parse(currentOut) as Array<{ id: number; number: number }>
			const currentByNumber = new Map(current.map((b) => [String(b.number), b.id]))
			const target = new Set(patch.blockedBy)
			for (const [number, internalId] of currentByNumber) {
				if (!target.has(number)) {
					await ghOrThrow(['api', '-X', 'DELETE', `repos/{owner}/{repo}/issues/${sliceId}/dependencies/blocked_by/${internalId}`])
				}
			}
			for (const number of patch.blockedBy) {
				if (currentByNumber.has(number)) continue
				const blockerInternalIdOut = await ghOrThrow(['api', `repos/{owner}/{repo}/issues/${number}`, '--jq', '.id'])
				const blockerInternalId = blockerInternalIdOut.trim()
				await ghOrThrow(['api', '-X', 'POST', `repos/{owner}/{repo}/issues/${sliceId}/dependencies/blocked_by`, '-F', `issue_id=${blockerInternalId}`])
			}
		}
		if (patch.state === 'CLOSED') {
			await ghOrThrow(['issue', 'close', sliceId])
		} else if (patch.state === 'OPEN') {
			await ghOrThrow(['issue', 'reopen', sliceId])
		}
	}
}

if (import.meta.vitest) {
	const { describe, test, expect } = import.meta.vitest

	type MockSpec = { match: (args: string[]) => boolean; respond: GhResult | ((args: string[]) => GhResult) }

	function makeDeps(mocks: MockSpec[]): { deps: BackendDeps; calls: string[][] } {
		const calls: string[][] = []
		const gh: GhRunner = async (args: string[]) => {
			calls.push(args)
			const m = mocks.find((s) => s.match(args))
			if (!m) return { ok: false, error: new Error(`unmocked gh call: ${args.join(' ')}`) }
			return typeof m.respond === 'function' ? m.respond(args) : m.respond
		}
		const deps: BackendDeps = {
			gh,
			repoRoot: '/tmp/x',
			projectRoot: '/tmp/x',
			baseBranch: 'main',
			branchPrefix: null,
			prdsDir: '/tmp/x/docs/prds',
			docMsg: 'docs',
			labels: { prd: 'prd', readyForAgent: 'ready-for-agent', needsRevision: 'needs-revision' },
			closeOptions: { comment: null, deleteBranch: 'never' },
			confirm: async () => false,
		}
		return { deps, calls }
	}

	describe('issue backend: createPrd', () => {
		test('calls issue create + issue develop and returns {id, branch}', async () => {
			const { deps, calls } = makeDeps([
				{
					match: (a) => a[0] === 'issue' && a[1] === 'create',
					respond: { ok: true, stdout: 'https://github.com/o/r/issues/42\n', stderr: '' },
				},
				{
					match: (a) => a[0] === 'issue' && a[1] === 'develop',
					respond: { ok: true, stdout: '', stderr: '' },
				},
			])
			const backend = createIssueBackend(deps)
			const result = await backend.createPrd({ title: 'Fix Tabs on macOS', body: 'the spec' })
			expect(result).toEqual({ id: '42', branch: '42-fix-tabs-on-macos' })
			expect(calls[0]).toEqual(['issue', 'create', '--title', 'Fix Tabs on macOS', '--body', 'the spec', '--label', 'prd'])
			expect(calls[1]).toEqual(['issue', 'develop', '42', '--branch', '42-fix-tabs-on-macos', '--base', 'main', '--checkout'])
		})

		test('applies configured branchPrefix and labels.prd, and respects custom baseBranch', async () => {
			const { deps, calls } = makeDeps([
				{ match: (a) => a[1] === 'create', respond: { ok: true, stdout: 'https://github.com/o/r/issues/7\n', stderr: '' } },
				{ match: (a) => a[1] === 'develop', respond: { ok: true, stdout: '', stderr: '' } },
			])
			deps.branchPrefix = 'feat/'
			deps.labels.prd = 'roadmap'
			deps.baseBranch = 'develop'

			const backend = createIssueBackend(deps)
			const result = await backend.createPrd({ title: 'Add ORM', body: 'b' })
			expect(result).toEqual({ id: '7', branch: 'feat/7-add-orm' })
			expect(calls[0]).toContain('--label')
			expect(calls[0][calls[0].indexOf('--label') + 1]).toBe('roadmap')
			expect(calls[1]).toContain('--base')
			expect(calls[1][calls[1].indexOf('--base') + 1]).toBe('develop')
		})

		test('throws if gh issue create fails', async () => {
			const { deps } = makeDeps([{ match: (a) => a[1] === 'create', respond: { ok: false, error: new Error('rate limited') } }])
			const backend = createIssueBackend(deps)
			await expect(backend.createPrd({ title: 'Fix', body: 'b' })).rejects.toThrow(/rate limited/)
		})
	})

	describe('issue backend: branchForExisting', () => {
		test('returns the linked branch when one already exists', async () => {
			const { deps, calls } = makeDeps([
				{
					match: (a) => a[0] === 'issue' && a[1] === 'develop' && a.includes('--list'),
					respond: { ok: true, stdout: '42-fix-tabs\thttps://github.com/o/r/tree/42-fix-tabs\n', stderr: '' },
				},
			])
			const backend = createIssueBackend(deps)
			expect(await backend.branchForExisting('42')).toBe('42-fix-tabs')
			expect(calls).toEqual([['issue', 'develop', '--list', '42']])
		})

		test('repairs by creating a linked branch when none exists', async () => {
			const { deps, calls } = makeDeps([
				{
					match: (a) => a[0] === 'issue' && a[1] === 'develop' && a.includes('--list'),
					respond: { ok: true, stdout: '', stderr: '' },
				},
				{
					match: (a) => a[0] === 'issue' && a[1] === 'view',
					respond: { ok: true, stdout: JSON.stringify({ title: 'Fix Tabs on macOS' }), stderr: '' },
				},
				{
					match: (a) => a[0] === 'issue' && a[1] === 'develop' && !a.includes('--list'),
					respond: { ok: true, stdout: '', stderr: '' },
				},
			])
			const backend = createIssueBackend(deps)
			expect(await backend.branchForExisting('42')).toBe('42-fix-tabs-on-macos')
			expect(calls[1]).toEqual(['issue', 'view', '42', '--json', 'title'])
			expect(calls[2]).toEqual(['issue', 'develop', '42', '--branch', '42-fix-tabs-on-macos', '--base', 'main'])
		})
	})

	describe('issue backend: listPrds', () => {
		test('returns empty array when no issues match the prd label', async () => {
			const { deps, calls } = makeDeps([
				{ match: (a) => a[0] === 'issue' && a[1] === 'list', respond: { ok: true, stdout: '[]', stderr: '' } },
			])
			const backend = createIssueBackend(deps)
			expect(await backend.listPrds({ state: 'open' })).toEqual([])
			expect(calls[0]).toEqual(['issue', 'list', '--label', 'prd', '--state', 'open', '--json', 'number,title'])
		})

		test('passes --state closed through to gh when called with { state: "closed" }', async () => {
			const { deps, calls } = makeDeps([
				{ match: (a) => a[0] === 'issue' && a[1] === 'list', respond: { ok: true, stdout: '[]', stderr: '' } },
			])
			const backend = createIssueBackend(deps)
			await backend.listPrds({ state: 'closed' })
			expect(calls[0]).toEqual(['issue', 'list', '--label', 'prd', '--state', 'closed', '--json', 'number,title'])
		})

		test('passes --state all through to gh when called with { state: "all" }', async () => {
			const { deps, calls } = makeDeps([
				{ match: (a) => a[0] === 'issue' && a[1] === 'list', respond: { ok: true, stdout: '[]', stderr: '' } },
			])
			const backend = createIssueBackend(deps)
			await backend.listPrds({ state: 'all' })
			expect(calls[0]).toEqual(['issue', 'list', '--label', 'prd', '--state', 'all', '--json', 'number,title'])
		})

		test('returns one PrdSummary per matching issue, with branch from branchForExisting', async () => {
			const { deps } = makeDeps([
				{
					match: (a) => a[0] === 'issue' && a[1] === 'list',
					respond: {
						ok: true,
						stdout: JSON.stringify([
							{ number: 42, title: 'Fix Tabs' },
							{ number: 7, title: 'Add ORM' },
						]),
						stderr: '',
					},
				},
				{
					match: (a) => a[0] === 'issue' && a[1] === 'develop' && a.includes('--list') && a.includes('42'),
					respond: { ok: true, stdout: '42-fix-tabs\thttps://github.com/o/r/tree/42-fix-tabs\n', stderr: '' },
				},
				{
					match: (a) => a[0] === 'issue' && a[1] === 'develop' && a.includes('--list') && a.includes('7'),
					respond: { ok: true, stdout: '7-add-orm\thttps://github.com/o/r/tree/7-add-orm\n', stderr: '' },
				},
			])
			const backend = createIssueBackend(deps)
			const result = await backend.listPrds({ state: 'open' })
			expect(result).toEqual([
				{ id: '42', title: 'Fix Tabs', branch: '42-fix-tabs' },
				{ id: '7', title: 'Add ORM', branch: '7-add-orm' },
			])
		})
	})

	describe('issue backend: createSlice', () => {
		test('creates issue with body trailer, resolves internal id, links as sub-issue, returns Slice', async () => {
			const { deps, calls } = makeDeps([
				{
					match: (a) => a[0] === 'issue' && a[1] === 'create',
					respond: { ok: true, stdout: 'https://github.com/o/r/issues/57\n', stderr: '' },
				},
				{
					match: (a) => a[0] === 'api' && a.some((s) => s === '--jq') && a.includes('repos/{owner}/{repo}/issues/57'),
					respond: { ok: true, stdout: '12345678\n', stderr: '' },
				},
				{
					match: (a) => a[0] === 'api' && a.includes('repos/{owner}/{repo}/issues/42/sub_issues'),
					respond: { ok: true, stdout: '', stderr: '' },
				},
			])
			const backend = createIssueBackend(deps)
			const slice = await backend.createSlice('42', { title: 'Implement Tab Parser', body: 'the slice spec', blockedBy: [] })

			expect(slice).toEqual({
				id: '57',
				title: 'Implement Tab Parser',
				body: 'the slice spec',
				state: 'OPEN',
				readyForAgent: false,
				needsRevision: false,
				bucket: 'draft',
				blockedBy: [],
				prState: null,
				branchAhead: false,
			})
			// create issue with composed body
			expect(calls[0]).toEqual(['issue', 'create', '--title', 'Implement Tab Parser', '--body', 'the slice spec\n\nPart of #42'])
			// resolve internal id
			expect(calls[1]).toEqual(['api', 'repos/{owner}/{repo}/issues/57', '--jq', '.id'])
			// link as sub-issue
			expect(calls[2]).toEqual(['api', '-X', 'POST', 'repos/{owner}/{repo}/issues/42/sub_issues', '-F', 'sub_issue_id=12345678'])
		})
	})

	describe('issue backend: createSlice with blockedBy', () => {
		test('POSTs dependencies/blocked_by for each blocker, resolving each blocker number → internal id', async () => {
			const { deps, calls } = makeDeps([
				{
					match: (a) => a[0] === 'issue' && a[1] === 'create',
					respond: { ok: true, stdout: 'https://github.com/o/r/issues/57\n', stderr: '' },
				},
				{
					// Blocker 99's internal id resolution.
					match: (a) => a.includes('repos/{owner}/{repo}/issues/99') && a.includes('--jq'),
					respond: { ok: true, stdout: '999000\n', stderr: '' },
				},
				{
					// New slice 57's internal id resolution.
					match: (a) => a.includes('repos/{owner}/{repo}/issues/57') && a.includes('--jq'),
					respond: { ok: true, stdout: '570000\n', stderr: '' },
				},
				{
					match: (a) => a.includes('repos/{owner}/{repo}/issues/42/sub_issues'),
					respond: { ok: true, stdout: '', stderr: '' },
				},
				{
					match: (a) => a.includes('repos/{owner}/{repo}/issues/57/dependencies/blocked_by'),
					respond: { ok: true, stdout: '{}', stderr: '' },
				},
			])
			const backend = createIssueBackend(deps)
			const slice = await backend.createSlice('42', { title: 'Implement Tab Parser', body: 'spec', blockedBy: ['99'] })
			expect(slice.blockedBy).toEqual(['99'])

			// Verify the dependencies/blocked_by POST was made with the resolved internal id.
			const depCall = calls.find((c) => c[0] === 'api' && c.includes('repos/{owner}/{repo}/issues/57/dependencies/blocked_by') && c.includes('-X') && c[c.indexOf('-X') + 1] === 'POST')
			expect(depCall).toBeDefined()
			expect(depCall).toContain('issue_id=999000')
		})

		test('blockedBy: [] → no extra dependencies POST calls', async () => {
			const { deps, calls } = makeDeps([
				{
					match: (a) => a[0] === 'issue' && a[1] === 'create',
					respond: { ok: true, stdout: 'https://github.com/o/r/issues/57\n', stderr: '' },
				},
				{
					match: (a) => a.includes('repos/{owner}/{repo}/issues/57') && a.includes('--jq'),
					respond: { ok: true, stdout: '570000\n', stderr: '' },
				},
				{
					match: (a) => a.includes('repos/{owner}/{repo}/issues/42/sub_issues'),
					respond: { ok: true, stdout: '', stderr: '' },
				},
			])
			const backend = createIssueBackend(deps)
			await backend.createSlice('42', { title: 'A', body: 'b', blockedBy: [] })
			expect(calls.find((c) => c.includes('repos/{owner}/{repo}/issues/57/dependencies/blocked_by'))).toBeUndefined()
		})
	})

	describe('issue backend: findSlices', () => {
		test('queries sub-issues endpoint with pagination and maps to Slice[]', async () => {
			const { deps, calls } = makeDeps([
				{
					match: (a) => a[0] === 'api' && a.includes('--paginate'),
					respond: {
						ok: true,
						stdout: JSON.stringify([
							{
								id: 1,
								number: 57,
								title: 'Implement Parser',
								body: 'parser spec\n\nPart of #42',
								state: 'open',
								labels: [{ name: 'ready-for-agent' }],
							},
							{
								id: 2,
								number: 58,
								title: 'Wire CLI',
								body: 'cli spec',
								state: 'closed',
								labels: [{ name: 'needs-revision' }, { name: 'other' }],
							},
						]),
						stderr: '',
					},
				},
				{ match: (a) => a[0] === 'pr' && a[1] === 'list', respond: { ok: true, stdout: '[]', stderr: '' } },
			])
			const backend = createIssueBackend(deps)
			const slices = await backend.findSlices('42')
			expect(calls[0]).toEqual(['api', '--paginate', 'repos/{owner}/{repo}/issues/42/sub_issues'])
			expect(slices).toEqual([
				{ id: '57', title: 'Implement Parser', body: 'parser spec', state: 'OPEN', readyForAgent: true, needsRevision: false, bucket: 'ready', blockedBy: [], prState: null, branchAhead: false },
				{ id: '58', title: 'Wire CLI', body: 'cli spec', state: 'CLOSED', readyForAgent: false, needsRevision: true, bucket: 'done', blockedBy: [], prState: null, branchAhead: false },
			])
		})

		test('uses configured label names to compute booleans', async () => {
			const { deps } = makeDeps([
				{
					match: (a) => a[0] === 'api' && a.includes('--paginate'),
					respond: {
						ok: true,
						stdout: JSON.stringify([
							{
								id: 1,
								number: 9,
								title: 't',
								body: 'b',
								state: 'open',
								labels: [{ name: 'CUSTOM-ready' }, { name: 'CUSTOM-needs' }],
							},
						]),
						stderr: '',
					},
				},
				{ match: (a) => a[0] === 'pr' && a[1] === 'list', respond: { ok: true, stdout: '[]', stderr: '' } },
			])
			deps.labels.readyForAgent = 'CUSTOM-ready'
			deps.labels.needsRevision = 'CUSTOM-needs'
			const backend = createIssueBackend(deps)
			const [slice] = await backend.findSlices('42')
			expect(slice!.readyForAgent).toBe(true)
			expect(slice!.needsRevision).toBe(true)
		})
	})

	describe('issue backend: findSlices computes bucket', () => {
		test('open slice with matching open-PR head branch → in-flight', async () => {
			const { deps } = makeDeps([
				{
					match: (a) => a[0] === 'api' && a.includes('--paginate'),
					respond: {
						ok: true,
						stdout: JSON.stringify([
							{ id: 1, number: 57, title: 'Implement Parser', body: 'b', state: 'open', labels: [{ name: 'ready-for-agent' }] },
						]),
						stderr: '',
					},
				},
				{
					match: (a) => a[0] === 'pr' && a[1] === 'list',
					respond: { ok: true, stdout: JSON.stringify([{ headRefName: '57-implement-parser' }]), stderr: '' },
				},
			])
			const backend = createIssueBackend(deps)
			const [s] = await backend.findSlices('42')
			expect(s!.bucket).toBe('in-flight')
		})

		test('open slice with no matching open PR + readyForAgent → ready', async () => {
			const { deps } = makeDeps([
				{
					match: (a) => a[0] === 'api' && a.includes('--paginate'),
					respond: {
						ok: true,
						stdout: JSON.stringify([
							{ id: 1, number: 57, title: 'Implement Parser', body: 'b', state: 'open', labels: [{ name: 'ready-for-agent' }] },
						]),
						stderr: '',
					},
				},
				{ match: (a) => a[0] === 'pr' && a[1] === 'list', respond: { ok: true, stdout: '[]', stderr: '' } },
			])
			const backend = createIssueBackend(deps)
			const [s] = await backend.findSlices('42')
			expect(s!.bucket).toBe('ready')
		})

		test('open slice with needsRevision → needs-revision (takes priority over in-flight)', async () => {
			const { deps } = makeDeps([
				{
					match: (a) => a[0] === 'api' && a.includes('--paginate'),
					respond: {
						ok: true,
						stdout: JSON.stringify([
							{ id: 1, number: 57, title: 'P', body: 'b', state: 'open', labels: [{ name: 'needs-revision' }] },
						]),
						stderr: '',
					},
				},
				{
					match: (a) => a[0] === 'pr' && a[1] === 'list',
					respond: { ok: true, stdout: JSON.stringify([{ headRefName: '57-p' }]), stderr: '' },
				},
			])
			const backend = createIssueBackend(deps)
			const [s] = await backend.findSlices('42')
			expect(s!.bucket).toBe('needs-revision')
		})

		test('open slice with total_blocked_by > 0 → fetches dependencies + populates blockedBy + blocked bucket', async () => {
			const { deps, calls } = makeDeps([
				{
					match: (a) => a.includes('repos/{owner}/{repo}/issues/42/sub_issues'),
					respond: {
						ok: true,
						stdout: JSON.stringify([
							{
								id: 1,
								number: 57,
								title: 'A',
								body: 'spec',
								state: 'open',
								labels: [],
								issue_dependencies_summary: { blocked_by: 0, blocking: 1, total_blocked_by: 0, total_blocking: 1 },
							},
							{
								id: 2,
								number: 58,
								title: 'B',
								body: 'spec',
								state: 'open',
								labels: [{ name: 'ready-for-agent' }],
								issue_dependencies_summary: { blocked_by: 1, blocking: 0, total_blocked_by: 1, total_blocking: 0 },
							},
						]),
						stderr: '',
					},
				},
				{ match: (a) => a[0] === 'pr' && a[1] === 'list', respond: { ok: true, stdout: '[]', stderr: '' } },
				{
					match: (a) => a.includes('repos/{owner}/{repo}/issues/58/dependencies/blocked_by'),
					respond: { ok: true, stdout: JSON.stringify([{ id: 1, number: 57, title: 'A' }]), stderr: '' },
				},
			])
			const backend = createIssueBackend(deps)
			const slices = await backend.findSlices('42')
			const b = slices.find((x) => x.id === '58')!
			expect(b.blockedBy).toEqual(['57'])
			expect(b.bucket).toBe('blocked')
			// Slice A had total_blocked_by=0 — no extra call should have been made for it.
			expect(calls.find((c) => c.includes('repos/{owner}/{repo}/issues/57/dependencies/blocked_by'))).toBeUndefined()
		})

		test('skips pr list query when no open slices', async () => {
			const { deps, calls } = makeDeps([
				{
					match: (a) => a[0] === 'api' && a.includes('--paginate'),
					respond: {
						ok: true,
						stdout: JSON.stringify([{ id: 1, number: 57, title: 'A', body: 'spec', state: 'closed', labels: [] }]),
						stderr: '',
					},
				},
			])
			const backend = createIssueBackend(deps)
			const [s] = await backend.findSlices('42')
			expect(s!.bucket).toBe('done')
			expect(calls.some((c) => c[0] === 'pr' && c[1] === 'list')).toBe(false)
		})
	})

	describe('issue backend: findPrd', () => {
		test('returns PrdRecord with branch and state for an existing issue', async () => {
			const { deps } = makeDeps([
				{
					match: (a) => a[0] === 'issue' && a[1] === 'view',
					respond: { ok: true, stdout: JSON.stringify({ number: 42, title: 'Fix Tabs', state: 'OPEN' }), stderr: '' },
				},
				{
					match: (a) => a[0] === 'issue' && a[1] === 'develop' && a.includes('--list'),
					respond: { ok: true, stdout: '42-fix-tabs\thttps://x\n', stderr: '' },
				},
			])
			const backend = createIssueBackend(deps)
			expect(await backend.findPrd('42')).toEqual({ id: '42', branch: '42-fix-tabs', title: 'Fix Tabs', state: 'OPEN' })
		})

		test('maps "CLOSED" GitHub state to CLOSED', async () => {
			const { deps } = makeDeps([
				{
					match: (a) => a[0] === 'issue' && a[1] === 'view',
					respond: { ok: true, stdout: JSON.stringify({ number: 42, title: 'X', state: 'CLOSED' }), stderr: '' },
				},
				{
					match: (a) => a[0] === 'issue' && a[1] === 'develop' && a.includes('--list'),
					respond: { ok: true, stdout: '42-x\n', stderr: '' },
				},
			])
			const backend = createIssueBackend(deps)
			expect((await backend.findPrd('42'))!.state).toBe('CLOSED')
		})

		test('returns null when gh issue view fails (issue not found)', async () => {
			const { deps } = makeDeps([
				{ match: (a) => a[0] === 'issue' && a[1] === 'view', respond: { ok: false, error: new Error('not found') } },
			])
			const backend = createIssueBackend(deps)
			expect(await backend.findPrd('999999')).toBeNull()
		})
	})

	describe('issue backend: updateSlice', () => {
		test('readyForAgent:true adds the configured label', async () => {
			const { deps, calls } = makeDeps([
				{ match: (a) => a[0] === 'issue' && a[1] === 'edit', respond: { ok: true, stdout: '', stderr: '' } },
			])
			const backend = createIssueBackend(deps)
			await backend.updateSlice('42', '57', { readyForAgent: true })
			expect(calls).toEqual([['issue', 'edit', '57', '--add-label', 'ready-for-agent']])
		})

		test('readyForAgent:false removes the configured label', async () => {
			const { deps, calls } = makeDeps([
				{ match: (a) => a[0] === 'issue' && a[1] === 'edit', respond: { ok: true, stdout: '', stderr: '' } },
			])
			const backend = createIssueBackend(deps)
			await backend.updateSlice('42', '57', { readyForAgent: false })
			expect(calls).toEqual([['issue', 'edit', '57', '--remove-label', 'ready-for-agent']])
		})

		test('needsRevision:true adds the configured label; uses custom label name', async () => {
			const { deps, calls } = makeDeps([
				{ match: (a) => a[0] === 'issue' && a[1] === 'edit', respond: { ok: true, stdout: '', stderr: '' } },
			])
			deps.labels.needsRevision = 'fixme'
			const backend = createIssueBackend(deps)
			await backend.updateSlice('42', '57', { needsRevision: true })
			expect(calls).toEqual([['issue', 'edit', '57', '--add-label', 'fixme']])
		})

		test('state CLOSED runs gh issue close; state OPEN runs gh issue reopen', async () => {
			const { deps, calls } = makeDeps([
				{
					match: (a) => a[0] === 'issue' && (a[1] === 'close' || a[1] === 'reopen'),
					respond: { ok: true, stdout: '', stderr: '' },
				},
			])
			const backend = createIssueBackend(deps)
			await backend.updateSlice('42', '57', { state: 'CLOSED' })
			await backend.updateSlice('42', '57', { state: 'OPEN' })
			expect(calls).toEqual([
				['issue', 'close', '57'],
				['issue', 'reopen', '57'],
			])
		})

		test('combined patch fires multiple gh calls in expected order', async () => {
			const { deps, calls } = makeDeps([{ match: () => true, respond: { ok: true, stdout: '', stderr: '' } }])
			const backend = createIssueBackend(deps)
			await backend.updateSlice('42', '57', { readyForAgent: false, needsRevision: true, state: 'CLOSED' })
			expect(calls).toHaveLength(3)
			expect(calls).toContainEqual(['issue', 'edit', '57', '--remove-label', 'ready-for-agent'])
			expect(calls).toContainEqual(['issue', 'edit', '57', '--add-label', 'needs-revision'])
			expect(calls).toContainEqual(['issue', 'close', '57'])
		})
	})

	describe('issue backend: updateSlice with blockedBy', () => {
		test('diffs old vs new: DELETEs removed blockers, POSTs added blockers', async () => {
			const { deps, calls } = makeDeps([
				{
					// GET current blockers — returns issue objects with id + number
					match: (a) => a.includes('repos/{owner}/{repo}/issues/100/dependencies/blocked_by') && !a.includes('-X'),
					respond: { ok: true, stdout: JSON.stringify([{ id: 700, number: 7 }]), stderr: '' },
				},
				{
					match: (a) => a.includes('repos/{owner}/{repo}/issues/8') && a.includes('--jq'),
					respond: { ok: true, stdout: '800\n', stderr: '' },
				},
				{
					match: (a) => a.includes('repos/{owner}/{repo}/issues/9') && a.includes('--jq'),
					respond: { ok: true, stdout: '900\n', stderr: '' },
				},
				{
					match: (a) => a.includes('-X') && a[a.indexOf('-X') + 1] === 'POST' && a.includes('repos/{owner}/{repo}/issues/100/dependencies/blocked_by'),
					respond: { ok: true, stdout: '{}', stderr: '' },
				},
				{
					match: (a) => a.includes('-X') && a[a.indexOf('-X') + 1] === 'DELETE' && a.includes('repos/{owner}/{repo}/issues/100/dependencies/blocked_by/700'),
					respond: { ok: true, stdout: '{}', stderr: '' },
				},
			])
			const backend = createIssueBackend(deps)
			await backend.updateSlice('42', '100', { blockedBy: ['8', '9'] })

			// 7 was in old, removed → DELETE 700
			const deleteCall = calls.find((c) => c.includes('-X') && c[c.indexOf('-X') + 1] === 'DELETE')
			expect(deleteCall).toBeDefined()
			expect(deleteCall!.some((s) => s.endsWith('/700'))).toBe(true)

			// 8 and 9 are new → 2 POSTs with their internal ids
			const postCalls = calls.filter((c) => c.includes('-X') && c[c.indexOf('-X') + 1] === 'POST' && c.includes('repos/{owner}/{repo}/issues/100/dependencies/blocked_by'))
			expect(postCalls).toHaveLength(2)
			expect(postCalls.some((c) => c.includes('issue_id=800'))).toBe(true)
			expect(postCalls.some((c) => c.includes('issue_id=900'))).toBe(true)
		})

		test('blockedBy unchanged → no POST/DELETE calls', async () => {
			const { deps, calls } = makeDeps([
				{
					match: (a) => a.includes('repos/{owner}/{repo}/issues/100/dependencies/blocked_by') && !a.includes('-X'),
					respond: { ok: true, stdout: JSON.stringify([{ id: 700, number: 7 }]), stderr: '' },
				},
			])
			const backend = createIssueBackend(deps)
			await backend.updateSlice('42', '100', { blockedBy: ['7'] })
			expect(calls.find((c) => c.includes('-X'))).toBeUndefined()
		})
	})

	describe('issue backend: close', () => {
		test('runs gh issue close (no PR check, no branch ops — those are orchestrator-owned)', async () => {
			const { deps, calls } = makeDeps([
				{
					match: (a) => a[0] === 'issue' && a[1] === 'view',
					respond: { ok: true, stdout: JSON.stringify({ state: 'OPEN' }), stderr: '' },
				},
				{
					match: (a) => a[0] === 'issue' && a[1] === 'close',
					respond: { ok: true, stdout: '', stderr: '' },
				},
			])
			const backend = createIssueBackend(deps)
			await backend.close('42')
			expect(calls.find((c) => c[0] === 'issue' && c[1] === 'close')).toEqual(['issue', 'close', '42'])
			expect(calls.find((c) => c[0] === 'pr' && c[1] === 'list')).toBeUndefined()
		})

		test('idempotent: gh issue close not invoked if issue already CLOSED', async () => {
			const { deps, calls } = makeDeps([
				{
					match: (a) => a[0] === 'issue' && a[1] === 'view',
					respond: { ok: true, stdout: JSON.stringify({ state: 'CLOSED' }), stderr: '' },
				},
			])
			const backend = createIssueBackend(deps)
			await backend.close('42')
			expect(calls.find((c) => c[0] === 'issue' && c[1] === 'close')).toBeUndefined()
		})

		test('passes --comment to gh issue close when config.close.comment is set', async () => {
			const { deps, calls } = makeDeps([
				{
					match: (a) => a[0] === 'issue' && a[1] === 'view',
					respond: { ok: true, stdout: JSON.stringify({ state: 'OPEN' }), stderr: '' },
				},
				{ match: (a) => a[0] === 'issue' && a[1] === 'close', respond: { ok: true, stdout: '', stderr: '' } },
			])
			deps.closeOptions.comment = 'Closed via trowel'
			const backend = createIssueBackend(deps)
			await backend.close('42')
			expect(calls.find((c) => c[0] === 'issue' && c[1] === 'close')).toEqual([
				'issue',
				'close',
				'42',
				'--comment',
				'Closed via trowel',
			])
		})
	})

	describe('createSliceBranch', () => {
		test('runs `gh issue develop` with prd-<prdId>/slice-<sliceId>-<slug>, fetches it, and returns the branch name', async () => {
			const ghCalls: string[][] = []
			const fetchCalls: string[] = []
			const branch = await createSliceBranch(
				{
					gh: async (args) => {
						ghCalls.push(args)
						return { ok: true, stdout: '', stderr: '' }
					},
					gitFetch: async (b) => {
						fetchCalls.push(b)
					},
				},
				'142',
				'145',
				'session-middleware',
				'prds-issue-142',
			)
			expect(branch).toBe('prd-142/slice-145-session-middleware')
			expect(ghCalls).toEqual([
				['issue', 'develop', '145', '--name', 'prd-142/slice-145-session-middleware', '--base', 'prds-issue-142'],
			])
			expect(fetchCalls).toEqual(['prd-142/slice-145-session-middleware'])
		})
	})
}
