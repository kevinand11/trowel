import type { Storage } from '../storages/types.ts'
import type { GhOps } from '../utils/gh-ops.ts'

/**
 * Identifies the entity to reconcile. PRDs and Fixes both have a single "Close-out PR" against
 * `config.baseBranch`; when that PR shows as merged on GitHub, the storage record flips to
 * CLOSED. See ADR `2026-05-17-fix-entity-unified-close-out.md` and
 * `2026-05-17-reads-acquire-mutation-lock.md`.
 */
export type LoopEntityRef =
	| { kind: 'prd'; id: string; branch: string }
	| { kind: 'fix'; id: string; branch: string }

export type ReconcileDeps = {
	storage: Storage
	gh: GhOps
	log?: (msg: string) => void
}

/**
 * Observe whether the entity's Close-out PR has been merged on GitHub and, if so, write CLOSED
 * to the storage record. Idempotent: re-running on an already-CLOSED entity is a no-op. On gh
 * failures (no remote, no auth) the call quietly does nothing — reconciliation is best-effort and
 * must not crash entity-touching commands.
 */
export async function reconcileEntity(entity: LoopEntityRef, deps: ReconcileDeps): Promise<void> {
	const current = entity.kind === 'prd' ? await deps.storage.findPrd(entity.id) : await deps.storage.findFix(entity.id)
	if (!current || current.state === 'CLOSED') return

	let pr: { number: number; state: 'OPEN' | 'CLOSED' | 'MERGED' } | null
	try {
		pr = await deps.gh.findAnyPrByHead(entity.branch)
	} catch {
		return
	}
	if (!pr || pr.state !== 'MERGED') return

	if (entity.kind === 'prd') await deps.storage.closePrd(entity.id)
	else await deps.storage.closeFix(entity.id)
	deps.log?.(`[reconcile ${entity.kind}-${entity.id}] PR #${pr.number} merged on GitHub → marked CLOSED`)
}

if (import.meta.vitest) {
	const { describe, test, expect } = import.meta.vitest
	const { recordingGhOps } = await import('../test-utils/gh-ops-recorder.ts')

	function fakeStorage(overrides: Partial<Storage>): Storage {
		return {
			createPrd: async () => ({ id: 'x', branch: 'x' }),
			findPrd: async () => null,
			listPrds: async () => [],
			closePrd: async () => {},
			createSlice: async () => { throw new Error('nyi') },
			findSlices: async () => [],
			findSlice: async () => null,
			updateSlice: async () => {},
			createFix: async () => ({ id: 'x', branch: 'x' }),
			findFix: async () => null,
			listFixes: async () => [],
			updateFix: async () => {},
			closeFix: async () => {},
			...overrides,
		}
	}

	describe('reconcileEntity', () => {
		test('PRD: PR merged → closePrd called', async () => {
			let closed: string | null = null
			const storage = fakeStorage({
				findPrd: async (id) => ({ id, branch: 'b', title: 't', state: 'OPEN' }),
				closePrd: async (id) => { closed = id },
			})
			const { gh } = recordingGhOps({
				findAnyPrByHead: async () => ({ number: 7, state: 'MERGED' }),
			})
			await reconcileEntity({ kind: 'prd', id: '42', branch: 'b' }, { storage, gh })
			expect(closed).toBe('42')
		})

		test('Fix: PR merged → closeFix called', async () => {
			let closed: string | null = null
			const storage = fakeStorage({
				findFix: async (id) => ({ id, branch: 'b', title: 't', body: '', state: 'OPEN', readyForAgent: false, needsRevision: false, blockedBy: [], prState: null }),
				closeFix: async (id) => { closed = id },
			})
			const { gh } = recordingGhOps({
				findAnyPrByHead: async () => ({ number: 8, state: 'MERGED' }),
			})
			await reconcileEntity({ kind: 'fix', id: '5', branch: 'b' }, { storage, gh })
			expect(closed).toBe('5')
		})

		test('PR open → no-op', async () => {
			let called = false
			const storage = fakeStorage({
				findFix: async (id) => ({ id, branch: 'b', title: 't', body: '', state: 'OPEN', readyForAgent: false, needsRevision: false, blockedBy: [], prState: null }),
				closeFix: async () => { called = true },
			})
			const { gh } = recordingGhOps({ findAnyPrByHead: async () => ({ number: 9, state: 'OPEN' }) })
			await reconcileEntity({ kind: 'fix', id: '5', branch: 'b' }, { storage, gh })
			expect(called).toBe(false)
		})

		test('no PR exists → no-op', async () => {
			let called = false
			const storage = fakeStorage({
				findPrd: async (id) => ({ id, branch: 'b', title: 't', state: 'OPEN' }),
				closePrd: async () => { called = true },
			})
			const { gh } = recordingGhOps({ findAnyPrByHead: async () => null })
			await reconcileEntity({ kind: 'prd', id: '1', branch: 'b' }, { storage, gh })
			expect(called).toBe(false)
		})

		test('entity already CLOSED → no gh round-trip', async () => {
			let ghCalled = false
			const storage = fakeStorage({
				findFix: async (id) => ({ id, branch: 'b', title: 't', body: '', state: 'CLOSED', readyForAgent: false, needsRevision: false, blockedBy: [], prState: null }),
			})
			const { gh } = recordingGhOps({ findAnyPrByHead: async () => { ghCalled = true; return null } })
			await reconcileEntity({ kind: 'fix', id: '5', branch: 'b' }, { storage, gh })
			expect(ghCalled).toBe(false)
		})

		test('gh throws → swallowed, no close call', async () => {
			let called = false
			const storage = fakeStorage({
				findFix: async (id) => ({ id, branch: 'b', title: 't', body: '', state: 'OPEN', readyForAgent: false, needsRevision: false, blockedBy: [], prState: null }),
				closeFix: async () => { called = true },
			})
			const { gh } = recordingGhOps({ findAnyPrByHead: async () => { throw new Error('no gh') } })
			await reconcileEntity({ kind: 'fix', id: '5', branch: 'b' }, { storage, gh })
			expect(called).toBe(false)
		})
	})
}
