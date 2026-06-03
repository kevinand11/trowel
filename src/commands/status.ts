import path from 'node:path'

import { loadConfig } from '../config.ts'
import { renderStatus, renderStatusFix, renderStatusSlice } from './status-render.ts'
import { getStorage } from '../storages/registry.ts'
import type { ClassifiedSlice, PrdRecord, Slice, Storage, StorageDeps } from '../storages/types.ts'
import { createGh, type GhOps } from '../utils/gh-ops.ts'
import { createRepoGit } from '../utils/git-ops.ts'
import { withMutationLock } from '../utils/mutation-lock.ts'
import { reconcileEntity } from '../work/reconcile.ts'
import { classifySlicesForPrd } from '../work/slice-buckets.ts'

type StatusRuntime = {
	storage: Storage
	gh: GhOps
	usePrs: boolean
	stdout: (s: string) => void
}

async function runStatus(prdId: string, rt: StatusRuntime): Promise<void> {
	const prd = await rt.storage.findPrd(prdId)
	if (!prd) throw new Error(`PRD '${prdId}' not found`)
	const slices = await classifySlicesForPrd({ storage: rt.storage, gh: rt.gh, prdId, usePrs: rt.usePrs })
	writeStatusText(rt.stdout, renderStatus(prd, slices))
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
		prdsDir: path.resolve(projectRoot, config.docs.prdsDir),
		fixesDir: path.resolve(projectRoot, config.docs.fixesDir),
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

export async function statusPrd(prdId: string, opts: { storage?: string }): Promise<void> {
	const { storage, projectRoot, gh, usePrs } = await buildStatusStorage(opts)
	await exitOnStatusError(() =>
		withMutationLock(projectRoot, async () => {
			const found = await storage.findPrd(prdId)
			if (found) await reconcileEntity({ kind: 'prd', id: prdId, branch: found.branch }, { storage, gh })
			await runStatus(prdId, statusRuntime(storage, gh, usePrs))
		}),
	)
}

export async function statusSlice(sliceId: string, opts: { storage?: string }): Promise<void> {
	const { storage, projectRoot, gh, usePrs } = await buildStatusStorage(opts)
	await exitOnStatusError(() => withMutationLock(projectRoot, () => runStatusSlice(sliceId, statusRuntime(storage, gh, usePrs))))
}

async function runStatusFix(fixId: string, rt: StatusRuntime): Promise<void> {
	const fix = await rt.storage.findFix(fixId)
	if (!fix) throw new Error(`Fix '${fixId}' not found`)
	writeStatusText(rt.stdout, renderStatusFix(fix))
}

export async function statusFix(fixId: string, opts: { storage?: string }): Promise<void> {
	const { storage, projectRoot, gh } = await buildStatusStorage(opts)
	await exitOnStatusError(() =>
		withMutationLock(projectRoot, async () => {
			const found = await storage.findFix(fixId)
			if (found) await reconcileEntity({ kind: 'fix', id: fixId, branch: found.branch }, { storage, gh })
			await runStatusFix(fixId, statusRuntime(storage, gh, false))
		}),
	)
}

type StatusSliceRuntime = {
	storage: Storage
	gh: GhOps
	usePrs: boolean
	stdout: (s: string) => void
}

type StatusSliceContext = { prd: PrdRecord; target: ClassifiedSlice; siblings: ClassifiedSlice[] }

async function runStatusSlice(sliceId: string, rt: StatusSliceRuntime): Promise<void> {
	const context = await statusSliceContext(sliceId, rt)
	writeStatusText(rt.stdout, renderStatusSlice(context.prd, context.target, context.siblings))
}

async function statusSliceContext(sliceId: string, rt: StatusSliceRuntime): Promise<StatusSliceContext> {
	const hit = await findSliceForStatus(sliceId, rt)
	const prd = await findPrdForStatusSlice(sliceId, hit.prdId, rt)
	const siblings = await classifySlicesForPrd({ storage: rt.storage, gh: rt.gh, prdId: hit.prdId, usePrs: rt.usePrs })
	return { prd, target: targetStatusSlice(sliceId, siblings), siblings }
}

async function findSliceForStatus(sliceId: string, rt: StatusSliceRuntime): Promise<{ prdId: string; slice: Slice }> {
	const hit = await rt.storage.findSlice(sliceId)
	if (!hit) throw new Error(`slice '${sliceId}' not found`)
	return hit
}

async function findPrdForStatusSlice(sliceId: string, prdId: string, rt: StatusSliceRuntime): Promise<PrdRecord> {
	const prd = await rt.storage.findPrd(prdId)
	if (!prd) throw new Error(`slice '${sliceId}' references missing PRD '${prdId}'`)
	return prd
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
	const { recordingGhOps } = await import('../test-utils/gh-ops-recorder.ts')

	type FakeStorageState = {
		prd: PrdRecord | null
		rawSlices: Slice[]
	}

	function fakeStorage(state: FakeStorageState): Storage {
		return {
			createPrd: async () => {
				throw new Error('nyi')
			},
			findPrd: async (id) => {
				if (!state.prd || state.prd.id !== id) return null
				return state.prd
			},
			listPrds: async () => [],
			closePrd: async () => {},
			createSlice: async () => {
				throw new Error('nyi')
			},
			findSlices: async () => state.rawSlices,
			findSlice: async () => null,
			updateSlice: async () => {},
			createFix: async () => ({ id: 'x', branch: 'x' }),
			findFix: async () => null,
			listFixes: async () => [],
			updateFix: async () => {},
			closeFix: async () => {},
		}
	}

	const prd: PrdRecord = { id: 'ab12cd', branch: 'prd/ab12cd-feature', title: 'Add SSO', state: 'OPEN' }

	describe('status: tracer (no slices)', () => {
		test('renders header + "(no slices)" summary', async () => {
			const storage = fakeStorage({ prd, rawSlices: [] })
			const { gh } = recordingGhOps()
			let buf = ''
			await runStatus('ab12cd', { storage, gh, usePrs: false, stdout: (s) => (buf += s) })
			expect(buf).toContain('PRD ab12cd  Add SSO')
			expect(buf).toContain('Branch:  prd/ab12cd-feature')
			expect(buf).toContain('State:   OPEN')
			expect(buf).toContain('(no slices)')
		})

		test('error when PRD not found', async () => {
			const storage = fakeStorage({ prd: null, rawSlices: [] })
			const { gh } = recordingGhOps()
			await expect(runStatus('zzzzzz', { storage, gh, usePrs: false, stdout: () => {} })).rejects.toThrow(/'zzzzzz' not found/)
		})

		test('usePrs:true renders a ready storage slice with an open PR as in-flight', async () => {
			const storage = fakeStorage({
				prd,
				rawSlices: [{ id: '124', title: 'Read query-shape validation', body: '', state: 'OPEN', readyForAgent: true, needsRevision: false, blockedBy: [], prState: null }],
			})
			const { gh } = recordingGhOps({
				listOpenPrs: async () => [{ number: 130, headRefName: `prd-${prd.id}/slice-124-read-query-shape-validation`, isDraft: false }],
			})
			let buf = ''
			await runStatus(prd.id, { storage, gh, usePrs: true, stdout: (s) => (buf += s) })
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
			const out = renderStatus(prd, [{ ...slice({ id: '142', title: 'Schema migration', state: 'CLOSED' }), bucket: 'done' }])
			expect(out).toMatch(/^ {2}done$/m)
			expect(out).toMatch(/142 +Schema migration/)
		})

		test('"ready" section appears for ready slices', () => {
			const out = renderStatus(prd, [{ ...slice({ id: '147', title: 'Audit log', readyForAgent: true }), bucket: 'ready' }])
			expect(out).toMatch(/^ {2}ready$/m)
			expect(out).toMatch(/147 +Audit log/)
		})

		test('"draft" section appears for non-ready slices', () => {
			const out = renderStatus(prd, [{ ...slice({ id: '149', title: 'TBD' }), bucket: 'draft' }])
			expect(out).toMatch(/^ {2}draft$/m)
		})

		test('"needs-revision" section appears for needsRevision slices', () => {
			const out = renderStatus(prd, [{ ...slice({ id: '150', title: 'Fix me', needsRevision: true }), bucket: 'needs-revision' }])
			expect(out).toMatch(/^ {2}needs-revision$/m)
		})

		test('"in-flight" section appears for in-flight slices', () => {
			const out = renderStatus(prd, [{ ...slice({ id: '145', title: 'Session middleware' }), bucket: 'in-flight' }])
			expect(out).toMatch(/^ {2}in-flight$/m)
		})

		test('"blocked" section shows blockedBy ids in the right column (read from ClassifiedSlice.blockedBy)', () => {
			const out = renderStatus(prd, [
				{
					...slice({ id: '146', title: 'SSO admin UI', readyForAgent: true, blockedBy: ['145', '147'] }),
					bucket: 'blocked',
				},
			])
			expect(out).toMatch(/^ {2}blocked$/m)
			expect(out).toContain('blockedBy: 145, 147')
		})

		test('empty buckets are omitted from the rendering', () => {
			const out = renderStatus(prd, [
				{ ...slice({ id: '142', title: 'A', state: 'CLOSED' }), bucket: 'done' },
				{ ...slice({ id: '147', title: 'B', readyForAgent: true }), bucket: 'ready' },
			])
			expect(out).toMatch(/^ {2}done$/m)
			expect(out).toMatch(/^ {2}ready$/m)
			expect(out).not.toMatch(/^ {2}draft$/m)
			expect(out).not.toMatch(/^ {2}in-flight$/m)
		})

		test('summary line shows counts only for non-empty buckets', () => {
			const out = renderStatus(prd, [
				{ ...slice({ id: 'd1', state: 'CLOSED' }), bucket: 'done' },
				{ ...slice({ id: 'd2', state: 'CLOSED' }), bucket: 'done' },
				{ ...slice({ id: 'r1', readyForAgent: true }), bucket: 'ready' },
			])
			expect(out).toContain('(2 done · 1 ready)')
		})

		test('summary uses · separator and bucket-order matches BUCKET_ORDER', () => {
			const out = renderStatus(prd, [
				{ ...slice({ id: 'd1', state: 'CLOSED' }), bucket: 'done' },
				{ ...slice({ id: 'fly', readyForAgent: true }), bucket: 'in-flight' },
				{ ...slice({ id: 'r1', readyForAgent: true }), bucket: 'ready' },
			])
			// Order: done, in-flight, ready
			expect(out).toMatch(/1 done · 1 in-flight · 1 ready/)
		})
	})

	describe('runStatusSlice', () => {
		function sliceStorage(prd: PrdRecord, rawSlices: Slice[]): Storage {
			const byId = new Map(rawSlices.map((s) => [s.id, s]))
			return {
				createPrd: async () => ({ id: 'x', branch: 'x' }),
				findPrd: async (id) => (id === prd.id ? prd : null),
				listPrds: async () => [],
				closePrd: async () => {},
				createSlice: async () => { throw new Error('nyi') },
				findSlices: async () => rawSlices,
				findSlice: async (sliceId) => {
					const s = byId.get(sliceId)
					return s ? { prdId: prd.id, slice: s } : null
				},
				updateSlice: async () => {},
				createFix: async () => ({ id: 'x', branch: 'x' }),
				findFix: async () => null,
				listFixes: async () => [],
				updateFix: async () => {},
				closeFix: async () => {},
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
			const storage = sliceStorage(prd, slices)
			const { gh } = recordingGhOps()
			let buf = ''
			await runStatusSlice('42', { storage, gh, usePrs: false, stdout: (s) => (buf += s) })
			return buf
		}

		test('renders slice header + parent PRD ref + bucket', async () => {
			const buf = await renderSliceStatus([rawSlice({ id: '42' })])
			expect(buf).toContain('Slice 42  Implement tab parser')
			expect(buf).toContain(`PRD:     ${prd.id}  ${prd.title}`)
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
			const storage = sliceStorage(prd, [])
			const { gh } = recordingGhOps()
			await expect(runStatusSlice('999', { storage, gh, usePrs: false, stdout: () => {} })).rejects.toThrow(/slice '999' not found/)
		})
	})
}
