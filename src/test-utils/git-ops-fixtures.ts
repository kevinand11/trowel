import type { GitOps } from '../utils/git-ops.ts'

export function noopGitOps(overrides: Partial<GitOps> = {}): GitOps {
	return {
		currentBranch: async () => 'fake-current',
		baseBranch: async () => 'fake-base',
		branchExists: async () => true,
		isMerged: async () => false,
		checkout: async () => {},
		deleteBranch: async () => {},
		fetch: async () => {},
		push: async () => {},
		mergeNoFf: async () => {},
		deleteRemoteBranch: async () => {},
		createRemoteBranch: async () => {},
		createLocalBranch: async () => {},
		pushSetUpstream: async () => {},
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
		detectVersion: async () => ({ installed: true, version: '0.0.0' }),
		...overrides,
	}
}
