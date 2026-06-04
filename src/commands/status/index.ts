import path from 'node:path'

import { renderStatus, renderStatusSlice } from './render.ts'
import { loadConfig } from '../../config.ts'
import { getStorage } from '../../storages/registry.ts'
import type { ClassifiedSlice, ChangeRecord, Slice, Storage, StorageDeps } from '../../storages/types.ts'
import { createGh, type GhOps } from '../../utils/gh-ops.ts'
import { createRepoGit } from '../../utils/git-ops.ts'
import { withMutationLock } from '../../utils/mutation-lock.ts'
import { reconcileEntity } from '../../work/reconcile.ts'
import { classifySlicesForChange } from '../../work/slice-buckets.ts'

type StatusRuntime = {
	storage: Storage
	gh: GhOps
	usePrs: boolean
	stdout: (s: string) => void
}

async function runStatus(changeId: string, rt: StatusRuntime): Promise<void> {
	const change = await rt.storage.findChange(changeId)
	if (!change) throw new Error(`Change '${changeId}' not found`)
	const slices = await classifySlicesForChange({ storage: rt.storage, gh: rt.gh, changeId, usePrs: rt.usePrs })
	writeStatusText(rt.stdout, renderStatus(change, slices))
}

async function buildStatusStorage(opts: { storage?: string }): Promise<{ storage: Storage; projectRoot: string; gh: GhOps; usePrs: boolean }> {
	const { config, projectRoot } = await loadConfig()
	if (!projectRoot) {
		process.stderr.write('trowel status: no project root found\n')
		process.exit(1)
	}
	const storageKind = opts.storage ?? config.storage
	const gh = createGh()
	const storageDeps: StorageDeps = {
		gh,
		git: createRepoGit(projectRoot),
		repoRoot: projectRoot,
		projectRoot,
		changesDir: path.resolve(projectRoot, config.docs.changesDir),
		labels: config.labels,
		closeOptions: config.close,
	}
	return { storage: getStorage(storageKind, storageDeps), projectRoot, gh, usePrs: config.work.usePrs }
}

function statusRuntime(storage: Storage, gh: GhOps, usePrs: boolean): StatusRuntime {
	return { storage, gh, usePrs, stdout: (s) => process.stdout.write(s) }
}

async function exitOnStatusError(fn: () => Promise<void>): Promise<void> {
	try {
		await fn()
	} catch (error) {
		process.stderr.write(`trowel status: ${(error as Error).message}\n`)
		process.exit(1)
	}
}

export async function statusChange(changeId: string, opts: { storage?: string }): Promise<void> {
	const { storage, projectRoot, gh, usePrs } = await buildStatusStorage(opts)
	await exitOnStatusError(() =>
		withMutationLock(projectRoot, async () => {
			const found = await storage.findChange(changeId)
			if (found) await reconcileEntity({ kind: 'change', id: changeId, branch: found.branch }, { storage, gh })
			await runStatus(changeId, statusRuntime(storage, gh, usePrs))
		}),
	)
}

export async function statusSlice(sliceId: string, opts: { storage?: string }): Promise<void> {
	const { storage, projectRoot, gh, usePrs } = await buildStatusStorage(opts)
	await exitOnStatusError(() => withMutationLock(projectRoot, () => runStatusSlice(sliceId, statusRuntime(storage, gh, usePrs))))
}

type StatusSliceRuntime = {
	storage: Storage
	gh: GhOps
	usePrs: boolean
	stdout: (s: string) => void
}

type StatusSliceContext = { change: ChangeRecord; target: ClassifiedSlice; siblings: ClassifiedSlice[] }

async function runStatusSlice(sliceId: string, rt: StatusSliceRuntime): Promise<void> {
	const context = await statusSliceContext(sliceId, rt)
	writeStatusText(rt.stdout, renderStatusSlice(context.change, context.target, context.siblings))
}

async function statusSliceContext(sliceId: string, rt: StatusSliceRuntime): Promise<StatusSliceContext> {
	const hit = await findSliceForStatus(sliceId, rt)
	const change = await findChangeForStatusSlice(sliceId, hit.changeId, rt)
	const siblings = await classifySlicesForChange({ storage: rt.storage, gh: rt.gh, changeId: hit.changeId, usePrs: rt.usePrs })
	return { change, target: targetStatusSlice(sliceId, siblings), siblings }
}

async function findSliceForStatus(sliceId: string, rt: StatusSliceRuntime): Promise<{ changeId: string; slice: Slice }> {
	const hit = await rt.storage.findSlice(sliceId)
	if (!hit) throw new Error(`slice '${sliceId}' not found`)
	return hit
}

async function findChangeForStatusSlice(sliceId: string, changeId: string, rt: StatusSliceRuntime): Promise<ChangeRecord> {
	const change = await rt.storage.findChange(changeId)
	if (!change) throw new Error(`slice '${sliceId}' references missing Change '${changeId}'`)
	return change
}

