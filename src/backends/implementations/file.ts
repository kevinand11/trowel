import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { classify } from '../../utils/bucket.ts'
import { parseDeps } from '../../utils/deps.ts'
import { generateUniqueId } from '../../utils/id.ts'
import { exec } from '../../utils/shell.ts'
import { slug as slugify } from '../../utils/slug.ts'
import type { Backend, BackendDeps, BackendFactory, PrdRecord, PrdSpec, PrdSummary, Slice, SlicePatch } from '../types.ts'

const DEFAULT_BRANCH_PREFIX = 'prd/'

type PrdStore = { id: string; slug: string; title: string; createdAt: string; closedAt: string | null }
type SliceStore = PrdStore & { readyForAgent: boolean; needsRevision: boolean }

export const createFileBackend: BackendFactory = (deps: BackendDeps): Backend => {
	const prefix = deps.branchPrefix ?? DEFAULT_BRANCH_PREFIX

	async function prdIdIsAvailable(candidate: string): Promise<boolean> {
		let entries: string[]
		try {
			entries = await readdir(deps.prdsDir)
		} catch {
			return true
		}
		return !entries.some((e) => e.startsWith(`${candidate}-`))
	}

	async function findPrdDir(id: string): Promise<string> {
		let entries: string[]
		try {
			entries = await readdir(deps.prdsDir)
		} catch {
			throw new Error(`no PRD directory found for id '${id}' (prdsDir does not exist)`)
		}
		const match = entries.find((e) => e.startsWith(`${id}-`))
		if (!match) throw new Error(`no PRD directory found for id '${id}'`)
		return path.join(deps.prdsDir, match)
	}

	async function readPrdStore(id: string): Promise<PrdStore> {
		const dir = await findPrdDir(id)
		return JSON.parse(await readFile(path.join(dir, 'store.json'), 'utf8'))
	}

	async function slicesDir(prdId: string): Promise<string> {
		const dir = await findPrdDir(prdId)
		return path.join(dir, 'slices')
	}

	async function findSliceDir(prdId: string, sliceId: string): Promise<string> {
		const dir = await slicesDir(prdId)
		let entries: string[]
		try {
			entries = await readdir(dir)
		} catch {
			throw new Error(`no slice directory found for '${sliceId}' under PRD '${prdId}'`)
		}
		const match = entries.find((e) => e.startsWith(`${sliceId}-`))
		if (!match) throw new Error(`no slice directory found for '${sliceId}' under PRD '${prdId}'`)
		return path.join(dir, match)
	}

	async function sliceIdIsAvailable(candidate: string): Promise<boolean> {
		try {
			const entries = await readdir(deps.prdsDir)
			for (const prd of entries) {
				const sl = path.join(deps.prdsDir, prd, 'slices')
				let slEntries: string[]
				try {
					slEntries = await readdir(sl)
				} catch {
					continue
				}
				if (slEntries.some((e) => e.startsWith(`${candidate}-`))) return false
			}
			return true
		} catch {
			return true
		}
	}

	async function createPrd(spec: PrdSpec): Promise<{ id: string; branch: string }> {
		const slug = slugify(spec.title)
		const id = await generateUniqueId(prdIdIsAvailable, deps.generateId ? { gen: deps.generateId } : {})
		const dir = path.join(deps.prdsDir, `${id}-${slug}`)
		const branch = `${prefix}${id}-${slug}`

		await mkdir(dir, { recursive: true })
		await writeFile(path.join(dir, 'README.md'), spec.body)
		const store: PrdStore = {
			id,
			slug,
			title: spec.title,
			createdAt: new Date().toISOString(),
			closedAt: null,
		}
		await writeFile(path.join(dir, 'store.json'), JSON.stringify(store, null, 2) + '\n')

		await exec('git', ['-C', deps.repoRoot, 'checkout', '-q', '-b', branch, deps.baseBranch])

		const relToRepo = path.relative(deps.repoRoot, dir)
		const isInsideRepo = !relToRepo.startsWith('..') && !path.isAbsolute(relToRepo)
		if (isInsideRepo) {
			await exec('git', ['-C', deps.repoRoot, 'add', relToRepo])
			const msg = deps.docMsg.replace(/\$\{id\}/g, id).replace(/\$\{title\}/g, spec.title)
			await exec('git', ['-C', deps.repoRoot, 'commit', '-q', '-m', msg])
		}
		await exec('git', ['-C', deps.repoRoot, 'push', '-q', '-u', 'origin', branch])

		return { id, branch }
	}

	async function branchForExisting(id: string): Promise<string> {
		const store = await readPrdStore(id)
		return `${prefix}${store.id}-${store.slug}`
	}

	async function listOpen(): Promise<PrdSummary[]> {
		let entries: string[]
		try {
			entries = await readdir(deps.prdsDir)
		} catch {
			return []
		}
		const summaries: PrdSummary[] = []
		for (const entry of entries) {
			const storePath = path.join(deps.prdsDir, entry, 'store.json')
			try {
				const store: PrdStore = JSON.parse(await readFile(storePath, 'utf8'))
				if (store.closedAt !== null) continue
				summaries.push({
					id: store.id,
					title: store.title,
					branch: `${prefix}${store.id}-${store.slug}`,
				})
			} catch {
				continue
			}
		}
		return summaries
	}

	async function close(id: string): Promise<void> {
		const dir = await findPrdDir(id)
		const storePath = path.join(dir, 'store.json')
		const store: PrdStore = JSON.parse(await readFile(storePath, 'utf8'))
		if (store.closedAt !== null) return // idempotent: already closed in store
		store.closedAt = new Date().toISOString()
		await writeFile(storePath, JSON.stringify(store, null, 2) + '\n')

		const relToRepo = path.relative(deps.repoRoot, dir)
		const isInsideRepo = !relToRepo.startsWith('..') && !path.isAbsolute(relToRepo)
		if (isInsideRepo) {
			await exec('git', ['-C', deps.repoRoot, 'add', path.join(relToRepo, 'store.json')])
			await exec('git', ['-C', deps.repoRoot, 'commit', '-q', '-m', `docs(prd-${id}): close`])
		}
	}

	async function createSlice(prdId: string, spec: PrdSpec): Promise<Slice> {
		const slug = slugify(spec.title)
		const id = await generateUniqueId(sliceIdIsAvailable, deps.generateId ? { gen: deps.generateId } : {})
		const slicesPath = await slicesDir(prdId)
		const dir = path.join(slicesPath, `${id}-${slug}`)

		await mkdir(dir, { recursive: true })
		await writeFile(path.join(dir, 'README.md'), spec.body)
		const store: SliceStore = {
			id,
			slug,
			title: spec.title,
			createdAt: new Date().toISOString(),
			closedAt: null,
			readyForAgent: false,
			needsRevision: false,
		}
		await writeFile(path.join(dir, 'store.json'), JSON.stringify(store, null, 2) + '\n')

		const raw = sliceFromStore(store, spec.body)
		return { ...raw, bucket: classify(raw, { hasOpenPr: false, unmetDepIds: [] }) }
	}

	async function findSlices(prdId: string): Promise<Slice[]> {
		let slicesPath: string
		try {
			slicesPath = await slicesDir(prdId)
		} catch {
			return []
		}
		let entries: string[]
		try {
			entries = await readdir(slicesPath)
		} catch {
			return []
		}
		const raw: Array<Omit<Slice, 'bucket'>> = []
		for (const entry of entries) {
			const dir = path.join(slicesPath, entry)
			try {
				const store: SliceStore = JSON.parse(await readFile(path.join(dir, 'store.json'), 'utf8'))
				const body = await readFile(path.join(dir, 'README.md'), 'utf8')
				raw.push(sliceFromStore(store, body))
			} catch {
				continue
			}
		}
		const doneIds = new Set(raw.filter((r) => r.state === 'CLOSED').map((r) => r.id))
		return raw.map((r) => {
			const deps = parseDeps(r.body)
			const unmetDepIds = deps.filter((d) => !doneIds.has(d))
			const bucket = classify(r, { hasOpenPr: false, unmetDepIds })
			return { ...r, bucket }
		})
	}

	async function updateSlice(prdId: string, sliceId: string, patch: SlicePatch): Promise<void> {
		const dir = await findSliceDir(prdId, sliceId)
		const storePath = path.join(dir, 'store.json')
		const store: SliceStore = JSON.parse(await readFile(storePath, 'utf8'))

		if (patch.readyForAgent !== undefined) store.readyForAgent = patch.readyForAgent
		if (patch.needsRevision !== undefined) store.needsRevision = patch.needsRevision
		if (patch.state === 'CLOSED' && store.closedAt === null) store.closedAt = new Date().toISOString()
		if (patch.state === 'OPEN') store.closedAt = null

		await writeFile(storePath, JSON.stringify(store, null, 2) + '\n')
	}

	function sliceFromStore(store: SliceStore, body: string): Omit<Slice, 'bucket'> {
		return {
			id: store.id,
			title: store.title,
			body,
			state: store.closedAt === null ? 'OPEN' : 'CLOSED',
			readyForAgent: store.readyForAgent,
			needsRevision: store.needsRevision,
		}
	}

	async function findPrd(id: string): Promise<PrdRecord | null> {
		try {
			const store = await readPrdStore(id)
			return {
				id: store.id,
				branch: `${prefix}${store.id}-${store.slug}`,
				title: store.title,
				state: store.closedAt === null ? 'OPEN' : 'CLOSED',
			}
		} catch {
			return null
		}
	}

	return {
		name: 'file',
		defaultBranchPrefix: DEFAULT_BRANCH_PREFIX,
		createPrd,
		branchForExisting,
		findPrd,
		listOpen,
		close,
		createSlice,
		findSlices,
		updateSlice,
	}
}

