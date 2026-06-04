import type { Storage } from '../storages/types.ts'
import type { GhOps } from '../utils/gh-ops.ts'

/**
 * Identifies the entity to reconcile. Changes and Fixes both have a single "Close-out PR" against
 * their targetBranch; when that PR shows as merged on GitHub, the storage record flips to CLOSED.
 * See ADR `2026-05-17-fix-entity-unified-close-out.md`,
 * `2026-05-17-reads-acquire-mutation-lock.md`, and
 * `2026-06-03-entity-target-branch-captured-from-invocation.md`.
 */
export type LoopEntityRef =
	| { kind: 'change'; id: string; branch: string }
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
type CloseOutPr = { number: number; state: 'OPEN' | 'CLOSED' | 'MERGED' }

export async function reconcileEntity(entity: LoopEntityRef, deps: ReconcileDeps): Promise<void> {
	if (await entityAlreadyClosed(entity, deps)) return
	const pr = await findCloseOutPr(entity, deps)
	if (!isMergedPr(pr)) return
	await closeEntity(entity, deps)
	deps.log?.(`[reconcile ${entity.kind}-${entity.id}] PR #${pr.number} merged on GitHub → marked CLOSED`)
}

async function entityAlreadyClosed(entity: LoopEntityRef, deps: ReconcileDeps): Promise<boolean> {
	const current = entity.kind === 'change' ? await deps.storage.findChange(entity.id) : await deps.storage.findFix(entity.id)
	return !current || current.state === 'CLOSED'
}

async function findCloseOutPr(entity: LoopEntityRef, deps: ReconcileDeps): Promise<CloseOutPr | null> {
	try {
		return await deps.gh.findAnyPrByHead(entity.branch)
	} catch {
		return null
	}
}

function isMergedPr(pr: CloseOutPr | null): pr is CloseOutPr {
	return pr?.state === 'MERGED'
}

async function closeEntity(entity: LoopEntityRef, deps: ReconcileDeps): Promise<void> {
	if (entity.kind === 'change') await deps.storage.closeChange(entity.id)
	else await deps.storage.closeFix(entity.id)
}

if (import.meta.vitest) {
	const { describe, test, expect } = import.meta.vitest
	const { recordingGhOps } = await import('../test-utils/gh-ops-recorder.ts')
	const { fakeSliceStorage } = await import('../test-utils/storage-fixtures.ts')

	function fakeStorage(overrides: Partial<Storage>): Storage {
		return fakeSliceStorage([], null, { findChange: async () => null, ...overrides })
	}

	function openFix(id: string) {
		return { id, branch: 'b', title: 't', body: '', state: 'OPEN' as const, readyForAgent: false, needsRevision: false, blockedBy: [], prState: null }
	}

	async function expectFixNotClosed(findAnyPrByHead: () => Promise<{ number: number; state: 'OPEN' | 'CLOSED' | 'MERGED' } | null>): Promise<void> {
		let called = false
		const storage = fakeStorage({
			findFix: async (id) => openFix(id),
			closeFix: async () => { called = true },
		})
		const { gh } = recordingGhOps({ findAnyPrByHead })
		await reconcileEntity({ kind: 'fix', id: '5', branch: 'b' }, { storage, gh })
		expect(called).toBe(false)
	}

	describe('reconcileEntity', () => {
		test('Change: PR merged → closeChange called', async () => {
			let closed: string | null = null
			const storage = fakeStorage({
				findChange: async (id) => ({ id, branch: 'b', title: 't', state: 'OPEN' }),
				closeChange: async (id) => { closed = id },
			})
			const { gh } = recordingGhOps({
				findAnyPrByHead: async () => ({ number: 7, state: 'MERGED' }),
			})
			await reconcileEntity({ kind: 'change', id: '42', branch: 'b' }, { storage, gh })
			expect(closed).toBe('42')
		})

		test('Fix: PR merged → closeFix called', async () => {
			let closed: string | null = null
			const storage = fakeStorage({
				findFix: async (id) => openFix(id),
				closeFix: async (id) => { closed = id },
			})
			const { gh } = recordingGhOps({
				findAnyPrByHead: async () => ({ number: 8, state: 'MERGED' }),
			})
			await reconcileEntity({ kind: 'fix', id: '5', branch: 'b' }, { storage, gh })
			expect(closed).toBe('5')
		})

		test('PR open → no-op', async () => {
			await expectFixNotClosed(async () => ({ number: 9, state: 'OPEN' }))
		})

		test('no PR exists → no-op', async () => {
			let called = false
			const storage = fakeStorage({
				findChange: async (id) => ({ id, branch: 'b', title: 't', state: 'OPEN' }),
				closeChange: async () => { called = true },
			})
			const { gh } = recordingGhOps({ findAnyPrByHead: async () => null })
			await reconcileEntity({ kind: 'change', id: '1', branch: 'b' }, { storage, gh })
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
			await expectFixNotClosed(async () => { throw new Error('no gh') })
		})
	})
}
