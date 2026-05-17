import { buildLoopWiring } from './_loop-wiring.ts'
import type { HarnessKind } from '../harnesses/registry.ts'
import type { StorageKind } from '../storages/registry.ts'
import type { ClassifiedSlice, Slice, Storage } from '../storages/types.ts'
import { classifySlices } from '../utils/bucket.ts'

export async function address(sliceId: string, opts: { storage?: StorageKind; harness?: HarnessKind }): Promise<void> {
	try {
		const wiring = await buildLoopWiring({ storage: opts.storage, harness: opts.harness })
		await runAddress(sliceId, {
			storage: wiring.storage,
			runOnePhase: (prdId, slice) => wiring.runOnePhase(prdId, slice, 'address'),
			stderr: (s) => process.stderr.write(s),
		})
	} catch (e) {
		process.stderr.write(`trowel address: ${(e as Error).message}\n`)
		process.exit(1)
	}
}

type AddressRuntime = {
	storage: Storage
	runOnePhase: (prdId: string, slice: Slice) => Promise<void>
	stderr: (s: string) => void
}

async function runAddress(sliceId: string, rt: AddressRuntime): Promise<void> {
	const hit = await rt.storage.findSlice(sliceId)
	if (!hit) throw new Error(`slice '${sliceId}' not found`)
	const { prdId } = hit
	const slice = classifySlices(await rt.storage.findSlices(prdId)).find((s) => s.id === sliceId)
	if (!slice) throw new Error(`slice '${sliceId}' disappeared between findSlice and findSlices`)
	if (slice.bucket !== 'needs-revision') {
		throw new Error(
			`slice '${sliceId}' is in bucket '${slice.bucket}', not 'needs-revision'. ` +
				`Addresser only runs against slices flagged for revision.`,
		)
	}
	await rt.runOnePhase(prdId, slice)
}

if (import.meta.vitest) {
	const { describe, test, expect } = import.meta.vitest

	function makeSlice(overrides: Partial<ClassifiedSlice> = {}): ClassifiedSlice {
		return {
			id: 's1',
			title: 'Implement A',
			body: 'spec',
			state: 'OPEN',
			readyForAgent: true,
			needsRevision: true,
			bucket: 'needs-revision',
			blockedBy: [],
			prState: 'draft',
			...overrides,
		}
	}

	function makeStorage(slices: Slice[]): Storage {
		const sliceById = new Map(slices.map((s) => [s.id, s]))
		return {
			createPrd: async () => ({ id: 'x', branch: 'x' }),
			findPrd: async (id) => ({ id, branch: 'b', title: 't', state: 'OPEN' }),
			listPrds: async () => [],
			closePrd: async () => {},
			createSlice: async () => {
				throw new Error('not used')
			},
			findSlices: async () => slices,
			findSlice: async (sliceId) => {
				const s = sliceById.get(sliceId)
				return s ? { prdId: 'p1', slice: s } : null
			},
			updateSlice: async () => {},
		}
	}

	describe('runAddress', () => {
		test('on a needs-revision slice (issue storage): calls runOnePhase exactly once', async () => {
			const slice = makeSlice({ id: 's1', bucket: 'needs-revision' })
			const storage = makeStorage([slice])
			const calls: Slice[] = []
			await runAddress('s1', {
				storage,
				runOnePhase: async (_prdId, s) => {
					calls.push(s)
				},
				stderr: () => {},
			})
			expect(calls).toHaveLength(1)
		})

		test('refuses when slice bucket is not "needs-revision"', async () => {
			const slice = makeSlice({ id: 's1', bucket: 'in-flight', needsRevision: false })
			const storage = makeStorage([slice])
			await expect(runAddress('s1', { storage, runOnePhase: async () => {}, stderr: () => {} })).rejects.toThrow(
				/bucket 'in-flight'/,
			)
		})
	})
}
