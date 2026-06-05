import { createFileStorage } from './implementations/file.ts'
import { createIssueStorage } from './implementations/issue.ts'
import type { Storage, StorageDeps, StorageFactory } from './types.ts'

export const storageFactories = {
	file: createFileStorage,
	issue: createIssueStorage,
} satisfies Record<string, StorageFactory>

export function getStorage(name: string, deps: StorageDeps): Storage {
	const factory = storageFactories[name]
	if (!factory) throw new Error(`No storage registered for name '${name}'`)
	return factory(deps)
}

if (import.meta.vitest) {
	const { describe, test, expect } = import.meta.vitest
	const { recordingGhOps } = await import('../test-utils/gh-ops-recorder.ts')
	const { noopGitOps } = await import('../test-utils/git-ops-fixtures.ts')

	const testDeps: StorageDeps = {
		gh: recordingGhOps().gh,
		git: noopGitOps({ currentBranch: async () => '', branchExists: async () => false }),
		repoRoot: '/tmp/x',
		projectRoot: '/tmp/x',
		changesDir: '/tmp/x/docs/changes',
		labels: { change: 'change', readyForAgent: 'ready-for-agent', needsRevision: 'needs-revision' },
		abortOptions: { comment: null, deleteBranch: 'never' },
	}

	describe('getStorage', () => {
		test('throws when no storage is registered for the name', () => {
			expect(() => getStorage('mongo', testDeps)).toThrow(/No storage registered/)
		})
	})
}
