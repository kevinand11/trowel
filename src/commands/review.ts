import { runManualSliceCommand } from './manual-slice-command.ts'
import type { HarnessKind } from '../harnesses/registry.ts'
import type { StorageKind } from '../storages/registry.ts'
import type { Slice } from '../storages/types.ts'

export async function review(sliceId: string, opts: { storage?: StorageKind; harness?: HarnessKind }): Promise<void> {
	await runManualSliceCommand({
		commandName: 'review',
		sliceId,
		storage: opts.storage,
		harness: opts.harness,
		role: 'review',
		requiredBucket: 'in-flight',
		reason: () => 'Reviewer only runs against slices with an open draft PR.',
	})
}

if (import.meta.vitest) {
	const { describe, test, expect } = import.meta.vitest
	const { recordingGhOps, runSlicePhaseCommand, fakeClassifiedSlice, fakeSliceStorage } = await import('../test-utils/slice-phase-command-fixtures.ts')

	describe('runReview', () => {
		const runReview = (sliceId: string, runtime: Parameters<typeof runSlicePhaseCommand>[0]['runtime']) =>
			runSlicePhaseCommand({
				sliceId,
				runtime,
				requiredBucket: 'in-flight',
				reason: () => 'Reviewer only runs against slices with an open draft PR.',
			})

		test('on an in-flight slice (issue storage): calls runOnePhase exactly once', async () => {
			const slice = fakeClassifiedSlice({ id: 's1', bucket: 'in-flight', prState: 'draft' })
			const storage = fakeSliceStorage([slice])
			const { gh } = recordingGhOps()
			const calls: Slice[] = []
			await runReview('s1', {
				storage,
				gh,
				usePrs: false,
				runOnePhase: async (_prdId, s) => {
					calls.push(s)
				},
			})
			expect(calls).toHaveLength(1)
		})

		test('refuses when slice bucket is not "in-flight"', async () => {
			const slice = fakeClassifiedSlice({ id: 's1', prState: null })
			const storage = fakeSliceStorage([slice])
			const { gh } = recordingGhOps()
			await expect(runReview('s1', { storage, gh, usePrs: false, runOnePhase: async () => {} })).rejects.toThrow(/bucket 'ready'/)
		})
	})
}
