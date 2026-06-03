import { buildLoopWiring } from './_loop-wiring.ts'
import type { HarnessKind } from '../harnesses/registry.ts'
import type { StorageKind } from '../storages/registry.ts'
import type { Storage } from '../storages/types.ts'
import type { LoopEntity } from '../work/entity-loop.ts'

export type WorkScope = 'prd' | 'fix'

type WorkRuntime = {
	storage: Storage
	runEntity: (entity: LoopEntity) => Promise<void>
	stdout: (s: string) => void
}

async function runWork(scope: WorkScope, id: string, rt: WorkRuntime): Promise<void> {
	if (scope === 'prd') {
		const prd = await rt.storage.findPrd(id)
		if (!prd) throw new Error(`PRD '${id}' not found`)
		await rt.runEntity({ kind: 'prd', id, integrationBranch: prd.branch, targetBranch: prd.targetBranch, title: prd.title })
		return
	}
	const fix = await rt.storage.findFix(id)
	if (!fix) throw new Error(`Fix '${id}' not found`)
	await rt.runEntity({ kind: 'fix', id, branch: fix.branch, targetBranch: fix.targetBranch, title: fix.title })
}

export async function work(scope: WorkScope, id: string, opts: { storage?: StorageKind; harness?: HarnessKind }): Promise<void> {
	try {
		const wiring = await buildLoopWiring(opts)
		await runWork(scope, id, {
			storage: wiring.storage,
			runEntity: wiring.runEntityLoopFor,
			stdout: (s) => process.stdout.write(s),
		})
	} catch (e) {
		process.stderr.write(`trowel work: ${(e as Error).message}\n`)
		process.exit(1)
	}
}

if (import.meta.vitest) {
	const { describe, test, expect } = import.meta.vitest

	function makeStorage(state: { prd?: { id: string; branch: string; targetBranch?: string; title: string }; fix?: { id: string; branch: string; targetBranch?: string; title: string } }): Storage {
		return {
			createPrd: async () => ({ id: 'x', branch: 'x' }),
			findPrd: async (id) => (state.prd && state.prd.id === id ? { id, branch: state.prd.branch, targetBranch: state.prd.targetBranch, title: state.prd.title, state: 'OPEN' } : null),
			listPrds: async () => [],
			closePrd: async () => {},
			createSlice: async () => { throw new Error('not used') },
			findSlices: async () => [],
			findSlice: async () => null,
			updateSlice: async () => {},
			createFix: async () => ({ id: 'x', branch: 'x' }),
			findFix: async (id) => (state.fix && state.fix.id === id ? { id, branch: state.fix.branch, targetBranch: state.fix.targetBranch, title: state.fix.title, body: '', state: 'OPEN', readyForAgent: false, needsRevision: false, blockedBy: [], prState: null } : null),
			listFixes: async () => [],
			updateFix: async () => {},
			closeFix: async () => {},
		}
	}

	describe('runWork', () => {
		test('prd scope dispatches with the PRD\'s integration and target branches', async () => {
			const storage = makeStorage({ prd: { id: 'abc123', branch: 'prd/abc123-feature', targetBranch: 'release/1.2', title: 'Feature' } })
			const calls: LoopEntity[] = []
			await runWork('prd', 'abc123', { storage, runEntity: async (e) => { calls.push(e) }, stdout: () => {} })
			expect(calls).toEqual([{ kind: 'prd', id: 'abc123', integrationBranch: 'prd/abc123-feature', targetBranch: 'release/1.2', title: 'Feature' }])
		})

		test('fix scope dispatches with the Fix branch and target branch', async () => {
			const storage = makeStorage({ fix: { id: '5', branch: 'fix/5-x', targetBranch: 'hotfix/base', title: 'X' } })
			const calls: LoopEntity[] = []
			await runWork('fix', '5', { storage, runEntity: async (e) => { calls.push(e) }, stdout: () => {} })
			expect(calls).toEqual([{ kind: 'fix', id: '5', branch: 'fix/5-x', targetBranch: 'hotfix/base', title: 'X' }])
		})

		test('throws when PRD is not found', async () => {
			const storage = makeStorage({})
			await expect(runWork('prd', 'zzz', { storage, runEntity: async () => {}, stdout: () => {} })).rejects.toThrow(/PRD 'zzz' not found/)
		})

		test('throws when Fix is not found', async () => {
			const storage = makeStorage({})
			await expect(runWork('fix', 'zzz', { storage, runEntity: async () => {}, stdout: () => {} })).rejects.toThrow(/Fix 'zzz' not found/)
		})
	})
}
