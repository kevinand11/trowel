import { createFileBackend } from './implementations/file.ts'
import { createIssueBackend } from './implementations/issue.ts'
import type { Backend, BackendDeps, BackendFactory } from './types.ts'

export const backendFactories: Record<string, BackendFactory> = {
	file: createFileBackend,
	issue: createIssueBackend,
}

export function getBackend(kind: string, deps: BackendDeps): Backend {
	const factory = backendFactories[kind]
	if (!factory) throw new Error(`No backend registered for kind '${kind}'`)
	return factory(deps)
}

if (import.meta.vitest) {
	const { describe, test, expect } = import.meta.vitest

	const testDeps: BackendDeps = {
		gh: async () => ({ ok: true, stdout: '', stderr: '' }),
		repoRoot: '/tmp/x',
		projectRoot: '/tmp/x',
		baseBranch: 'main',
		branchPrefix: null,
		prdsDir: '/tmp/x/docs/prds',
		docMsg: 'docs',
		labels: { prd: 'prd', readyForAgent: 'ready-for-agent', needsRevision: 'needs-revision' },
		closeOptions: { comment: null, deleteBranch: 'never' },
		confirm: async () => false,
	}

	describe('getBackend', () => {
		test('returns the file backend when kind is "file"', () => {
			expect(getBackend('file', testDeps).name).toBe('file')
		})

		test('returns the issue backend when kind is "issue"', () => {
			expect(getBackend('issue', testDeps).name).toBe('issue')
		})

		test('throws when no backend is registered for the kind', () => {
			expect(() => getBackend('mongo', testDeps)).toThrow(/No backend registered/)
		})

		test('each backend exposes its defaultBranchPrefix', () => {
			expect(getBackend('file', testDeps).defaultBranchPrefix).toBe('prd/')
			expect(getBackend('issue', testDeps).defaultBranchPrefix).toBe('')
		})
	})
}
