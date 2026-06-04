import type { GitOps } from '../utils/git-ops.ts'

const noop = async (): Promise<void> => {}
const fakeCurrentBranch = async (): Promise<string> => 'fake-current'
const fakeBaseBranch = async (): Promise<string> => 'fake-base'
const trueAsync = async (): Promise<boolean> => true
const falseAsync = async (): Promise<boolean> => false
const zeroAsync = async (): Promise<number> => 0
const emptyWorktreeList = async (): Promise<Awaited<ReturnType<GitOps['worktreeList']>>> => []
const emptyBranchList = async (): Promise<string[]> => []
const installedGit = async (): Promise<Awaited<ReturnType<GitOps['detectVersion']>>> => ({ installed: true, version: '0.0.0' })
const emptyStatus = async (): Promise<string> => ''

export function noopGitOps(overrides: Partial<GitOps> = {}): GitOps {
	return {
		currentBranch: fakeCurrentBranch,
		baseBranch: fakeBaseBranch,
		branchExists: trueAsync,
		localBranchExists: trueAsync,
		isMerged: falseAsync,
		checkout: noop,
		deleteBranch: noop,
		listLocalBranches: emptyBranchList,
		fetch: noop,
		push: noop,
		mergeNoFf: noop,
		mergeNoFfIn: noop,
		deleteRemoteBranch: noop,
		remoteBranchExists: trueAsync,
		createRemoteBranch: noop,
		createLocalBranch: noop,
		pushSetUpstream: noop,
		resolveRef: async (ref) => ref,
		checkoutDetached: noop,
		resetHard: noop,
		pushHeadTo: noop,
		updateLocalBranchRef: noop,
		worktreeAdd: noop,
		worktreeRemove: noop,
		worktreeList: emptyWorktreeList,
		restoreAll: noop,
		cleanUntracked: noop,
		cleanAll: noop,
		isWorkingTreeClean: trueAsync,
		statusShort: emptyStatus,
		stashPush: noop,
		stashPop: noop,
		mergeAbort: noop,
		mergeAbortIn: noop,
		commitsAhead: zeroAsync,
		detectVersion: installedGit,
		...overrides,
	}
}
