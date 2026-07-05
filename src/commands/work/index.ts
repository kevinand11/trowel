import type { HarnessKind } from '../../harnesses/registry.ts'
import type { Storage } from '../../storages/types.ts'
import type { LoopEntity } from '../../work/entity-loop.ts'
import { buildLoopWiring } from '../_loop-wiring.ts'

type WorkRuntime = {
	storage: Storage
	runEntity: (entity: LoopEntity, opts?: { loop?: boolean }) => Promise<void>
	stdout: (s: string) => void
}

type ProjectWorkRuntime = {
	runProject: (opts?: { loop?: boolean }) => Promise<void>
}

async function runWork(id: string, rt: WorkRuntime, opts: { loop?: boolean } = {}): Promise<void> {
	const change = await rt.storage.findChange(id)
	if (!change) throw new Error(`Change '${id}' not found`)
	await rt.runEntity({ kind: 'change', id, changeBranch: change.changeBranch, targetBranch: change.targetBranch, title: change.title }, { loop: opts.loop })
}

async function runProjectWork(rt: ProjectWorkRuntime, opts: { loop?: boolean } = {}): Promise<void> {
	await rt.runProject({ loop: opts.loop })
}

export async function changeWork(id: string | undefined, opts: { storage?: string; harness?: HarnessKind; loop?: boolean }): Promise<void> {
	try {
		const wiring = await buildLoopWiring(opts)
		if (id) {
			await runWork(id, {
				storage: wiring.storage,
				runEntity: wiring.runEntityLoopFor,
				stdout: (s) => process.stdout.write(s),
			}, { loop: opts.loop })
			return
		}
		await runProjectWork({ runProject: wiring.runProjectLoop }, { loop: opts.loop })
	} catch (e) {
		process.stderr.write(`trowel change work: ${(e as Error).message}\n`)
		process.exit(1)
	}
}

if (import.meta.vitest) {
	const { describe, test, expect } = import.meta.vitest
	const { fakeSliceStorage } = await import('../../test-utils/storage-fixtures.ts')

	function makeStorage(state: { change?: { id: string; changeBranch: string; targetBranch: string; title: string } }): Storage {
		return fakeSliceStorage([], null, {
			findChange: async (id) => state.change && state.change.id === id
				? {
					id,
					title: state.change.title,
					body: '',
					createdAt: '2026-01-01T00:00:00.000Z',
					closedAt: null,
					targetBranch: state.change.targetBranch,
					changeBranch: state.change.changeBranch,
				}
				: null,
		})
	}

	describe('runWork', () => {
		test('dispatches with the Change\'s Change and target branches', async () => {
			const storage = makeStorage({ change: { id: 'abc123', changeBranch: 'change/abc123-feature', targetBranch: 'release/1.2', title: 'Feature' } })
			const calls: LoopEntity[] = []
			await runWork('abc123', { storage, runEntity: async (e) => { calls.push(e) }, stdout: () => {} })
			expect(calls).toEqual([{ kind: 'change', id: 'abc123', changeBranch: 'change/abc123-feature', targetBranch: 'release/1.2', title: 'Feature' }])
		})

		test('passes loop mode to the entity loop', async () => {
			const storage = makeStorage({ change: { id: 'abc123', changeBranch: 'change/abc123-feature', targetBranch: 'release/1.2', title: 'Feature' } })
			const options: Array<{ loop?: boolean } | undefined> = []
			await runWork('abc123', { storage, runEntity: async (_e, opts) => { options.push(opts) }, stdout: () => {} }, { loop: true })
			expect(options).toEqual([{ loop: true }])
		})

		test('throws when Change is not found', async () => {
			const storage = makeStorage({})
			await expect(runWork('zzz', { storage, runEntity: async () => {}, stdout: () => {} })).rejects.toThrow(/Change 'zzz' not found/)
		})
	})

	describe('runProjectWork', () => {
		test('passes loop mode to the project loop', async () => {
			const options: Array<{ loop?: boolean } | undefined> = []
			await runProjectWork({ runProject: async (opts) => { options.push(opts) } }, { loop: true })
			expect(options).toEqual([{ loop: true }])
		})
	})
}
