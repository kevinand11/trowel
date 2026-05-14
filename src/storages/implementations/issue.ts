import { classifySlices } from '../../utils/bucket.ts'
import type { GhResult, GhRunner } from '../../utils/gh-runner.ts'
import { slug as slugify } from '../../utils/slug.ts'
import { landAddress, landImplement, landReview, prepareAddress, prepareImplement, prepareReview, type PhaseDeps } from '../../work/phases.ts'
import type { ClassifiedSlice, Storage, StorageDeps, StorageFactory, PrdRecord, PrdSpec, PrdSummary, Slice, SlicePatch, SliceSpec } from '../types.ts'

/**
 * Compose the slice branch name (`prd-<prdId>/slice-<sliceId>-<slug>`) and create
 * it as a new remote branch off the integration branch's tip, then fetch it locally
 * so the host has the ref before any worktree op.
 *
 * Implemented via `git push origin <integration-base>:<new>` rather than `gh issue
 * develop` — gh 2.71.x has a bug where `gh issue develop --name X --base Y` writes
 * `branch..gh-merge-base = Y` (empty branch name) to .git/config and then trips
 * over its own write inside the same command. The trade-off: the new slice branch
 * is not "linked" to the GitHub issue in the UI, but trowel never reads that
 * linkage — `Closes #<sliceId>` on the PR closes the issue at merge time, and
 * `findSlices` discovers slices via the sub-issues API.
 *
 * See ADR `afk-loop-asymmetric-across-storages` for why this lives outside the
 * Storage interface (issue-only operation; the loop imports it directly).
 */
async function createSliceBranch(
	deps: {
		gitFetch: (branch: string) => Promise<void>
		gitCreateRemoteBranch: (newBranch: string, baseBranch: string) => Promise<void>
	},
	prdId: string,
	sliceId: string,
	slug: string,
	integrationBranch: string,
): Promise<string> {
	const branch = `prd-${prdId}/slice-${sliceId}-${slug}`
	await deps.gitCreateRemoteBranch(branch, integrationBranch)
	await deps.gitFetch(branch)
	return branch
}

