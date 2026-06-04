import type { GhOps } from './gh-ops.ts'
import type { GitOps } from './git-ops.ts'
import type { ClassifiedSlice, ChangeRecord, ChangeState } from '../storages/types.ts'

export type CloseOutPrState = 'OPEN' | 'CLOSED' | 'MERGED' | null

export type ChangeStateFacts = {
	closeOutPrState: CloseOutPrState
	repositoryMerged: boolean
}

export type ChangeStateDeps = {
	gh: GhOps
	git: GitOps
}

export async function classifyChange(change: ChangeRecord, slices: ClassifiedSlice[], deps: ChangeStateDeps): Promise<ChangeState> {
	return computeChangeState(change, slices, await collectChangeStateFacts(change, slices, deps))
}

export async function collectChangeStateFacts(change: ChangeRecord, slices: ClassifiedSlice[], deps: ChangeStateDeps): Promise<ChangeStateFacts> {
	const closeOutPrState = await closeOutPrStateFor(change, deps.gh)
	return {
		closeOutPrState,
		repositoryMerged: await repositoryMergeProven(change, slices, deps, closeOutPrState),
	}
}

export function computeChangeState(change: Pick<ChangeRecord, 'closedAt' | 'state'>, slices: ClassifiedSlice[], facts: ChangeStateFacts): ChangeState {
	const closedAt = rawClosedAt(change)
	const repositoryMerged = mergeFactApplies(closedAt, slices, facts)
	if (closedAt !== null && repositoryMerged) return 'done'
	if (closedAt === null && repositoryMerged) return 'landed'
	if (closedAt !== null) return 'aborted'
	if (facts.closeOutPrState === 'OPEN') return 'in-flight'
	if (allSlicesDone(slices)) return 'ready'
	return 'open'
}

function rawClosedAt(change: Pick<ChangeRecord, 'closedAt' | 'state'>): string | null {
	if (change.closedAt !== undefined && change.closedAt !== null) return change.closedAt
	return change.state === 'CLOSED' ? 'closed' : null
}

function mergeFactApplies(closedAt: string | null, slices: ClassifiedSlice[], facts: ChangeStateFacts): boolean {
	if (!facts.repositoryMerged) return false
	return closedAt !== null || facts.closeOutPrState === 'MERGED' || allSlicesDone(slices)
}

function allSlicesDone(slices: ClassifiedSlice[]): boolean {
	return slices.length > 0 && slices.every((slice) => slice.state === 'done')
}

async function closeOutPrStateFor(change: ChangeRecord, gh: GhOps): Promise<CloseOutPrState> {
	try {
		return (await gh.findAnyPrByHead(change.branch))?.state ?? null
	} catch {
		return null
	}
}

async function repositoryMergeProven(change: ChangeRecord, slices: ClassifiedSlice[], deps: ChangeStateDeps, closeOutPrState: CloseOutPrState): Promise<boolean> {
	if (closeOutPrState === 'MERGED') return true
	if (!worthCheckingBranchMerge(change, slices)) return false
	const targetBranch = await targetBranchFor(change, deps.git)
	if (!targetBranch) return false
	return await branchMergeProven(change.branch, targetBranch, deps.git)
}

function worthCheckingBranchMerge(change: ChangeRecord, slices: ClassifiedSlice[]): boolean {
	return rawClosedAt(change) !== null || allSlicesDone(slices)
}

async function targetBranchFor(change: ChangeRecord, git: GitOps): Promise<string | null> {
	if (change.targetBranch) return change.targetBranch
	try {
		return await git.baseBranch()
	} catch {
		return null
	}
}

async function branchMergeProven(branch: string, targetBranch: string, git: GitOps): Promise<boolean> {
	try {
		return (await git.remoteBranchExists(branch)) ? await remoteBranchMerged(branch, targetBranch, git) : await localBranchMerged(branch, targetBranch, git)
	} catch {
		return false
	}
}

