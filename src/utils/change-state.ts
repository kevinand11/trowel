import type { GhOps } from './gh-ops.ts'
import type { ReadOnlyGitFacts } from './git-ops.ts'
import type { Change } from '../storages/types.ts'
import type { ChangeState } from '../work/change-types.ts'
import type { ClassifiedSlice } from '../work/slice-types.ts'

export type CloseOutPrState = 'OPEN' | 'CLOSED' | 'MERGED' | null

export type CloseOutPrFacts = {
	number: number
	state: Exclude<CloseOutPrState, null>
	labels?: Array<{ name: string }>
	reviewDecision?: 'CHANGES_REQUESTED' | 'APPROVED' | 'REVIEW_REQUIRED' | string | null
}

export type ChangeStateFacts = {
	closeOutPr: CloseOutPrFacts | null
	repositoryMerged: boolean
}

export type ChangeStateDeps = {
	gh: GhOps
	git: ReadOnlyGitFacts
	needsRevisionLabel?: string
}

export async function classifyChange(change: Change, slices: ClassifiedSlice[], deps: ChangeStateDeps): Promise<ChangeState> {
	return computeChangeState(change, slices, await collectChangeStateFacts(change, slices, deps), { needsRevisionLabel: deps.needsRevisionLabel })
}

export async function collectChangeStateFacts(change: Change, slices: ClassifiedSlice[], deps: ChangeStateDeps): Promise<ChangeStateFacts> {
	const closeOutPr = await closeOutPrFor(change, deps.gh)
	return {
		closeOutPr,
		repositoryMerged: await repositoryMergeProven(change, slices, deps, closeOutPr?.state ?? null),
	}
}

export function computeChangeState(change: Pick<Change, 'closedAt'>, slices: ClassifiedSlice[], facts: ChangeStateFacts, opts: { needsRevisionLabel?: string } = {}): ChangeState {
	const repositoryMerged = mergeFactApplies(change.closedAt, slices, facts)
	if (change.closedAt !== null && repositoryMerged) return 'done'
	if (change.closedAt === null && repositoryMerged) return 'landed'
	if (change.closedAt !== null) return 'aborted'
	if (facts.closeOutPr?.state === 'OPEN') return closeOutPrNeedsRevision(facts.closeOutPr, opts.needsRevisionLabel) ? 'needs-revision' : 'awaiting-review'
	if (allSlicesDone(slices)) return 'ready'
	return 'open'
}

function closeOutPrNeedsRevision(pr: CloseOutPrFacts, label = 'needs-revision'): boolean {
	return pr.reviewDecision === 'CHANGES_REQUESTED' || (pr.labels?.some((entry) => entry.name === label) ?? false)
}

function mergeFactApplies(closedAt: string | null, slices: ClassifiedSlice[], facts: ChangeStateFacts): boolean {
	if (!facts.repositoryMerged) return false
	return closedAt !== null || facts.closeOutPr?.state === 'MERGED' || allSlicesDone(slices)
}

function allSlicesDone(slices: ClassifiedSlice[]): boolean {
	return slices.length > 0 && slices.every((slice) => slice.state === 'done')
}

async function closeOutPrFor(change: Change, gh: GhOps): Promise<CloseOutPrFacts | null> {
	try {
		return await gh.findAnyPrByHead(change.changeBranch)
	} catch {
		return null
	}
}

async function repositoryMergeProven(change: Change, slices: ClassifiedSlice[], deps: ChangeStateDeps, closeOutPrState: CloseOutPrState): Promise<boolean> {
	if (closeOutPrState === 'MERGED') return true
	if (!worthCheckingBranchMerge(change, slices)) return false
	return await branchMergeProven(change.changeBranch, change.targetBranch, deps.git)
}

function worthCheckingBranchMerge(change: Change, slices: ClassifiedSlice[]): boolean {
	return change.closedAt !== null || allSlicesDone(slices)
}

async function branchMergeProven(branch: string, targetBranch: string, git: ReadOnlyGitFacts): Promise<boolean> {
	try {
		return (await git.remoteBranchExists(branch)) ? await remoteBranchMerged(branch, targetBranch, git) : await localBranchMerged(branch, targetBranch, git)
	} catch {
		return false
	}
}

async function remoteBranchMerged(branch: string, targetBranch: string, git: ReadOnlyGitFacts): Promise<boolean> {
	await Promise.all([git.fetch(branch), git.fetch(targetBranch)])
	return (await git.commitsAhead(`origin/${branch}`, `origin/${targetBranch}`)) === 0
}

async function localBranchMerged(branch: string, targetBranch: string, git: ReadOnlyGitFacts): Promise<boolean> {
	if (!(await git.branchExists(branch))) return false
	return await git.isMerged(branch, targetBranch)
}

