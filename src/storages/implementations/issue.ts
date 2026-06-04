import { classifySlices } from '../../utils/bucket.ts'
import { parseGhIssueNumber } from '../../utils/gh-ops.ts'
import { slug as slugify } from '../../utils/slug.ts'
import { landAddress, landImplement, landReview, prepareAddress, prepareImplement, prepareReview, type PhaseDeps } from '../../work/phases.ts'
import type { ClassifiedSlice, Storage, StorageDeps, StorageFactory, ChangeRecord, ChangeSpec, ChangeSummary, Slice, SlicePatch, SliceSpec } from '../types.ts'

type LabelPatch = { readyForAgent?: boolean; needsRevision?: boolean }
type GhSubIssue = Awaited<ReturnType<StorageDeps['gh']['listSubIssues']>>[number]

export const createIssueStorage: StorageFactory = (deps: StorageDeps): Storage => {
	async function closeIssueIfOpen(id: string): Promise<void> {
		const state = await deps.gh.getIssueState(id)
		if (state !== null && state.toUpperCase() === 'CLOSED') return
		const opts = deps.closeOptions.comment !== null ? { comment: deps.closeOptions.comment } : undefined
		await deps.gh.closeIssue(id, opts)
	}

	async function applyLabelPatch(id: string, patch: LabelPatch): Promise<void> {
		await applyBooleanLabelPatch(id, deps.labels.readyForAgent, patch.readyForAgent)
		await applyBooleanLabelPatch(id, deps.labels.needsRevision, patch.needsRevision)
	}

	async function applyBooleanLabelPatch(id: string, label: string, value: boolean | undefined): Promise<void> {
		if (value === undefined) return
		await deps.gh.editIssueLabels(id, labelPatchOptions(label, value))
	}

	function labelPatchOptions(label: string, value: boolean): { add: string[] } | { remove: string[] } {
		return value ? { add: [label] } : { remove: [label] }
	}
	async function createChange(spec: ChangeSpec): Promise<{ id: string; branch: string }> {
		const targetBranch = spec.targetBranch ?? await deps.git.baseBranch()
		const createOut = await deps.gh.createIssue({ title: spec.title, body: bodyWithTargetBranch(spec.body, targetBranch), labels: [deps.labels.change] })
		const id = parseGhIssueNumber(createOut)
		const branch = `${id}-${slugify(spec.title)}`
		await deps.git.createLocalBranch(branch, targetBranch)
		await deps.git.pushSetUpstream(branch)
		return { id, branch }
	}

	async function fetchBlockedBy(sliceNumber: number): Promise<string[]> {
		const blockers = await deps.gh.listBlockedBy(String(sliceNumber))
		return blockers.map((b) => String(b.number))
	}

	async function findSlices(changeId: string): Promise<Slice[]> {
		const rawIssues = await deps.gh.listSubIssues(changeId)
		// Storage emits raw slices with `prState: null` for everyone. The loop
		// calls `enrichSlicesFromOpenPrs` (and, eventually, branch-ahead detection) before classification.
		// See ADR `storage-behavior-separation` step 4.
		return Promise.all(rawIssues.map((issue) => sliceFromSubIssue(issue)))
	}

	async function sliceFromSubIssue(issue: GhSubIssue): Promise<Slice> {
		return {
			id: String(issue.number),
			title: issue.title,
			body: issue.body,
			state: issueState(issue.state),
			readyForAgent: hasIssueLabel(issue, deps.labels.readyForAgent),
			needsRevision: hasIssueLabel(issue, deps.labels.needsRevision),
			blockedBy: await blockedByForIssue(issue),
			prState: null,
		}
	}

	function issueState(state: string): Slice['state'] {
		return state === 'open' ? 'OPEN' : 'CLOSED'
	}

	function hasIssueLabel(issue: GhSubIssue, label: string): boolean {
		return issue.labels.some((l) => l.name === label)
	}

	async function blockedByForIssue(issue: GhSubIssue): Promise<string[]> {
		return (issue.issue_dependencies_summary?.total_blocked_by ?? 0) > 0 ? fetchBlockedBy(issue.number) : []
	}

	async function createSlice(changeId: string, spec: SliceSpec): Promise<Slice> {
		// Parent linkage lives in the GitHub sub-issues API (`addSubIssue` below); no body
		// trailer needed. See ADR `storage-behavior-separation` step 4.
		const createOut = await deps.gh.createIssue({ title: spec.title, body: spec.body })
		const sliceNumber = parseGhIssueNumber(createOut)
		const internalId = await deps.gh.getIssueInternalId(sliceNumber)
		await deps.gh.addSubIssue(changeId, internalId)

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

	async function closeChange(id: string): Promise<void> {
		await closeIssueIfOpen(id)
	}

	async function findChange(id: string): Promise<ChangeRecord | null> {
		const issue = await deps.gh.viewIssue(id)
		if (!issue) return null
		return {
			id: String(issue.number),
			branch: `${issue.number}-${slugify(issue.title)}`,
			targetBranch: targetBranchFromBody(issue.body),
			title: issue.title,
			state: issue.state.toUpperCase() === 'OPEN' ? 'OPEN' : 'CLOSED',
		}
	}

	async function listIssueSummaries(label: string, opts: { state: 'open' | 'closed' | 'all' }, branchFor: (id: string, title: string) => string): Promise<Array<{ id: string; title: string; branch: string; createdAt: string }>> {
		const issues = await deps.gh.listIssues({ label, state: opts.state })
		return issues.map((issue) => {
			const id = String(issue.number)
			return {
				id,
				title: issue.title,
				branch: branchFor(id, issue.title),
				createdAt: issue.createdAt,
			}
		})
	}

	async function listChanges(opts: { state: 'open' | 'closed' | 'all' }): Promise<ChangeSummary[]> {
		return listIssueSummaries(deps.labels.change, opts, (id, title) => `${id}-${slugify(title)}`)
	}

	async function findSlice(sliceId: string): Promise<{ changeId: string; slice: Slice } | null> {
		const changes = await deps.gh.listIssues({ label: deps.labels.change, state: 'all' })
		for (const change of changes) {
			const changeId = String(change.number)
			const slices = await findSlices(changeId)
			const match = slices.find((s) => s.id === sliceId)
			if (match) return { changeId, slice: match }
		}
		return null
	}

	function bodyWithTargetBranch(body: string, targetBranch: string): string {
		return `${body}\n\n<!-- trowel:${JSON.stringify({ targetBranch })} -->`
	}

	function targetBranchFromBody(body: string | null | undefined): string | undefined {
		const raw = trowelMetadataFromBody(body)
		return raw ? targetBranchFromMetadataJson(raw) : undefined
	}

	function targetBranchFromMetadataJson(raw: string): string | undefined {
		try {
			return targetBranchFromMetadata(JSON.parse(raw) as { targetBranch?: unknown })
		} catch {
			return undefined
		}
	}

	function targetBranchFromMetadata(parsed: { targetBranch?: unknown }): string | undefined {
		return isTargetBranch(parsed.targetBranch) ? parsed.targetBranch : undefined
	}

	function isTargetBranch(value: unknown): value is string {
		return typeof value === 'string' && value.length > 0
	}

	function trowelMetadataFromBody(body: string | null | undefined): string | null {
		const match = /<!--\s*trowel:(.*?)-->/s.exec(body ?? '')
		return match?.[1]?.trim() ?? null
	}

	return {
		createChange,
		findChange,
		listChanges,
		closeChange,
		createSlice,
		findSlices,
		findSlice,
		updateSlice,
	}

	async function updateSlice(_changeId: string, sliceId: string, patch: SlicePatch): Promise<void> {
		await applyLabelPatch(sliceId, patch)
		if (patch.blockedBy !== undefined) await replaceBlockedBy(sliceId, patch.blockedBy)
		await applyIssueStatePatch(sliceId, patch.state)
	}

	async function replaceBlockedBy(sliceId: string, blockedBy: string[]): Promise<void> {
		const currentByNumber = await currentBlockersByNumber(sliceId)
		const target = new Set(blockedBy)
		await removeStaleBlockers(sliceId, currentByNumber, target)
		await addNewBlockers(sliceId, blockedBy, currentByNumber)
	}

	async function currentBlockersByNumber(sliceId: string): Promise<Map<string, string | number>> {
		const current = await deps.gh.listBlockedBy(sliceId)
		return new Map(current.map((b) => [String(b.number), b.id]))
	}

	async function removeStaleBlockers(sliceId: string, currentByNumber: Map<string, string | number>, target: Set<string>): Promise<void> {
		for (const [number, internalId] of currentByNumber) {
			if (!target.has(number)) await deps.gh.removeBlockedBy(sliceId, String(internalId))
		}
	}

	async function addNewBlockers(sliceId: string, blockedBy: string[], currentByNumber: Map<string, string | number>): Promise<void> {
		for (const number of blockedBy) {
			if (currentByNumber.has(number)) continue
			const blockerInternalId = await deps.gh.getIssueInternalId(number)
			await deps.gh.addBlockedBy(sliceId, blockerInternalId)
		}
	}

	async function applyIssueStatePatch(sliceId: string, state: SlicePatch['state']): Promise<void> {
		if (state === 'CLOSED') await deps.gh.closeIssue(sliceId)
		else if (state === 'OPEN') await deps.gh.reopenIssue(sliceId)
	}
}

if (import.meta.vitest) {
	const { describe, test, expect } = import.meta.vitest
	const { recordingGhOps } = await import('../../test-utils/gh-ops-recorder.ts')
	const { noopGitOps } = await import('../../test-utils/git-ops-fixtures.ts')
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
			changesDir: '/tmp/x/docs/changes',
				labels: { change: 'change', readyForAgent: 'ready-for-agent', needsRevision: 'needs-revision' },
			closeOptions: { comment: null, deleteBranch: 'never' },
			confirm: async () => false,
			git: noopGitOps({
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
			}),
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

		function makeIssueFixture(overrides: GhOverrides = {}): ReturnType<typeof makeDeps> & { storage: Storage; phase: PhaseDeps } {
			const fixture = makeDeps(overrides)
			const storage = createIssueStorage(fixture.deps)
			return { ...fixture, storage, phase: phaseDeps(fixture.deps, storage) }
		}

		function phaseContext(config = { usePrs: true, review: false, perSliceBranches: true }) {
			return { changeId: '142', integrationBranch: 'changes-issue-142', config }
		}

		function reviewContext() {
			return phaseContext({ usePrs: true, review: true, perSliceBranches: true })
		}

		function expectClosedWithoutDraftPr(calls: Array<[string, ...unknown[]]>): void {
			expect(calls.find((c) => c[0] === 'createDraftPr')).toBeUndefined()
			expect(calls).toContainEqual(['closeIssue', '145'])
		}

		function expectNoPhaseSideEffects(outcome: string, gitCalls: GitCall[], calls: Array<[string, ...unknown[]]>): void {
			expect(outcome).toBe('partial')
			expect(gitCalls).toEqual([])
			expect(calls).toEqual([])
		}

		test('prepareImplement: creates slice branch via git, returns {branch, turnIn}', async () => {
			const { phase, gitCalls } = makeIssueFixture()
			const prep = await prepareImplement(phase, makeOpenSlice(), phaseContext())
			expect(prep.branch).toBe('change-142/slice-145-session-middleware')
			expect(prep.turnIn.slice).toEqual({ id: '145', title: 'Session Middleware', body: 'wire JWT' })
			expect(gitCalls).toContainEqual(['createRemoteBranch', 'change-142/slice-145-session-middleware', 'changes-issue-142'])
			expect(gitCalls).toContainEqual(['fetch', 'change-142/slice-145-session-middleware'])
		})

		test('landImplement + usePrs=true + ready: pushes slice branch and opens a draft PR; returns progress', async () => {
			const { phase, calls, gitCalls } = makeIssueFixture()
			const outcome = await landImplement(phase, makeOpenSlice(), { verdict: 'ready', commits: 1 }, phaseContext())
			expect(outcome).toBe('progress')
			expect(gitCalls).toContainEqual(['push', 'change-142/slice-145-session-middleware'])
			expect(calls).toContainEqual([
				'createDraftPr',
				{
					title: 'Session Middleware',
					head: 'change-142/slice-145-session-middleware',
					base: 'changes-issue-142',
					body: 'Closes #145',
				},
			])
		})

		test('landImplement + usePrs=false + ready: pushes slice, checks out integration, merges --no-ff, pushes integration, deletes slice branch, closes sub-issue; returns done', async () => {
			const { phase, calls, gitCalls } = makeIssueFixture()
			const outcome = await landImplement(phase, makeOpenSlice(), { verdict: 'ready', commits: 1 }, phaseContext({ usePrs: false, review: false, perSliceBranches: true }))
			expect(outcome).toBe('done')
			expect(gitCalls).toEqual([
				['push', 'change-142/slice-145-session-middleware'],
				['checkout', 'changes-issue-142'],
				['mergeNoFf', 'change-142/slice-145-session-middleware'],
				['push', 'changes-issue-142'],
				['deleteRemoteBranch', 'change-142/slice-145-session-middleware'],
			])
			expectClosedWithoutDraftPr(calls)
		})

		test('landImplement + perSliceBranches:false + ready: pushes integration directly, closes sub-issue via updateSlice; returns done', async () => {
			const { phase, calls, gitCalls } = makeIssueFixture()
			const outcome = await landImplement(phase, makeOpenSlice(), { verdict: 'ready', commits: 1 }, phaseContext({ usePrs: false, review: false, perSliceBranches: false }))
			expect(outcome).toBe('done')
			expect(gitCalls).toEqual([['push', 'changes-issue-142']])
			expectClosedWithoutDraftPr(calls)
		})

		test('prepareImplement + perSliceBranches:false: runs on the integration branch; no git ops', async () => {
			const { phase, gitCalls } = makeIssueFixture()
			const prep = await prepareImplement(phase, makeOpenSlice(), phaseContext({ usePrs: false, review: false, perSliceBranches: false }))
			expect(prep.branch).toBe('changes-issue-142')
			expect(gitCalls).toEqual([])
		})

		test('landImplement + no-work-needed: clears readyForAgent via gh label edit, returns no-work', async () => {
			const { phase, calls } = makeIssueFixture()
			const outcome = await landImplement(phase, makeOpenSlice(), { verdict: 'no-work-needed', commits: 0 }, phaseContext())
			expect(outcome).toBe('no-work')
			expect(calls).toContainEqual(['editIssueLabels', '145', { remove: ['ready-for-agent'] }])
		})

		test('landImplement + partial: returns partial, no side effects', async () => {
			const { phase, calls, gitCalls } = makeIssueFixture()
			const outcome = await landImplement(phase, makeOpenSlice(), { verdict: 'partial', commits: 0 }, phaseContext())
			expectNoPhaseSideEffects(outcome, gitCalls, calls)
		})

		test('prepareReview: looks up PR number for the slice branch, builds turnIn with {pr, slice}', async () => {
			const { phase, calls } = makeIssueFixture({ findPrNumberByHead: async () => 168 })
			const prep = await prepareReview(phase, makeOpenSlice(), reviewContext())
			expect(prep.branch).toBe('change-142/slice-145-session-middleware')
			expect(prep.turnIn.pr).toEqual({ number: 168, branch: 'change-142/slice-145-session-middleware' })
			expect(prep.turnIn.slice).toEqual({ id: '145', title: 'Session Middleware', body: 'wire JWT' })
			expect(calls).toContainEqual(['findPrNumberByHead', 'change-142/slice-145-session-middleware'])
		})

		test('landReview + ready (commits > 0): pushes slice branch, then runs markPrReady; returns progress', async () => {
			const { phase, calls, gitCalls } = makeIssueFixture({ findPrNumberByHead: async () => 168 })
			const outcome = await landReview(phase, makeOpenSlice({ prState: 'draft' }), { verdict: 'ready', commits: 2 }, reviewContext())
			expect(outcome).toBe('progress')
			expect(gitCalls).toContainEqual(['push', 'change-142/slice-145-session-middleware'])
			expect(calls).toContainEqual(['markPrReady', 168])
		})

		test('landReview + ready (commits === 0): skips push, runs markPrReady', async () => {
			const { phase, calls, gitCalls } = makeIssueFixture({ findPrNumberByHead: async () => 168 })
			const outcome = await landReview(phase, makeOpenSlice({ prState: 'draft' }), { verdict: 'ready', commits: 0 }, reviewContext())
			expect(outcome).toBe('progress')
			expect(gitCalls.find((c) => c[0] === 'push')).toBeUndefined()
			expect(calls).toContainEqual(['markPrReady', 168])
		})

		test('landReview + needs-revision: flips slice.needsRevision via gh label edit; does NOT mark PR ready', async () => {
			const { phase, calls, gitCalls } = makeIssueFixture()
			const outcome = await landReview(phase, makeOpenSlice({ prState: 'draft' }), { verdict: 'needs-revision', commits: 0 }, reviewContext())
			expect(outcome).toBe('progress')
			expect(calls).toContainEqual(['editIssueLabels', '145', { add: ['needs-revision'] }])
			expect(calls.find((c) => c[0] === 'markPrReady')).toBeUndefined()
			expect(gitCalls.find((c) => c[0] === 'push')).toBeUndefined()
		})

		test('landReview + partial: returns partial, no side effects', async () => {
			const { phase, calls, gitCalls } = makeIssueFixture()
			const outcome = await landReview(phase, makeOpenSlice({ prState: 'draft' }), { verdict: 'partial', commits: 0 }, reviewContext())
			expectNoPhaseSideEffects(outcome, gitCalls, calls)
		})

		test('prepareAddress: finds PR, fetches feedback, packs both into turnIn', async () => {
			const { phase } = makeIssueFixture({ findPrNumberByHead: async () => 168 })
			const prep = await prepareAddress(phase, makeOpenSlice({ prState: 'draft', needsRevision: true }), reviewContext())
			expect(prep.branch).toBe('change-142/slice-145-session-middleware')
			expect(prep.turnIn.pr).toEqual({ number: 168, branch: 'change-142/slice-145-session-middleware' })
			expect(prep.turnIn.feedback).toEqual([])
		})

		test('landAddress + ready (commits > 0): pushes slice branch, clears needsRevision, returns progress', async () => {
			const { phase, calls, gitCalls } = makeIssueFixture()
			const outcome = await landAddress(phase, makeOpenSlice({ prState: 'draft', needsRevision: true }), { verdict: 'ready', commits: 3 }, reviewContext())
			expect(outcome).toBe('progress')
			expect(gitCalls).toContainEqual(['push', 'change-142/slice-145-session-middleware'])
			expect(calls).toContainEqual(['editIssueLabels', '145', { remove: ['needs-revision'] }])
		})

		test('landAddress + no-work-needed: clears needsRevision, returns no-work, no push', async () => {
			const { phase, calls, gitCalls } = makeIssueFixture()
			const outcome = await landAddress(phase, makeOpenSlice({ prState: 'draft', needsRevision: true }), { verdict: 'no-work-needed', commits: 0 }, reviewContext())
			expect(outcome).toBe('no-work')
			expect(gitCalls.find((c) => c[0] === 'push')).toBeUndefined()
			expect(calls).toContainEqual(['editIssueLabels', '145', { remove: ['needs-revision'] }])
		})

		test('landAddress + partial: returns partial, no side effects', async () => {
			const { phase, calls, gitCalls } = makeIssueFixture()
			const outcome = await landAddress(phase, makeOpenSlice({ prState: 'draft', needsRevision: true }), { verdict: 'partial', commits: 0 }, reviewContext())
			expectNoPhaseSideEffects(outcome, gitCalls, calls)
		})
	})

	describe('issue storage: createChange', () => {
		test('creates the issue then creates the integration branch locally and pushes it upstream', async () => {
			const { deps, calls, gitCalls } = makeDeps({
				createIssue: async () => 'https://github.com/o/r/issues/42\n',
			})
			const storage = createIssueStorage(deps)
			const result = await storage.createChange({ title: 'Fix Tabs on macOS', body: 'the spec' })
			expect(result).toEqual({ id: '42', branch: '42-fix-tabs-on-macos' })
			expect(calls).toEqual([['createIssue', { title: 'Fix Tabs on macOS', body: expect.stringContaining('the spec'), labels: ['change'] }]])
			expect((calls[0]![1] as { body: string }).body).toContain('"targetBranch":"develop"')
			expect(gitCalls).toEqual([
				['createLocalBranch', '42-fix-tabs-on-macos', 'develop'],
				['pushSetUpstream', '42-fix-tabs-on-macos'],
			])
		})

		test('stores explicit targetBranch metadata and creates the integration branch from it', async () => {
			const { deps, calls, gitCalls } = makeDeps({
				createIssue: async () => 'https://github.com/o/r/issues/99\n',
			})
			const storage = createIssueStorage(deps)

			const result = await storage.createChange({ title: 'Release Feature', body: 'body', targetBranch: 'release/1.2' })

			expect(result).toEqual({ id: '99', branch: '99-release-feature' })
			expect((calls[0]![1] as { body: string }).body).toContain('"targetBranch":"release/1.2"')
			expect(gitCalls).toEqual([
				['createLocalBranch', '99-release-feature', 'release/1.2'],
				['pushSetUpstream', '99-release-feature'],
			])
		})

		test('applies configured labels.change to the createIssue call', async () => {
			const { deps, calls, gitCalls } = makeDeps({
				createIssue: async () => 'https://github.com/o/r/issues/7\n',
			})
			deps.labels.change = 'roadmap'
			const storage = createIssueStorage(deps)
			const result = await storage.createChange({ title: 'Add ORM', body: 'b' })
			expect(result).toEqual({ id: '7', branch: '7-add-orm' })
			const [name, args] = calls[0]!
			expect(name).toBe('createIssue')
			expect((args as { labels: string[] }).labels).toEqual(['roadmap'])
			expect((args as { body: string }).body).toContain('"targetBranch":"develop"')
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
			await expect(storage.createChange({ title: 'Fix', body: 'b' })).rejects.toThrow(/rate limited/)
		})
	})

	describe('issue storage: listChanges', () => {
		test('returns empty array when no issues match the change label', async () => {
			const { deps, calls } = makeDeps()
			const storage = createIssueStorage(deps)
			expect(await storage.listChanges({ state: 'open' })).toEqual([])
			expect(calls).toEqual([['listIssues', { label: 'change', state: 'open' }]])
		})

		test('passes state: "closed" through to GhOps', async () => {
			const { deps, calls } = makeDeps()
			const storage = createIssueStorage(deps)
			await storage.listChanges({ state: 'closed' })
			expect(calls).toEqual([['listIssues', { label: 'change', state: 'closed' }]])
		})

		test('passes state: "all" through to GhOps', async () => {
			const { deps, calls } = makeDeps()
			const storage = createIssueStorage(deps)
			await storage.listChanges({ state: 'all' })
			expect(calls).toEqual([['listIssues', { label: 'change', state: 'all' }]])
		})

		test('returns one ChangeSummary per matching issue with branch composed from id+title (one gh call total)', async () => {
			const { deps, calls } = makeDeps({
				listIssues: async () => [
					{ number: 42, title: 'Fix Tabs', createdAt: '2026-05-12T00:00:00Z' },
					{ number: 7, title: 'Add ORM', createdAt: '2026-05-11T00:00:00Z' },
				],
			})
			const storage = createIssueStorage(deps)
			const result = await storage.listChanges({ state: 'open' })
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

	describe('issue storage: findChange', () => {
		test('returns ChangeRecord with branch, targetBranch, and state for an existing issue', async () => {
			const { deps } = makeDeps({
				viewIssue: async () => ({ number: 42, title: 'Fix Tabs', state: 'OPEN', body: 'body\n\n<!-- trowel:{"targetBranch":"release/1.2"} -->' }),
			})
			const storage = createIssueStorage(deps)
			expect(await storage.findChange('42')).toEqual({ id: '42', branch: '42-fix-tabs', targetBranch: 'release/1.2', title: 'Fix Tabs', state: 'OPEN' })
		})

		test('maps "CLOSED" GitHub state to CLOSED', async () => {
			const { deps } = makeDeps({
				viewIssue: async () => ({ number: 42, title: 'X', state: 'CLOSED', body: '' }),
			})
			const storage = createIssueStorage(deps)
			expect((await storage.findChange('42'))!.state).toBe('CLOSED')
		})

		test('returns null when viewIssue returns null (issue not found)', async () => {
			const { deps } = makeDeps({ viewIssue: async () => null })
			const storage = createIssueStorage(deps)
			expect(await storage.findChange('999999')).toBeNull()
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
			await storage.closeChange('42')
			expect(calls).toContainEqual(['closeIssue', '42', undefined])
			expect(calls.find((c) => c[0] === 'listOpenPrs')).toBeUndefined()
		})

		test('idempotent: closeIssue not invoked if issue already CLOSED', async () => {
			const { deps, calls } = makeDeps({
				getIssueState: async () => 'CLOSED',
			})
			const storage = createIssueStorage(deps)
			await storage.closeChange('42')
			expect(calls.find((c) => c[0] === 'closeIssue')).toBeUndefined()
		})

		test('passes the comment through to closeIssue when config.close.comment is set', async () => {
			const { deps, calls } = makeDeps({
				getIssueState: async () => 'OPEN',
			})
			deps.closeOptions.comment = 'Closed via trowel'
			const storage = createIssueStorage(deps)
			await storage.closeChange('42')
			expect(calls).toContainEqual(['closeIssue', '42', { comment: 'Closed via trowel' }])
		})
	})
}