if (import.meta.vitest) {
	const { describe, test, expect, beforeEach, afterEach } = import.meta.vitest
	const path = await import('node:path')
	const { mkdir, mkdtemp, rm, readFile, stat, writeFile } = await import('node:fs/promises')
	const { tmpdir } = await import('node:os')
	const { exec } = await import('../../utils/shell.ts')

	type Fixture = { work: string; bare: string; prdsDir: string; deps: BackendDeps }

	async function setup(): Promise<Fixture> {
		const bare = await mkdtemp(path.join(tmpdir(), 'trowel-file-bare-'))
		await exec('git', ['init', '--bare', '-q', '-b', 'main', bare])
		const work = await mkdtemp(path.join(tmpdir(), 'trowel-file-work-'))
		await exec('git', ['-C', work, 'init', '-q', '-b', 'main'])
		await exec('git', ['-C', work, 'config', 'user.email', 't@t.t'])
		await exec('git', ['-C', work, 'config', 'user.name', 'T'])
		await exec('git', ['-C', work, 'remote', 'add', 'origin', bare])
		await exec('git', ['-C', work, 'commit', '-q', '--allow-empty', '-m', 'init'])
		await exec('git', ['-C', work, 'push', '-q', '-u', 'origin', 'main'])
		const prdsDir = path.join(work, 'docs', 'prds')
		const deps: BackendDeps = {
			gh: async () => ({ ok: true, stdout: '', stderr: '' }),
			repoRoot: work,
			projectRoot: work,
			baseBranch: 'main',
			branchPrefix: null,
			prdsDir,
			docMsg: 'docs(prd-${id}): land context for ${title}',
			labels: { prd: 'prd', readyForAgent: 'ready-for-agent', needsRevision: 'needs-revision' },
			closeOptions: { comment: null, deleteBranch: 'never' },
			confirm: async () => false,
		}
		return { work, bare, prdsDir, deps }
	}

	async function teardown(f: Fixture | undefined) {
		if (!f) return
		await rm(f.work, { recursive: true, force: true })
		await rm(f.bare, { recursive: true, force: true })
	}

	async function exists(p: string): Promise<boolean> {
		try {
			await stat(p)
			return true
		} catch {
			return false
		}
	}

	describe('file backend: createPrd', () => {
		let f: Fixture
		beforeEach(async () => {
			f = await setup()
		})
		afterEach(async () => {
			await teardown(f)
		})

		test('writes README.md and store.json under <prdsDir>/<id>-<slug>/ and returns matching id+branch', async () => {
			const backend = createFileBackend(f.deps)
			const result = await backend.createPrd({ title: 'Fix Tabs', body: '# Hi\n\nthe body' })
			expect(result.id).toMatch(/^[a-z0-9]{6}$/)
			expect(result.branch).toBe(`prd/${result.id}-fix-tabs`)
			const dir = path.join(f.prdsDir, `${result.id}-fix-tabs`)
			expect(await exists(path.join(dir, 'README.md'))).toBe(true)
			expect(await exists(path.join(dir, 'store.json'))).toBe(true)
			const readme = await readFile(path.join(dir, 'README.md'), 'utf8')
			expect(readme).toBe('# Hi\n\nthe body')
			const store = JSON.parse(await readFile(path.join(dir, 'store.json'), 'utf8'))
			expect(store).toMatchObject({ id: result.id, slug: 'fix-tabs', title: 'Fix Tabs', closedAt: null })
			expect(typeof store.createdAt).toBe('string')
		})

		test('creates the integration branch, commits the PRD files, and pushes to origin', async () => {
			const backend = createFileBackend(f.deps)
			const result = await backend.createPrd({ title: 'Add ORM', body: 'spec' })
			const localHead = (await exec('git', ['-C', f.work, 'rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim()
			expect(localHead).toBe(result.branch)
			const remoteRefs = (await exec('git', ['-C', f.work, 'ls-remote', '--heads', 'origin'])).stdout
			expect(remoteRefs).toContain(`refs/heads/${result.branch}`)
			const lastMsg = (await exec('git', ['-C', f.work, 'log', '-1', '--pretty=%s'])).stdout.trim()
			expect(lastMsg).toBe(`docs(prd-${result.id}): land context for Add ORM`)
		})

		test('retries id generation on collision with an existing PRD directory', async () => {
			const ids = ['aaaaaa', 'bbbbbb']
			let i = 0
			const deps: BackendDeps = { ...f.deps, generateId: () => ids[i++]! }
			await mkdir(path.join(f.prdsDir, 'aaaaaa-foo'), { recursive: true })
			const backend = createFileBackend(deps)
			const result = await backend.createPrd({ title: 'Foo', body: 'spec' })
			expect(result.id).toBe('bbbbbb')
			expect(await exists(path.join(f.prdsDir, 'bbbbbb-foo'))).toBe(true)
		})
	})

	describe('file backend: branchForExisting', () => {
		let f: Fixture
		beforeEach(async () => {
			f = await setup()
		})
		afterEach(async () => {
			await teardown(f)
		})

		test('reads slug from store.json and composes the branch with the configured prefix', async () => {
			const backend = createFileBackend(f.deps)
			const { id, branch } = await backend.createPrd({ title: 'Fix Tabs', body: 'spec' })
			expect(await backend.branchForExisting(id)).toBe(branch)
		})

		test('uses the user-provided branchPrefix when set, overriding default', async () => {
			const deps: BackendDeps = { ...f.deps, branchPrefix: 'feat/' }
			const backend = createFileBackend(deps)
			const { id } = await backend.createPrd({ title: 'Fix Tabs', body: 'spec' })
			expect(await backend.branchForExisting(id)).toBe(`feat/${id}-fix-tabs`)
		})

		test('throws when no PRD directory exists for the id', async () => {
			const backend = createFileBackend(f.deps)
			await expect(backend.branchForExisting('zzzzzz')).rejects.toThrow(/no PRD/i)
		})
	})

	describe('file backend: listOpen', () => {
		let f: Fixture
		beforeEach(async () => {
			f = await setup()
		})
		afterEach(async () => {
			await teardown(f)
		})

		test('returns empty array when prdsDir does not exist', async () => {
			const backend = createFileBackend(f.deps)
			expect(await backend.listOpen()).toEqual([])
		})

		test('returns one summary per PRD with closedAt === null, skipping closed ones', async () => {
			const alphaDir = path.join(f.prdsDir, 'aaaaaa-alpha')
			const betaDir = path.join(f.prdsDir, 'bbbbbb-beta')
			await mkdir(alphaDir, { recursive: true })
			await mkdir(betaDir, { recursive: true })
			await writeFile(
				path.join(alphaDir, 'store.json'),
				JSON.stringify({
					id: 'aaaaaa',
					slug: 'alpha',
					title: 'Alpha',
					createdAt: '2026-05-11T00:00:00.000Z',
					closedAt: '2026-05-11T01:00:00.000Z',
				}),
			)
			await writeFile(
				path.join(betaDir, 'store.json'),
				JSON.stringify({
					id: 'bbbbbb',
					slug: 'beta',
					title: 'Beta',
					createdAt: '2026-05-11T00:00:00.000Z',
					closedAt: null,
				}),
			)

			const backend = createFileBackend(f.deps)
			const open = await backend.listOpen()
			expect(open).toHaveLength(1)
			expect(open[0]).toEqual({ id: 'bbbbbb', title: 'Beta', branch: 'prd/bbbbbb-beta' })
		})
	})

	describe('file backend: close', () => {
		let f: Fixture
		beforeEach(async () => {
			f = await setup()
		})
		afterEach(async () => {
			await teardown(f)
		})

		test('sets closedAt in store.json and commits the change (does not touch branches)', async () => {
			const backend = createFileBackend(f.deps)
			const { id, branch } = await backend.createPrd({ title: 'Alpha', body: 'a' })
			await backend.close(id)
			const storePath = path.join(f.prdsDir, `${id}-alpha`, 'store.json')
			const store = JSON.parse(await readFile(storePath, 'utf8'))
			expect(store.closedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
			const lastMsg = (await exec('git', ['-C', f.work, 'log', '-1', '--pretty=%s'])).stdout.trim()
			expect(lastMsg).toBe(`docs(prd-${id}): close`)
			// Branch must still exist — branch deletion is orchestrator's job.
			const remoteRefs = (await exec('git', ['-C', f.work, 'ls-remote', '--heads', 'origin'])).stdout
			expect(remoteRefs).toContain(`refs/heads/${branch}`)
			const localRefs = (await exec('git', ['-C', f.work, 'branch', '--list', branch])).stdout
			expect(localRefs.trim()).not.toBe('')
		})

		test('idempotent: re-running close on a closed PRD is a no-op', async () => {
			const backend = createFileBackend(f.deps)
			const { id } = await backend.createPrd({ title: 'Alpha', body: 'a' })
			await backend.close(id)
			const storePath = path.join(f.prdsDir, `${id}-alpha`, 'store.json')
			const firstClosedAt = JSON.parse(await readFile(storePath, 'utf8')).closedAt
			const commitCountBefore = (await exec('git', ['-C', f.work, 'rev-list', '--count', 'HEAD'])).stdout.trim()
			await backend.close(id)
			const secondClosedAt = JSON.parse(await readFile(storePath, 'utf8')).closedAt
			expect(secondClosedAt).toBe(firstClosedAt)
			const commitCountAfter = (await exec('git', ['-C', f.work, 'rev-list', '--count', 'HEAD'])).stdout.trim()
			expect(commitCountAfter).toBe(commitCountBefore)
		})
	})

	describe('file backend: createSlice', () => {
		let f: Fixture
		beforeEach(async () => {
			f = await setup()
		})
		afterEach(async () => {
			await teardown(f)
		})

		test('writes README.md and store.json under <prdDir>/slices/<id>-<slug>/ and returns the Slice', async () => {
			const backend = createFileBackend(f.deps)
			const { id: prdId } = await backend.createPrd({ title: 'Add ORM', body: 'prd-spec' })

			const slice = await backend.createSlice(prdId, { title: 'Implement Tab Parser', body: '# spec\nbody' })
			expect(slice.id).toMatch(/^[a-z0-9]{6}$/)
			expect(slice.title).toBe('Implement Tab Parser')
			expect(slice.body).toBe('# spec\nbody')
			expect(slice.state).toBe('OPEN')
			expect(slice.readyForAgent).toBe(false)
			expect(slice.needsRevision).toBe(false)

			const dir = path.join(f.prdsDir, `${prdId}-add-orm`, 'slices', `${slice.id}-implement-tab-parser`)
			expect(await exists(path.join(dir, 'README.md'))).toBe(true)
			expect(await exists(path.join(dir, 'store.json'))).toBe(true)
		})

		test('retries id generation on collision (across all PRDs slices/)', async () => {
			const ids = ['ccccc1', 'aaaaaa', 'bbbbbb']
			let i = 0
			const deps: BackendDeps = { ...f.deps, generateId: () => ids[i++]! }
			const backend = createFileBackend(deps)

			const { id: prdId } = await backend.createPrd({ title: 'P', body: 'b' })
			// Pre-create a colliding slice dir so 'aaaaaa' is taken.
			await mkdir(path.join(f.prdsDir, `${prdId}-p`, 'slices', 'aaaaaa-pre'), { recursive: true })

			const slice = await backend.createSlice(prdId, { title: 'Foo', body: 'b' })
			expect(slice.id).toBe('bbbbbb')
		})
	})

	describe('file backend: findSlices', () => {
		let f: Fixture
		beforeEach(async () => {
			f = await setup()
		})
		afterEach(async () => {
			await teardown(f)
		})

		test('returns empty array when the PRD has no slices/ directory', async () => {
			const backend = createFileBackend(f.deps)
			const { id: prdId } = await backend.createPrd({ title: 'P', body: 'b' })
			expect(await backend.findSlices(prdId)).toEqual([])
		})

		test('returns one Slice per slice directory with body from README.md and state from closedAt', async () => {
			const backend = createFileBackend(f.deps)
			const { id: prdId } = await backend.createPrd({ title: 'P', body: 'b' })
			const a = await backend.createSlice(prdId, { title: 'Alpha', body: 'aa' })
			const b = await backend.createSlice(prdId, { title: 'Beta', body: 'bb' })
			// Mark b as closed and needsRevision via updateSlice
			await backend.updateSlice(prdId, b.id, { state: 'CLOSED', needsRevision: true })

			const slices = await backend.findSlices(prdId)
			expect(slices).toHaveLength(2)
			const byId = Object.fromEntries(slices.map((s) => [s.id, s]))
			expect(byId[a.id]).toMatchObject({ title: 'Alpha', body: 'aa', state: 'OPEN', readyForAgent: false, needsRevision: false })
			expect(byId[b.id]).toMatchObject({ title: 'Beta', body: 'bb', state: 'CLOSED', needsRevision: true })
		})
	})

	describe('file backend: findSlices computes bucket', () => {
		let f: Fixture
		beforeEach(async () => {
			f = await setup()
		})
		afterEach(async () => {
			await teardown(f)
		})

		test('OPEN slice with no readiness flags → draft', async () => {
			const backend = createFileBackend(f.deps)
			const { id: prdId } = await backend.createPrd({ title: 'P', body: 'b' })
			await backend.createSlice(prdId, { title: 'A', body: 'spec' })
			const [s] = await backend.findSlices(prdId)
			expect(s!.bucket).toBe('draft')
		})

		test('readyForAgent and no deps → ready', async () => {
			const backend = createFileBackend(f.deps)
			const { id: prdId } = await backend.createPrd({ title: 'P', body: 'b' })
			const s = await backend.createSlice(prdId, { title: 'A', body: 'spec' })
			await backend.updateSlice(prdId, s.id, { readyForAgent: true })
			const [updated] = await backend.findSlices(prdId)
			expect(updated!.bucket).toBe('ready')
		})

		test('needsRevision → needs-revision (regardless of readyForAgent)', async () => {
			const backend = createFileBackend(f.deps)
			const { id: prdId } = await backend.createPrd({ title: 'P', body: 'b' })
			const s = await backend.createSlice(prdId, { title: 'A', body: 'spec' })
			await backend.updateSlice(prdId, s.id, { needsRevision: true, readyForAgent: true })
			const [updated] = await backend.findSlices(prdId)
			expect(updated!.bucket).toBe('needs-revision')
		})

		test('CLOSED → done', async () => {
			const backend = createFileBackend(f.deps)
			const { id: prdId } = await backend.createPrd({ title: 'P', body: 'b' })
			const s = await backend.createSlice(prdId, { title: 'A', body: 'spec' })
			await backend.updateSlice(prdId, s.id, { state: 'CLOSED' })
			const [updated] = await backend.findSlices(prdId)
			expect(updated!.bucket).toBe('done')
		})

		test('slice with Depends-on: pointing to a non-done slice → blocked', async () => {
			const backend = createFileBackend(f.deps)
			const { id: prdId } = await backend.createPrd({ title: 'P', body: 'b' })
			const a = await backend.createSlice(prdId, { title: 'A', body: 'spec' })
			const b = await backend.createSlice(prdId, { title: 'B', body: `b spec\n\nDepends-on: ${a.id}` })
			await backend.updateSlice(prdId, b.id, { readyForAgent: true })
			const slices = await backend.findSlices(prdId)
			const bAfter = slices.find((s) => s.id === b.id)!
			expect(bAfter.bucket).toBe('blocked')
		})

		test('slice with Depends-on: pointing to a done slice → ready (dep satisfied)', async () => {
			const backend = createFileBackend(f.deps)
			const { id: prdId } = await backend.createPrd({ title: 'P', body: 'b' })
			const a = await backend.createSlice(prdId, { title: 'A', body: 'spec' })
			const b = await backend.createSlice(prdId, { title: 'B', body: `b spec\n\nDepends-on: ${a.id}` })
			await backend.updateSlice(prdId, a.id, { state: 'CLOSED' })
			await backend.updateSlice(prdId, b.id, { readyForAgent: true })
			const slices = await backend.findSlices(prdId)
			const bAfter = slices.find((s) => s.id === b.id)!
			expect(bAfter.bucket).toBe('ready')
		})

		test('file backend never returns in-flight (no PR concept)', async () => {
			const backend = createFileBackend(f.deps)
			const { id: prdId } = await backend.createPrd({ title: 'P', body: 'b' })
			const s = await backend.createSlice(prdId, { title: 'A', body: 'spec' })
			await backend.updateSlice(prdId, s.id, { readyForAgent: true })
			const slices = await backend.findSlices(prdId)
			expect(slices.every((x) => x.bucket !== 'in-flight')).toBe(true)
		})
	})

	describe('file backend: findPrd', () => {
		let f: Fixture
		beforeEach(async () => {
			f = await setup()
		})
		afterEach(async () => {
			await teardown(f)
		})

		test('returns null when no PRD exists for id', async () => {
			const backend = createFileBackend(f.deps)
			expect(await backend.findPrd('zzzzzz')).toBeNull()
		})

		test('returns PrdRecord with state=OPEN for an open PRD', async () => {
			const backend = createFileBackend(f.deps)
			const { id, branch } = await backend.createPrd({ title: 'Alpha', body: 'a' })
			expect(await backend.findPrd(id)).toEqual({ id, branch, title: 'Alpha', state: 'OPEN' })
		})

		test('returns PrdRecord with state=CLOSED after close', async () => {
			const deps: BackendDeps = { ...f.deps, closeOptions: { comment: null, deleteBranch: 'never' } }
			const backend = createFileBackend(deps)
			const { id, branch } = await backend.createPrd({ title: 'Beta', body: 'b' })
			await backend.close(id)
			expect(await backend.findPrd(id)).toEqual({ id, branch, title: 'Beta', state: 'CLOSED' })
		})
	})

	describe('file backend: updateSlice', () => {
		let f: Fixture
		beforeEach(async () => {
			f = await setup()
		})
		afterEach(async () => {
			await teardown(f)
		})

		test('flips readyForAgent and needsRevision', async () => {
			const backend = createFileBackend(f.deps)
			const { id: prdId } = await backend.createPrd({ title: 'P', body: 'b' })
			const s = await backend.createSlice(prdId, { title: 'Foo', body: 'b' })

			await backend.updateSlice(prdId, s.id, { readyForAgent: true })
			let store = JSON.parse(await readFile(path.join(f.prdsDir, `${prdId}-p`, 'slices', `${s.id}-foo`, 'store.json'), 'utf8'))
			expect(store.readyForAgent).toBe(true)
			expect(store.needsRevision).toBe(false)

			await backend.updateSlice(prdId, s.id, { needsRevision: true, readyForAgent: false })
			store = JSON.parse(await readFile(path.join(f.prdsDir, `${prdId}-p`, 'slices', `${s.id}-foo`, 'store.json'), 'utf8'))
			expect(store.readyForAgent).toBe(false)
			expect(store.needsRevision).toBe(true)
		})

		test('setting state CLOSED stamps closedAt; setting state OPEN clears it', async () => {
			const backend = createFileBackend(f.deps)
			const { id: prdId } = await backend.createPrd({ title: 'P', body: 'b' })
			const s = await backend.createSlice(prdId, { title: 'Foo', body: 'b' })

			await backend.updateSlice(prdId, s.id, { state: 'CLOSED' })
			let store = JSON.parse(await readFile(path.join(f.prdsDir, `${prdId}-p`, 'slices', `${s.id}-foo`, 'store.json'), 'utf8'))
			expect(store.closedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)

			await backend.updateSlice(prdId, s.id, { state: 'OPEN' })
			store = JSON.parse(await readFile(path.join(f.prdsDir, `${prdId}-p`, 'slices', `${s.id}-foo`, 'store.json'), 'utf8'))
			expect(store.closedAt).toBeNull()
		})

		test('throws when the slice does not exist', async () => {
			const backend = createFileBackend(f.deps)
			const { id: prdId } = await backend.createPrd({ title: 'P', body: 'b' })
			await expect(backend.updateSlice(prdId, 'zzzzzz', { readyForAgent: true })).rejects.toThrow(/no slice/i)
		})
	})
}
