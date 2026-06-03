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
	const { noopGitOps } = await import('../test-utils/git-ops-fixtures.ts')

	const testDeps: StorageDeps = {
		gh: recordingGhOps().gh,
		git: noopGitOps({ currentBranch: async () => '', branchExists: async () => false }),
		repoRoot: '/tmp/x',
		projectRoot: '/tmp/x',
		prdsDir: '/tmp/x/docs/prds',
		fixesDir: '/tmp/x/docs/fixes',
		labels: { prd: 'prd', fix: 'fix', readyForAgent: 'ready-for-agent', needsRevision: 'needs-revision' },
		closeOptions: { comment: null, deleteBranch: 'never' },
	}

	describe('getStorage', () => {
		test('throws when no storage is registered for the kind', () => {
			expect(() => getStorage('mongo', testDeps)).toThrow(/No storage registered/)
		})
	})
}
