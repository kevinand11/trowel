import { runManualSliceCommand } from './manual-slice-command.ts'
import type { HarnessKind } from '../harnesses/registry.ts'
import type { StorageKind } from '../storages/registry.ts'

export async function review(sliceId: string, opts: { storage?: StorageKind; harness?: HarnessKind }): Promise<void> {
	await runManualSliceCommand({
		commandName: 'review',
		sliceId,
		storage: opts.storage,
		harness: opts.harness,
		role: 'review',
		requiredState: 'needs-revision',
		reason: () => 'Reviewer only runs against slices with PR review feedback marked needs-revision.',
	})
}

if (import.meta.vitest) {
	const { describe, test, expect } = import.meta.vitest
	const { recordingGhOps, runSlicePhaseCommand, fakeClassifiedSlice, fakeSliceStorage, collectRunOnePhaseSlices } = await import('../test-utils/slice-phase-command-fixtures.ts')

	describe('runReview', () => {
		const runReview = (sliceId: string, runtime: Parameters<typeof runSlicePhaseCommand>[0]['runtime']) =>
			runSlicePhaseCommand({
				sliceId,
				runtime,
				requiredState: 'needs-revision',
				reason: () => 'Reviewer only runs against slices with PR review feedback marked needs-revision.',
			})

		test('on a needs-revision slice: calls runOnePhase exactly once', async () => {
			const calls = await collectRunOnePhaseSlices(runReview, fakeClassifiedSlice({ id: 's1', state: 'needs-revision', needsRevision: true, prState: 'ready' }))
			expect(calls).toHaveLength(1)
		})

		test('refuses when slice state is not "needs-revision"', async () => {
			const slice = fakeClassifiedSlice({ id: 's1', prState: null })
			const storage = fakeSliceStorage([slice])
			const { gh } = recordingGhOps()
			await expect(runReview('s1', { storage, gh, usePrs: false, runOnePhase: async () => {} })).rejects.toThrow(/state 'open'/)
		})
	})
}
