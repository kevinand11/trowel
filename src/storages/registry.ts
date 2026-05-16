import { createFileStorage } from './implementations/file.ts'
import { createIssueStorage } from './implementations/issue.ts'
import type { Storage, StorageDeps, StorageFactory } from './types.ts'

export const storageFactories = {
	file: createFileStorage,
	issue: createIssueStorage,
} satisfies Record<string, StorageFactory>

export type StorageKind = keyof typeof storageFactories

export function getStorage(kind: string, deps: StorageDeps): Storage {
	const factory = storageFactories[kind]
	if (!factory) throw new Error(`No storage registered for kind '${kind}'`)
	return factory(deps)
}

if (import.meta.vitest) {
	const { describe, test, expect } = import.meta.vitest
	const { recordingGhOps } = await import('../test-utils/gh-ops-recorder.ts')

	const noopGit = {
		fetch: async () => {},
		push: async () => {},
		checkout: async () => {},
		mergeNoFf: async () => {},
		deleteRemoteBranch: async () => {},
		createRemoteBranch: async () => {},
		createLocalBranch: async () => {},
		pushSetUpstream: async () => {},
		currentBranch: async () => '',
		branchExists: async () => false,
		isMerged: async () => false,
		deleteBranch: async () => {},
		worktreeAdd: async () => {},
		worktreeRemove: async () => {},
		worktreeList: async () => [],
		restoreAll: async () => {},
		cleanUntracked: async () => {},
		baseBranch: async () => 'main',
		isWorkingTreeClean: async () => true,
		stashPush: async () => {},
		stashPop: async () => {},
		mergeAbort: async () => {},
		commitsAhead: async () => 0,
	}
	const testDeps: StorageDeps = {
		gh: recordingGhOps().gh,
		git: noopGit,
		repoRoot: '/tmp/x',
		projectRoot: '/tmp/x',
		prdsDir: '/tmp/x/docs/prds',
		labels: { prd: 'prd', readyForAgent: 'ready-for-agent', needsRevision: 'needs-revision' },
		closeOptions: { comment: null, deleteBranch: 'never' },
	}

	describe('getStorage', () => {
		test('throws when no storage is registered for the kind', () => {
			expect(() => getStorage('mongo', testDeps)).toThrow(/No storage registered/)
		})
	})
}
