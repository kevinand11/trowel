import { openDraftPr } from './pr-flow.ts'
import type { PhaseCtx, Slice } from '../storages/types.ts'
import type { GhRunner } from '../utils/gh-runner.ts'
import { slug as slugify } from '../utils/slug.ts'

/**
 * Heal cross-process drift before each outer-loop iteration's `findSlices`. A slice with
 * `branchAhead && !prState` is one whose implementer pushed but died before `gh pr create`
 * (or whose PR was manually closed without the branch landing). Open the missing draft PR so
 * the next `findSlices` sees `prState: 'draft'` and the loop routes correctly.
 *
 * Pure with respect to storage internals: takes slices as input rather than calling `findSlices`
 * itself. Naturally a no-op on file-storage slices (their `branchAhead` is always `false`),
 * so no capability check is needed yet — that arrives in step 4 via `storage.capabilities.prFlow`.
 *
 * See ADR `storage-behavior-separation` (step 3 moves this off `Storage`).
 */
export async function reconcileSlices(gh: GhRunner, slices: Slice[], ctx: PhaseCtx): Promise<void> {
	for (const slice of slices) {
		if (!slice.branchAhead || slice.prState !== null) continue
		if (slice.state === 'CLOSED' || !slice.readyForAgent) continue
		const sliceBranch = `prd-${ctx.prdId}/slice-${slice.id}-${slugify(slice.title)}`
		try {
			await openDraftPr(gh, slice, sliceBranch, ctx.integrationBranch)
		} catch (e) {
			throw new Error(`gh pr create failed for slice ${slice.id}: ${(e as Error).message}`)
		}
	}
}

if (import.meta.vitest) {
	const { describe, test, expect } = import.meta.vitest

	type Call = string[]
	function recordingGh(): { gh: GhRunner; calls: Call[] } {
		const calls: Call[] = []
		const gh: GhRunner = async (args) => {
			calls.push(args)
			return { ok: true, stdout: '', stderr: '' }
		}
		return { gh, calls }
	}

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
			const { gh, calls } = recordingGh()
			await reconcileSlices(gh, [makeSlice({ branchAhead: true })], ctx)
			expect(calls).toContainEqual([
				'pr', 'create', '--draft',
				'--title', 'Session Middleware',
				'--head', 'prd-142/slice-145-session-middleware',
				'--base', 'prds-issue-142',
				'--body', 'Closes #145',
			])
		})

		test('does not open a PR for a slice that already has one (prState !== null)', async () => {
			const { gh, calls } = recordingGh()
			await reconcileSlices(gh, [makeSlice({ branchAhead: true, prState: 'draft' })], ctx)
			expect(calls.find((c) => c[0] === 'pr' && c[1] === 'create')).toBeUndefined()
		})

		test('does not open a PR for a slice without commits ahead (branchAhead === false)', async () => {
			const { gh, calls } = recordingGh()
			await reconcileSlices(gh, [makeSlice({ branchAhead: false, prState: null })], ctx)
			expect(calls.find((c) => c[0] === 'pr' && c[1] === 'create')).toBeUndefined()
		})

		test("skips CLOSED or !readyForAgent slices (the loop wouldn't touch them anyway)", async () => {
			const { gh, calls } = recordingGh()
			await reconcileSlices(
				gh,
				[
					makeSlice({ id: '1', state: 'CLOSED', branchAhead: true }),
					makeSlice({ id: '2', readyForAgent: false, branchAhead: true }),
				],
				ctx,
			)
			expect(calls.find((c) => c[0] === 'pr' && c[1] === 'create')).toBeUndefined()
		})

		test('file-storage shape (branchAhead always false) → never calls gh', async () => {
			const { gh, calls } = recordingGh()
			await reconcileSlices(gh, [makeSlice({ branchAhead: false }), makeSlice({ id: '2', branchAhead: false })], ctx)
			expect(calls).toEqual([])
		})

		test('throws when gh pr create fails (the loop surfaces the error)', async () => {
			const gh: GhRunner = async () => ({ ok: false, error: new Error('gh down') })
			await expect(reconcileSlices(gh, [makeSlice({ branchAhead: true })], ctx)).rejects.toThrow(/slice 145.*gh down/)
		})
	})
}
