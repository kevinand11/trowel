import { classifySlices } from '../../utils/bucket.ts'
import { parseGhIssueNumber } from '../../utils/gh-ops.ts'
import { slug as slugify } from '../../utils/slug.ts'
import { landAddress, landImplement, landReview, prepareAddress, prepareImplement, prepareReview, type PhaseDeps } from '../../work/phases.ts'
import type { ClassifiedSlice, Storage, StorageDeps, StorageFactory, PrdRecord, PrdSpec, PrdSummary, Slice, SlicePatch, SliceSpec } from '../types.ts'

export const createIssueStorage: StorageFactory = (deps: StorageDeps): Storage => {
	async function createPrd(spec: PrdSpec): Promise<{ id: string; branch: string }> {
		const createOut = await deps.gh.createIssue({ title: spec.title, body: spec.body, labels: [deps.labels.prd] })
		const id = parseGhIssueNumber(createOut)
		const branch = `${id}-${slugify(spec.title)}`
		await deps.git.createLocalBranch(branch, await deps.git.baseBranch())
		await deps.git.pushSetUpstream(branch)
		return { id, branch }
	}

	async function fetchBlockedBy(sliceNumber: number): Promise<string[]> {
		const blockers = await deps.gh.listBlockedBy(String(sliceNumber))
		return blockers.map((b) => String(b.number))
	}

	async function findSlices(prdId: string): Promise<Slice[]> {
		const rawIssues = await deps.gh.listSubIssues(prdId)
		// Storage emits raw slices with `prState: null` for everyone. The loop
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
				}
			}),
		)
	}

	async function createSlice(prdId: string, spec: SliceSpec): Promise<Slice> {
		// Parent linkage lives in the GitHub sub-issues API (`addSubIssue` below); no body
		// trailer needed. See ADR `storage-behavior-separation` step 4.
		const createOut = await deps.gh.createIssue({ title: spec.title, body: spec.body })
		const sliceNumber = parseGhIssueNumber(createOut)
		const internalId = await deps.gh.getIssueInternalId(sliceNumber)
		await deps.gh.addSubIssue(prdId, internalId)

		for (const blockerNumber of spec.blockedBy) {
			const blockerInternalId = await deps.gh.getIssueInternalId(blockerNumber)
			await deps.gh.addBlockedBy(sliceNumber, blockerInternalId)
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
		}
	}

	async function closePrd(id: string): Promise<void> {
		// Idempotent: if the issue is already closed, no-op.
		const state = await deps.gh.getIssueState(id)
		if (state !== null && state.toUpperCase() === 'CLOSED') return
		const opts = deps.closeOptions.comment !== null ? { comment: deps.closeOptions.comment } : undefined
		await deps.gh.closeIssue(id, opts)
	}

	async function findPrd(id: string): Promise<PrdRecord | null> {
		const issue = await deps.gh.viewIssue(id)
		if (!issue) return null
		return {
			id: String(issue.number),
			branch: `${issue.number}-${slugify(issue.title)}`,
			title: issue.title,
			state: issue.state.toUpperCase() === 'OPEN' ? 'OPEN' : 'CLOSED',
		}
	}

	async function listPrds(opts: { state: 'open' | 'closed' | 'all' }): Promise<PrdSummary[]> {
		const issues = await deps.gh.listIssues({ label: deps.labels.prd, state: opts.state })
		return issues.map((issue) => ({
			id: String(issue.number),
			title: issue.title,
			branch: `${issue.number}-${slugify(issue.title)}`,
			createdAt: issue.createdAt,
		}))
	}

	return {
		createPrd,
		findPrd,
		listPrds,
		closePrd,
		createSlice,
		findSlices,
		updateSlice,
	}

	async function updateSlice(_prdId: string, sliceId: string, patch: SlicePatch): Promise<void> {
		if (patch.readyForAgent !== undefined) {
			const opts = patch.readyForAgent ? { add: [deps.labels.readyForAgent] } : { remove: [deps.labels.readyForAgent] }
			await deps.gh.editIssueLabels(sliceId, opts)
		}
		if (patch.needsRevision !== undefined) {
			const opts = patch.needsRevision ? { add: [deps.labels.needsRevision] } : { remove: [deps.labels.needsRevision] }
			await deps.gh.editIssueLabels(sliceId, opts)
		}
		if (patch.blockedBy !== undefined) {
			const current = await deps.gh.listBlockedBy(sliceId)
			const currentByNumber = new Map(current.map((b) => [String(b.number), b.id]))
			const target = new Set(patch.blockedBy)
			for (const [number, internalId] of currentByNumber) {
				if (!target.has(number)) {
					await deps.gh.removeBlockedBy(sliceId, String(internalId))
				}
			}
			for (const number of patch.blockedBy) {
				if (currentByNumber.has(number)) continue
				const blockerInternalId = await deps.gh.getIssueInternalId(number)
				await deps.gh.addBlockedBy(sliceId, blockerInternalId)
			}
		}
		if (patch.state === 'CLOSED') {
			await deps.gh.closeIssue(sliceId)
		} else if (patch.state === 'OPEN') {
			await deps.gh.reopenIssue(sliceId)
		}
	}
}