if (import.meta.vitest) {
	const { describe, test, expect } = import.meta.vitest
	const { recordingGhOps } = await import('../test-utils/gh-ops-recorder.ts')
	const { noopGitOps } = await import('../test-utils/git-ops-fixtures.ts')

	const change = (overrides: Partial<Change> = {}): Change => ({
		id: '42',
		title: 'X',
		body: '',
		createdAt: '2026-01-01T00:00:00.000Z',
		closedAt: null,
		targetBranch: 'main',
		changeBranch: 'change-42-x',
		...overrides,
	})
	const slice = (overrides: Partial<ClassifiedSlice> = {}): ClassifiedSlice => ({
		id: 's1',
		title: 'S',
		body: '',
		state: 'open',
		closedAt: null,
		implementedAt: null,
		auditedAt: null,
		readyForAgent: true,
		needsRevision: false,
		blockedBy: [],
		sliceBranch: 'change-42/slice-s1-s',
		prState: null,
		...overrides,
	})
	const doneSlice = () => slice({ state: 'done', closedAt: '2026-06-04T00:00:00.000Z', readyForAgent: false })

	describe('computeChangeState', () => {
		test('priority is done → landed → aborted → needs-revision → awaiting-review → ready → open', () => {
			expect(computeChangeState(change({ closedAt: 'x' }), [doneSlice()], { closeOutPr: { number: 7, state: 'OPEN' }, repositoryMerged: true })).toBe('done')
			expect(computeChangeState(change(), [doneSlice()], { closeOutPr: { number: 7, state: 'OPEN' }, repositoryMerged: true })).toBe('landed')
			expect(computeChangeState(change({ closedAt: 'x' }), [doneSlice()], { closeOutPr: { number: 7, state: 'OPEN' }, repositoryMerged: false })).toBe('aborted')
			expect(computeChangeState(change(), [doneSlice()], { closeOutPr: { number: 7, state: 'OPEN', reviewDecision: 'CHANGES_REQUESTED' }, repositoryMerged: false })).toBe('needs-revision')
			expect(computeChangeState(change(), [doneSlice()], { closeOutPr: { number: 7, state: 'OPEN' }, repositoryMerged: false })).toBe('awaiting-review')
			expect(computeChangeState(change(), [doneSlice()], { closeOutPr: null, repositoryMerged: false })).toBe('ready')
			expect(computeChangeState(change(), [slice()], { closeOutPr: null, repositoryMerged: false })).toBe('open')
		})

		test('configured needs-revision label yields needs-revision', () => {
			expect(computeChangeState(change(), [doneSlice()], { closeOutPr: { number: 7, state: 'OPEN', labels: [{ name: 'revise-me' }] }, repositoryMerged: false }, { needsRevisionLabel: 'revise-me' })).toBe('needs-revision')
		})

		test('merged branch fact only yields landed for a closeable Change', () => {
			expect(computeChangeState(change(), [], { closeOutPr: null, repositoryMerged: true })).toBe('open')
			expect(computeChangeState(change(), [slice()], { closeOutPr: null, repositoryMerged: true })).toBe('open')
			expect(computeChangeState(change(), [doneSlice()], { closeOutPr: null, repositoryMerged: true })).toBe('landed')
		})
	})

	describe('classifyChange', () => {
		test('merged Close-out PR proves landed', async () => {
			const { gh } = recordingGhOps({ findAnyPrByHead: async () => ({ number: 7, state: 'MERGED' }) })
			const git = noopGitOps({ remoteBranchExists: async () => false, branchExists: async () => false })
			expect(await classifyChange(change(), [doneSlice()], { gh, git })).toBe('landed')
		})

		test('remote Change branch not ahead of target proves landed', async () => {
			const { gh } = recordingGhOps({ findAnyPrByHead: async () => null })
			const git = noopGitOps({ remoteBranchExists: async () => true, commitsAhead: async () => 0 })
			expect(await classifyChange(change(), [doneSlice()], { gh, git })).toBe('landed')
		})

		test('repository merge proof uses stored Change and Target branches without base fallback', async () => {
			const calls: string[] = []
			const { gh } = recordingGhOps({ findAnyPrByHead: async () => null })
			const git = noopGitOps({
				baseBranch: async () => {
					calls.push('baseBranch')
					throw new Error('baseBranch must not be used for Change state classification')
				},
				remoteBranchExists: async (branch) => {
					calls.push(`remoteBranchExists(${branch})`)
					return true
				},
				fetch: async (branch) => { calls.push(`fetch(${branch})`) },
				commitsAhead: async (branch, base) => {
					calls.push(`commitsAhead(${branch},${base})`)
					return 0
				},
			})
			expect(await classifyChange(change({ changeBranch: 'stored/change', targetBranch: 'release/1.2' }), [doneSlice()], { gh, git })).toBe('landed')
			expect(calls).toEqual([
				'remoteBranchExists(stored/change)',
				'fetch(stored/change)',
				'fetch(release/1.2)',
				'commitsAhead(origin/stored/change,origin/release/1.2)',
			])
		})

		test('missing remote does not prove merge unless local fallback is merged', async () => {
			const { gh } = recordingGhOps({ findAnyPrByHead: async () => null })
			const git = noopGitOps({ remoteBranchExists: async () => false, branchExists: async () => false })
			expect(await classifyChange(change({ closedAt: 'x' }), [doneSlice()], { gh, git })).toBe('aborted')
		})
	})
}
