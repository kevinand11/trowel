import { runManualSliceCommand } from './manual-slice-command.ts'
import type { HarnessKind } from '../harnesses/registry.ts'
import type { StorageKind } from '../storages/registry.ts'
import type { Slice } from '../storages/types.ts'

export async function implement(sliceId: string, opts: { storage?: StorageKind; harness?: HarnessKind }): Promise<void> {
	await runManualSliceCommand({
		commandName: 'implement',
		sliceId,
		storage: opts.storage,
		harness: opts.harness,
		role: 'implement',
		requiredBucket: 'ready',
		reason: (prdId) => `Run \`trowel work ${prdId}\` to drive it through the loop, or address it manually.`,
	})
}

if (import.meta.vitest) {
	const { describe, test, expect } = import.meta.vitest
	const { recordingGhOps, runSlicePhaseCommand, fakeClassifiedSlice, fakeSliceStorage } = await import('../test-utils/slice-phase-command-fixtures.ts')

	describe('runImplement', () => {
		const runImplement = (sliceId: string, runtime: Parameters<typeof runSlicePhaseCommand>[0]['runtime']) =>
			runSlicePhaseCommand({
				sliceId,
				runtime,
				requiredBucket: 'ready',
				reason: (prdId) => `Run \`trowel work ${prdId}\` to drive it through the loop, or address it manually.`,
			})

		test('on a ready slice: calls runOnePhase exactly once with that slice', async () => {
			const slice = fakeClassifiedSlice({ id: 's1', bucket: 'ready' })
			const storage = fakeSliceStorage([slice])
			const { gh } = recordingGhOps()
			const calls: Array<{ prdId: string; slice: Slice }> = []
			await runImplement('s1', {
				storage,
				gh,
				usePrs: false,
				runOnePhase: async (prdId, s) => {
					calls.push({ prdId, slice: s })
				},
			})
			expect(calls).toHaveLength(1)
			expect(calls[0]!.slice.id).toBe('s1')
			expect(calls[0]!.prdId).toBe('p1')
		})

		test('throws when slice is not found', async () => {
			const storage = fakeSliceStorage([], null)
			const { gh } = recordingGhOps()
			await expect(runImplement('s1', { storage, gh, usePrs: false, runOnePhase: async () => {} })).rejects.toThrow(/slice 's1' not found/)
		})

		test('usePrs:true refuses to implement a ready storage slice that already has an open PR', async () => {
			const slice = fakeClassifiedSlice({ id: 's1', title: 'Implement A', prState: null, readyForAgent: true })
			const storage = fakeSliceStorage([slice])
			const { gh } = recordingGhOps({
				listOpenPrs: async () => [{ number: 1, headRefName: 'prd-p1/slice-s1-implement-a', isDraft: true }],
			})
			await expect(runImplement('s1', { storage, gh, usePrs: true, runOnePhase: async () => {} })).rejects.toThrow(/bucket 'in-flight'/)
		})

		test('refuses when slice bucket is not "ready", naming the actual bucket', async () => {
			const slice = fakeClassifiedSlice({ id: 's1', bucket: 'draft', readyForAgent: false })
			const storage = fakeSliceStorage([slice])
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
				}),
			).rejects.toThrow(/bucket 'draft'/)
			expect(phaseCalled).toBe(false)
		})
	})
}
