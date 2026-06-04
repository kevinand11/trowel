import type { Storage } from '../storages/types.ts'
import type { GhOps } from '../utils/gh-ops.ts'

/**
 * Identifies the Change to reconcile. A Change has a single Close-out PR against its targetBranch;
 * when that PR shows as merged on GitHub, the storage record flips to CLOSED.
 */
export type LoopEntityRef = { kind: 'change'; id: string; branch: string }

export type ReconcileDeps = {
	storage: Storage
	gh: GhOps
	log?: (msg: string) => void
}

type CloseOutPr = { number: number; state: 'OPEN' | 'CLOSED' | 'MERGED' }

export async function reconcileEntity(entity: LoopEntityRef, deps: ReconcileDeps): Promise<void> {
	if (await changeAlreadyClosed(entity, deps)) return
	const pr = await findCloseOutPr(entity, deps)
	if (!isMergedPr(pr)) return
	await deps.storage.closeChange(entity.id)
	deps.log?.(`[reconcile ${entity.kind}-${entity.id}] PR #${pr.number} merged on GitHub → marked CLOSED`)
}

async function changeAlreadyClosed(entity: LoopEntityRef, deps: ReconcileDeps): Promise<boolean> {
	const current = await deps.storage.findChange(entity.id)
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

if (import.meta.vitest) {
	const { describe, test, expect } = import.meta.vitest
	const { recordingGhOps } = await import('../test-utils/gh-ops-recorder.ts')
	const { fakeSliceStorage } = await import('../test-utils/storage-fixtures.ts')

	function fakeStorage(overrides: Partial<Storage>): Storage {
		return fakeSliceStorage([], null, { findChange: async () => null, ...overrides })
	}

	async function reconciledClosedFlag(findAnyPrByHead: () => Promise<{ number: number; state: 'OPEN' | 'CLOSED' | 'MERGED' } | null>): Promise<boolean> {
		let closed = false
		const storage = fakeStorage({
			findChange: async (id) => ({ id, branch: 'b', title: 't', state: 'OPEN' }),
			closeChange: async () => { closed = true },
		})
		const { gh } = recordingGhOps({ findAnyPrByHead })
		await reconcileEntity({ kind: 'change', id: '42', branch: 'b' }, { storage, gh })
		return closed
	}

	describe('reconcileEntity', () => {
		test('Change: PR merged → closeChange called', async () => {
			let closed: string | null = null
			const storage = fakeStorage({
				findChange: async (id) => ({ id, branch: 'b', title: 't', state: 'OPEN' }),
				closeChange: async (id) => { closed = id },
			})
			const { gh } = recordingGhOps({ findAnyPrByHead: async () => ({ number: 7, state: 'MERGED' }) })
			await reconcileEntity({ kind: 'change', id: '42', branch: 'b' }, { storage, gh })
			expect(closed).toBe('42')
		})

		test('OPEN PR → no close', async () => {
			expect(await reconciledClosedFlag(async () => ({ number: 7, state: 'OPEN' }))).toBe(false)
		})

		test('gh failure is swallowed', async () => {
			expect(await reconciledClosedFlag(async () => { throw new Error('no gh') })).toBe(false)
		})
	})
}
