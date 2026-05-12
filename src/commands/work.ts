import { buildLoopWiring } from './_loop-wiring.ts'
import type { Backend } from '../backends/types.ts'


export type WorkRuntime = {
	backend: Backend
	runFileLoop: (prdId: string, integrationBranch: string) => Promise<void>
	runIssueLoop: (prdId: string, integrationBranch: string) => Promise<void>
	stdout: (s: string) => void
}

export async function runWork(prdId: string, rt: WorkRuntime): Promise<void> {
	const prd = await rt.backend.findPrd(prdId)
	if (!prd) throw new Error(`PRD '${prdId}' not found`)
	if (rt.backend.name === 'file') {
		await rt.runFileLoop(prdId, prd.branch)
	} else if (rt.backend.name === 'issue') {
		await rt.runIssueLoop(prdId, prd.branch)
	} else {
		throw new Error(`unknown backend: ${rt.backend.name}`)
	}
}

/**
 * Production entry. Wires real gh/git/sandbox callbacks (via _loop-wiring) and calls runWork.
 * The `runAgent` callback inside spawnSandbox is intentionally unimplemented; it needs
 * `@ai-hero/sandcastle` integration (see TODO Section 1, Phase E).
 */
export async function work(prdId: string, opts: { backend?: string }): Promise<void> {
	try {
		const wiring = await buildLoopWiring(opts)
		await runWork(prdId, {
			backend: wiring.backend,
			runFileLoop: wiring.runFileLoopFor,
			runIssueLoop: wiring.runIssueLoopFor,
			stdout: (s) => process.stdout.write(s),
		})
	} catch (e) {
		process.stderr.write(`trowel work: ${(e as Error).message}\n`)
		process.exit(1)
	}
}

if (import.meta.vitest) {
	const { describe, test, expect } = import.meta.vitest

	function makeBackend(name: string, prd: { branch: string; title: string } | null): Backend {
		return {
			name,
			defaultBranchPrefix: '',
			createPrd: async () => ({ id: 'x', branch: 'x' }),
			branchForExisting: async () => 'x',
			findPrd: async (id) => (prd ? { id, branch: prd.branch, title: prd.title, state: 'OPEN' } : null),
			listOpen: async () => [],
			close: async () => {},
			createSlice: async () => {
				throw new Error('not used')
			},
			findSlices: async () => [],
			updateSlice: async () => {},
		}
	}

	describe('runWork', () => {
		test('dispatches to runFileLoop when backend.name is "file", passing prdId + integration branch', async () => {
			const backend = makeBackend('file', { branch: 'prd/abc123-feature', title: 'Feature' })
			const fileCalls: Array<{ prdId: string; branch: string }> = []
			const issueCalls: Array<{ prdId: string; branch: string }> = []
			await runWork('abc123', {
				backend,
				runFileLoop: async (prdId, branch) => {
					fileCalls.push({ prdId, branch })
				},
				runIssueLoop: async (prdId, branch) => {
					issueCalls.push({ prdId, branch })
				},
				stdout: () => {},
			})
			expect(fileCalls).toEqual([{ prdId: 'abc123', branch: 'prd/abc123-feature' }])
			expect(issueCalls).toEqual([])
		})

		test('dispatches to runIssueLoop when backend.name is "issue"', async () => {
			const backend = makeBackend('issue', { branch: 'prds-issue-142', title: 'SSO' })
			const fileCalls: number[] = []
			const issueCalls: Array<{ prdId: string; branch: string }> = []
			await runWork('142', {
				backend,
				runFileLoop: async () => {
					fileCalls.push(1)
				},
				runIssueLoop: async (prdId, branch) => {
					issueCalls.push({ prdId, branch })
				},
				stdout: () => {},
			})
			expect(fileCalls).toEqual([])
			expect(issueCalls).toEqual([{ prdId: '142', branch: 'prds-issue-142' }])
		})

		test('throws when PRD is not found', async () => {
			const backend = makeBackend('file', null)
			await expect(
				runWork('zzz', {
					backend,
					runFileLoop: async () => {},
					runIssueLoop: async () => {},
					stdout: () => {},
				}),
			).rejects.toThrow(/not found/)
		})

		test('throws on unknown backend.name', async () => {
			const backend = makeBackend('mongo', { branch: 'x', title: 'x' })
			await expect(
				runWork('abc', {
					backend,
					runFileLoop: async () => {},
					runIssueLoop: async () => {},
					stdout: () => {},
				}),
			).rejects.toThrow(/unknown backend: mongo/)
		})
	})
}
