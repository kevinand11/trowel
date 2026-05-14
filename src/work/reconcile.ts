import { sliceBranchFor } from './pr-flow.ts'
import type { PhaseCtx, Slice } from '../storages/types.ts'
import type { GhOps } from '../utils/gh-ops.ts'

/**
 * Heal cross-process drift before each outer-loop iteration's `findSlices`. A slice with
 * `branchAhead && !prState` is one whose implementer pushed but died before `gh pr create`
 * (or whose PR was manually closed without the branch landing). Open the missing draft PR so
 * the next `findSlices` sees `prState: 'draft'` and the loop routes correctly.
 *
 * Pure with respect to storage internals: takes slices as input rather than calling `findSlices`
 * itself. Naturally a no-op when `branchAhead` is `false` for every slice (the loop only enriches
 * `branchAhead` when `config.work.usePrs` is true; otherwise it stays `false`).
 *
 * See ADR `storage-behavior-separation` (step 3 moves this off `Storage`).
 */
export async function reconcileSlices(gh: GhOps, slices: Slice[], ctx: PhaseCtx): Promise<void> {
	for (const slice of slices) {
		if (!slice.branchAhead || slice.prState !== null) continue
		if (slice.state === 'CLOSED' || !slice.readyForAgent) continue
		const branch = sliceBranchFor(ctx.prdId, slice)
		try {
			await gh.createDraftPr({ title: slice.title, head: branch, base: ctx.integrationBranch, body: `Closes #${slice.id}` })
		} catch (e) {
			throw new Error(`gh pr create failed for slice ${slice.id}: ${(e as Error).message}`)
		}
	}
}

if (import.meta.vitest) {
	const { describe, test, expect } = import.meta.vitest
	const { recordingGhOps } = await import('../test-utils/gh-ops-recorder.ts')

	function makeSlice(overrides: Partial<Slice> = {}): Slice {
		return {
			id: '145',
			title: 'Session Middleware',
			body: 'b',
			state: 'OPEN',
			readyForAgent: true,
			needsRevision: false,
			blockedBy: [],
			prState: null,
			branchAhead: false,
			...overrides,
		}
	}

	const ctx: PhaseCtx = {
		prdId: '142',
		integrationBranch: 'prds-issue-142',
		config: { usePrs: true, review: false, perSliceBranches: true },
	}

	describe('reconcileSlices', () => {
		test('opens a draft PR for a slice with branchAhead && !prState (the self-heal case)', async () => {
			const { gh, calls } = recordingGhOps()
			await reconcileSlices(gh, [makeSlice({ branchAhead: true })], ctx)
			expect(calls).toContainEqual([
				'createDraftPr',
				{ title: 'Session Middleware', head: 'prd-142/slice-145-session-middleware', base: 'prds-issue-142', body: 'Closes #145' },
			])
		})

		test('does not open a PR for a slice that already has one (prState !== null)', async () => {
			const { gh, calls } = recordingGhOps()
			await reconcileSlices(gh, [makeSlice({ branchAhead: true, prState: 'draft' })], ctx)
			expect(calls.find((c) => c[0] === 'createDraftPr')).toBeUndefined()
		})

		test('does not open a PR for a slice without commits ahead (branchAhead === false)', async () => {
			const { gh, calls } = recordingGhOps()
			await reconcileSlices(gh, [makeSlice({ branchAhead: false, prState: null })], ctx)
			expect(calls.find((c) => c[0] === 'createDraftPr')).toBeUndefined()
		})

		test("skips CLOSED or !readyForAgent slices (the loop wouldn't touch them anyway)", async () => {
			const { gh, calls } = recordingGhOps()
			await reconcileSlices(
				gh,
				[
					makeSlice({ id: '1', state: 'CLOSED', branchAhead: true }),
					makeSlice({ id: '2', readyForAgent: false, branchAhead: true }),
				],
				ctx,
			)
			expect(calls.find((c) => c[0] === 'createDraftPr')).toBeUndefined()
		})

		test('file-storage shape (branchAhead always false) → never calls gh', async () => {
			const { gh, calls } = recordingGhOps()
			await reconcileSlices(gh, [makeSlice({ branchAhead: false }), makeSlice({ id: '2', branchAhead: false })], ctx)
			expect(calls).toEqual([])
		})

		test('throws when gh pr create fails (the loop surfaces the error)', async () => {
			const { gh } = recordingGhOps({
				createDraftPr: async () => {
					throw new Error('gh down')
				},
			})
			await expect(reconcileSlices(gh, [makeSlice({ branchAhead: true })], ctx)).rejects.toThrow(/slice 145.*gh down/)
		})
	})
}
