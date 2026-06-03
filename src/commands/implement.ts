import { buildLoopWiring } from './_loop-wiring.ts'
import type { HarnessKind } from '../harnesses/registry.ts'
import type { StorageKind } from '../storages/registry.ts'
import type { ClassifiedSlice, Slice, Storage } from '../storages/types.ts'
import type { GhOps } from '../utils/gh-ops.ts'
import { classifySlicesForPrd } from '../work/slice-buckets.ts'


type ImplementRuntime = {
	storage: Storage
	gh: GhOps
	usePrs: boolean
	runOnePhase: (prdId: string, slice: Slice) => Promise<void>
	stderr: (s: string) => void
}

export async function implement(sliceId: string, opts: { storage?: StorageKind; harness?: HarnessKind }): Promise<void> {
	try {
		const wiring = await buildLoopWiring({ storage: opts.storage, harness: opts.harness })
		await runImplement(sliceId, {
			storage: wiring.storage,
			gh: wiring.gh,
			usePrs: wiring.config.work.usePrs,
			runOnePhase: (prdId, slice) => wiring.runOnePhase(prdId, slice, 'implement'),
			stderr: (s) => process.stderr.write(s),
		})
	} catch (e) {
		process.stderr.write(`trowel implement: ${(e as Error).message}\n`)
		process.exit(1)
	}
}

async function runImplement(sliceId: string, rt: ImplementRuntime): Promise<void> {
	const hit = await rt.storage.findSlice(sliceId)
	if (!hit) throw new Error(`slice '${sliceId}' not found`)
	const { prdId } = hit
	const slice = (await classifySlicesForPrd({ storage: rt.storage, gh: rt.gh, prdId, usePrs: rt.usePrs })).find((s) => s.id === sliceId)
	if (!slice) throw new Error(`slice '${sliceId}' disappeared between findSlice and findSlices`)
	if (slice.bucket !== 'ready') {
		throw new Error(
			`slice '${sliceId}' is in bucket '${slice.bucket}', not 'ready'. ` +
				`Run \`trowel work ${prdId}\` to drive it through the loop, or address it manually.`,
		)
	}
	await rt.runOnePhase(prdId, slice)
}

if (import.meta.vitest) {
	const { describe, test, expect } = import.meta.vitest
	const { recordingGhOps } = await import('../test-utils/gh-ops-recorder.ts')

	function makeSlice(overrides: Partial<ClassifiedSlice> = {}): ClassifiedSlice {
		return {
			id: 's1',
			title: 'Implement A',
			body: 'spec',
			state: 'OPEN',
			readyForAgent: true,
			needsRevision: false,
			bucket: 'ready',
			blockedBy: [],
			prState: null,
			...overrides,
		}
	}

	function makeStorage(slices: Slice[], prdId: string | null = 'p1'): Storage {
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
				if (prdId === null) return null
				const s = sliceById.get(sliceId)
				return s ? { prdId, slice: s } : null
			},
			updateSlice: async () => {},
			createFix: async () => ({ id: 'x', branch: 'x' }),
			findFix: async () => null,
			listFixes: async () => [],
			updateFix: async () => {},
			closeFix: async () => {},
		}
	}

	describe('runImplement', () => {
		test('on a ready slice: calls runOnePhase exactly once with that slice', async () => {
			const slice = makeSlice({ id: 's1', bucket: 'ready' })
			const storage = makeStorage([slice])
			const { gh } = recordingGhOps()
			const calls: Array<{ prdId: string; slice: Slice }> = []
			await runImplement('s1', {
				storage,
				gh,
				usePrs: false,
				runOnePhase: async (prdId, s) => {
					calls.push({ prdId, slice: s })
				},
				stderr: () => {},
			})
			expect(calls).toHaveLength(1)
			expect(calls[0]!.slice.id).toBe('s1')
			expect(calls[0]!.prdId).toBe('p1')
		})

		test('throws when slice is not found', async () => {
			const storage = makeStorage([], null)
			const { gh } = recordingGhOps()
			await expect(
				runImplement('s1', { storage, gh, usePrs: false, runOnePhase: async () => {}, stderr: () => {} }),
			).rejects.toThrow(/slice 's1' not found/)
		})

		test('usePrs:true refuses to implement a ready storage slice that already has an open PR', async () => {
			const slice = makeSlice({ id: 's1', title: 'Implement A', prState: null, readyForAgent: true })
			const storage = makeStorage([slice])
			const { gh } = recordingGhOps({
				listOpenPrs: async () => [{ number: 1, headRefName: 'prd-p1/slice-s1-implement-a', isDraft: true }],
			})
			await expect(runImplement('s1', { storage, gh, usePrs: true, runOnePhase: async () => {}, stderr: () => {} })).rejects.toThrow(/bucket 'in-flight'/)
		})

		test('refuses when slice bucket is not "ready", naming the actual bucket', async () => {
			const slice = makeSlice({ id: 's1', bucket: 'draft', readyForAgent: false })
			const storage = makeStorage([slice])
			let phaseCalled = false
			const { gh } = recordingGhOps()
			await expect(
				runImplement('s1', {
					storage,
					gh,
					usePrs: false,
					runOnePhase: async () => {
						phaseCalled = true
					},
					stderr: () => {},
				}),
			).rejects.toThrow(/bucket 'draft'/)
			expect(phaseCalled).toBe(false)
		})
	})
}
