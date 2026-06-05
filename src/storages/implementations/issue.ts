import { parseGhIssueNumber } from '../../utils/gh-ops.ts'
import { classifySlices } from '../../utils/slice-state.ts'
import { landAddress, landImplement, landReview, prepareAddress, prepareImplement, prepareReview, type PhaseDeps } from '../../work/phases.ts'
import type { ClassifiedSlice, Storage, StorageDeps, StorageFactory, ChangeMetadataPatch, ChangeRecord, ChangeSpec, ChangeSummary, CreatedChange, CreatedSlice, Slice, SliceMetadataPatch, SlicePatch, SliceSpec } from '../types.ts'

type LabelPatch = { readyForAgent?: boolean; needsRevision?: boolean }
type GhSubIssue = Awaited<ReturnType<StorageDeps['gh']['listSubIssues']>>[number]
type TrowelMetadata = Record<string, unknown>
type ProcessMilestones = { implementedAt: string | null; auditedAt: string | null }

export const createIssueStorage: StorageFactory = (deps: StorageDeps): Storage => {
	async function closeIssueIfOpen(id: string): Promise<void> {
		const state = await deps.gh.getIssueState(id)
		if (state !== null && state.toUpperCase() === 'CLOSED') return
		const opts = deps.abortOptions.comment !== null ? { comment: deps.abortOptions.comment } : undefined
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
	async function createChange(spec: ChangeSpec): Promise<CreatedChange> {
		const createOut = await deps.gh.createIssue({ title: spec.title, body: spec.body, labels: [deps.labels.change] })
		const id = parseGhIssueNumber(createOut)
		return { id, title: spec.title }
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
		return classifySlices(await Promise.all(rawIssues.map((issue) => sliceFromSubIssue(issue))))
	}

	async function sliceFromSubIssue(issue: GhSubIssue): Promise<Slice> {
		const closedAt = issueClosedAt(issue)
		const milestones = processMilestones(issue.body, `issue #${issue.number}`)
		return {
			id: String(issue.number),
			title: issue.title,
			body: bodyWithoutMetadata(issue.body),
			state: closedAt === null ? 'draft' : 'done',
			closedAt,
			implementedAt: milestones.implementedAt,
			auditedAt: milestones.auditedAt,
			readyForAgent: hasIssueLabel(issue, deps.labels.readyForAgent),
			needsRevision: hasIssueLabel(issue, deps.labels.needsRevision),
			blockedBy: await blockedByForIssue(issue),
			sliceBranch: requiredSliceBranch(issue.body, `issue #${issue.number}`),
			prState: null,
		}
	}

	function issueClosedAt(issue: GhSubIssue): string | null {
		return issue.closed_at ?? issue.closedAt ?? null
	}

	function hasIssueLabel(issue: GhSubIssue, label: string): boolean {
		return issue.labels.some((l) => l.name === label)
	}

	async function blockedByForIssue(issue: GhSubIssue): Promise<string[]> {
		return (issue.issue_dependencies_summary?.total_blocked_by ?? 0) > 0 ? fetchBlockedBy(issue.number) : []
	}

	async function createSlice(changeId: string, spec: SliceSpec): Promise<CreatedSlice> {
		// Parent linkage lives in the GitHub sub-issues API (`addSubIssue` below); Slice branch
		// metadata starts as null and is filled by prepareImplement.
		const createOut = await deps.gh.createIssue({ title: spec.title, body: bodyWithMetadata(spec.body, { sliceBranch: null, implementedAt: null, auditedAt: null }) })
		const sliceNumber = parseGhIssueNumber(createOut)
		const internalId = await deps.gh.getIssueInternalId(sliceNumber)
		await deps.gh.addSubIssue(changeId, internalId)

		for (const blockerNumber of spec.blockedBy) {
			const blockerInternalId = await deps.gh.getIssueInternalId(blockerNumber)
			await deps.gh.addBlockedBy(sliceNumber, blockerInternalId)
		}

		return { id: sliceNumber, title: spec.title }
	}

	async function closeChange(id: string): Promise<void> {
		await closeIssueIfOpen(id)
	}

	async function findChange(id: string): Promise<ChangeRecord | null> {
		const issue = await deps.gh.viewIssue(id)
		if (!issue) return null
		const closedAt = issue.closedAt ?? null
		return {
			id: String(issue.number),
			changeBranch: requiredChangeBranch(issue.body, `issue #${issue.number}`),
			targetBranch: requiredTargetBranch(issue.body, `issue #${issue.number}`),
			title: issue.title,
			state: closedAt === null && issue.state.toUpperCase() === 'OPEN' ? 'OPEN' : 'CLOSED',
			closedAt,
		}
	}

	async function listIssueSummaries(label: string, opts: { state: 'open' | 'closed' | 'all' }): Promise<ChangeSummary[]> {
		const issues = await deps.gh.listIssues({ label, state: opts.state })
		return issues.map((issue) => ({
			id: String(issue.number),
			title: issue.title,
			changeBranch: requiredChangeBranch(issue.body, `issue #${issue.number}`),
			createdAt: issue.createdAt,
		}))
	}

	async function listChanges(opts: { state: 'open' | 'closed' | 'all' }): Promise<ChangeSummary[]> {
		return listIssueSummaries(deps.labels.change, opts)
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

	function bodyWithMetadata(body: string, patch: TrowelMetadata): string {
		return replaceOrAppendMetadata(body, { ...metadataFromBody(body), ...patch })
	}

	function requiredTargetBranch(body: string | null | undefined, source: string): string {
		return requiredMetadataString(body, source, 'targetBranch')
	}

	function requiredChangeBranch(body: string | null | undefined, source: string): string {
		return requiredMetadataString(body, source, 'changeBranch')
	}

	function requiredSliceBranch(body: string | null | undefined, source: string): string | null {
		return requiredMetadataStringOrNull(body, source, 'sliceBranch')
	}

	function processMilestones(body: string | null | undefined, source: string): ProcessMilestones {
		return {
			implementedAt: optionalMetadataStringOrNull(body, source, 'implementedAt'),
			auditedAt: optionalMetadataStringOrNull(body, source, 'auditedAt'),
		}
	}

	function optionalMetadataStringOrNull(body: string | null | undefined, source: string, key: string): string | null {
		const metadata = metadataFromBody(body)
		if (metadata[key] === undefined || metadata[key] === null) return null
		return requiredMetadataStringValue(metadata[key], source, key)
	}

	function requiredMetadataStringOrNull(body: string | null | undefined, source: string, key: string): string | null {
		const metadata = metadataFromBody(body)
		if (metadata[key] === null) return null
		return requiredMetadataStringValue(metadata[key], source, key)
	}

	function requiredMetadataString(body: string | null | undefined, source: string, key: string): string {
		return requiredMetadataStringValue(metadataFromBody(body)[key], source, key)
	}

	function requiredMetadataStringValue(value: unknown, source: string, key: string): string {
		if (typeof value !== 'string' || value.length === 0) throw new Error(`${source} is missing required Trowel metadata: ${key}. Repair legacy issue storage with \`trowel repair branch-metadata --dry-run\`, review the patches, then run \`trowel repair branch-metadata --apply\`.`)
		return value
	}

	function metadataFromBody(body: string | null | undefined): TrowelMetadata {
		const raw = trowelMetadataFromBody(body)
		if (!raw) return {}
		try {
			const parsed = JSON.parse(raw) as unknown
			if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as TrowelMetadata
		} catch {
			// Fall through to loud read/update failure below.
		}
		throw new Error('issue body contains invalid Trowel metadata JSON')
	}

	function trowelMetadataFromBody(body: string | null | undefined): string | null {
		const match = /<!--\s*trowel:(.*?)-->/s.exec(body ?? '')
		return match?.[1]?.trim() ?? null
	}

	function bodyWithoutMetadata(body: string): string {
		return body.replace(/\n?\n?<!--\s*trowel:.*?-->/s, '').trimEnd()
	}

	function replaceOrAppendMetadata(body: string, metadata: TrowelMetadata): string {
		const serialized = `<!-- trowel:${JSON.stringify(metadata)} -->`
		const publicBody = bodyWithoutMetadata(body)
		return publicBody ? `${publicBody}\n\n${serialized}` : serialized
	}

	return {
		createChange,
		findChange,
		listChanges,
		closeChange,
		updateChangeMetadata,
		createSlice,
		findSlices,
		findSlice,
		updateSlice,
		updateSliceMetadata,
	}

	async function updateChangeMetadata(changeId: string, patch: ChangeMetadataPatch): Promise<void> {
		await updateIssueMetadata(changeId, patch)
	}

	async function updateSliceMetadata(_changeId: string, sliceId: string, patch: SliceMetadataPatch): Promise<void> {
		await updateIssueMetadata(sliceId, patch)
	}

	async function updateIssueMetadata(issueId: string, patch: TrowelMetadata): Promise<void> {
		const issue = await deps.gh.viewIssue(issueId)
		if (!issue) throw new Error(`issue #${issueId} not found while updating Trowel metadata`)
		await deps.gh.editIssueBody(issueId, bodyWithMetadata(issue.body, withoutUndefined(patch)))
	}

	function withoutUndefined(patch: TrowelMetadata): TrowelMetadata {
		return Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined))
	}

	async function updateSlice(_changeId: string, sliceId: string, patch: SlicePatch): Promise<void> {
		await applyLabelPatch(sliceId, patch)
		await applySliceProcessMilestonePatch(sliceId, patch)
		if (patch.blockedBy !== undefined) await replaceBlockedBy(sliceId, patch.blockedBy)
		await applyIssueClosedAtPatch(sliceId, patch.closedAt)
	}

	async function applySliceProcessMilestonePatch(sliceId: string, patch: SlicePatch): Promise<void> {
		const metadataPatch: TrowelMetadata = withoutUndefined({ implementedAt: patch.implementedAt, auditedAt: patch.auditedAt })
		if (Object.keys(metadataPatch).length === 0) return
		await updateIssueMetadata(sliceId, metadataPatch)
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

	async function applyIssueClosedAtPatch(sliceId: string, closedAt: SlicePatch['closedAt']): Promise<void> {
		if (closedAt === undefined) return
		if (closedAt === null) await deps.gh.reopenIssue(sliceId)
		else await closeSliceIssueForAbort(sliceId)
	}

	async function closeSliceIssueForAbort(sliceId: string): Promise<void> {
		if (deps.abortOptions.comment === null) await deps.gh.closeIssue(sliceId)
		else await deps.gh.closeIssue(sliceId, { comment: deps.abortOptions.comment })
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

	function trowelBody(body: string, metadata: Record<string, unknown>): string {
		return `${body}\n\n<!-- trowel:${JSON.stringify(metadata)} -->`
	}

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
			abortOptions: { comment: null, deleteBranch: 'never' },
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
				state: 'open',
				closedAt: null,
				implementedAt: null,
				auditedAt: null,
				readyForAgent: true,
				needsRevision: false,
				blockedBy: [],
				sliceBranch: `change-142/slice-${overrides.id ?? '145'}-session-middleware`,
				prState: null,
				...overrides,
			}
		}

		function phaseDeps(deps: StorageDeps, storage: Storage): PhaseDeps {
			return { storage, git: deps.git!, gh: deps.gh, log: deps.log!, mergeNoVerify: false }
		}

		function makeIssueFixture(overrides: GhOverrides = {}): ReturnType<typeof makeDeps> & { storage: Storage; phase: PhaseDeps } {
			const fixture = makeDeps({ viewIssue: async (id) => ({ number: Number(id), title: 'Session Middleware', state: 'OPEN', body: trowelBody('wire JWT', { sliceBranch: 'change-142/slice-145-session-middleware', implementedAt: null, auditedAt: null }), closedAt: null }), ...overrides })
			const storage = createIssueStorage(fixture.deps)
			return { ...fixture, storage, phase: phaseDeps(fixture.deps, storage) }
		}

		function phaseContext(config = { usePrs: true, audit: false, perSliceBranches: true }) {
			return { changeId: '142', changeBranch: 'changes-issue-142', config }
		}

		function reviewContext() {
			return phaseContext({ usePrs: true, audit: true, perSliceBranches: true })
		}

		function expectNoPhaseSideEffects(outcome: string, gitCalls: GitCall[], calls: Array<[string, ...unknown[]]>): void {
			expect(outcome).toBe('partial')
			expect(gitCalls).toEqual([])
			expect(calls).toEqual([])
		}

		test('prepareImplement: verifies and fetches the stored Slice branch without creating it', async () => {
			const { phase, gitCalls } = makeIssueFixture()
			const prep = await prepareImplement(phase, makeOpenSlice(), phaseContext())
			expect(prep.branch).toBe('change-142/slice-145-session-middleware')
			expect(prep.turnIn.slice).toEqual({ id: '145', title: 'Session Middleware', body: 'wire JWT' })
			expect(gitCalls.map((c) => c[0])).not.toContain('createRemoteBranch')
			expect(gitCalls).toContainEqual(['fetch', 'change-142/slice-145-session-middleware'])
		})

		test('landImplement + ready: pushes slice branch and records implementedAt; returns progress', async () => {
			const { phase, calls, gitCalls } = makeIssueFixture()
			const outcome = await landImplement(phase, makeOpenSlice(), { verdict: 'ready', commits: 1 }, phaseContext())
			expect(outcome).toBe('progress')
			expect(gitCalls).toContainEqual(['push', 'change-142/slice-145-session-middleware'])
			expect(calls.some((call) => call[0] === 'editIssueBody' && /"implementedAt":"\d{4}-/.test(String(call[2])))).toBe(true)
			expect(calls.map((c) => c[0])).not.toContain('createDraftPr')
		})

		test('landImplement + usePrs=false + ready: records implementedAt without merging; returns progress', async () => {
			const { phase, calls, gitCalls } = makeIssueFixture()
			const outcome = await landImplement(phase, makeOpenSlice(), { verdict: 'ready', commits: 1 }, phaseContext({ usePrs: false, audit: false, perSliceBranches: true }))
			expect(outcome).toBe('progress')
			expect(gitCalls).toEqual([['push', 'change-142/slice-145-session-middleware']])
			expect(calls.some((call) => call[0] === 'editIssueBody' && /"implementedAt":"\d{4}-/.test(String(call[2])))).toBe(true)
		})

		test('landImplement + stored Slice branch equals Change branch + ready: pushes Change branch and records implementedAt; returns progress', async () => {
			const { phase, calls, gitCalls } = makeIssueFixture()
			const outcome = await landImplement(phase, makeOpenSlice({ sliceBranch: 'changes-issue-142' }), { verdict: 'ready', commits: 1 }, phaseContext({ usePrs: false, audit: false, perSliceBranches: false }))
			expect(outcome).toBe('progress')
			expect(gitCalls).toEqual([['push', 'changes-issue-142']])
			expect(calls.some((call) => call[0] === 'editIssueBody' && /"implementedAt":"\d{4}-/.test(String(call[2])))).toBe(true)
		})

		test('prepareImplement + stored Slice branch equals Change branch: runs on stored branch and fetches it', async () => {
			const { phase, gitCalls } = makeIssueFixture()
			const prep = await prepareImplement(phase, makeOpenSlice({ sliceBranch: 'changes-issue-142' }), phaseContext({ usePrs: false, audit: false, perSliceBranches: false }))
			expect(prep.branch).toBe('changes-issue-142')
			expect(gitCalls).toEqual([['fetch', 'changes-issue-142']])
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
		test('creates the issue record and returns allocated id+title without branch metadata', async () => {
			const { deps, calls, gitCalls } = makeDeps({
				createIssue: async () => 'https://github.com/o/r/issues/42\n',
			})
			const storage = createIssueStorage(deps)
			const result = await storage.createChange({ title: 'Fix Tabs on macOS', body: 'the spec' })
			expect(result).toEqual({ id: '42', title: 'Fix Tabs on macOS' })
			expect(calls[0]).toEqual(['createIssue', { title: 'Fix Tabs on macOS', body: 'the spec', labels: ['change'] }])
			expect(calls.find((c) => c[0] === 'editIssueBody')).toBeUndefined()
			expect(gitCalls).toEqual([])
		})

		test('createChange ignores targetBranch because branch metadata is updated after branch creation', async () => {
			const { deps, calls, gitCalls } = makeDeps({
				createIssue: async () => 'https://github.com/o/r/issues/99\n',
			})
			const storage = createIssueStorage(deps)

			const result = await storage.createChange({ title: 'Release Feature', body: 'body', targetBranch: 'release/1.2' })

			expect(result).toEqual({ id: '99', title: 'Release Feature' })
			expect(calls[0]).toEqual(['createIssue', { title: 'Release Feature', body: 'body', labels: ['change'] }])
			expect(gitCalls).toEqual([])
		})

		test('applies configured labels.change to the createIssue call', async () => {
			const { deps, calls, gitCalls } = makeDeps({
				createIssue: async () => 'https://github.com/o/r/issues/7\n',
			})
			deps.labels.change = 'roadmap'
			const storage = createIssueStorage(deps)
			const result = await storage.createChange({ title: 'Add ORM', body: 'b' })
			expect(result).toEqual({ id: '7', title: 'Add ORM' })
			const [name, args] = calls[0]!
			expect(name).toBe('createIssue')
			expect((args as { labels: string[] }).labels).toEqual(['roadmap'])
			expect((args as { body: string }).body).toBe('b')
			expect(gitCalls).toEqual([])
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

		test('returns one ChangeSummary per matching issue with stored Change branch metadata', async () => {
			const { deps, calls } = makeDeps({
				listIssues: async () => [
					{ number: 42, title: 'Fix Tabs', createdAt: '2026-05-12T00:00:00Z', body: '<!-- trowel:{"changeBranch":"change-42-fix-tabs","targetBranch":"main"} -->' },
					{ number: 7, title: 'Add ORM', createdAt: '2026-05-11T00:00:00Z', body: '<!-- trowel:{"changeBranch":"change-7-add-orm","targetBranch":"main"} -->' },
				],
			})
			const storage = createIssueStorage(deps)
			const result = await storage.listChanges({ state: 'open' })
			expect(result).toEqual([
				{ id: '42', title: 'Fix Tabs', changeBranch: 'change-42-fix-tabs', createdAt: '2026-05-12T00:00:00Z' },
				{ id: '7', title: 'Add ORM', changeBranch: 'change-7-add-orm', createdAt: '2026-05-11T00:00:00Z' },
			])
			// No per-issue lookups — Change branch is read from the list response metadata.
			expect(calls.filter((c) => c[0] === 'viewIssue')).toEqual([])
		})
	})

	describe('issue storage: createSlice', () => {
		test('creates issue, resolves internal id, links as sub-issue, returns id+title', async () => {
			const { deps, calls } = makeDeps({
				createIssue: async () => 'https://github.com/o/r/issues/57\n',
				getIssueInternalId: async () => '12345678',
			})
			const storage = createIssueStorage(deps)
			const slice = await storage.createSlice('42', { title: 'Implement Tab Parser', body: 'the slice spec', blockedBy: [] })

			expect(slice).toEqual({ id: '57', title: 'Implement Tab Parser' })
			expect(calls[0]).toEqual(['createIssue', { title: 'Implement Tab Parser', body: trowelBody('the slice spec', { sliceBranch: null, implementedAt: null, auditedAt: null }) }])
			expect(calls[1]).toEqual(['getIssueInternalId', '57'])
			expect(calls[2]).toEqual(['addSubIssue', '42', '12345678'])
			expect(calls.find((c) => c[0] === 'editIssueBody')).toBeUndefined()
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
			expect(slice).toEqual({ id: '57', title: 'Implement Tab Parser' })
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
					{ number: 57, title: 'Implement Parser', body: trowelBody('parser spec', { sliceBranch: 'change-42/slice-57-implement-parser' }), state: 'open', labels: [{ name: 'ready-for-agent' }] },
					{ number: 58, title: 'Wire CLI', body: trowelBody('cli spec', { sliceBranch: 'change-42/slice-58-wire-cli' }), state: 'closed', closed_at: '2026-06-04T00:00:00Z', labels: [{ name: 'needs-revision' }, { name: 'other' }] },
				],
			})
			const storage = createIssueStorage(deps)
			const slices = classifySlices(await storage.findSlices('42'))
			expect(calls[0]).toEqual(['listSubIssues', '42'])
			expect(slices).toEqual([
				{ id: '57', title: 'Implement Parser', body: 'parser spec', state: 'open', closedAt: null, implementedAt: null, auditedAt: null, readyForAgent: true, needsRevision: false, blockedBy: [], sliceBranch: 'change-42/slice-57-implement-parser', prState: null },
				{ id: '58', title: 'Wire CLI', body: 'cli spec', state: 'done', closedAt: '2026-06-04T00:00:00Z', implementedAt: null, auditedAt: null, readyForAgent: false, needsRevision: true, blockedBy: [], sliceBranch: 'change-42/slice-58-wire-cli', prState: null },
			])
		})

		test('uses configured label names to compute booleans', async () => {
			const { deps } = makeDeps({
				listSubIssues: async () => [
					{ number: 9, title: 't', body: trowelBody('b', { sliceBranch: 'change-42/slice-9-t' }), state: 'open', labels: [{ name: 'CUSTOM-ready' }, { name: 'CUSTOM-needs' }] },
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
		test('open slice with readyForAgent label and no blockers → open state', async () => {
			const { deps, calls } = makeDeps({
				listSubIssues: async () => [
					{ number: 57, title: 'Implement Parser', body: trowelBody('b', { sliceBranch: 'change-42/slice-57-implement-parser' }), state: 'open', labels: [{ name: 'ready-for-agent' }] },
				],
			})
			const storage = createIssueStorage(deps)
			const slices = await storage.findSlices('42')
			expect(slices[0]!.prState).toBeNull()
			expect(classifySlices(slices)[0]!.state).toBe('open')
			expect(calls.find((c) => c[0] === 'listOpenPrs')).toBeUndefined()
		})

		test('open slice with needsRevision label → needs-revision state (classifier precedence)', async () => {
			const { deps } = makeDeps({
				listSubIssues: async () => [
					{ number: 57, title: 'P', body: trowelBody('b', { sliceBranch: 'change-42/slice-57-p' }), state: 'open', labels: [{ name: 'needs-revision' }] },
				],
			})
			const storage = createIssueStorage(deps)
			const [s] = classifySlices(await storage.findSlices('42'))
			expect(s!.state).toBe('needs-revision')
		})

		test('open slice with total_blocked_by > 0 → fetches dependencies + populates blockedBy + blocked state', async () => {
			const { deps, calls } = makeDeps({
				listSubIssues: async () => [
					{ number: 57, title: 'A', body: trowelBody('spec', { sliceBranch: 'change-42/slice-57-a' }), state: 'open', labels: [], issue_dependencies_summary: { total_blocked_by: 0 } },
					{ number: 58, title: 'B', body: trowelBody('spec', { sliceBranch: 'change-42/slice-58-b' }), state: 'open', labels: [{ name: 'ready-for-agent' }], issue_dependencies_summary: { total_blocked_by: 1 } },
				],
				listBlockedBy: async (id) => (id === '58' ? [{ id: 1, number: 57 }] : []),
			})
			const storage = createIssueStorage(deps)
			const slices = classifySlices(await storage.findSlices('42'))
			const b = slices.find((x) => x.id === '58')!
			expect(b.blockedBy).toEqual(['57'])
			expect(b.state).toBe('blocked')
			expect(calls.filter((c) => c[0] === 'listBlockedBy').map((c) => c[1])).toEqual(['58'])
		})

		test('closed slice → done state; no listOpenPrs call (findSlices does not issue PR queries)', async () => {
			const { deps, calls } = makeDeps({
				listSubIssues: async () => [
					{ number: 57, title: 'A', body: trowelBody('spec', { sliceBranch: 'change-42/slice-57-a' }), state: 'closed', closed_at: '2026-06-04T00:00:00Z', labels: [] },
				],
			})
			const storage = createIssueStorage(deps)
			const [s] = classifySlices(await storage.findSlices('42'))
			expect(s!.state).toBe('done')
			expect(calls.some((c) => c[0] === 'listOpenPrs')).toBe(false)
		})
	})

	describe('issue storage: findChange', () => {
		test('returns ChangeRecord with changeBranch, targetBranch, and state for an existing issue', async () => {
			const { deps } = makeDeps({
				viewIssue: async () => ({ number: 42, title: 'Fix Tabs', state: 'OPEN', body: 'body\n\n<!-- trowel:{"targetBranch":"release/1.2","changeBranch":"change-42-fix-tabs"} -->' }),
			})
			const storage = createIssueStorage(deps)
			expect(await storage.findChange('42')).toEqual({ id: '42', changeBranch: 'change-42-fix-tabs', targetBranch: 'release/1.2', title: 'Fix Tabs', state: 'OPEN', closedAt: null })
		})

		test('maps "CLOSED" GitHub state to CLOSED', async () => {
			const { deps } = makeDeps({
				viewIssue: async () => ({ number: 42, title: 'X', state: 'CLOSED', body: '<!-- trowel:{"targetBranch":"main","changeBranch":"change-42-x"} -->' }),
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

	describe('issue storage: branch metadata', () => {
		test('updateChangeMetadata merges into the existing hidden JSON object without clobbering unrelated keys', async () => {
			const { deps, calls } = makeDeps({
				viewIssue: async () => ({ number: 42, title: 'Fix Tabs', state: 'OPEN', body: trowelBody('body', { targetBranch: 'main', owner: 'docs' }) }),
			})
			const storage = createIssueStorage(deps)

			await storage.updateChangeMetadata('42', { changeBranch: 'change-42-fix-tabs' })

			expect(calls).toEqual([
				['viewIssue', '42'],
				['editIssueBody', '42', 'body\n\n<!-- trowel:{"targetBranch":"main","owner":"docs","changeBranch":"change-42-fix-tabs"} -->'],
			])
		})

		test('updateSliceMetadata merges into the existing hidden JSON object without clobbering unrelated keys', async () => {
			const { deps, calls } = makeDeps({
				viewIssue: async () => ({ number: 57, title: 'Slice', state: 'OPEN', body: trowelBody('body', { reviewer: 'bot', sliceBranch: 'old' }) }),
			})
			const storage = createIssueStorage(deps)

			await storage.updateSliceMetadata('42', '57', { sliceBranch: 'change-42/slice-57-slice' })

			expect(calls).toEqual([
				['viewIssue', '57'],
				['editIssueBody', '57', 'body\n\n<!-- trowel:{"reviewer":"bot","sliceBranch":"change-42/slice-57-slice"} -->'],
			])
		})

		test('findChange fails loudly with repair guidance when required branch metadata is missing', async () => {
			const { deps } = makeDeps({
				viewIssue: async () => ({ number: 42, title: 'Missing', state: 'OPEN', body: trowelBody('body', { targetBranch: 'main' }) }),
			})
			const storage = createIssueStorage(deps)
			await expect(storage.findChange('42')).rejects.toThrow(/missing required Trowel metadata: changeBranch[\s\S]*trowel repair branch-metadata --dry-run[\s\S]*--apply/)
		})

		test('findSlices accepts null Slice branch metadata before first implementation preparation', async () => {
			const { deps } = makeDeps({
				listSubIssues: async () => [{ number: 57, title: 'Slice', body: trowelBody('body', { sliceBranch: null }), state: 'open', labels: [] }],
			})
			const storage = createIssueStorage(deps)
			expect((await storage.findSlices('42'))[0]).toMatchObject({ id: '57', sliceBranch: null })
		})

		test('findSlices fails loudly with repair guidance when required Slice branch metadata is missing', async () => {
			const { deps } = makeDeps({
				listSubIssues: async () => [{ number: 57, title: 'Slice', body: 'body', state: 'open', labels: [] }],
			})
			const storage = createIssueStorage(deps)
			await expect(storage.findSlices('42')).rejects.toThrow(/missing required Trowel metadata: sliceBranch[\s\S]*trowel repair branch-metadata --dry-run[\s\S]*--apply/)
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
			await storage.updateSlice('42', '57', { closedAt: '2026-06-04T00:00:00Z' })
			await storage.updateSlice('42', '57', { closedAt: null })
			expect(calls).toEqual([
				['closeIssue', '57'],
				['reopenIssue', '57'],
			])
		})

		test('state CLOSED passes the configured abort comment when present', async () => {
			const { deps, calls } = makeDeps()
			deps.abortOptions.comment = 'Closed via trowel'
			const storage = createIssueStorage(deps)
			await storage.updateSlice('42', '57', { closedAt: '2026-06-04T00:00:00Z' })
			expect(calls).toEqual([['closeIssue', '57', { comment: 'Closed via trowel' }]])
		})

		test('combined patch fires multiple gh calls in expected order', async () => {
			const { deps, calls } = makeDeps()
			const storage = createIssueStorage(deps)
			await storage.updateSlice('42', '57', { readyForAgent: false, needsRevision: true, closedAt: '2026-06-04T00:00:00Z' })
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

		test('passes the comment through to closeIssue when config.abort.comment is set', async () => {
			const { deps, calls } = makeDeps({
				getIssueState: async () => 'OPEN',
			})
			deps.abortOptions.comment = 'Closed via trowel'
			const storage = createIssueStorage(deps)
			await storage.closeChange('42')
			expect(calls).toContainEqual(['closeIssue', '42', { comment: 'Closed via trowel' }])
		})
	})
}
