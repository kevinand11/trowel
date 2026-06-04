import type { HarnessKind } from '../../harnesses/registry.ts'
import type { StorageKind } from '../../storages/registry.ts'
import type { Storage } from '../../storages/types.ts'
import type { LoopEntity } from '../../work/entity-loop.ts'
import { buildLoopWiring } from '../_loop-wiring.ts'

type WorkRuntime = {
	storage: Storage
	runEntity: (entity: LoopEntity) => Promise<void>
	stdout: (s: string) => void
}

async function runWork(id: string, rt: WorkRuntime): Promise<void> {
	const change = await rt.storage.findChange(id)
	if (!change) throw new Error(`Change '${id}' not found`)
	await rt.runEntity({ kind: 'change', id, integrationBranch: change.branch, targetBranch: change.targetBranch, title: change.title })
}

export async function work(id: string, opts: { storage?: StorageKind; harness?: HarnessKind }): Promise<void> {
	try {
		const wiring = await buildLoopWiring(opts)
		await runWork(id, {
			storage: wiring.storage,
			runEntity: wiring.runEntityLoopFor,
			stdout: (s) => process.stdout.write(s),
		})
	} catch (e) {
		process.stderr.write(`trowel change work: ${(e as Error).message}\n`)
		process.exit(1)
	}
}

if (import.meta.vitest) {
	const { describe, test, expect } = import.meta.vitest
	const { fakeSliceStorage } = await import('../../test-utils/storage-fixtures.ts')

	function makeStorage(state: { change?: { id: string; branch: string; targetBranch?: string; title: string } }): Storage {
		return fakeSliceStorage([], null, {
			findChange: async (id) => (state.change && state.change.id === id ? { id, branch: state.change.branch, targetBranch: state.change.targetBranch, title: state.change.title, state: 'OPEN' } : null),
		})
	}

	describe('runWork', () => {
		test('dispatches with the Change\'s integration and target branches', async () => {
			const storage = makeStorage({ change: { id: 'abc123', branch: 'change/abc123-feature', targetBranch: 'release/1.2', title: 'Feature' } })
			const calls: LoopEntity[] = []
			await runWork('abc123', { storage, runEntity: async (e) => { calls.push(e) }, stdout: () => {} })
			expect(calls).toEqual([{ kind: 'change', id: 'abc123', integrationBranch: 'change/abc123-feature', targetBranch: 'release/1.2', title: 'Feature' }])
		})

		test('throws when Change is not found', async () => {
			const storage = makeStorage({})
			await expect(runWork('zzz', { storage, runEntity: async () => {}, stdout: () => {} })).rejects.toThrow(/Change 'zzz' not found/)
		})
	})
}
