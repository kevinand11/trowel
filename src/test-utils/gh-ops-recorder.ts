import type { GhOps } from '../utils/gh-ops.ts'

/**
 * Test helper: build a `GhOps` whose every method records its call name + args
 * into a shared array and then delegates to a per-test override (if provided).
 *
 * Defaults: every method that returns a list returns `[]`; every method that
 * returns a record-or-null returns `null`; void methods resolve. Override
 * individual methods via the `overrides` arg.
 *
 * Imported dynamically from inside `import.meta.vitest` blocks; not used in
 * production code paths.
 */
export type RecordedCall = [keyof GhOps, ...unknown[]]

export function recordingGhOps(overrides: Partial<GhOps> = {}): { gh: GhOps; calls: RecordedCall[] } {
	const calls: RecordedCall[] = []
	const wrap = <K extends keyof GhOps>(name: K, fallback: GhOps[K]): GhOps[K] => {
		const impl = (overrides[name] ?? fallback) as GhOps[K]
		return (async (...args: unknown[]) => {
			calls.push([name, ...args])
			return (impl as (...a: unknown[]) => unknown)(...args)
		}) as GhOps[K]
	}

	const gh: GhOps = {
		detectVersion: wrap('detectVersion', async () => ({ installed: true, version: '0.0.0' })),
		isAuthenticated: wrap('isAuthenticated', async () => true),
		createIssue: wrap('createIssue', async () => 'https://github.com/o/r/issues/0\n'),
		viewIssue: wrap('viewIssue', async () => null),
		getIssueState: wrap('getIssueState', async () => null),
		listIssues: wrap('listIssues', async () => []),
		closeIssue: wrap('closeIssue', async () => undefined),
		reopenIssue: wrap('reopenIssue', async () => undefined),
		editIssueLabels: wrap('editIssueLabels', async () => undefined),
		listSubIssues: wrap('listSubIssues', async () => []),
		getIssueInternalId: wrap('getIssueInternalId', async () => '0'),
		addSubIssue: wrap('addSubIssue', async () => undefined),
		listBlockedBy: wrap('listBlockedBy', async () => []),
		addBlockedBy: wrap('addBlockedBy', async () => undefined),
		removeBlockedBy: wrap('removeBlockedBy', async () => undefined),
		createDraftPr: wrap('createDraftPr', async () => undefined),
		markPrReady: wrap('markPrReady', async () => undefined),
		findPrNumberByHead: wrap('findPrNumberByHead', async () => 0),
		listOpenPrs: wrap('listOpenPrs', async () => []),
		fetchPrLineComments: wrap('fetchPrLineComments', async () => []),
		fetchPrReviews: wrap('fetchPrReviews', async () => []),
		fetchPrThread: wrap('fetchPrThread', async () => []),
	}

	return { gh, calls }
}

if (import.meta.vitest) {
	const { describe, test, expect } = import.meta.vitest

	describe('recordingGhOps', () => {
		test('records each call as [methodName, ...args] and returns the override result', async () => {
			const { gh, calls } = recordingGhOps({
				createIssue: async () => 'https://github.com/o/r/issues/42\n',
			})
			const url = await gh.createIssue({ title: 't', body: 'b', labels: ['prd'] })
			expect(url).toBe('https://github.com/o/r/issues/42\n')
			expect(calls).toEqual([['createIssue', { title: 't', body: 'b', labels: ['prd'] }]])
		})

		test('falls back to a sensible default when no override is given', async () => {
			const { gh } = recordingGhOps()
			expect(await gh.listIssues({ label: 'prd', state: 'open' })).toEqual([])
			expect(await gh.viewIssue('42')).toBeNull()
		})

		test('records calls across multiple methods in invocation order', async () => {
			const { gh, calls } = recordingGhOps()
			await gh.editIssueLabels('7', { add: ['prd'] })
			await gh.closeIssue('7')
			expect(calls.map((c) => c[0])).toEqual(['editIssueLabels', 'closeIssue'])
		})
	})
}
