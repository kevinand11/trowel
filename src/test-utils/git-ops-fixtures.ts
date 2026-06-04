import type { GitOps } from '../utils/git-ops.ts'

const noop = async (): Promise<void> => {}
const fakeCurrentBranch = async (): Promise<string> => 'fake-current'
const fakeBaseBranch = async (): Promise<string> => 'fake-base'
const trueAsync = async (): Promise<boolean> => true
const falseAsync = async (): Promise<boolean> => false
const zeroAsync = async (): Promise<number> => 0
const emptyWorktreeList = async (): Promise<Awaited<ReturnType<GitOps['worktreeList']>>> => []
const installedGit = async (): Promise<Awaited<ReturnType<GitOps['detectVersion']>>> => ({ installed: true, version: '0.0.0' })
const emptyStatus = async (): Promise<string> => ''

export function noopGitOps(overrides: Partial<GitOps> = {}): GitOps {
	return {
		currentBranch: fakeCurrentBranch,
		baseBranch: fakeBaseBranch,
		branchExists: trueAsync,
		isMerged: falseAsync,
		checkout: noop,
		deleteBranch: noop,
		fetch: noop,
		push: noop,
		mergeNoFf: noop,
		deleteRemoteBranch: noop,
		remoteBranchExists: trueAsync,
		createRemoteBranch: noop,
		createLocalBranch: noop,
		pushSetUpstream: noop,
		worktreeAdd: noop,
		worktreeRemove: noop,
		worktreeList: emptyWorktreeList,
		restoreAll: noop,
		cleanUntracked: noop,
		isWorkingTreeClean: trueAsync,
		statusShort: emptyStatus,
		stashPush: noop,
		stashPop: noop,
		mergeAbort: noop,
		commitsAhead: zeroAsync,
		detectVersion: installedGit,
		...overrides,
	}
}
