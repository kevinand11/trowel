import { buildLoopWiring } from './_loop-wiring.ts'
import type { Storage } from '../storages/types.ts'

type WorkRuntime = {
	storage: Storage
	runLoop: (prdId: string, integrationBranch: string) => Promise<void>
	stdout: (s: string) => void
}

async function runWork (prdId: string, rt: WorkRuntime): Promise<void> {
	const prd = await rt.storage.findPrd(prdId)
	if (!prd) throw new Error(`PRD '${prdId}' not found`)
	await rt.runLoop(prdId, prd.branch)
}

/**
 * Production entry. Wires real gh/git/turn callbacks (via _loop-wiring) and calls runWork.
 */
export async function work(prdId: string, opts: { storage?: string }): Promise<void> {
	try {
		const wiring = await buildLoopWiring(opts)
		await runWork(prdId, {
			storage: wiring.storage,
			runLoop: wiring.runLoopFor,
			stdout: (s) => process.stdout.write(s),
		})
	} catch (e) {
		process.stderr.write(`trowel work: ${(e as Error).message}\n`)
		process.exit(1)
	}
}

if (import.meta.vitest) {
	const { describe, test, expect } = import.meta.vitest

	function makeStorage(name: string, prd: { branch: string; title: string } | null): Storage {
		return {
			name,
			defaultBranchPrefix: '',
			createPrd: async () => ({ id: 'x', branch: 'x' }),
			branchForExisting: async () => 'x',
			findPrd: async (id) => (prd ? { id, branch: prd.branch, title: prd.title, state: 'OPEN' } : null),
			listPrds: async () => [],
			closePrd: async () => {},
			createSlice: async () => {
				throw new Error('not used')
			},
			findSlices: async () => [],
			updateSlice: async () => {},
		}
	}

	describe('runWork', () => {
		test('calls runLoop with prdId and the PRD\'s integration branch (no per-storage dispatch)', async () => {
			const storage = makeStorage('file', { branch: 'prd/abc123-feature', title: 'Feature' })
			const calls: Array<{ prdId: string; branch: string }> = []
			await runWork('abc123', {
				storage,
				runLoop: async (prdId, branch) => {
					calls.push({ prdId, branch })
				},
				stdout: () => {},
			})
			expect(calls).toEqual([{ prdId: 'abc123', branch: 'prd/abc123-feature' }])
		})

		test('also calls runLoop on the issue storage (no per-storage dispatch)', async () => {
			const storage = makeStorage('issue', { branch: 'prds-issue-142', title: 'SSO' })
			const calls: Array<{ prdId: string; branch: string }> = []
			await runWork('142', {
				storage,
				runLoop: async (prdId, branch) => {
					calls.push({ prdId, branch })
				},
				stdout: () => {},
			})
			expect(calls).toEqual([{ prdId: '142', branch: 'prds-issue-142' }])
		})

		test('throws when PRD is not found', async () => {
			const storage = makeStorage('file', null)
			await expect(
				runWork('zzz', {
					storage,
					runLoop: async () => {},
					stdout: () => {},
				}),
			).rejects.toThrow(/not found/)
		})
	})
}
