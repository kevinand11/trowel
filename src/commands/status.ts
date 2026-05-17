import path from 'node:path'

import { loadConfig } from '../config.ts'
import { getStorage } from '../storages/registry.ts'
import type { ClassifiedSlice, PrdRecord, Slice, Storage, StorageDeps } from '../storages/types.ts'
import { classifySlices, type Bucket } from '../utils/bucket.ts'
import { createGh } from '../utils/gh-ops.ts'
import { createRepoGit } from '../utils/git-ops.ts'

// Bucket render order. Mirrors the predicate evaluation order in
// `src/utils/bucket.ts` so the user reads buckets in the same flow as
// the classifier evaluates them.
const BUCKET_ORDER: Bucket[] = ['done', 'needs-revision', 'in-flight', 'blocked', 'ready', 'draft']

function renderStatus(prd: PrdRecord, slices: ClassifiedSlice[]): string {
	const counts: Record<Bucket, number> = {
		done: 0,
		'needs-revision': 0,
		'in-flight': 0,
		blocked: 0,
		ready: 0,
		draft: 0,
	}
	for (const s of slices) counts[s.bucket]++

	const summary = slices.length === 0 ? '(no slices)' : `(${formatCounts(counts)})`

	const lines: string[] = []
	lines.push(`PRD ${prd.id}  ${prd.title}`)
	lines.push(`Branch:  ${prd.branch}`)
	lines.push(`State:   ${prd.state}          ${summary}`)
	lines.push('')

	const sliceById = bySliceId(slices)

	for (const bucket of BUCKET_ORDER) {
		const inBucket = slices.filter((s) => s.bucket === bucket)
		if (inBucket.length === 0) continue
		lines.push(`  ${bucket}`)
		for (const s of inBucket) {
			const right = rightColumn(s, sliceById)
			const idCol = s.id.padEnd(8)
			if (right) {
				lines.push(`    ${idCol}  ${s.title.padEnd(48)}  ${right}`)
			} else {
				lines.push(`    ${idCol}  ${s.title}`)
			}
		}
		lines.push('')
	}

	return lines.join('\n')
}

function formatCounts(counts: Record<Bucket, number>): string {
	return BUCKET_ORDER.filter((b) => counts[b] > 0)
		.map((b) => `${counts[b]} ${b}`)
		.join(' · ')
}

function bySliceId(slices: ClassifiedSlice[]): Map<string, ClassifiedSlice> {
	return new Map(slices.map((s) => [s.id, s]))
}

function rightColumn(s: ClassifiedSlice, byId: Map<string, ClassifiedSlice>): string {
	if (s.bucket === 'blocked') {
		const unmet = s.blockedBy.filter((id) => {
			const dep = byId.get(id)
			return !dep || dep.bucket !== 'done'
		})
		if (unmet.length === 0) return ''
		return `blockedBy: ${unmet.join(', ')}`
	}
	return ''
}

type StatusRuntime = {
	storage: Storage
	stdout: (s: string) => void
}

async function runStatus(prdId: string, rt: StatusRuntime): Promise<void> {
	const prd = await rt.storage.findPrd(prdId)
	if (!prd) throw new Error(`PRD '${prdId}' not found`)
	const slices = classifySlices(await rt.storage.findSlices(prdId))
	rt.stdout(renderStatus(prd, slices))
	if (!renderStatus(prd, slices).endsWith('\n')) rt.stdout('\n')
}

async function buildStatusStorage(opts: { storage?: string }): Promise<{ storage: Storage; projectRoot: string }> {
	const { config, projectRoot } = await loadConfig()
	if (!projectRoot) {
		process.stderr.write('trowel status: no project root found\n')
		process.exit(1)
	}
	const storageKind = opts.storage ?? config.storage
	const storageDeps: StorageDeps = {
		gh: createGh(),
		git: createRepoGit(projectRoot),
		repoRoot: projectRoot,
		projectRoot,
		prdsDir: path.resolve(projectRoot, config.docs.prdsDir),
		labels: config.labels,
		closeOptions: config.close,
	}
	return { storage: getStorage(storageKind, storageDeps), projectRoot }
}

export async function statusPrd(prdId: string, opts: { storage?: string }): Promise<void> {
	const { storage } = await buildStatusStorage(opts)
	try {
		await runStatus(prdId, {
			storage,
			stdout: (s) => process.stdout.write(s),
		})
	} catch (error) {
		process.stderr.write(`trowel status: ${(error as Error).message}\n`)
		process.exit(1)
	}
}