function targetStatusSlice(sliceId: string, siblings: ClassifiedSlice[]): ClassifiedSlice {
	const target = siblings.find((s) => s.id === sliceId)
	if (!target) throw new Error(`slice '${sliceId}' disappeared between findSlice and findSlices`)
	return target
}

function writeStatusText(stdout: (s: string) => void, text: string): void {
	stdout(text)
	if (!text.endsWith('\n')) stdout('\n')
}

if (import.meta.vitest) {
	const { describe, test, expect } = import.meta.vitest
	const { recordingGhOps } = await import('../../test-utils/gh-ops-recorder.ts')

	type FakeStorageState = {
		change: ChangeRecord | null
		rawSlices: Slice[]
	}

	function fakeStorage(state: FakeStorageState): Storage {
		return {
			createChange: async () => {
				throw new Error('nyi')
			},
			findChange: async (id) => {
				if (!state.change || state.change.id !== id) return null
				return state.change
			},
			listChanges: async () => [],
			closeChange: async () => {},
			createSlice: async () => {
				throw new Error('nyi')
			},
			findSlices: async () => state.rawSlices,
			findSlice: async () => null,
			updateSlice: async () => {},
		}
	}

	const change: ChangeRecord = { id: 'ab12cd', branch: 'change/ab12cd-feature', title: 'Add SSO', state: 'OPEN' }

	describe('status: tracer (no slices)', () => {
		test('renders header + "(no slices)" summary', async () => {
			const storage = fakeStorage({ change, rawSlices: [] })
			const { gh } = recordingGhOps()
			let buf = ''
			await runStatus('ab12cd', { storage, gh, usePrs: false, stdout: (s) => (buf += s) })
			expect(buf).toContain('Change ab12cd  Add SSO')
			expect(buf).toContain('Branch:  change/ab12cd-feature')
			expect(buf).toContain('State:   OPEN')
			expect(buf).toContain('(no slices)')
		})

		test('error when Change not found', async () => {
			const storage = fakeStorage({ change: null, rawSlices: [] })
			const { gh } = recordingGhOps()
			await expect(runStatus('zzzzzz', { storage, gh, usePrs: false, stdout: () => {} })).rejects.toThrow(/'zzzzzz' not found/)
		})

		test('usePrs:true renders a ready storage slice with an open PR as in-flight', async () => {
			const storage = fakeStorage({
				change,
				rawSlices: [{ id: '124', title: 'Read query-shape validation', body: '', state: 'OPEN', readyForAgent: true, needsRevision: false, blockedBy: [], prState: null }],
			})
			const { gh } = recordingGhOps({
				listOpenPrs: async () => [{ number: 130, headRefName: `change-${change.id}/slice-124-read-query-shape-validation`, isDraft: false }],
			})
			let buf = ''
			await runStatus(change.id, { storage, gh, usePrs: true, stdout: (s) => (buf += s) })
			expect(buf).toContain('(1 in-flight)')
			expect(buf).toMatch(/^ {2}in-flight$/m)
			expect(buf).not.toMatch(/^ {2}ready$/m)
		})
	})

	describe('status: per-bucket rendering', () => {
		const slice = (overrides: Partial<Omit<ClassifiedSlice, 'bucket'>>): Omit<ClassifiedSlice, 'bucket'> => ({
			id: 's1',
			title: 'a slice',
			body: '',
			state: 'OPEN',
			readyForAgent: false,
			needsRevision: false,
			blockedBy: [],
			prState: null,
			...overrides,
		})

		test('"done" section appears for CLOSED slices', () => {
			const out = renderStatus(change, [{ ...slice({ id: '142', title: 'Schema migration', state: 'CLOSED' }), bucket: 'done' }])
			expect(out).toMatch(/^ {2}done$/m)
			expect(out).toMatch(/142 +Schema migration/)
		})

		test('"ready" section appears for ready slices', () => {
			const out = renderStatus(change, [{ ...slice({ id: '147', title: 'Audit log', readyForAgent: true }), bucket: 'ready' }])
			expect(out).toMatch(/^ {2}ready$/m)
			expect(out).toMatch(/147 +Audit log/)
		})

		test('"draft" section appears for non-ready slices', () => {
			const out = renderStatus(change, [{ ...slice({ id: '149', title: 'TBD' }), bucket: 'draft' }])
			expect(out).toMatch(/^ {2}draft$/m)
		})

		test('"needs-revision" section appears for needsRevision slices', () => {
			const out = renderStatus(change, [{ ...slice({ id: '150', title: 'Fix me', needsRevision: true }), bucket: 'needs-revision' }])
			expect(out).toMatch(/^ {2}needs-revision$/m)
		})

		test('"in-flight" section appears for in-flight slices', () => {
			const out = renderStatus(change, [{ ...slice({ id: '145', title: 'Session middleware' }), bucket: 'in-flight' }])
			expect(out).toMatch(/^ {2}in-flight$/m)
		})

		test('"blocked" section shows blockedBy ids in the right column (read from ClassifiedSlice.blockedBy)', () => {
			const out = renderStatus(change, [
				{
					...slice({ id: '146', title: 'SSO admin UI', readyForAgent: true, blockedBy: ['145', '147'] }),
					bucket: 'blocked',
				},
			])
			expect(out).toMatch(/^ {2}blocked$/m)
			expect(out).toContain('blockedBy: 145, 147')
		})

		test('empty buckets are omitted from the rendering', () => {
			const out = renderStatus(change, [
				{ ...slice({ id: '142', title: 'A', state: 'CLOSED' }), bucket: 'done' },
				{ ...slice({ id: '147', title: 'B', readyForAgent: true }), bucket: 'ready' },
			])
			expect(out).toMatch(/^ {2}done$/m)
			expect(out).toMatch(/^ {2}ready$/m)
			expect(out).not.toMatch(/^ {2}draft$/m)
			expect(out).not.toMatch(/^ {2}in-flight$/m)
		})

		test('summary line shows counts only for non-empty buckets', () => {
			const out = renderStatus(change, [
				{ ...slice({ id: 'd1', state: 'CLOSED' }), bucket: 'done' },
				{ ...slice({ id: 'd2', state: 'CLOSED' }), bucket: 'done' },
				{ ...slice({ id: 'r1', readyForAgent: true }), bucket: 'ready' },
			])
			expect(out).toContain('(2 done · 1 ready)')
		})

		test('summary uses · separator and bucket-order matches BUCKET_ORDER', () => {
			const out = renderStatus(change, [
				{ ...slice({ id: 'd1', state: 'CLOSED' }), bucket: 'done' },
				{ ...slice({ id: 'fly', readyForAgent: true }), bucket: 'in-flight' },
				{ ...slice({ id: 'r1', readyForAgent: true }), bucket: 'ready' },
			])
			// Order: done, in-flight, ready
			expect(out).toMatch(/1 done · 1 in-flight · 1 ready/)
		})
	})

	describe('runStatusSlice', () => {
		function sliceStorage(change: ChangeRecord, rawSlices: Slice[]): Storage {
			const byId = new Map(rawSlices.map((s) => [s.id, s]))
			return {
				createChange: async () => ({ id: 'x', branch: 'x' }),
				findChange: async (id) => (id === change.id ? change : null),
				listChanges: async () => [],
				closeChange: async () => {},
				createSlice: async () => { throw new Error('nyi') },
				findSlices: async () => rawSlices,
				findSlice: async (sliceId) => {
					const s = byId.get(sliceId)
					return s ? { changeId: change.id, slice: s } : null
				},
				updateSlice: async () => {},
			}
		}

		const rawSlice = (overrides: Partial<Slice>): Slice => ({
			id: '42',
			title: 'Implement tab parser',
			body: '',
			state: 'OPEN',
			readyForAgent: true,
			needsRevision: false,
			blockedBy: [],
			prState: null,
			...overrides,
		})

		async function renderSliceStatus(slices: Slice[]): Promise<string> {
			const storage = sliceStorage(change, slices)
			const { gh } = recordingGhOps()
			let buf = ''
			await runStatusSlice('42', { storage, gh, usePrs: false, stdout: (s) => (buf += s) })
			return buf
		}

		test('renders slice header + parent Change ref + bucket', async () => {
			const buf = await renderSliceStatus([rawSlice({ id: '42' })])
			expect(buf).toContain('Slice 42  Implement tab parser')
			expect(buf).toContain(`Change:     ${change.id}  ${change.title}`)
			expect(buf).toContain('bucket: ready')
		})

		test('renders blockedBy with each blocker\'s bucket', async () => {
			const buf = await renderSliceStatus([
				rawSlice({ id: '40', title: 'Migration', state: 'CLOSED' }),
				rawSlice({ id: '41', title: 'Constants', readyForAgent: true }),
				rawSlice({ id: '42', title: 'Tab parser', blockedBy: ['40', '41'] }),
			])
			expect(buf).toContain('blockedBy:')
			expect(buf).toMatch(/40.*done.*Migration/)
			expect(buf).toMatch(/41.*ready.*Constants/)
		})

		test('errors when slice id not found', async () => {
			const storage = sliceStorage(change, [])
			const { gh } = recordingGhOps()
			await expect(runStatusSlice('999', { storage, gh, usePrs: false, stdout: () => {} })).rejects.toThrow(/slice '999' not found/)
		})
	})
}
