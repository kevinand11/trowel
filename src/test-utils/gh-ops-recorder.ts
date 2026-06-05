import { DEFAULT_GH_OPS } from './gh-ops-defaults.ts'
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
	const gh = Object.fromEntries(ghOpNames().map((name) => [name, recordedGhMethod(name, calls, overrides)])) as GhOps
	return { gh, calls }
}

function ghOpNames(): Array<keyof GhOps> {
	return Object.keys(DEFAULT_GH_OPS) as Array<keyof GhOps>
}

function recordedGhMethod<K extends keyof GhOps>(name: K, calls: RecordedCall[], overrides: Partial<GhOps>): GhOps[K] {
	const impl = (overrides[name] ?? DEFAULT_GH_OPS[name]) as GhOps[K]
	return (async (...args: unknown[]) => {
		calls.push([name, ...args])
		return (impl as (...a: unknown[]) => unknown)(...args)
	}) as GhOps[K]
}

if (import.meta.vitest) {
	const { describe, test, expect } = import.meta.vitest

	describe('recordingGhOps', () => {
		test('records each call as [methodName, ...args] and returns the override result', async () => {
			const issue = { number: 42, internalId: 4200, title: 't', url: 'https://github.com/o/r/issues/42' }
			const { gh, calls } = recordingGhOps({
				createIssue: async () => issue,
			})
			const out = await gh.createIssue({ title: 't', body: 'b', labels: ['change'] })
			expect(out).toBe(issue)
			expect(calls).toEqual([['createIssue', { title: 't', body: 'b', labels: ['change'] }]])
		})

		test('falls back to a sensible default when no override is given', async () => {
			const { gh } = recordingGhOps()
			expect(await gh.listIssues({ label: 'change', state: 'open' })).toEqual([])
			expect(await gh.viewIssue(42)).toMatchObject({ internalId: 0, number: 0, state: 'open' })
		})

		test('records calls across multiple methods in invocation order', async () => {
			const { gh, calls } = recordingGhOps()
			await gh.editIssueLabels(7, { add: ['change'] })
			await gh.closeIssue(7)
			expect(calls.map((c) => c[0])).toEqual(['editIssueLabels', 'closeIssue'])
		})
	})
}