export const createIssueStorage: StorageFactory = (deps: StorageDeps): Storage => {
	const requireGit = () => {
		if (!deps.git) throw new Error('issue storage createPrd requires git ops to be wired')
		return deps.git
	}

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
		const git = requireGit()
		const createOut = await ghOrThrow(['issue', 'create', '--title', spec.title, '--body', spec.body, '--label', deps.labels.prd])
		const id = parseIssueNumberFromUrl(createOut)
		const branch = `${id}-${slugify(spec.title)}`
		await git.createLocalBranch(branch, deps.baseBranch)
		await git.pushSetUpstream(branch)
		return { id, branch }
	}

	async function branchForExisting(id: string): Promise<string> {
		// Computed from the current issue title rather than recovered from a GitHub-side
		// branch↔issue linkage. The branch is the source of truth; if the issue is renamed
		// after creation, the original branch persists and this lookup will drift.
		const viewOut = await ghOrThrow(['issue', 'view', id, '--json', 'title'])
		const parsed = JSON.parse(viewOut) as { title: string }
		return `${id}-${slugify(parsed.title)}`
	}

	async function fetchBlockedBy(sliceNumber: number): Promise<string[]> {
		const out = await ghOrThrow(['api', '--paginate', `repos/{owner}/{repo}/issues/${sliceNumber}/dependencies/blocked_by`])
		const blockers = JSON.parse(out) as Array<{ number: number }>
		return blockers.map((b) => String(b.number))
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
		// Storage emits raw slices: `prState: null` and `branchAhead: false` for everyone. The loop
		// calls `enrichSlicePrStates` (and, eventually, branch-ahead detection) before classification.
		// See ADR `storage-behavior-separation` step 4.
		return Promise.all(
			rawIssues.map(async (s): Promise<Slice> => {
				const totalBlockedBy = s.issue_dependencies_summary?.total_blocked_by ?? 0
				const blockedBy = totalBlockedBy > 0 ? await fetchBlockedBy(s.number) : []
				return {
					id: String(s.number),
					title: s.title,
					body: s.body,
					state: (s.state === 'open' ? 'OPEN' : 'CLOSED') as Slice['state'],
					readyForAgent: s.labels.some((l) => l.name === deps.labels.readyForAgent),
					needsRevision: s.labels.some((l) => l.name === deps.labels.needsRevision),
					blockedBy,
					prState: null,
					branchAhead: false,
				}
			}),
		)
	}

	async function createSlice(prdId: string, spec: SliceSpec): Promise<Slice> {
		// Parent linkage lives in the GitHub sub-issues API (`POST .../sub_issues` below); no body
		// trailer needed. See ADR `storage-behavior-separation` step 4.
		const createOut = await ghOrThrow(['issue', 'create', '--title', spec.title, '--body', spec.body])
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
			blockedBy: [...spec.blockedBy],
			prState: null,
			branchAhead: false,
		}
	}

	async function closePrd(id: string): Promise<void> {
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
		return {
			id: String(parsed.number),
			branch: `${parsed.number}-${slugify(parsed.title)}`,
			title: parsed.title,
			state: parsed.state.toUpperCase() === 'OPEN' ? 'OPEN' : 'CLOSED',
		}
	}

	async function listPrds(opts: { state: 'open' | 'closed' | 'all' }): Promise<PrdSummary[]> {
		const out = await ghOrThrow(['issue', 'list', '--label', deps.labels.prd, '--state', opts.state, '--json', 'number,title,createdAt'])
		const issues = JSON.parse(out) as Array<{ number: number; title: string; createdAt: string }>
		return issues.map((issue) => ({
			id: String(issue.number),
			title: issue.title,
			branch: `${issue.number}-${slugify(issue.title)}`,
			createdAt: issue.createdAt,
		}))
	}

	return {
		name: 'issue',
		createPrd,
		branchForExisting,
		findPrd,
		listPrds,
		closePrd,
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

	function makeDeps(mocks: MockSpec[]): { deps: StorageDeps; calls: string[][]; gitCalls: Array<[string, ...string[]]>; logCalls: string[] } {
		const calls: string[][] = []
		const gh: GhRunner = async (args: string[]) => {
			calls.push(args)
			const m = mocks.find((s) => s.match(args))
			if (!m) return { ok: false, error: new Error(`unmocked gh call: ${args.join(' ')}`) }
			return typeof m.respond === 'function' ? m.respond(args) : m.respond
		}
		const gitCalls: Array<[string, ...string[]]> = []
		const logCalls: string[] = []
		const deps: StorageDeps = {
			gh,
			repoRoot: '/tmp/x',
			projectRoot: '/tmp/x',
			baseBranch: 'main',
			prdsDir: '/tmp/x/docs/prds',
			labels: { prd: 'prd', readyForAgent: 'ready-for-agent', needsRevision: 'needs-revision' },
			closeOptions: { comment: null, deleteBranch: 'never' },
			confirm: async () => false,
			git: {
				fetch: async (b) => { gitCalls.push(['fetch', b]) },
				push: async (b) => { gitCalls.push(['push', b]) },
				checkout: async (b) => { gitCalls.push(['checkout', b]) },
				mergeNoFf: async (b) => { gitCalls.push(['mergeNoFf', b]) },
				deleteRemoteBranch: async (b) => { gitCalls.push(['deleteRemoteBranch', b]) },
				createRemoteBranch: async (n, b) => { gitCalls.push(['createRemoteBranch', n, b]) },
				createLocalBranch: async (n, b) => { gitCalls.push(['createLocalBranch', n, b]) },
				pushSetUpstream: async (b) => { gitCalls.push(['pushSetUpstream', b]) },
				currentBranch: async () => '',
				branchExists: async () => false,
				isMerged: async () => false,
				deleteBranch: async () => {},
				worktreeAdd: async () => {},
				worktreeRemove: async () => {},
				worktreeList: async () => [],
				restoreAll: async () => {},
				cleanUntracked: async () => {},
			},
			log: (m) => { logCalls.push(m) },
		}
		return { deps, calls, gitCalls, logCalls }
	}

	describe('issue storage: phase primitives', () => {
		function makeOpenSlice(overrides: Partial<ClassifiedSlice> = {}): ClassifiedSlice {
			return {
				id: '145',
				title: 'Session Middleware',
				body: 'wire JWT',
				state: 'OPEN',
				readyForAgent: true,
				needsRevision: false,
				bucket: 'ready',
				blockedBy: [],
				prState: null,
				branchAhead: false,
				...overrides,
			}
		}

		function phaseDeps(deps: StorageDeps, storage: Storage): PhaseDeps {
			return { storage, git: deps.git!, gh: deps.gh, log: deps.log! }
		}

		test('prepareImplement: creates slice branch via git, returns {branch, turnIn}', async () => {
			const { deps, gitCalls } = makeDeps([])
			const storage = createIssueStorage(deps)
			const prep = await prepareImplement(phaseDeps(deps, storage), makeOpenSlice(), {
				prdId: '142',
				integrationBranch: 'prds-issue-142',
				config: { usePrs: true, review: false, perSliceBranches: true },
			})
			expect(prep.branch).toBe('prd-142/slice-145-session-middleware')
			expect(prep.turnIn.slice).toEqual({ id: '145', title: 'Session Middleware', body: 'wire JWT' })
			expect(gitCalls).toContainEqual(['createRemoteBranch', 'prd-142/slice-145-session-middleware', 'prds-issue-142'])
			expect(gitCalls).toContainEqual(['fetch', 'prd-142/slice-145-session-middleware'])
		})

		test('landImplement + usePrs=true + ready: pushes slice branch and opens a draft PR; returns progress', async () => {
			const { deps, calls, gitCalls } = makeDeps([
				{ match: (a) => a[0] === 'pr' && a[1] === 'create', respond: { ok: true, stdout: '', stderr: '' } },
			])
			const storage = createIssueStorage(deps)
			const outcome = await landImplement(
				phaseDeps(deps, storage),
				makeOpenSlice(),
				{ verdict: 'ready', commits: 1 },
				{ prdId: '142', integrationBranch: 'prds-issue-142', config: { usePrs: true, review: false, perSliceBranches: true } },
			)
			expect(outcome).toBe('progress')
			expect(gitCalls).toContainEqual(['push', 'prd-142/slice-145-session-middleware'])
			expect(calls).toContainEqual([
				'pr', 'create', '--draft',
				'--title', 'Session Middleware',
				'--head', 'prd-142/slice-145-session-middleware',
				'--base', 'prds-issue-142',
				'--body', 'Closes #145',
			])
		})

		test('landImplement + usePrs=false + ready: pushes slice, checks out integration, merges --no-ff, pushes integration, deletes slice branch, closes sub-issue; returns done', async () => {
			const { deps, calls, gitCalls } = makeDeps([
				{ match: (a) => a[0] === 'issue' && a[1] === 'close', respond: { ok: true, stdout: '', stderr: '' } },
			])
			const storage = createIssueStorage(deps)
			const outcome = await landImplement(
				phaseDeps(deps, storage),
				makeOpenSlice(),
				{ verdict: 'ready', commits: 1 },
				{ prdId: '142', integrationBranch: 'prds-issue-142', config: { usePrs: false, review: false, perSliceBranches: true } },
			)
			expect(outcome).toBe('done')
			expect(gitCalls).toEqual([
				['push', 'prd-142/slice-145-session-middleware'],
				['checkout', 'prds-issue-142'],
				['mergeNoFf', 'prd-142/slice-145-session-middleware'],
				['push', 'prds-issue-142'],
				['deleteRemoteBranch', 'prd-142/slice-145-session-middleware'],
			])
			expect(calls.find((c) => c[0] === 'pr' && c[1] === 'create')).toBeUndefined()
			expect(calls).toContainEqual(['issue', 'close', '145'])
		})

		test('landImplement + perSliceBranches:false + ready: pushes integration directly, closes sub-issue via updateSlice; returns done', async () => {
			const { deps, calls, gitCalls } = makeDeps([
				{ match: (a) => a[0] === 'issue' && a[1] === 'close', respond: { ok: true, stdout: '', stderr: '' } },
			])
			const storage = createIssueStorage(deps)
			const outcome = await landImplement(
				phaseDeps(deps, storage),
				makeOpenSlice(),
				{ verdict: 'ready', commits: 1 },
				{ prdId: '142', integrationBranch: 'prds-issue-142', config: { usePrs: false, review: false, perSliceBranches: false } },
			)
			expect(outcome).toBe('done')
			expect(gitCalls).toEqual([['push', 'prds-issue-142']])
			expect(calls.find((c) => c[0] === 'pr' && c[1] === 'create')).toBeUndefined()
			expect(calls).toContainEqual(['issue', 'close', '145'])
		})

		test('prepareImplement + perSliceBranches:false: runs on the integration branch; no git ops', async () => {
			const { deps, gitCalls } = makeDeps([])
			const storage = createIssueStorage(deps)
			const prep = await prepareImplement(phaseDeps(deps, storage), makeOpenSlice(), {
				prdId: '142',
				integrationBranch: 'prds-issue-142',
				config: { usePrs: false, review: false, perSliceBranches: false },
			})
			expect(prep.branch).toBe('prds-issue-142')
			expect(gitCalls).toEqual([])
		})

		test('landImplement + no-work-needed: clears readyForAgent via gh label edit, returns no-work', async () => {
			const { deps, calls } = makeDeps([
				{ match: (a) => a[0] === 'issue' && a[1] === 'edit', respond: { ok: true, stdout: '', stderr: '' } },
			])
			const storage = createIssueStorage(deps)
			const outcome = await landImplement(
				phaseDeps(deps, storage),
				makeOpenSlice(),
				{ verdict: 'no-work-needed', commits: 0 },
				{ prdId: '142', integrationBranch: 'prds-issue-142', config: { usePrs: true, review: false, perSliceBranches: true } },
			)
			expect(outcome).toBe('no-work')
			expect(calls).toContainEqual(['issue', 'edit', '145', '--remove-label', 'ready-for-agent'])
		})

		test('landImplement + partial: returns partial, no side effects', async () => {
			const { deps, calls, gitCalls } = makeDeps([])
			const storage = createIssueStorage(deps)
			const outcome = await landImplement(
				phaseDeps(deps, storage),
				makeOpenSlice(),
				{ verdict: 'partial', commits: 0 },
				{ prdId: '142', integrationBranch: 'prds-issue-142', config: { usePrs: true, review: false, perSliceBranches: true } },
			)
			expect(outcome).toBe('partial')
			expect(gitCalls).toEqual([])
			expect(calls).toEqual([])
		})

		test('prepareReview: looks up PR number for the slice branch, builds turnIn with {pr, slice}', async () => {
			const { deps, calls } = makeDeps([
				{ match: (a) => a[0] === 'pr' && a[1] === 'list', respond: { ok: true, stdout: '168\n', stderr: '' } },
			])
			const storage = createIssueStorage(deps)
			const prep = await prepareReview(phaseDeps(deps, storage), makeOpenSlice(), {
				prdId: '142',
				integrationBranch: 'prds-issue-142',
				config: { usePrs: true, review: true, perSliceBranches: true },
			})
			expect(prep.branch).toBe('prd-142/slice-145-session-middleware')
			expect(prep.turnIn.pr).toEqual({ number: 168, branch: 'prd-142/slice-145-session-middleware' })
			expect(prep.turnIn.slice).toEqual({ id: '145', title: 'Session Middleware', body: 'wire JWT' })
			expect(calls.find((c) => c[0] === 'pr' && c[1] === 'list')).toBeDefined()
		})

		test('landReview + ready (commits > 0): pushes slice branch, then runs `gh pr ready <num>`; returns progress', async () => {
			const { deps, calls, gitCalls } = makeDeps([
				{ match: (a) => a[0] === 'pr' && a[1] === 'list', respond: { ok: true, stdout: '168\n', stderr: '' } },
				{ match: (a) => a[0] === 'pr' && a[1] === 'ready', respond: { ok: true, stdout: '', stderr: '' } },
			])
			const storage = createIssueStorage(deps)
			const outcome = await landReview(
				phaseDeps(deps, storage),
				makeOpenSlice({ prState: 'draft' }),
				{ verdict: 'ready', commits: 2 },
				{ prdId: '142', integrationBranch: 'prds-issue-142', config: { usePrs: true, review: true, perSliceBranches: true } },
			)
			expect(outcome).toBe('progress')
			expect(gitCalls).toContainEqual(['push', 'prd-142/slice-145-session-middleware'])
			expect(calls).toContainEqual(['pr', 'ready', '168'])
		})

		test('landReview + ready (commits === 0): skips push, runs `gh pr ready <num>`', async () => {
			const { deps, calls, gitCalls } = makeDeps([
				{ match: (a) => a[0] === 'pr' && a[1] === 'list', respond: { ok: true, stdout: '168\n', stderr: '' } },
				{ match: (a) => a[0] === 'pr' && a[1] === 'ready', respond: { ok: true, stdout: '', stderr: '' } },
			])
			const storage = createIssueStorage(deps)
			const outcome = await landReview(
				phaseDeps(deps, storage),
				makeOpenSlice({ prState: 'draft' }),
				{ verdict: 'ready', commits: 0 },
				{ prdId: '142', integrationBranch: 'prds-issue-142', config: { usePrs: true, review: true, perSliceBranches: true } },
			)
			expect(outcome).toBe('progress')
			expect(gitCalls.find((c) => c[0] === 'push')).toBeUndefined()
			expect(calls).toContainEqual(['pr', 'ready', '168'])
		})

		test('landReview + needs-revision: flips slice.needsRevision via gh label edit; does NOT mark PR ready', async () => {
			const { deps, calls, gitCalls } = makeDeps([
				{ match: (a) => a[0] === 'issue' && a[1] === 'edit', respond: { ok: true, stdout: '', stderr: '' } },
			])
			const storage = createIssueStorage(deps)
			const outcome = await landReview(
				phaseDeps(deps, storage),
				makeOpenSlice({ prState: 'draft' }),
				{ verdict: 'needs-revision', commits: 0 },
				{ prdId: '142', integrationBranch: 'prds-issue-142', config: { usePrs: true, review: true, perSliceBranches: true } },
			)
			expect(outcome).toBe('progress')
			expect(calls).toContainEqual(['issue', 'edit', '145', '--add-label', 'needs-revision'])
			expect(calls.find((c) => c[0] === 'pr' && c[1] === 'ready')).toBeUndefined()
			expect(gitCalls.find((c) => c[0] === 'push')).toBeUndefined()
		})

		test('landReview + partial: returns partial, no side effects', async () => {
			const { deps, calls, gitCalls } = makeDeps([])
			const storage = createIssueStorage(deps)
			const outcome = await landReview(
				phaseDeps(deps, storage),
				makeOpenSlice({ prState: 'draft' }),
				{ verdict: 'partial', commits: 0 },
				{ prdId: '142', integrationBranch: 'prds-issue-142', config: { usePrs: true, review: true, perSliceBranches: true } },
			)
			expect(outcome).toBe('partial')
			expect(gitCalls).toEqual([])
			expect(calls).toEqual([])
		})

		test('prepareAddress: finds PR, fetches feedback, packs both into turnIn', async () => {
			const { deps } = makeDeps([
				{ match: (a) => a[0] === 'pr' && a[1] === 'list', respond: { ok: true, stdout: '168\n', stderr: '' } },
				{ match: (a) => a[0] === 'api' && (a[1] ?? '').endsWith('/comments'), respond: { ok: true, stdout: '[]', stderr: '' } },
				{ match: (a) => a[0] === 'pr' && a[1] === 'view' && a.includes('reviews'), respond: { ok: true, stdout: '{"reviews":[]}', stderr: '' } },
				{ match: (a) => a[0] === 'pr' && a[1] === 'view' && a.includes('comments'), respond: { ok: true, stdout: '{"comments":[]}', stderr: '' } },
			])
			const storage = createIssueStorage(deps)
			const prep = await prepareAddress(phaseDeps(deps, storage), makeOpenSlice({ prState: 'draft', needsRevision: true }), {
				prdId: '142',
				integrationBranch: 'prds-issue-142',
				config: { usePrs: true, review: true, perSliceBranches: true },
			})
			expect(prep.branch).toBe('prd-142/slice-145-session-middleware')
			expect(prep.turnIn.pr).toEqual({ number: 168, branch: 'prd-142/slice-145-session-middleware' })
			expect(prep.turnIn.feedback).toEqual([])
		})

		test('landAddress + ready (commits > 0): pushes slice branch, clears needsRevision, returns progress', async () => {
			const { deps, calls, gitCalls } = makeDeps([
				{ match: (a) => a[0] === 'issue' && a[1] === 'edit', respond: { ok: true, stdout: '', stderr: '' } },
			])
			const storage = createIssueStorage(deps)
			const outcome = await landAddress(
				phaseDeps(deps, storage),
				makeOpenSlice({ prState: 'draft', needsRevision: true }),
				{ verdict: 'ready', commits: 3 },
				{ prdId: '142', integrationBranch: 'prds-issue-142', config: { usePrs: true, review: true, perSliceBranches: true } },
			)
			expect(outcome).toBe('progress')
			expect(gitCalls).toContainEqual(['push', 'prd-142/slice-145-session-middleware'])
			expect(calls).toContainEqual(['issue', 'edit', '145', '--remove-label', 'needs-revision'])
		})

		test('landAddress + no-work-needed: clears needsRevision, returns no-work, no push', async () => {
			const { deps, calls, gitCalls } = makeDeps([
				{ match: (a) => a[0] === 'issue' && a[1] === 'edit', respond: { ok: true, stdout: '', stderr: '' } },
			])
			const storage = createIssueStorage(deps)
			const outcome = await landAddress(
				phaseDeps(deps, storage),
				makeOpenSlice({ prState: 'draft', needsRevision: true }),
				{ verdict: 'no-work-needed', commits: 0 },
				{ prdId: '142', integrationBranch: 'prds-issue-142', config: { usePrs: true, review: true, perSliceBranches: true } },
			)
			expect(outcome).toBe('no-work')
			expect(gitCalls.find((c) => c[0] === 'push')).toBeUndefined()
			expect(calls).toContainEqual(['issue', 'edit', '145', '--remove-label', 'needs-revision'])
		})

		test('landAddress + partial: returns partial, no side effects', async () => {
			const { deps, calls, gitCalls } = makeDeps([])
			const storage = createIssueStorage(deps)
			const outcome = await landAddress(
				phaseDeps(deps, storage),
				makeOpenSlice({ prState: 'draft', needsRevision: true }),
				{ verdict: 'partial', commits: 0 },
				{ prdId: '142', integrationBranch: 'prds-issue-142', config: { usePrs: true, review: true, perSliceBranches: true } },
			)
			expect(outcome).toBe('partial')
			expect(gitCalls).toEqual([])
			expect(calls).toEqual([])
		})
	})

	describe('issue storage: createPrd', () => {
		test('creates the issue then creates the integration branch locally and pushes it upstream', async () => {
			const { deps, calls, gitCalls } = makeDeps([
				{
					match: (a) => a[0] === 'issue' && a[1] === 'create',
					respond: { ok: true, stdout: 'https://github.com/o/r/issues/42\n', stderr: '' },
				},
			])
			const storage = createIssueStorage(deps)
			const result = await storage.createPrd({ title: 'Fix Tabs on macOS', body: 'the spec' })
			expect(result).toEqual({ id: '42', branch: '42-fix-tabs-on-macos' })
			expect(calls).toEqual([['issue', 'create', '--title', 'Fix Tabs on macOS', '--body', 'the spec', '--label', 'prd']])
			expect(gitCalls).toEqual([
				['createLocalBranch', '42-fix-tabs-on-macos', 'main'],
				['pushSetUpstream', '42-fix-tabs-on-macos'],
			])
		})

		test('applies configured labels.prd and respects custom baseBranch', async () => {
			const { deps, calls, gitCalls } = makeDeps([
				{ match: (a) => a[1] === 'create', respond: { ok: true, stdout: 'https://github.com/o/r/issues/7\n', stderr: '' } },
			])
			deps.labels.prd = 'roadmap'
			deps.baseBranch = 'develop'

			const storage = createIssueStorage(deps)
			const result = await storage.createPrd({ title: 'Add ORM', body: 'b' })
			expect(result).toEqual({ id: '7', branch: '7-add-orm' })
			expect(calls[0]).toContain('--label')
			expect(calls[0][calls[0].indexOf('--label') + 1]).toBe('roadmap')
			expect(gitCalls).toEqual([
				['createLocalBranch', '7-add-orm', 'develop'],
				['pushSetUpstream', '7-add-orm'],
			])
		})

		test('throws if gh issue create fails', async () => {
			const { deps } = makeDeps([{ match: (a) => a[1] === 'create', respond: { ok: false, error: new Error('rate limited') } }])
			const storage = createIssueStorage(deps)
			await expect(storage.createPrd({ title: 'Fix', body: 'b' })).rejects.toThrow(/rate limited/)
		})
	})

	describe('issue storage: branchForExisting', () => {
		test('computes the branch from the current issue title via gh issue view', async () => {
			const { deps, calls } = makeDeps([
				{
					match: (a) => a[0] === 'issue' && a[1] === 'view',
					respond: { ok: true, stdout: JSON.stringify({ title: 'Fix Tabs on macOS' }), stderr: '' },
				},
			])
			const storage = createIssueStorage(deps)
			expect(await storage.branchForExisting('42')).toBe('42-fix-tabs-on-macos')
			expect(calls).toEqual([['issue', 'view', '42', '--json', 'title']])
		})

	})

	describe('issue storage: listPrds', () => {
		test('returns empty array when no issues match the prd label', async () => {
			const { deps, calls } = makeDeps([
				{ match: (a) => a[0] === 'issue' && a[1] === 'list', respond: { ok: true, stdout: '[]', stderr: '' } },
			])
			const storage = createIssueStorage(deps)
			expect(await storage.listPrds({ state: 'open' })).toEqual([])
			expect(calls[0]).toEqual(['issue', 'list', '--label', 'prd', '--state', 'open', '--json', 'number,title,createdAt'])
		})

		test('passes --state closed through to gh when called with { state: "closed" }', async () => {
			const { deps, calls } = makeDeps([
				{ match: (a) => a[0] === 'issue' && a[1] === 'list', respond: { ok: true, stdout: '[]', stderr: '' } },
			])
			const storage = createIssueStorage(deps)
			await storage.listPrds({ state: 'closed' })
			expect(calls[0]).toEqual(['issue', 'list', '--label', 'prd', '--state', 'closed', '--json', 'number,title,createdAt'])
		})

		test('passes --state all through to gh when called with { state: "all" }', async () => {
			const { deps, calls } = makeDeps([
				{ match: (a) => a[0] === 'issue' && a[1] === 'list', respond: { ok: true, stdout: '[]', stderr: '' } },
			])
			const storage = createIssueStorage(deps)
			await storage.listPrds({ state: 'all' })
			expect(calls[0]).toEqual(['issue', 'list', '--label', 'prd', '--state', 'all', '--json', 'number,title,createdAt'])
		})

		test('returns one PrdSummary per matching issue with branch composed from id+title (one gh call total)', async () => {
			const { deps, calls } = makeDeps([
				{
					match: (a) => a[0] === 'issue' && a[1] === 'list',
					respond: {
						ok: true,
						stdout: JSON.stringify([
							{ number: 42, title: 'Fix Tabs', createdAt: '2026-05-12T00:00:00Z' },
							{ number: 7, title: 'Add ORM', createdAt: '2026-05-11T00:00:00Z' },
						]),
						stderr: '',
					},
				},
			])
			const storage = createIssueStorage(deps)
			const result = await storage.listPrds({ state: 'open' })
			expect(result).toEqual([
				{ id: '42', title: 'Fix Tabs', branch: '42-fix-tabs', createdAt: '2026-05-12T00:00:00Z' },
				{ id: '7', title: 'Add ORM', branch: '7-add-orm', createdAt: '2026-05-11T00:00:00Z' },
			])
			// No per-issue lookups — branch is derived from the list response.
			expect(calls.filter((c) => c[1] === 'view' || c[1] === 'develop')).toEqual([])
		})
	})

	describe('issue storage: createSlice', () => {
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
			const storage = createIssueStorage(deps)
			const slice = await storage.createSlice('42', { title: 'Implement Tab Parser', body: 'the slice spec', blockedBy: [] })

			expect(slice).toEqual({
				id: '57',
				title: 'Implement Tab Parser',
				body: 'the slice spec',
				state: 'OPEN',
				readyForAgent: false,
				needsRevision: false,
				blockedBy: [],
				prState: null,
				branchAhead: false,
			})
			// create issue (no body trailer — parent linkage uses the sub_issues API below)
			expect(calls[0]).toEqual(['issue', 'create', '--title', 'Implement Tab Parser', '--body', 'the slice spec'])
			// resolve internal id
			expect(calls[1]).toEqual(['api', 'repos/{owner}/{repo}/issues/57', '--jq', '.id'])
			// link as sub-issue
			expect(calls[2]).toEqual(['api', '-X', 'POST', 'repos/{owner}/{repo}/issues/42/sub_issues', '-F', 'sub_issue_id=12345678'])
		})
	})

	describe('issue storage: createSlice with blockedBy', () => {
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
			const storage = createIssueStorage(deps)
			const slice = await storage.createSlice('42', { title: 'Implement Tab Parser', body: 'spec', blockedBy: ['99'] })
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
			const storage = createIssueStorage(deps)
			await storage.createSlice('42', { title: 'A', body: 'b', blockedBy: [] })
			expect(calls.find((c) => c.includes('repos/{owner}/{repo}/issues/57/dependencies/blocked_by'))).toBeUndefined()
		})
	})

	describe('issue storage: findSlices', () => {
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
								body: 'parser spec',
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
			const storage = createIssueStorage(deps)
			const slices = classifySlices(await storage.findSlices('42'))
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
			])
			deps.labels.readyForAgent = 'CUSTOM-ready'
			deps.labels.needsRevision = 'CUSTOM-needs'
			const storage = createIssueStorage(deps)
			const [slice] = await storage.findSlices('42')
			expect(slice!.readyForAgent).toBe(true)
			expect(slice!.needsRevision).toBe(true)
		})
	})

	describe('issue storage: findSlices output → classifier', () => {
		// findSlices itself no longer enriches `prState`; the loop calls `enrichSlicePrStates` from
		// pr-flow.ts before classification. These tests cover the non-PR paths the storage still owns:
		// raw slice shape + label parsing + blockedBy resolution.

		test('open slice with readyForAgent label and no blockers → ready bucket', async () => {
			const { deps, calls } = makeDeps([
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
			])
			const storage = createIssueStorage(deps)
			const slices = await storage.findSlices('42')
			expect(slices[0]!.prState).toBeNull()
			expect(classifySlices(slices)[0]!.bucket).toBe('ready')
			expect(calls.find((c) => c[0] === 'pr' && c[1] === 'list')).toBeUndefined()
		})

		test('open slice with needsRevision label → needs-revision bucket (classifier precedence)', async () => {
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
			])
			const storage = createIssueStorage(deps)
			const [s] = classifySlices(await storage.findSlices('42'))
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
				{
					match: (a) => a.includes('repos/{owner}/{repo}/issues/58/dependencies/blocked_by'),
					respond: { ok: true, stdout: JSON.stringify([{ id: 1, number: 57, title: 'A' }]), stderr: '' },
				},
			])
			const storage = createIssueStorage(deps)
			const slices = classifySlices(await storage.findSlices('42'))
			const b = slices.find((x) => x.id === '58')!
			expect(b.blockedBy).toEqual(['57'])
			expect(b.bucket).toBe('blocked')
			// Slice A had total_blocked_by=0 — no extra call should have been made for it.
			expect(calls.find((c) => c.includes('repos/{owner}/{repo}/issues/57/dependencies/blocked_by'))).toBeUndefined()
		})

		test('closed slice → done bucket; no `pr list` call (findSlices does not issue PR queries)', async () => {
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
			const storage = createIssueStorage(deps)
			const [s] = classifySlices(await storage.findSlices('42'))
			expect(s!.bucket).toBe('done')
			expect(calls.some((c) => c[0] === 'pr' && c[1] === 'list')).toBe(false)
		})
	})

	describe('issue storage: findPrd', () => {
		test('returns PrdRecord with branch and state for an existing issue', async () => {
			const { deps } = makeDeps([
				{
					match: (a) => a[0] === 'issue' && a[1] === 'view',
					respond: { ok: true, stdout: JSON.stringify({ number: 42, title: 'Fix Tabs', state: 'OPEN' }), stderr: '' },
				},
			])
			const storage = createIssueStorage(deps)
			expect(await storage.findPrd('42')).toEqual({ id: '42', branch: '42-fix-tabs', title: 'Fix Tabs', state: 'OPEN' })
		})

		test('maps "CLOSED" GitHub state to CLOSED', async () => {
			const { deps } = makeDeps([
				{
					match: (a) => a[0] === 'issue' && a[1] === 'view',
					respond: { ok: true, stdout: JSON.stringify({ number: 42, title: 'X', state: 'CLOSED' }), stderr: '' },
				},
			])
			const storage = createIssueStorage(deps)
			expect((await storage.findPrd('42'))!.state).toBe('CLOSED')
		})

		test('returns null when gh issue view fails (issue not found)', async () => {
			const { deps } = makeDeps([
				{ match: (a) => a[0] === 'issue' && a[1] === 'view', respond: { ok: false, error: new Error('not found') } },
			])
			const storage = createIssueStorage(deps)
			expect(await storage.findPrd('999999')).toBeNull()
		})
	})

	describe('issue storage: updateSlice', () => {
		test('readyForAgent:true adds the configured label', async () => {
			const { deps, calls } = makeDeps([
				{ match: (a) => a[0] === 'issue' && a[1] === 'edit', respond: { ok: true, stdout: '', stderr: '' } },
			])
			const storage = createIssueStorage(deps)
			await storage.updateSlice('42', '57', { readyForAgent: true })
			expect(calls).toEqual([['issue', 'edit', '57', '--add-label', 'ready-for-agent']])
		})

		test('readyForAgent:false removes the configured label', async () => {
			const { deps, calls } = makeDeps([
				{ match: (a) => a[0] === 'issue' && a[1] === 'edit', respond: { ok: true, stdout: '', stderr: '' } },
			])
			const storage = createIssueStorage(deps)
			await storage.updateSlice('42', '57', { readyForAgent: false })
			expect(calls).toEqual([['issue', 'edit', '57', '--remove-label', 'ready-for-agent']])
		})

		test('needsRevision:true adds the configured label; uses custom label name', async () => {
			const { deps, calls } = makeDeps([
				{ match: (a) => a[0] === 'issue' && a[1] === 'edit', respond: { ok: true, stdout: '', stderr: '' } },
			])
			deps.labels.needsRevision = 'fixme'
			const storage = createIssueStorage(deps)
			await storage.updateSlice('42', '57', { needsRevision: true })
			expect(calls).toEqual([['issue', 'edit', '57', '--add-label', 'fixme']])
		})

		test('state CLOSED runs gh issue close; state OPEN runs gh issue reopen', async () => {
			const { deps, calls } = makeDeps([
				{
					match: (a) => a[0] === 'issue' && (a[1] === 'close' || a[1] === 'reopen'),
					respond: { ok: true, stdout: '', stderr: '' },
				},
			])
			const storage = createIssueStorage(deps)
			await storage.updateSlice('42', '57', { state: 'CLOSED' })
			await storage.updateSlice('42', '57', { state: 'OPEN' })
			expect(calls).toEqual([
				['issue', 'close', '57'],
				['issue', 'reopen', '57'],
			])
		})

		test('combined patch fires multiple gh calls in expected order', async () => {
			const { deps, calls } = makeDeps([{ match: () => true, respond: { ok: true, stdout: '', stderr: '' } }])
			const storage = createIssueStorage(deps)
			await storage.updateSlice('42', '57', { readyForAgent: false, needsRevision: true, state: 'CLOSED' })
			expect(calls).toHaveLength(3)
			expect(calls).toContainEqual(['issue', 'edit', '57', '--remove-label', 'ready-for-agent'])
			expect(calls).toContainEqual(['issue', 'edit', '57', '--add-label', 'needs-revision'])
			expect(calls).toContainEqual(['issue', 'close', '57'])
		})
	})

	describe('issue storage: updateSlice with blockedBy', () => {
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
			const storage = createIssueStorage(deps)
			await storage.updateSlice('42', '100', { blockedBy: ['8', '9'] })

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
			const storage = createIssueStorage(deps)
			await storage.updateSlice('42', '100', { blockedBy: ['7'] })
			expect(calls.find((c) => c.includes('-X'))).toBeUndefined()
		})
	})

	describe('issue storage: close', () => {
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
			const storage = createIssueStorage(deps)
			await storage.closePrd('42')
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
			const storage = createIssueStorage(deps)
			await storage.closePrd('42')
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
			const storage = createIssueStorage(deps)
			await storage.closePrd('42')
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
		test('creates the remote branch from the integration base, fetches it, returns its name', async () => {
			const createCalls: Array<[string, string]> = []
			const fetchCalls: string[] = []
			const branch = await createSliceBranch(
				{
					gitFetch: async (b) => {
						fetchCalls.push(b)
					},
					gitCreateRemoteBranch: async (newBranch, baseBranch) => {
						createCalls.push([newBranch, baseBranch])
					},
				},
				'142',
				'145',
				'session-middleware',
				'prds-issue-142',
			)
			expect(branch).toBe('prd-142/slice-145-session-middleware')
			expect(createCalls).toEqual([['prd-142/slice-145-session-middleware', 'prds-issue-142']])
			expect(fetchCalls).toEqual(['prd-142/slice-145-session-middleware'])
		})

		test('propagates the underlying git error when remote-branch creation fails', async () => {
			await expect(
				createSliceBranch(
					{
						gitFetch: async () => {},
						gitCreateRemoteBranch: async () => {
							throw new Error('remote rejected: refs/heads/<x> already exists')
						},
					},
					'142',
					'145',
					'session-middleware',
					'prds-issue-142',
				),
			).rejects.toThrow(/remote rejected/)
		})
	})
}