async function remoteBranchMerged(branch: string, targetBranch: string, git: GitOps): Promise<boolean> {
	await Promise.all([git.fetch(branch), git.fetch(targetBranch)])
	return (await git.commitsAhead(`origin/${branch}`, `origin/${targetBranch}`)) === 0
}

async function localBranchMerged(branch: string, targetBranch: string, git: GitOps): Promise<boolean> {
	if (!(await git.branchExists(branch))) return false
	return await git.isMerged(branch, targetBranch)
}

if (import.meta.vitest) {
	const { describe, test, expect } = import.meta.vitest
	const { recordingGhOps } = await import('../test-utils/gh-ops-recorder.ts')
	const { noopGitOps } = await import('../test-utils/git-ops-fixtures.ts')

	const change = (overrides: Partial<ChangeRecord> = {}): ChangeRecord => ({
		id: '42',
		branch: 'change-42-x',
		targetBranch: 'main',
		title: 'X',
		state: 'OPEN',
		closedAt: null,
		...overrides,
	})
	const slice = (overrides: Partial<ClassifiedSlice> = {}): ClassifiedSlice => ({
		id: 's1',
		title: 'S',
		body: '',
		state: 'open',
		closedAt: null,
		readyForAgent: true,
		needsRevision: false,
		blockedBy: [],
		prState: null,
		...overrides,
	})
	const doneSlice = () => slice({ state: 'done', closedAt: '2026-06-04T00:00:00.000Z', readyForAgent: false })

	describe('computeChangeState', () => {
		test('priority is done → landed → aborted → in-flight → ready → open', () => {
			expect(computeChangeState(change({ closedAt: 'x', state: 'CLOSED' }), [doneSlice()], { closeOutPrState: 'OPEN', repositoryMerged: true })).toBe('done')
			expect(computeChangeState(change(), [doneSlice()], { closeOutPrState: 'OPEN', repositoryMerged: true })).toBe('landed')
			expect(computeChangeState(change({ closedAt: 'x', state: 'CLOSED' }), [doneSlice()], { closeOutPrState: 'OPEN', repositoryMerged: false })).toBe('aborted')
			expect(computeChangeState(change(), [doneSlice()], { closeOutPrState: 'OPEN', repositoryMerged: false })).toBe('in-flight')
			expect(computeChangeState(change(), [doneSlice()], { closeOutPrState: null, repositoryMerged: false })).toBe('ready')
			expect(computeChangeState(change(), [slice()], { closeOutPrState: null, repositoryMerged: false })).toBe('open')
		})

		test('merged branch fact only yields landed for a closeable Change', () => {
			expect(computeChangeState(change(), [], { closeOutPrState: null, repositoryMerged: true })).toBe('open')
			expect(computeChangeState(change(), [slice()], { closeOutPrState: null, repositoryMerged: true })).toBe('open')
			expect(computeChangeState(change(), [doneSlice()], { closeOutPrState: null, repositoryMerged: true })).toBe('landed')
		})
	})

	describe('classifyChange', () => {
		test('merged Close-out PR proves landed', async () => {
			const { gh } = recordingGhOps({ findAnyPrByHead: async () => ({ number: 7, state: 'MERGED' }) })
			const git = noopGitOps({ remoteBranchExists: async () => false, branchExists: async () => false })
			expect(await classifyChange(change(), [doneSlice()], { gh, git })).toBe('landed')
		})

		test('remote integration branch not ahead of target proves landed', async () => {
			const { gh } = recordingGhOps({ findAnyPrByHead: async () => null })
			const git = noopGitOps({ remoteBranchExists: async () => true, commitsAhead: async () => 0 })
			expect(await classifyChange(change(), [doneSlice()], { gh, git })).toBe('landed')
		})

		test('missing remote does not prove merge unless local fallback is merged', async () => {
			const { gh } = recordingGhOps({ findAnyPrByHead: async () => null })
			const git = noopGitOps({ remoteBranchExists: async () => false, branchExists: async () => false })
			expect(await classifyChange(change({ closedAt: 'x', state: 'CLOSED' }), [doneSlice()], { gh, git })).toBe('aborted')
		})
	})
}
