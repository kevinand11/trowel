import { createFileStorage } from './implementations/file.ts'
import { createIssueStorage } from './implementations/issue.ts'
import type { Storage, StorageDeps, StorageFactory } from './types.ts'

export const storageFactories: Record<string, StorageFactory> = {
	file: createFileStorage,
	issue: createIssueStorage,
}

export function getStorage(kind: string, deps: StorageDeps): Storage {
	const factory = storageFactories[kind]
	if (!factory) throw new Error(`No storage registered for kind '${kind}'`)
	return factory(deps)
}

if (import.meta.vitest) {
	const { describe, test, expect } = import.meta.vitest

	const testDeps: StorageDeps = {
		gh: async () => ({ ok: true, stdout: '', stderr: '' }),
		repoRoot: '/tmp/x',
		projectRoot: '/tmp/x',
		baseBranch: 'main',
		branchPrefix: null,
		prdsDir: '/tmp/x/docs/prds',
		labels: { prd: 'prd', readyForAgent: 'ready-for-agent', needsRevision: 'needs-revision' },
		closeOptions: { comment: null, deleteBranch: 'never' },
		// registry tests only verify storage construction; no git/confirm/log needed.
	}

	describe('getStorage', () => {
		test('returns the file storage when kind is "file"', () => {
			expect(getStorage('file', testDeps).name).toBe('file')
		})

		test('returns the issue storage when kind is "issue"', () => {
			expect(getStorage('issue', testDeps).name).toBe('issue')
		})

		test('throws when no storage is registered for the kind', () => {
			expect(() => getStorage('mongo', testDeps)).toThrow(/No storage registered/)
		})

		test('each storage exposes its defaultBranchPrefix', () => {
			expect(getStorage('file', testDeps).defaultBranchPrefix).toBe('prd/')
			expect(getStorage('issue', testDeps).defaultBranchPrefix).toBe('')
		})
	})
}
