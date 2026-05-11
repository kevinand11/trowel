import type { GhResult, GhRunner } from '../../utils/gh-runner.ts'
import { slug as slugify } from '../../utils/slug.ts'
import { applyBranchDeletePolicy } from '../branch-policy.ts'
import type { Backend, BackendDeps, BackendFactory, PrdSpec, PrdSummary, Slice, SlicePatch } from '../types.ts'

const DEFAULT_BRANCH_PREFIX = ''

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

	function stripBodyTrailer(body: string, prdId: string): string {
		const re = new RegExp(`\\s*\\n+\\s*Part of #${prdId}\\s*$`)
		return body.replace(re, '')
	}

	async function findSlices(prdId: string): Promise<Slice[]> {
		const out = await ghOrThrow(['api', '--paginate', `repos/{owner}/{repo}/issues/${prdId}/sub_issues`])
		const raw = JSON.parse(out) as Array<{
			number: number
			title: string
			body: string
			state: string
			labels: Array<{ name: string }>
		}>
		return raw.map((s) => ({
			id: String(s.number),
			title: s.title,
			body: stripBodyTrailer(s.body, prdId),
			state: (s.state === 'open' ? 'OPEN' : 'CLOSED') as Slice['state'],
			readyForAgent: s.labels.some((l) => l.name === deps.labels.readyForAgent),
			needsRevision: s.labels.some((l) => l.name === deps.labels.needsRevision),
		}))
	}

	async function createSlice(prdId: string, spec: PrdSpec): Promise<Slice> {
		const body = `${spec.body}\n\nPart of #${prdId}`
		const createOut = await ghOrThrow(['issue', 'create', '--title', spec.title, '--body', body])
		const sliceNumber = parseIssueNumberFromUrl(createOut)
		const internalIdOut = await ghOrThrow(['api', `repos/{owner}/{repo}/issues/${sliceNumber}`, '--jq', '.id'])
		const internalId = internalIdOut.trim()
		await ghOrThrow(['api', '-X', 'POST', `repos/{owner}/{repo}/issues/${prdId}/sub_issues`, '-F', `sub_issue_id=${internalId}`])
		return {
			id: sliceNumber,
			title: spec.title,
			body: spec.body,
			state: 'OPEN',
			readyForAgent: false,
			needsRevision: false,
		}
	}

	async function close(id: string): Promise<void> {
		const branch = await branchForExisting(id)

		// Refuse to close if an open PR has this branch as head.
		const prListOut = await ghOrThrow(['pr', 'list', '--head', branch, '--state', 'open', '--json', 'number,url'])
		const prs = JSON.parse(prListOut) as Array<{ number: number; url: string }>
		if (prs.length > 0) {
			throw new Error(`refusing to close: open PR(s) for branch '${branch}': ${prs.map((p) => p.url).join(', ')}`)
		}

		await applyBranchDeletePolicy(branch, {
			repoRoot: deps.repoRoot,
			baseBranch: deps.baseBranch,
			deleteBranch: deps.closeOptions.deleteBranch,
			confirm: deps.confirm,
		})

		const closeArgs = ['issue', 'close', id]
		if (deps.closeOptions.comment !== null) closeArgs.push('--comment', deps.closeOptions.comment)
		await ghOrThrow(closeArgs)
	}

	async function listOpen(): Promise<PrdSummary[]> {
		const out = await ghOrThrow(['issue', 'list', '--label', deps.labels.prd, '--state', 'open', '--json', 'number,title'])
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
		listOpen,
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

	describe('issue backend: listOpen', () => {
		test('returns empty array when no issues match the prd label', async () => {
			const { deps, calls } = makeDeps([
				{ match: (a) => a[0] === 'issue' && a[1] === 'list', respond: { ok: true, stdout: '[]', stderr: '' } },
			])
			const backend = createIssueBackend(deps)
			expect(await backend.listOpen()).toEqual([])
			expect(calls[0]).toEqual(['issue', 'list', '--label', 'prd', '--state', 'open', '--json', 'number,title'])
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
			const result = await backend.listOpen()
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
			const slice = await backend.createSlice('42', { title: 'Implement Tab Parser', body: 'the slice spec' })

			expect(slice).toEqual({
				id: '57',
				title: 'Implement Tab Parser',
				body: 'the slice spec',
				state: 'OPEN',
				readyForAgent: false,
				needsRevision: false,
			})
			// create issue with composed body
			expect(calls[0]).toEqual(['issue', 'create', '--title', 'Implement Tab Parser', '--body', 'the slice spec\n\nPart of #42'])
			// resolve internal id
			expect(calls[1]).toEqual(['api', 'repos/{owner}/{repo}/issues/57', '--jq', '.id'])
			// link as sub-issue
			expect(calls[2]).toEqual(['api', '-X', 'POST', 'repos/{owner}/{repo}/issues/42/sub_issues', '-F', 'sub_issue_id=12345678'])
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
			])
			const backend = createIssueBackend(deps)
			const slices = await backend.findSlices('42')
			expect(calls[0]).toEqual(['api', '--paginate', 'repos/{owner}/{repo}/issues/42/sub_issues'])
			expect(slices).toEqual([
				{ id: '57', title: 'Implement Parser', body: 'parser spec', state: 'OPEN', readyForAgent: true, needsRevision: false },
				{ id: '58', title: 'Wire CLI', body: 'cli spec', state: 'CLOSED', readyForAgent: false, needsRevision: true },
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
			])
			deps.labels.readyForAgent = 'CUSTOM-ready'
			deps.labels.needsRevision = 'CUSTOM-needs'
			const backend = createIssueBackend(deps)
			const [slice] = await backend.findSlices('42')
			expect(slice!.readyForAgent).toBe(true)
			expect(slice!.needsRevision).toBe(true)
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

	describe('issue backend: close', () => {
		test('refuses to close when an open PR has the branch as head', async () => {
			const { deps, calls } = makeDeps([
				{
					match: (a) => a[0] === 'issue' && a[1] === 'develop' && a.includes('--list'),
					respond: { ok: true, stdout: '42-fix-tabs\thttps://x\n', stderr: '' },
				},
				{
					match: (a) => a[0] === 'pr' && a[1] === 'list',
					respond: { ok: true, stdout: JSON.stringify([{ number: 99, url: 'https://github.com/o/r/pull/99' }]), stderr: '' },
				},
			])
			const backend = createIssueBackend(deps)
			await expect(backend.close('42')).rejects.toThrow(/open PR/i)
			// Verify gh issue close was NOT invoked
			expect(calls.find((c) => c[0] === 'issue' && c[1] === 'close')).toBeUndefined()
		})

		test('with deleteBranch=never, just runs gh issue close (no branch ops, no comment by default)', async () => {
			const { deps, calls } = makeDeps([
				{
					match: (a) => a[0] === 'issue' && a[1] === 'develop' && a.includes('--list'),
					respond: { ok: true, stdout: '42-fix-tabs\thttps://x\n', stderr: '' },
				},
				{
					match: (a) => a[0] === 'pr' && a[1] === 'list',
					respond: { ok: true, stdout: '[]', stderr: '' },
				},
				{
					match: (a) => a[0] === 'issue' && a[1] === 'close',
					respond: { ok: true, stdout: '', stderr: '' },
				},
			])
			const backend = createIssueBackend(deps)
			await backend.close('42')
			expect(calls.find((c) => c[0] === 'issue' && c[1] === 'close')).toEqual(['issue', 'close', '42'])
			expect(calls.find((c) => c[0] === 'pr' && c[1] === 'list')).toEqual([
				'pr',
				'list',
				'--head',
				'42-fix-tabs',
				'--state',
				'open',
				'--json',
				'number,url',
			])
		})

		test('passes --comment to gh issue close when config.close.comment is set', async () => {
			const { deps, calls } = makeDeps([
				{ match: (a) => a[1] === 'develop' && a.includes('--list'), respond: { ok: true, stdout: '42-x\n', stderr: '' } },
				{ match: (a) => a[0] === 'pr' && a[1] === 'list', respond: { ok: true, stdout: '[]', stderr: '' } },
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
}
