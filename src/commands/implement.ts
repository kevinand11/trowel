import { runManualSliceCommand } from './manual-slice-command.ts'
import type { HarnessKind } from '../harnesses/registry.ts'
import type { StorageKind } from '../storages/registry.ts'
import type { Slice } from '../storages/types.ts'
import type { PhaseDeps } from '../work/phases.ts'

export async function implement(sliceId: string, opts: { storage?: StorageKind; harness?: HarnessKind }): Promise<void> {
	await runManualSliceCommand({
		commandName: 'implement',
		sliceId,
		storage: opts.storage,
		harness: opts.harness,
		role: 'implement',
		requiredState: 'open',
		reason: (changeId) => `Run \`trowel work ${changeId}\` to drive it through the loop, or implement it manually.`,
	})
}

if (import.meta.vitest) {
	const { describe, test, expect } = import.meta.vitest
	const { recordingGhOps, runSlicePhaseCommand, fakeClassifiedSlice, fakeSliceStorage } = await import('../test-utils/slice-phase-command-fixtures.ts')
	const { setupLocalSliceMergeFixture } = await import('../test-utils/local-merge-fixtures.ts')
	const { landImplement, prepareImplement } = await import('../work/phases.ts')

	describe('runImplement', () => {
		const runImplement = (sliceId: string, runtime: Parameters<typeof runSlicePhaseCommand>[0]['runtime']) =>
			runSlicePhaseCommand({
				sliceId,
				runtime,
				requiredState: 'open',
				reason: (changeId) => `Run \`trowel work ${changeId}\` to drive it through the loop, or implement it manually.`,
			})

		test('on a ready slice: calls runOnePhase exactly once with that slice', async () => {
			const slice = fakeClassifiedSlice({ id: 's1', state: 'open' })
			const storage = fakeSliceStorage([slice])
			const { gh } = recordingGhOps()
			const calls: Array<{ changeId: string; slice: Slice }> = []
			await runImplement('s1', {
				storage,
				gh,
				usePrs: false,
				runOnePhase: async (changeId, s) => {
					calls.push({ changeId, slice: s })
				},
			})
			expect(calls).toHaveLength(1)
			expect(calls[0]!.slice.id).toBe('s1')
			expect(calls[0]!.changeId).toBe('p1')
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
				listOpenPrs: async () => [{ number: 1, headRefName: 'change-p1/slice-s1-implement-a', isDraft: true }],
			})
			await expect(runImplement('s1', { storage, gh, usePrs: true, runOnePhase: async () => {} })).rejects.toThrow(/state 'in-flight'/)
		})

		test('refuses when slice state is not "open", naming the actual state', async () => {
			const slice = fakeClassifiedSlice({ id: 's1', state: 'draft', readyForAgent: false })
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
			).rejects.toThrow(/state 'draft'/)
			expect(phaseCalled).toBe(false)
		})

		test('trowel slice implement keeps the user\'s main checkout on the starting branch during local slice host merges', async () => {
			const fixture = await setupLocalSliceMergeFixture()
			try {
				const { gh } = recordingGhOps()
				const logs: string[] = []

				await runImplement('s1', {
					storage: fixture.storage,
					gh,
					usePrs: false,
					runOnePhase: async (changeId, slice) => {
						const ctx = { changeId, changeBranch: fixture.state.change.changeBranch, config: { usePrs: false, audit: false, perSliceBranches: true } }
						const deps: PhaseDeps = { storage: fixture.storage, git: fixture.git, gh, log: (msg) => logs.push(msg), mergeNoVerify: false, projectRoot: fixture.projectRoot }
						const prep = await prepareImplement(deps, slice, ctx)
						await fixture.commitOnBranch(prep.branch, 'manual.txt', 'manual\n')
						await landImplement(deps, slice, { verdict: 'ready', commits: 1 }, ctx)
					},
				})

				expect(await fixture.currentBranch()).toBe('main')
				expect(fixture.state.slice.implementedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
				expect(fixture.state.slice.closedAt).toBeNull()
				expect(logs.join('\n')).toContain('recorded implementedAt')
			} finally {
				await fixture.cleanup()
			}
		})
	})
}