if (import.meta.vitest) {
	const { describe, test, expect } = import.meta.vitest
	const { recordingGhOps } = await import('../../test-utils/gh-ops-recorder.ts')
	const { GhOps } = {} as unknown as { GhOps: import('../../utils/gh-ops.ts').GhOps }
	void GhOps

	type GhOverrides = Partial<import('../../utils/gh-ops.ts').GhOps>
	type GitCall = [string, ...string[]]

	function makeDeps(overrides: GhOverrides = {}): {
		deps: StorageDeps
		calls: Array<[string, ...unknown[]]>
		gitCalls: GitCall[]
		logCalls: string[]
	} {
		const { gh, calls } = recordingGhOps(overrides)
		const gitCalls: GitCall[] = []
		const logCalls: string[] = []
		const deps: StorageDeps = {
			gh,
			repoRoot: '/tmp/x',
			projectRoot: '/tmp/x',
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
				baseBranch: async () => 'develop',
				branchExists: async () => false,
				isMerged: async () => false,
				deleteBranch: async () => {},
				worktreeAdd: async () => {},
				worktreeRemove: async () => {},
				worktreeList: async () => [],
				restoreAll: async () => {},
				cleanUntracked: async () => {},
				isWorkingTreeClean: async () => true,
				stashPush: async () => {},
				stashPop: async () => {},
				mergeAbort: async () => {},
				commitsAhead: async () => 0,
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
				...overrides,
			}
		}

		function phaseDeps(deps: StorageDeps, storage: Storage): PhaseDeps {
			return { storage, git: deps.git!, gh: deps.gh, log: deps.log!, mergeNoVerify: false }
		}

		test('prepareImplement: creates slice branch via git, returns {branch, turnIn}', async () => {
			const { deps, gitCalls } = makeDeps()
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
			const { deps, calls, gitCalls } = makeDeps()
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
				'createDraftPr',
				{
					title: 'Session Middleware',
					head: 'prd-142/slice-145-session-middleware',
					base: 'prds-issue-142',
					body: 'Closes #145',
				},
			])
		})

		test('landImplement + usePrs=false + ready: pushes slice, checks out integration, merges --no-ff, pushes integration, deletes slice branch, closes sub-issue; returns done', async () => {
			const { deps, calls, gitCalls } = makeDeps()
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
			expect(calls.find((c) => c[0] === 'createDraftPr')).toBeUndefined()
			expect(calls).toContainEqual(['closeIssue', '145'])
		})

		test('landImplement + perSliceBranches:false + ready: pushes integration directly, closes sub-issue via updateSlice; returns done', async () => {
			const { deps, calls, gitCalls } = makeDeps()
			const storage = createIssueStorage(deps)
			const outcome = await landImplement(
				phaseDeps(deps, storage),
				makeOpenSlice(),
				{ verdict: 'ready', commits: 1 },
				{ prdId: '142', integrationBranch: 'prds-issue-142', config: { usePrs: false, review: false, perSliceBranches: false } },
			)
			expect(outcome).toBe('done')
			expect(gitCalls).toEqual([['push', 'prds-issue-142']])
			expect(calls.find((c) => c[0] === 'createDraftPr')).toBeUndefined()
			expect(calls).toContainEqual(['closeIssue', '145'])
		})

		test('prepareImplement + perSliceBranches:false: runs on the integration branch; no git ops', async () => {
			const { deps, gitCalls } = makeDeps()
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
			const { deps, calls } = makeDeps()
			const storage = createIssueStorage(deps)
			const outcome = await landImplement(
				phaseDeps(deps, storage),
				makeOpenSlice(),
				{ verdict: 'no-work-needed', commits: 0 },
				{ prdId: '142', integrationBranch: 'prds-issue-142', config: { usePrs: true, review: false, perSliceBranches: true } },
			)
			expect(outcome).toBe('no-work')
			expect(calls).toContainEqual(['editIssueLabels', '145', { remove: ['ready-for-agent'] }])
		})

		test('landImplement + partial: returns partial, no side effects', async () => {
			const { deps, calls, gitCalls } = makeDeps()
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
			const { deps, calls } = makeDeps({ findPrNumberByHead: async () => 168 })
			const storage = createIssueStorage(deps)
			const prep = await prepareReview(phaseDeps(deps, storage), makeOpenSlice(), {
				prdId: '142',
				integrationBranch: 'prds-issue-142',
				config: { usePrs: true, review: true, perSliceBranches: true },
			})
			expect(prep.branch).toBe('prd-142/slice-145-session-middleware')
			expect(prep.turnIn.pr).toEqual({ number: 168, branch: 'prd-142/slice-145-session-middleware' })
			expect(prep.turnIn.slice).toEqual({ id: '145', title: 'Session Middleware', body: 'wire JWT' })
			expect(calls).toContainEqual(['findPrNumberByHead', 'prd-142/slice-145-session-middleware'])
		})

		test('landReview + ready (commits > 0): pushes slice branch, then runs markPrReady; returns progress', async () => {
			const { deps, calls, gitCalls } = makeDeps({ findPrNumberByHead: async () => 168 })
			const storage = createIssueStorage(deps)
			const outcome = await landReview(
				phaseDeps(deps, storage),
				makeOpenSlice({ prState: 'draft' }),
				{ verdict: 'ready', commits: 2 },
				{ prdId: '142', integrationBranch: 'prds-issue-142', config: { usePrs: true, review: true, perSliceBranches: true } },
			)
			expect(outcome).toBe('progress')
			expect(gitCalls).toContainEqual(['push', 'prd-142/slice-145-session-middleware'])
			expect(calls).toContainEqual(['markPrReady', 168])
		})

		test('landReview + ready (commits === 0): skips push, runs markPrReady', async () => {
			const { deps, calls, gitCalls } = makeDeps({ findPrNumberByHead: async () => 168 })
			const storage = createIssueStorage(deps)
			const outcome = await landReview(
				phaseDeps(deps, storage),
				makeOpenSlice({ prState: 'draft' }),
				{ verdict: 'ready', commits: 0 },
				{ prdId: '142', integrationBranch: 'prds-issue-142', config: { usePrs: true, review: true, perSliceBranches: true } },
			)
			expect(outcome).toBe('progress')
			expect(gitCalls.find((c) => c[0] === 'push')).toBeUndefined()
			expect(calls).toContainEqual(['markPrReady', 168])
		})

		test('landReview + needs-revision: flips slice.needsRevision via gh label edit; does NOT mark PR ready', async () => {
			const { deps, calls, gitCalls } = makeDeps()
			const storage = createIssueStorage(deps)
			const outcome = await landReview(
				phaseDeps(deps, storage),
				makeOpenSlice({ prState: 'draft' }),
				{ verdict: 'needs-revision', commits: 0 },
				{ prdId: '142', integrationBranch: 'prds-issue-142', config: { usePrs: true, review: true, perSliceBranches: true } },
			)
			expect(outcome).toBe('progress')
			expect(calls).toContainEqual(['editIssueLabels', '145', { add: ['needs-revision'] }])
			expect(calls.find((c) => c[0] === 'markPrReady')).toBeUndefined()
			expect(gitCalls.find((c) => c[0] === 'push')).toBeUndefined()
		})

		test('landReview + partial: returns partial, no side effects', async () => {
			const { deps, calls, gitCalls } = makeDeps()
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
			const { deps } = makeDeps({ findPrNumberByHead: async () => 168 })
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
			const { deps, calls, gitCalls } = makeDeps()
			const storage = createIssueStorage(deps)
			const outcome = await landAddress(
				phaseDeps(deps, storage),
				makeOpenSlice({ prState: 'draft', needsRevision: true }),
				{ verdict: 'ready', commits: 3 },
				{ prdId: '142', integrationBranch: 'prds-issue-142', config: { usePrs: true, review: true, perSliceBranches: true } },
			)
			expect(outcome).toBe('progress')
			expect(gitCalls).toContainEqual(['push', 'prd-142/slice-145-session-middleware'])
			expect(calls).toContainEqual(['editIssueLabels', '145', { remove: ['needs-revision'] }])
		})

		test('landAddress + no-work-needed: clears needsRevision, returns no-work, no push', async () => {
			const { deps, calls, gitCalls } = makeDeps()
			const storage = createIssueStorage(deps)
			const outcome = await landAddress(
				phaseDeps(deps, storage),
				makeOpenSlice({ prState: 'draft', needsRevision: true }),
				{ verdict: 'no-work-needed', commits: 0 },
				{ prdId: '142', integrationBranch: 'prds-issue-142', config: { usePrs: true, review: true, perSliceBranches: true } },
			)
			expect(outcome).toBe('no-work')
			expect(gitCalls.find((c) => c[0] === 'push')).toBeUndefined()
			expect(calls).toContainEqual(['editIssueLabels', '145', { remove: ['needs-revision'] }])
		})

		test('landAddress + partial: returns partial, no side effects', async () => {
			const { deps, calls, gitCalls } = makeDeps()
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
			const { deps, calls, gitCalls } = makeDeps({
				createIssue: async () => 'https://github.com/o/r/issues/42\n',
			})
			const storage = createIssueStorage(deps)
			const result = await storage.createPrd({ title: 'Fix Tabs on macOS', body: 'the spec' })
			expect(result).toEqual({ id: '42', branch: '42-fix-tabs-on-macos' })
			expect(calls).toEqual([['createIssue', { title: 'Fix Tabs on macOS', body: 'the spec', labels: ['prd'] }]])
			expect(gitCalls).toEqual([
				['createLocalBranch', '42-fix-tabs-on-macos', 'develop'],
				['pushSetUpstream', '42-fix-tabs-on-macos'],
			])
		})

		test('applies configured labels.prd to the createIssue call', async () => {
			const { deps, calls, gitCalls } = makeDeps({
				createIssue: async () => 'https://github.com/o/r/issues/7\n',
			})
			deps.labels.prd = 'roadmap'
			const storage = createIssueStorage(deps)
			const result = await storage.createPrd({ title: 'Add ORM', body: 'b' })
			expect(result).toEqual({ id: '7', branch: '7-add-orm' })
			const [name, args] = calls[0]!
			expect(name).toBe('createIssue')
			expect((args as { labels: string[] }).labels).toEqual(['roadmap'])
			expect(gitCalls).toEqual([
				['createLocalBranch', '7-add-orm', 'develop'],
				['pushSetUpstream', '7-add-orm'],
			])
		})

		test('throws if gh createIssue fails', async () => {
			const { deps } = makeDeps({
				createIssue: async () => {
					throw new Error('rate limited')
				},
			})
			const storage = createIssueStorage(deps)
			await expect(storage.createPrd({ title: 'Fix', body: 'b' })).rejects.toThrow(/rate limited/)
		})
	})

	describe('issue storage: listPrds', () => {
		test('returns empty array when no issues match the prd label', async () => {
			const { deps, calls } = makeDeps()
			const storage = createIssueStorage(deps)
			expect(await storage.listPrds({ state: 'open' })).toEqual([])
			expect(calls).toEqual([['listIssues', { label: 'prd', state: 'open' }]])
		})

		test('passes state: "closed" through to GhOps', async () => {
			const { deps, calls } = makeDeps()
			const storage = createIssueStorage(deps)
			await storage.listPrds({ state: 'closed' })
			expect(calls).toEqual([['listIssues', { label: 'prd', state: 'closed' }]])
		})

		test('passes state: "all" through to GhOps', async () => {
			const { deps, calls } = makeDeps()
			const storage = createIssueStorage(deps)
			await storage.listPrds({ state: 'all' })
			expect(calls).toEqual([['listIssues', { label: 'prd', state: 'all' }]])
		})

		test('returns one PrdSummary per matching issue with branch composed from id+title (one gh call total)', async () => {
			const { deps, calls } = makeDeps({
				listIssues: async () => [
					{ number: 42, title: 'Fix Tabs', createdAt: '2026-05-12T00:00:00Z' },
					{ number: 7, title: 'Add ORM', createdAt: '2026-05-11T00:00:00Z' },
				],
			})
			const storage = createIssueStorage(deps)
			const result = await storage.listPrds({ state: 'open' })
			expect(result).toEqual([
				{ id: '42', title: 'Fix Tabs', branch: '42-fix-tabs', createdAt: '2026-05-12T00:00:00Z' },
				{ id: '7', title: 'Add ORM', branch: '7-add-orm', createdAt: '2026-05-11T00:00:00Z' },
			])
			// No per-issue lookups — branch is derived from the list response.
			expect(calls.filter((c) => c[0] === 'viewIssue')).toEqual([])
		})
	})

	describe('issue storage: createSlice', () => {
		test('creates issue, resolves internal id, links as sub-issue, returns Slice', async () => {
			const { deps, calls } = makeDeps({
				createIssue: async () => 'https://github.com/o/r/issues/57\n',
				getIssueInternalId: async () => '12345678',
			})
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
			})
			expect(calls[0]).toEqual(['createIssue', { title: 'Implement Tab Parser', body: 'the slice spec' }])
			expect(calls[1]).toEqual(['getIssueInternalId', '57'])
			expect(calls[2]).toEqual(['addSubIssue', '42', '12345678'])
		})
	})

	describe('issue storage: createSlice with blockedBy', () => {
		test('addBlockedBy for each blocker, resolving each blocker number → internal id', async () => {
			const internalIds: Record<string, string> = { '99': '999000', '57': '570000' }
			const { deps, calls } = makeDeps({
				createIssue: async () => 'https://github.com/o/r/issues/57\n',
				getIssueInternalId: async (n) => internalIds[n] ?? '0',
			})
			const storage = createIssueStorage(deps)
			const slice = await storage.createSlice('42', { title: 'Implement Tab Parser', body: 'spec', blockedBy: ['99'] })
			expect(slice.blockedBy).toEqual(['99'])
			expect(calls).toContainEqual(['addBlockedBy', '57', '999000'])
		})

		test('blockedBy: [] → no addBlockedBy calls', async () => {
			const { deps, calls } = makeDeps({
				createIssue: async () => 'https://github.com/o/r/issues/57\n',
				getIssueInternalId: async () => '570000',
			})
			const storage = createIssueStorage(deps)
			await storage.createSlice('42', { title: 'A', body: 'b', blockedBy: [] })
			expect(calls.find((c) => c[0] === 'addBlockedBy')).toBeUndefined()
		})
	})

	describe('issue storage: findSlices', () => {
		test('queries sub-issues endpoint and maps to Slice[]', async () => {
			const { deps, calls } = makeDeps({
				listSubIssues: async () => [
					{ number: 57, title: 'Implement Parser', body: 'parser spec', state: 'open', labels: [{ name: 'ready-for-agent' }] },
					{ number: 58, title: 'Wire CLI', body: 'cli spec', state: 'closed', labels: [{ name: 'needs-revision' }, { name: 'other' }] },
				],
			})
			const storage = createIssueStorage(deps)
			const slices = classifySlices(await storage.findSlices('42'))
			expect(calls[0]).toEqual(['listSubIssues', '42'])
			expect(slices).toEqual([
				{ id: '57', title: 'Implement Parser', body: 'parser spec', state: 'OPEN', readyForAgent: true, needsRevision: false, bucket: 'ready', blockedBy: [], prState: null },
				{ id: '58', title: 'Wire CLI', body: 'cli spec', state: 'CLOSED', readyForAgent: false, needsRevision: true, bucket: 'done', blockedBy: [], prState: null },
			])
		})

		test('uses configured label names to compute booleans', async () => {
			const { deps } = makeDeps({
				listSubIssues: async () => [
					{ number: 9, title: 't', body: 'b', state: 'open', labels: [{ name: 'CUSTOM-ready' }, { name: 'CUSTOM-needs' }] },
				],
			})
			deps.labels.readyForAgent = 'CUSTOM-ready'
			deps.labels.needsRevision = 'CUSTOM-needs'
			const storage = createIssueStorage(deps)
			const [slice] = await storage.findSlices('42')
			expect(slice!.readyForAgent).toBe(true)
			expect(slice!.needsRevision).toBe(true)
		})
	})

	describe('issue storage: findSlices output → classifier', () => {
		test('open slice with readyForAgent label and no blockers → ready bucket', async () => {
			const { deps, calls } = makeDeps({
				listSubIssues: async () => [
					{ number: 57, title: 'Implement Parser', body: 'b', state: 'open', labels: [{ name: 'ready-for-agent' }] },
				],
			})
			const storage = createIssueStorage(deps)
			const slices = await storage.findSlices('42')
			expect(slices[0]!.prState).toBeNull()
			expect(classifySlices(slices)[0]!.bucket).toBe('ready')
			expect(calls.find((c) => c[0] === 'listOpenPrs')).toBeUndefined()
		})

		test('open slice with needsRevision label → needs-revision bucket (classifier precedence)', async () => {
			const { deps } = makeDeps({
				listSubIssues: async () => [
					{ number: 57, title: 'P', body: 'b', state: 'open', labels: [{ name: 'needs-revision' }] },
				],
			})
			const storage = createIssueStorage(deps)
			const [s] = classifySlices(await storage.findSlices('42'))
			expect(s!.bucket).toBe('needs-revision')
		})

		test('open slice with total_blocked_by > 0 → fetches dependencies + populates blockedBy + blocked bucket', async () => {
			const { deps, calls } = makeDeps({
				listSubIssues: async () => [
					{ number: 57, title: 'A', body: 'spec', state: 'open', labels: [], issue_dependencies_summary: { total_blocked_by: 0 } },
					{ number: 58, title: 'B', body: 'spec', state: 'open', labels: [{ name: 'ready-for-agent' }], issue_dependencies_summary: { total_blocked_by: 1 } },
				],
				listBlockedBy: async (id) => (id === '58' ? [{ id: 1, number: 57 }] : []),
			})
			const storage = createIssueStorage(deps)
			const slices = classifySlices(await storage.findSlices('42'))
			const b = slices.find((x) => x.id === '58')!
			expect(b.blockedBy).toEqual(['57'])
			expect(b.bucket).toBe('blocked')
			expect(calls.filter((c) => c[0] === 'listBlockedBy').map((c) => c[1])).toEqual(['58'])
		})

		test('closed slice → done bucket; no listOpenPrs call (findSlices does not issue PR queries)', async () => {
			const { deps, calls } = makeDeps({
				listSubIssues: async () => [
					{ number: 57, title: 'A', body: 'spec', state: 'closed', labels: [] },
				],
			})
			const storage = createIssueStorage(deps)
			const [s] = classifySlices(await storage.findSlices('42'))
			expect(s!.bucket).toBe('done')
			expect(calls.some((c) => c[0] === 'listOpenPrs')).toBe(false)
		})
	})

	describe('issue storage: findPrd', () => {
		test('returns PrdRecord with branch and state for an existing issue', async () => {
			const { deps } = makeDeps({
				viewIssue: async () => ({ number: 42, title: 'Fix Tabs', state: 'OPEN' }),
			})
			const storage = createIssueStorage(deps)
			expect(await storage.findPrd('42')).toEqual({ id: '42', branch: '42-fix-tabs', title: 'Fix Tabs', state: 'OPEN' })
		})

		test('maps "CLOSED" GitHub state to CLOSED', async () => {
			const { deps } = makeDeps({
				viewIssue: async () => ({ number: 42, title: 'X', state: 'CLOSED' }),
			})
			const storage = createIssueStorage(deps)
			expect((await storage.findPrd('42'))!.state).toBe('CLOSED')
		})

		test('returns null when viewIssue returns null (issue not found)', async () => {
			const { deps } = makeDeps({ viewIssue: async () => null })
			const storage = createIssueStorage(deps)
			expect(await storage.findPrd('999999')).toBeNull()
		})
	})

	describe('issue storage: updateSlice', () => {
		test('readyForAgent:true adds the configured label', async () => {
			const { deps, calls } = makeDeps()
			const storage = createIssueStorage(deps)
			await storage.updateSlice('42', '57', { readyForAgent: true })
			expect(calls).toEqual([['editIssueLabels', '57', { add: ['ready-for-agent'] }]])
		})

		test('readyForAgent:false removes the configured label', async () => {
			const { deps, calls } = makeDeps()
			const storage = createIssueStorage(deps)
			await storage.updateSlice('42', '57', { readyForAgent: false })
			expect(calls).toEqual([['editIssueLabels', '57', { remove: ['ready-for-agent'] }]])
		})

		test('needsRevision:true adds the configured label; uses custom label name', async () => {
			const { deps, calls } = makeDeps()
			deps.labels.needsRevision = 'fixme'
			const storage = createIssueStorage(deps)
			await storage.updateSlice('42', '57', { needsRevision: true })
			expect(calls).toEqual([['editIssueLabels', '57', { add: ['fixme'] }]])
		})

		test('state CLOSED runs closeIssue; state OPEN runs reopenIssue', async () => {
			const { deps, calls } = makeDeps()
			const storage = createIssueStorage(deps)
			await storage.updateSlice('42', '57', { state: 'CLOSED' })
			await storage.updateSlice('42', '57', { state: 'OPEN' })
			expect(calls).toEqual([
				['closeIssue', '57'],
				['reopenIssue', '57'],
			])
		})

		test('combined patch fires multiple gh calls in expected order', async () => {
			const { deps, calls } = makeDeps()
			const storage = createIssueStorage(deps)
			await storage.updateSlice('42', '57', { readyForAgent: false, needsRevision: true, state: 'CLOSED' })
			expect(calls).toHaveLength(3)
			expect(calls).toContainEqual(['editIssueLabels', '57', { remove: ['ready-for-agent'] }])
			expect(calls).toContainEqual(['editIssueLabels', '57', { add: ['needs-revision'] }])
			expect(calls).toContainEqual(['closeIssue', '57'])
		})
	})

	describe('issue storage: updateSlice with blockedBy', () => {
		test('diffs old vs new: removes deleted blockers, adds new ones', async () => {
			const internalIds: Record<string, string> = { '8': '800', '9': '900' }
			const { deps, calls } = makeDeps({
				listBlockedBy: async () => [{ id: 700, number: 7 }],
				getIssueInternalId: async (n) => internalIds[n] ?? '0',
			})
			const storage = createIssueStorage(deps)
			await storage.updateSlice('42', '100', { blockedBy: ['8', '9'] })

			// 7 was in old, removed → removeBlockedBy with internal id 700
			expect(calls).toContainEqual(['removeBlockedBy', '100', '700'])

			// 8 and 9 are new → two addBlockedBy calls with their resolved internal ids
			expect(calls).toContainEqual(['addBlockedBy', '100', '800'])
			expect(calls).toContainEqual(['addBlockedBy', '100', '900'])
		})

		test('blockedBy unchanged → no add/remove calls', async () => {
			const { deps, calls } = makeDeps({
				listBlockedBy: async () => [{ id: 700, number: 7 }],
			})
			const storage = createIssueStorage(deps)
			await storage.updateSlice('42', '100', { blockedBy: ['7'] })
			expect(calls.find((c) => c[0] === 'addBlockedBy' || c[0] === 'removeBlockedBy')).toBeUndefined()
		})
	})

	describe('issue storage: close', () => {
		test('runs closeIssue (no PR check, no branch ops — those are orchestrator-owned)', async () => {
			const { deps, calls } = makeDeps({
				getIssueState: async () => 'OPEN',
			})
			const storage = createIssueStorage(deps)
			await storage.closePrd('42')
			expect(calls).toContainEqual(['closeIssue', '42', undefined])
			expect(calls.find((c) => c[0] === 'listOpenPrs')).toBeUndefined()
		})

		test('idempotent: closeIssue not invoked if issue already CLOSED', async () => {
			const { deps, calls } = makeDeps({
				getIssueState: async () => 'CLOSED',
			})
			const storage = createIssueStorage(deps)
			await storage.closePrd('42')
			expect(calls.find((c) => c[0] === 'closeIssue')).toBeUndefined()
		})

		test('passes the comment through to closeIssue when config.close.comment is set', async () => {
			const { deps, calls } = makeDeps({
				getIssueState: async () => 'OPEN',
			})
			deps.closeOptions.comment = 'Closed via trowel'
			const storage = createIssueStorage(deps)
			await storage.closePrd('42')
			expect(calls).toContainEqual(['closeIssue', '42', { comment: 'Closed via trowel' }])
		})
	})
}
