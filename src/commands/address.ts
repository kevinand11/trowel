import { runManualSliceCommand } from './manual-slice-command.ts'
import type { HarnessKind } from '../harnesses/registry.ts'
import type { StorageKind } from '../storages/registry.ts'
import type { Slice } from '../storages/types.ts'

export async function address(sliceId: string, opts: { storage?: StorageKind; harness?: HarnessKind }): Promise<void> {
	await runManualSliceCommand({
		commandName: 'address',
		sliceId,
		storage: opts.storage,
		harness: opts.harness,
		role: 'address',
		requiredBucket: 'needs-revision',
		reason: () => 'Addresser only runs against slices flagged for revision.',
	})
}

if (import.meta.vitest) {
	const { describe, test, expect } = import.meta.vitest
	const { recordingGhOps } = await import('../test-utils/gh-ops-recorder.ts')
	const { runSlicePhaseCommand } = await import('./slice-phase-command.ts')
	const { fakeClassifiedSlice, fakeSliceStorage } = await import('../test-utils/storage-fixtures.ts')

	describe('runAddress', () => {
		const runAddress = (sliceId: string, runtime: Parameters<typeof runSlicePhaseCommand>[0]['runtime']) =>
			runSlicePhaseCommand({
				sliceId,
				runtime,
				requiredBucket: 'needs-revision',
				reason: () => 'Addresser only runs against slices flagged for revision.',
			})

		test('on a needs-revision slice (issue storage): calls runOnePhase exactly once', async () => {
			const slice = fakeClassifiedSlice({ id: 's1', bucket: 'needs-revision', needsRevision: true, prState: 'draft' })
			const storage = fakeSliceStorage([slice])
			const { gh } = recordingGhOps()
			const calls: Slice[] = []
			await runAddress('s1', {
				storage,
				gh,
				usePrs: false,
				runOnePhase: async (_prdId, s) => {
					calls.push(s)
				},
			})
			expect(calls).toHaveLength(1)
		})

		test('refuses when slice bucket is not "needs-revision"', async () => {
			const slice = fakeClassifiedSlice({ id: 's1', bucket: 'in-flight', needsRevision: false, prState: 'draft' })
			const storage = fakeSliceStorage([slice])
			const { gh } = recordingGhOps()
			await expect(runAddress('s1', { storage, gh, usePrs: false, runOnePhase: async () => {} })).rejects.toThrow(/bucket 'in-flight'/)
		})
	})
}
