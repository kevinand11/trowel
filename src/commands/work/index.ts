import type { HarnessKind } from '../../harnesses/registry.ts'
import type { StorageKind } from '../../storages/registry.ts'
import type { Storage } from '../../storages/types.ts'
import type { LoopEntity } from '../../work/entity-loop.ts'
import { buildLoopWiring } from '../_loop-wiring.ts'

export type WorkScope = 'change' | 'fix'

type WorkRuntime = {
	storage: Storage
	runEntity: (entity: LoopEntity) => Promise<void>
	stdout: (s: string) => void
}

type WorkHandler = (id: string, rt: WorkRuntime) => Promise<void>

const WORK_HANDLERS: Record<WorkScope, WorkHandler> = {
	change: runChangeWork,
	fix: runFixWork,
}

async function runWork(scope: WorkScope, id: string, rt: WorkRuntime): Promise<void> {
	await WORK_HANDLERS[scope](id, rt)
}

async function runChangeWork(id: string, rt: WorkRuntime): Promise<void> {
	const change = await rt.storage.findChange(id)
	if (!change) throw new Error(`Change '${id}' not found`)
	await rt.runEntity({ kind: 'change', id, integrationBranch: change.branch, targetBranch: change.targetBranch, title: change.title })
}

async function runFixWork(id: string, rt: WorkRuntime): Promise<void> {
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
	const { fakeSliceStorage } = await import('../../test-utils/storage-fixtures.ts')

	function makeStorage(state: { change?: { id: string; branch: string; targetBranch?: string; title: string }; fix?: { id: string; branch: string; targetBranch?: string; title: string } }): Storage {
		return fakeSliceStorage([], null, {
			findChange: async (id) => (state.change && state.change.id === id ? { id, branch: state.change.branch, targetBranch: state.change.targetBranch, title: state.change.title, state: 'OPEN' } : null),
			findFix: async (id) => (state.fix && state.fix.id === id ? { id, branch: state.fix.branch, targetBranch: state.fix.targetBranch, title: state.fix.title, body: '', state: 'OPEN', readyForAgent: false, needsRevision: false, blockedBy: [], prState: null } : null),
		})
	}

	describe('runWork', () => {
		test('change scope dispatches with the Change\'s integration and target branches', async () => {
			const storage = makeStorage({ change: { id: 'abc123', branch: 'change/abc123-feature', targetBranch: 'release/1.2', title: 'Feature' } })
			const calls: LoopEntity[] = []
			await runWork('change', 'abc123', { storage, runEntity: async (e) => { calls.push(e) }, stdout: () => {} })
			expect(calls).toEqual([{ kind: 'change', id: 'abc123', integrationBranch: 'change/abc123-feature', targetBranch: 'release/1.2', title: 'Feature' }])
		})

		test('fix scope dispatches with the Fix branch and target branch', async () => {
			const storage = makeStorage({ fix: { id: '5', branch: 'fix/5-x', targetBranch: 'hotfix/base', title: 'X' } })
			const calls: LoopEntity[] = []
			await runWork('fix', '5', { storage, runEntity: async (e) => { calls.push(e) }, stdout: () => {} })
			expect(calls).toEqual([{ kind: 'fix', id: '5', branch: 'fix/5-x', targetBranch: 'hotfix/base', title: 'X' }])
		})

		test('throws when Change is not found', async () => {
			const storage = makeStorage({})
			await expect(runWork('change', 'zzz', { storage, runEntity: async () => {}, stdout: () => {} })).rejects.toThrow(/Change 'zzz' not found/)
		})

		test('throws when Fix is not found', async () => {
			const storage = makeStorage({})
			await expect(runWork('fix', 'zzz', { storage, runEntity: async () => {}, stdout: () => {} })).rejects.toThrow(/Fix 'zzz' not found/)
		})
	})
}
