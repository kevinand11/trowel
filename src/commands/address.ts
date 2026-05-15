import { buildLoopWiring } from './_loop-wiring.ts'
import type { ClassifiedSlice, Slice, Storage } from '../storages/types.ts'
import { classifySlices } from '../utils/bucket.ts'

export async function address(prdId: string, sliceId: string): Promise<void> {
	try {
		const wiring = await buildLoopWiring({})
		await runAddress(prdId, sliceId, {
			storage: wiring.storage,
			runOnePhase: (slice) => wiring.runOnePhase(prdId, slice, 'address'),
			stderr: (s) => process.stderr.write(s),
		})
	} catch (e) {
		process.stderr.write(`trowel address: ${(e as Error).message}\n`)
		process.exit(1)
	}
}

type AddressRuntime = {
	storage: Storage
	runOnePhase: (slice: Slice) => Promise<void>
	stderr: (s: string) => void
}

async function runAddress(prdId: string, sliceId: string, rt: AddressRuntime): Promise<void> {
	const prd = await rt.storage.findPrd(prdId)
	if (!prd) throw new Error(`PRD '${prdId}' not found`)
	const slice = classifySlices(await rt.storage.findSlices(prdId)).find((s) => s.id === sliceId)
	if (!slice) throw new Error(`slice '${sliceId}' not found in PRD '${prdId}'`)
	if (slice.bucket !== 'needs-revision') {
		throw new Error(
			`slice '${sliceId}' is in bucket '${slice.bucket}', not 'needs-revision'. ` +
				`Addresser only runs against slices flagged for revision.`,
		)
	}
	await rt.runOnePhase(slice)
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
			branchAhead: false,
			...overrides,
		}
	}

	function makeStorage(slices: Slice[]): Storage {
		return {
			createPrd: async () => ({ id: 'x', branch: 'x' }),
			findPrd: async (id) => ({ id, branch: 'b', title: 't', state: 'OPEN' }),
			listPrds: async () => [],
			closePrd: async () => {},
			createSlice: async () => {
				throw new Error('not used')
			},
			findSlices: async () => slices,
			updateSlice: async () => {},
		}
	}

	describe('runAddress', () => {
		test('on a needs-revision slice (issue storage): calls runOnePhase exactly once', async () => {
			const slice = makeSlice({ id: 's1', bucket: 'needs-revision' })
			const storage = makeStorage([slice])
			const calls: Slice[] = []
			await runAddress('p1', 's1', {
				storage,
				runOnePhase: async (s) => {
					calls.push(s)
				},
				stderr: () => {},
			})
			expect(calls).toHaveLength(1)
		})

		test('refuses when slice bucket is not "needs-revision"', async () => {
			const slice = makeSlice({ id: 's1', bucket: 'in-flight', needsRevision: false })
			const storage = makeStorage([slice])
			await expect(runAddress('p1', 's1', { storage, runOnePhase: async () => {}, stderr: () => {} })).rejects.toThrow(
				/bucket 'in-flight'/,
			)
		})
	})
}