export async function statusSlice(sliceId: string, opts: { storage?: string }): Promise<void> {
	const { storage } = await buildStatusStorage(opts)
	try {
		await runStatusSlice(sliceId, {
			storage,
			stdout: (s) => process.stdout.write(s),
		})
	} catch (error) {
		process.stderr.write(`trowel status: ${(error as Error).message}\n`)
		process.exit(1)
	}
}

type StatusSliceRuntime = {
	storage: Storage
	stdout: (s: string) => void
}

async function runStatusSlice(sliceId: string, rt: StatusSliceRuntime): Promise<void> {
	const hit = await rt.storage.findSlice(sliceId)
	if (!hit) throw new Error(`slice '${sliceId}' not found`)
	const prd = await rt.storage.findPrd(hit.prdId)
	if (!prd) throw new Error(`slice '${sliceId}' references missing PRD '${hit.prdId}'`)
	const siblings = classifySlices(await rt.storage.findSlices(hit.prdId))
	const target = siblings.find((s) => s.id === sliceId)
	if (!target) throw new Error(`slice '${sliceId}' disappeared between findSlice and findSlices`)
	rt.stdout(renderStatusSlice(prd, target, siblings))
	if (!renderStatusSlice(prd, target, siblings).endsWith('\n')) rt.stdout('\n')
}

function renderStatusSlice(prd: PrdRecord, slice: ClassifiedSlice, siblings: ClassifiedSlice[]): string {
	const lines: string[] = []
	lines.push(`Slice ${slice.id}  ${slice.title}`)
	lines.push(`PRD:     ${prd.id}  ${prd.title}`)
	lines.push(`State:   ${slice.state}   bucket: ${slice.bucket}`)
	lines.push(`ready-for-agent: ${slice.readyForAgent}`)
	lines.push(`needs-revision:  ${slice.needsRevision}`)
	if (slice.blockedBy.length > 0) {
		lines.push('blockedBy:')
		const byId = new Map(siblings.map((s) => [s.id, s]))
		for (const id of slice.blockedBy) {
			const dep = byId.get(id)
			if (dep) {
				lines.push(`  ${id.padEnd(6)}  ${dep.bucket.padEnd(14)}  ${dep.title}`)
			} else {
				lines.push(`  ${id.padEnd(6)}  (not found)`)
			}
		}
	}
	return lines.join('\n')
}

if (import.meta.vitest) {
	const { describe, test, expect } = import.meta.vitest

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
		}
	}

	const prd: PrdRecord = { id: 'ab12cd', branch: 'prd/ab12cd-feature', title: 'Add SSO', state: 'OPEN' }

	describe('status: tracer (no slices)', () => {
		test('renders header + "(no slices)" summary', async () => {
			const storage = fakeStorage({ prd, rawSlices: [] })
			let buf = ''
			await runStatus('ab12cd', { storage, stdout: (s) => (buf += s) })
			expect(buf).toContain('PRD ab12cd  Add SSO')
			expect(buf).toContain('Branch:  prd/ab12cd-feature')
			expect(buf).toContain('State:   OPEN')
			expect(buf).toContain('(no slices)')
		})

		test('error when PRD not found', async () => {
			const storage = fakeStorage({ prd: null, rawSlices: [] })
			await expect(runStatus('zzzzzz', { storage, stdout: () => {} })).rejects.toThrow(/'zzzzzz' not found/)
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

		test('renders slice header + parent PRD ref + bucket', async () => {
			const storage = sliceStorage(prd, [rawSlice({ id: '42' })])
			let buf = ''
			await runStatusSlice('42', { storage, stdout: (s) => (buf += s) })
			expect(buf).toContain('Slice 42  Implement tab parser')
			expect(buf).toContain(`PRD:     ${prd.id}  ${prd.title}`)
			expect(buf).toContain('bucket: ready')
		})

		test('renders blockedBy with each blocker\'s bucket', async () => {
			const storage = sliceStorage(prd, [
				rawSlice({ id: '40', title: 'Migration', state: 'CLOSED' }),
				rawSlice({ id: '41', title: 'Constants', readyForAgent: true }),
				rawSlice({ id: '42', title: 'Tab parser', blockedBy: ['40', '41'] }),
			])
			let buf = ''
			await runStatusSlice('42', { storage, stdout: (s) => (buf += s) })
			expect(buf).toContain('blockedBy:')
			expect(buf).toMatch(/40.*done.*Migration/)
			expect(buf).toMatch(/41.*ready.*Constants/)
		})

		test('errors when slice id not found', async () => {
			const storage = sliceStorage(prd, [])
			await expect(runStatusSlice('999', { storage, stdout: () => {} })).rejects.toThrow(/slice '999' not found/)
		})
	})
}
