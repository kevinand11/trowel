import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { allocateNextId } from '../../utils/id.ts'
import { slug as slugify } from '../../utils/slug.ts'
import type { Change, CreateChange, CreateSlice, Slice, Storage, StorageDeps, StorageFactory } from '../types.ts'

type ChangeStore = {
	id: string
	slug: string
	title: string
	createdAt: string
	closedAt: string | null
	targetBranch: string
	changeBranch: string
}
type ChangeStoreDraft = Omit<ChangeStore, 'targetBranch' | 'changeBranch'> & Partial<Pick<ChangeStore, 'targetBranch' | 'changeBranch'>>
type SliceStore = Omit<ChangeStore, 'targetBranch' | 'changeBranch'> & {
	implementedAt: string | null
	auditedAt: string | null
	sliceBranch: string | null
	readyForAgent: boolean
	blockedBy: string[]
}
type SliceStoreDraft = SliceStore
type TestSliceSpec = CreateSlice & { blockedBy?: string[] }
type SlicePatch = Partial<Pick<Slice, 'readyForAgent' | 'closedAt' | 'implementedAt' | 'auditedAt' | 'blockedBy'>>

function applyValuePatch<T, K extends keyof T>(store: T, key: K, value: T[K] | undefined): void {
	if (value !== undefined) store[key] = value
}

function jsonWithNewline(value: unknown): string {
	return `${JSON.stringify(value, null, 2)}\n`
}

async function readdirOrEmpty(dir: string): Promise<string[]> {
	try {
		return await readdir(dir)
	} catch {
		return []
	}
}

function validateChangeStore(value: unknown, source: string): ChangeStore {
	const store = value as Partial<ChangeStore>
	const missing = ['targetBranch', 'changeBranch'].filter(
		(key) => typeof store[key as keyof ChangeStore] !== 'string' || store[key as keyof ChangeStore] === '',
	)
	if (missing.length > 0) throw new Error(`${source} is missing required Change branch metadata: ${missing.join(', ')}`)
	return store as ChangeStore
}

export const createFileStorage: StorageFactory = (deps) => {
	async function findChangeDir(id: string): Promise<string> {
		let entries: string[]
		try {
			entries = await readdir(deps.changesDir)
		} catch {
			throw new Error(`no Change directory found for id '${id}' (changesDir does not exist)`)
		}
		const match = entries.find((e) => e.startsWith(`${id}-`))
		if (!match) throw new Error(`no Change directory found for id '${id}'`)
		return path.join(deps.changesDir, match)
	}

	async function slicesDir(changeId: string): Promise<string> {
		return path.join(await findChangeDir(changeId), 'slices')
	}

	async function findSliceDir(changeId: string, sliceId: string): Promise<string> {
		const dir = await slicesDir(changeId)
		let entries: string[]
		try {
			entries = await readdir(dir)
		} catch {
			throw new Error(`no slice directory found for '${sliceId}' under Change '${changeId}'`)
		}
		const match = entries.find((e) => e.startsWith(`${sliceId}-`))
		if (!match) throw new Error(`no slice directory found for '${sliceId}' under Change '${changeId}'`)
		return path.join(dir, match)
	}

	async function closeStore(dir: string): Promise<void> {
		const storePath = path.join(dir, 'store.json')
		const store = validateChangeStore(JSON.parse(await readFile(storePath, 'utf8')), storePath)
		if (store.closedAt !== null) return
		store.closedAt = new Date().toISOString()
		await writeFile(storePath, jsonWithNewline(store))
	}

	async function updateSliceStore(changeId: string, sliceId: string, patch: SlicePatch): Promise<void> {
		const storePath = path.join(await findSliceDir(changeId, sliceId), 'store.json')
		const store = JSON.parse(await readFile(storePath, 'utf8')) as SliceStore
		if (patch.readyForAgent !== undefined) store.readyForAgent = patch.readyForAgent
		if (patch.blockedBy !== undefined) store.blockedBy = [...patch.blockedBy]
		if (patch.closedAt !== undefined) store.closedAt = patch.closedAt
		if (patch.implementedAt !== undefined) store.implementedAt = patch.implementedAt
		if (patch.auditedAt !== undefined) store.auditedAt = patch.auditedAt
		await writeFile(storePath, jsonWithNewline(store))
	}

	async function changeFromDir(dir: string): Promise<Change> {
		const storePath = path.join(dir, 'store.json')
		const store = validateChangeStore(JSON.parse(await readFile(storePath, 'utf8')), storePath)
		const body = await readFile(path.join(dir, 'README.md'), 'utf8')
		return {
			id: store.id,
			title: store.title,
			body,
			createdAt: store.createdAt,
			closedAt: store.closedAt,
			targetBranch: store.targetBranch,
			changeBranch: store.changeBranch,
		}
	}

	async function sliceFromDir(dir: string): Promise<Slice> {
		const storePath = path.join(dir, 'store.json')
		const store = JSON.parse(await readFile(storePath, 'utf8')) as SliceStore
		if (store.sliceBranch !== null && (typeof store.sliceBranch !== 'string' || store.sliceBranch.length === 0))
			throw new Error(`${storePath} is missing required Slice branch metadata: sliceBranch`)
		const body = await readFile(path.join(dir, 'README.md'), 'utf8')
		return {
			id: store.id,
			title: store.title,
			body,
			closedAt: store.closedAt,
			implementedAt: store.implementedAt ?? null,
			auditedAt: store.auditedAt ?? null,
			readyForAgent: store.readyForAgent,
			blockedBy: store.blockedBy ?? [],
			sliceBranch: store.sliceBranch,
		}
	}

	return {
		createChange: async (spec) => {
			const slug = slugify(spec.title)
			const id = await allocateNextId(deps.changesDir)
			const dir = path.join(deps.changesDir, `${id}-${slug}`)

			await mkdir(dir, { recursive: true })
			await writeFile(path.join(dir, 'README.md'), spec.body)
			await writeFile(
				path.join(dir, 'store.json'),
				jsonWithNewline({
					id,
					slug,
					title: spec.title,
					createdAt: new Date().toISOString(),
					closedAt: null,
				}),
			)

			return { id, title: spec.title }
		},
		findChange: async (id) => {
			try {
				return await changeFromDir(await findChangeDir(id))
			} catch (error) {
				if (error instanceof Error && /no Change directory found/.test(error.message)) return null
				throw error
			}
		},
		listChanges: async () => {
			const changes: Change[] = []
			for (const entry of await readdirOrEmpty(deps.changesDir)) changes.push(await changeFromDir(path.join(deps.changesDir, entry)))
			return changes
		},
		finalizeChange: async (id) => closeStore(await findChangeDir(id)),
		abortChange: async (id) => closeStore(await findChangeDir(id)),
		updateChangeMetadata: async (changeId, patch) => {
			const storePath = path.join(await findChangeDir(changeId), 'store.json')
			const store = JSON.parse(await readFile(storePath, 'utf8')) as ChangeStoreDraft
			applyValuePatch(store, 'targetBranch', patch.targetBranch)
			applyValuePatch(store, 'changeBranch', patch.changeBranch)
			await writeFile(storePath, jsonWithNewline(store))
		},
		createSlice: async (changeId, spec) => {
			const slug = slugify(spec.title)
			const id = await allocateNextId(deps.changesDir)
			const dir = path.join(await slicesDir(changeId), `${id}-${slug}`)

			await mkdir(dir, { recursive: true })
			await writeFile(path.join(dir, 'README.md'), spec.body)
			const store: SliceStoreDraft = {
				id,
				slug,
				title: spec.title,
				createdAt: new Date().toISOString(),
				closedAt: null,
				implementedAt: null,
				auditedAt: null,
				sliceBranch: null,
				readyForAgent: false,
				blockedBy: [],
			}
			await writeFile(path.join(dir, 'store.json'), jsonWithNewline(store))

			return { id, title: spec.title }
		},
		findSlices: async (changeId) => {
			let slicesPath: string
			try {
				slicesPath = await slicesDir(changeId)
			} catch {
				return []
			}

			const result: Slice[] = []
			for (const entry of await readdirOrEmpty(slicesPath)) result.push(await sliceFromDir(path.join(slicesPath, entry)))
			return result
		},
		setSliceReadyForAgent: async (changeId, sliceId, ready) => updateSliceStore(changeId, sliceId, { readyForAgent: ready }),
		setSliceBlockers: async (changeId, sliceId, blockedBy) => updateSliceStore(changeId, sliceId, { blockedBy }),
		markSliceImplemented: async (changeId, sliceId, at) => updateSliceStore(changeId, sliceId, { implementedAt: at }),
		markSliceAudited: async (changeId, sliceId, at) => updateSliceStore(changeId, sliceId, { auditedAt: at }),
		finalizeSlice: async (changeId, sliceId) => updateSliceStore(changeId, sliceId, { closedAt: new Date().toISOString() }),
		abortSlice: async (changeId, sliceId) => updateSliceStore(changeId, sliceId, { closedAt: new Date().toISOString() }),
		updateSliceMetadata: async (changeId, sliceId, patch) => {
			const storePath = path.join(await findSliceDir(changeId, sliceId), 'store.json')
			const store = JSON.parse(await readFile(storePath, 'utf8')) as SliceStoreDraft
			applyValuePatch(store, 'sliceBranch', patch.sliceBranch)
			await writeFile(storePath, jsonWithNewline(store))
		},
	}
}

if (import.meta.vitest) {
	const { describe, test, expect } = import.meta.vitest
	const path = await import('node:path')
	const { mkdir, mkdtemp, rm, readFile, stat, writeFile } = await import('node:fs/promises')
	const { tmpdir } = await import('node:os')
	const { recordingGhOps } = await import('../../test-utils/gh-ops-recorder.ts')
	const { noopGitOps } = await import('../../test-utils/git-ops-fixtures.ts')

	type Fixture = {
		work: string
		changesDir: string
		deps: StorageDeps
		calls: { log: string[] }
	}

	const storageTest = test.extend<{ f: Fixture }>({
		f: async ({ task: _ }, use) => {
			const work = await mkdtemp(path.join(tmpdir(), 'trowel-file-'))
			const changesDir = path.join(work, 'docs', 'changes')
			const calls: { log: string[] } = { log: [] }
			const git = noopGitOps()
			const { gh } = recordingGhOps()
			const deps: StorageDeps = {
				gh,
				changesDir,
				labels: { change: 'change', readyForAgent: 'ready-for-agent', needsRevision: 'needs-revision' },
				git,
			}
			const f: Fixture = { work, changesDir, deps, calls }
			try {
				await use(f)
			} finally {
				await rm(f.work, { recursive: true, force: true })
			}
		},
	})

	async function exists(p: string): Promise<boolean> {
		try {
			await stat(p)
			return true
		} catch {
			return false
		}
	}

	async function writeChangeStoreFixture(
		f: Fixture,
		entry: { id: string; slug: string; title: string; createdAt: string; closedAt: string | null },
	): Promise<void> {
		const dir = path.join(f.changesDir, `${entry.id}-${entry.slug}`)
		await mkdir(dir, { recursive: true })
		await writeFile(path.join(dir, 'README.md'), `${entry.title} body`)
		await writeFile(
			path.join(dir, 'store.json'),
			JSON.stringify({ ...entry, targetBranch: 'main', changeBranch: `change-${entry.id}-${entry.slug}` }),
		)
	}

	async function readChangeStoreJson(f: Fixture, id: string, slug: string): Promise<Record<string, unknown>> {
		return JSON.parse(await readFile(path.join(f.changesDir, `${id}-${slug}`, 'store.json'), 'utf8')) as Record<string, unknown>
	}

	async function createMaterialisedChange(
		storage: Storage,
		spec: CreateChange = { title: 'P', body: 'b' },
		targetBranch = 'main',
	): Promise<{ id: string; title: string; changeBranch: string }> {
		const created = await storage.createChange(spec)
		const changeBranch = `${created.id}-${slugify(created.title)}`
		await storage.updateChangeMetadata(created.id, { targetBranch, changeBranch })
		return { ...created, changeBranch }
	}

	async function createMaterialisedSlice(
		storage: Storage,
		changeId: string,
		spec: TestSliceSpec = { title: 'A', body: 'spec' },
		sliceBranch?: string,
	): Promise<Slice> {
		const created = await storage.createSlice(changeId, { title: spec.title, body: spec.body })
		await storage.updateSliceMetadata(changeId, created.id, {
			sliceBranch: sliceBranch ?? `${changeId}/${created.id}-${slugify(created.title)}`,
		})
		if (spec.blockedBy !== undefined) await storage.setSliceBlockers(changeId, created.id, spec.blockedBy)
		return (await storage.findSlices(changeId)).find((s) => s.id === created.id)!
	}

	async function createChangeWithSlice(
		f: Fixture,
		spec: TestSliceSpec = { title: 'A', body: 'spec' },
	): Promise<{ storage: Storage; changeId: string; slice: Slice }> {
		const storage = createFileStorage(f.deps)
		const { id: changeId } = await createMaterialisedChange(storage)
		const slice = await createMaterialisedSlice(storage, changeId, spec)
		return { storage, changeId, slice }
	}

	describe('file storage: createChange', () => {
		storageTest('writes README.md and store.json under <changesDir>/<id>-<slug>/ and returns matching id+title', async ({ f }) => {
			const storage = createFileStorage(f.deps)
			const result = await storage.createChange({ title: 'Fix Tabs', body: '# Hi\n\nthe body' })
			expect(result.title).toBe('Fix Tabs')
			const dir = path.join(f.changesDir, `${result.id}-fix-tabs`)
			expect(await exists(path.join(dir, 'README.md'))).toBe(true)
			expect(await exists(path.join(dir, 'store.json'))).toBe(true)
			const readme = await readFile(path.join(dir, 'README.md'), 'utf8')
			expect(readme).toBe('# Hi\n\nthe body')
			const store = JSON.parse(await readFile(path.join(dir, 'store.json'), 'utf8'))
			expect(store).toMatchObject({ id: result.id, slug: 'fix-tabs', title: 'Fix Tabs', closedAt: null })
			expect(store).not.toHaveProperty('changeBranch')
			expect(store).not.toHaveProperty('targetBranch')
			expect(typeof store.createdAt).toBe('string')
		})

		storageTest('updateChangeMetadata persists targetBranch and changeBranch', async ({ f }) => {
			const storage = createFileStorage(f.deps)
			const result = await storage.createChange({ title: 'Ship From Release', body: 'spec' })
			await storage.updateChangeMetadata(result.id, { targetBranch: 'release/1.2', changeBranch: `${result.id}-ship-from-release` })

			const dir = path.join(f.changesDir, `${result.id}-ship-from-release`)
			const store = JSON.parse(await readFile(path.join(dir, 'store.json'), 'utf8'))
			expect(store.targetBranch).toBe('release/1.2')
			expect(store.changeBranch).toBe(`${result.id}-ship-from-release`)
			expect((await storage.findChange(result.id))?.targetBranch).toBe('release/1.2')
		})
	})

	describe('file storage: listChanges', () => {
		storageTest('returns empty array when changesDir does not exist', async ({ f }) => {
			const storage = createFileStorage(f.deps)
			expect(await storage.listChanges()).toEqual([])
		})

		storageTest('returns both open and closed Changes', async ({ f }) => {
			await writeChangeStoreFixture(f, {
				id: 'aaaaaa',
				slug: 'alpha',
				title: 'Alpha',
				createdAt: '2026-05-11T00:00:00.000Z',
				closedAt: '2026-05-11T01:00:00.000Z',
			})
			await writeChangeStoreFixture(f, {
				id: 'bbbbbb',
				slug: 'beta',
				title: 'Beta',
				createdAt: '2026-05-11T00:00:00.000Z',
				closedAt: null,
			})

			const storage = createFileStorage(f.deps)
			const all = await storage.listChanges()
			expect(all).toHaveLength(2)
			expect(all.map((p) => p.id).sort()).toEqual(['aaaaaa', 'bbbbbb'])
		})

		storageTest('returns Changes with their createdAt populated (consumer sorts; see `trowel list`)', async ({ f }) => {
			const dirs = [
				{ name: 'aaaaaa-old', id: 'aaaaaa', slug: 'old', createdAt: '2026-05-01T00:00:00.000Z' },
				{ name: 'bbbbbb-new', id: 'bbbbbb', slug: 'new', createdAt: '2026-05-12T00:00:00.000Z' },
			]
			for (const d of dirs) {
				const dir = path.join(f.changesDir, d.name)
				await mkdir(dir, { recursive: true })
				await writeFile(path.join(dir, 'README.md'), `${d.id} body`)
				await writeFile(
					path.join(dir, 'store.json'),
					JSON.stringify({
						id: d.id,
						slug: d.slug,
						title: d.id,
						createdAt: d.createdAt,
						closedAt: null,
						targetBranch: 'main',
						changeBranch: `change-${d.id}-${d.slug}`,
					}),
				)
			}

			const storage = createFileStorage(f.deps)
			const out = await storage.listChanges()
			expect(out.find((p) => p.id === 'aaaaaa')!.createdAt).toBe('2026-05-01T00:00:00.000Z')
			expect(out.find((p) => p.id === 'bbbbbb')!.createdAt).toBe('2026-05-12T00:00:00.000Z')
		})
	})

	describe('file storage: close', () => {
		storageTest('sets closedAt in store.json', async ({ f }) => {
			const storage = createFileStorage(f.deps)
			const { id } = await createMaterialisedChange(storage, { title: 'Alpha', body: 'a' })
			await storage.finalizeChange(id)
			expect((await readChangeStoreJson(f, id, 'alpha')).closedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
		})

		storageTest('idempotent: re-running close on a closed Change keeps the same closedAt', async ({ f }) => {
			const storage = createFileStorage(f.deps)
			const { id } = await createMaterialisedChange(storage, { title: 'Alpha', body: 'a' })
			await storage.finalizeChange(id)
			const firstClosedAt = (await readChangeStoreJson(f, id, 'alpha')).closedAt
			await storage.finalizeChange(id)
			const secondClosedAt = (await readChangeStoreJson(f, id, 'alpha')).closedAt
			expect(secondClosedAt).toBe(firstClosedAt)
		})
	})

	describe('file storage: createSlice', () => {

		storageTest('writes README.md and store.json under <changeDir>/slices/<id>-<slug>/ and returns id+title', async ({ f }) => {
			const storage = createFileStorage(f.deps)
			const { id: changeId } = await storage.createChange({ title: 'Add ORM', body: 'change-spec' })

			const slice = await storage.createSlice(changeId, { title: 'Implement Tab Parser', body: '# spec\nbody' })
			expect(slice.title).toBe('Implement Tab Parser')

			const dir = path.join(f.changesDir, `${changeId}-add-orm`, 'slices', `${slice.id}-implement-tab-parser`)
			expect(await exists(path.join(dir, 'README.md'))).toBe(true)
			expect(await exists(path.join(dir, 'store.json'))).toBe(true)
			const store = JSON.parse(await readFile(path.join(dir, 'store.json'), 'utf8'))
			expect(store.sliceBranch).toBeNull()
			expect(store).not.toHaveProperty('needsRevision')
			expect((await storage.findSlices(changeId))[0]).toMatchObject({ id: slice.id, sliceBranch: null })
		})
	})

	describe('file storage: findSlices', () => {
		storageTest('returns empty array when the Change has no slices/ directory', async ({ f }) => {
			const storage = createFileStorage(f.deps)
			const { id: changeId } = await storage.createChange({ title: 'P', body: 'b' })
			expect(await storage.findSlices(changeId)).toEqual([])
		})

		storageTest('returned slices have prState=null (file storage has no PR concept)', async ({ f }) => {
			const { storage, changeId } = await createChangeWithSlice(f)
			const [s] = await storage.findSlices(changeId)
			expect(s).not.toHaveProperty('prState')
		})

		storageTest('returns one Slice per slice directory with body and raw terminal fields', async ({ f }) => {
			const storage = createFileStorage(f.deps)
			const { id: changeId } = await createMaterialisedChange(storage)
			const a = await createMaterialisedSlice(storage, changeId, { title: 'Alpha', body: 'aa' })
			const b = await createMaterialisedSlice(storage, changeId, { title: 'Beta', body: 'bb' })
			// Mark b as closed; needs-revision is PR-derived and not stored by file storage.
			await storage.finalizeSlice(changeId, b.id)

			const slices = await storage.findSlices(changeId)
			expect(slices).toHaveLength(2)
			const byId = Object.fromEntries(slices.map((s) => [s.id, s]))
			expect(byId[a.id]).toMatchObject({
				title: 'Alpha',
				body: 'aa',
				closedAt: null,
				readyForAgent: false,
			})
			expect(byId[b.id]).toMatchObject({ title: 'Beta', body: 'bb' })
			expect(byId[b.id]!.closedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
		})
	})

	describe('file storage: createSlice round-trips blockedBy', () => {
		storageTest('persists spec.blockedBy to store.json; findSlices returns it on Slice', async ({ f }) => {
			const storage = createFileStorage(f.deps)
			const { id: changeId } = await createMaterialisedChange(storage)
			const slice = await createMaterialisedSlice(storage, changeId, {
				title: 'Needs others',
				body: 'spec',
				blockedBy: ['abc123', 'def456'],
			})
			expect(slice.blockedBy).toEqual(['abc123', 'def456'])

			const found = (await storage.findSlices(changeId)).find((s) => s.id === slice.id)!
			expect(found.blockedBy).toEqual(['abc123', 'def456'])
		})
	})

	describe('file storage: findSlices raw persistence fields', () => {
		storageTest('new slice has raw readiness and terminal fields unset', async ({ f }) => {
			const { storage, changeId } = await createChangeWithSlice(f)
			const [s] = await storage.findSlices(changeId)
			expect(s).toMatchObject({ readyForAgent: false, closedAt: null, implementedAt: null, auditedAt: null, blockedBy: [] })
		})

		storageTest('setSliceReadyForAgent persists readyForAgent=true', async ({ f }) => {
			const { storage, changeId, slice } = await createChangeWithSlice(f)
			await storage.setSliceReadyForAgent(changeId, slice.id, true)
			const [updated] = await storage.findSlices(changeId)
			expect(updated!.readyForAgent).toBe(true)
		})

		storageTest('finalizeSlice persists closedAt', async ({ f }) => {
			const { storage, changeId, slice } = await createChangeWithSlice(f)
			await storage.finalizeSlice(changeId, slice.id)
			const [updated] = await storage.findSlices(changeId)
			expect(updated!.closedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
		})

		storageTest('setSliceBlockers overrides blockedBy with the raw blocker id set', async ({ f }) => {
			const { storage, changeId, slice } = await createChangeWithSlice(f)
			await storage.setSliceBlockers(changeId, slice.id, ['1', '2'])
			const [updated] = await storage.findSlices(changeId)
			expect(updated!.blockedBy).toEqual(['1', '2'])
		})
	})

	describe('file storage: findChange', () => {
		storageTest('returns null when no Change exists for id', async ({ f }) => {
			const storage = createFileStorage(f.deps)
			expect(await storage.findChange('zzzzzz')).toBeNull()
		})

		storageTest('returns Change with closedAt=null for an open Change', async ({ f }) => {
			const storage = createFileStorage(f.deps)
			const { id, changeBranch } = await createMaterialisedChange(storage, { title: 'Alpha', body: 'a' })
			expect(await storage.findChange(id)).toMatchObject({
				id,
				title: 'Alpha',
				body: 'a',
				closedAt: null,
				targetBranch: 'main',
				changeBranch,
			})
		})

		storageTest('returns Change with closedAt set after close', async ({ f }) => {
			const storage = createFileStorage(f.deps)
			const { id, changeBranch } = await createMaterialisedChange(storage, { title: 'Beta', body: 'b' })
			await storage.finalizeChange(id)
			expect(await storage.findChange(id)).toMatchObject({ id, changeBranch, targetBranch: 'main', title: 'Beta' })
			expect((await storage.findChange(id))!.closedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
		})
	})

	describe('file storage: allocateNextId via createChange/createSlice', () => {
		storageTest('first Change gets id "1"', async ({ f }) => {
			const storage = createFileStorage(f.deps)
			const { id } = await storage.createChange({ title: 'First', body: 'a' })
			expect(id).toBe('1')
		})

		storageTest('Changes and slices share one pool: change(1), slice(2), change(3)', async ({ f }) => {
			const storage = createFileStorage(f.deps)
			const first = await storage.createChange({ title: 'First', body: 'a' })
			expect(first.id).toBe('1')
			const slice = await storage.createSlice(first.id, { title: 'Foo', body: 'spec' })
			expect(slice.id).toBe('2')
			const second = await storage.createChange({ title: 'Second', body: 'b' })
			expect(second.id).toBe('3')
			const slice2 = await storage.createSlice(second.id, { title: 'Bar', body: 'spec' })
			expect(slice2.id).toBe('4')
		})

		storageTest('closed Changes reserve their id (counter does not roll back)', async ({ f }) => {
			const storage = createFileStorage(f.deps)
			const first = await createMaterialisedChange(storage, { title: 'First', body: 'a' })
			await storage.finalizeChange(first.id)
			const second = await storage.createChange({ title: 'Second', body: 'b' })
			expect(second.id).toBe('2')
		})
	})

	describe('file storage: branch metadata', () => {
		storageTest('updateChangeMetadata persists one field without clobbering existing branch metadata', async ({ f }) => {
			const storage = createFileStorage(f.deps)
			const { id } = await createMaterialisedChange(storage, { title: 'Branch Metadata', body: 'b' })

			await storage.updateChangeMetadata(id, { changeBranch: 'change-custom' })

			expect(await storage.findChange(id)).toMatchObject({ id, targetBranch: 'main', changeBranch: 'change-custom' })
		})

		storageTest('updateSliceMetadata persists the stored Slice branch', async ({ f }) => {
			const storage = createFileStorage(f.deps)
			const { id: changeId } = await storage.createChange({ title: 'P', body: 'b' })
			const slice = await storage.createSlice(changeId, { title: 'Slice', body: 's' })

			await storage.updateSliceMetadata(changeId, slice.id, { sliceBranch: 'change-custom/slice' })

			expect((await storage.findSlices(changeId))[0]).toMatchObject({ id: slice.id, sliceBranch: 'change-custom/slice' })
		})

		storageTest('findChange fails loudly when required branch metadata is missing', async ({ f }) => {
			await mkdir(path.join(f.changesDir, '1-missing'), { recursive: true })
			await writeFile(
				path.join(f.changesDir, '1-missing', 'store.json'),
				JSON.stringify({ id: '1', slug: 'missing', title: 'Missing', createdAt: '2026-05-17T00:00:00.000Z', closedAt: null }),
			)
			const storage = createFileStorage(f.deps)

			await expect(storage.findChange('1')).rejects.toThrow(/missing required Change branch metadata/)
		})

		storageTest('findSlices fails loudly when required Slice branch metadata is missing', async ({ f }) => {
			await writeChangeStoreFixture(f, { id: '1', slug: 'p', title: 'P', createdAt: '2026-05-17T00:00:00.000Z', closedAt: null })
			await mkdir(path.join(f.changesDir, '1-p', 'slices', '2-s'), { recursive: true })
			await writeFile(path.join(f.changesDir, '1-p', 'slices', '2-s', 'README.md'), 'body')
			await writeFile(
				path.join(f.changesDir, '1-p', 'slices', '2-s', 'store.json'),
				JSON.stringify({
					id: '2',
					slug: 's',
					title: 'S',
					createdAt: '2026-05-17T00:00:00.000Z',
					closedAt: null,
					readyForAgent: false,
					needsRevision: false,
					blockedBy: [],
				}),
			)
			const storage = createFileStorage(f.deps)

			await expect(storage.findSlices('1')).rejects.toThrow(/missing required Slice branch metadata/)
		})
	})

	describe('file storage: updateSlice', () => {
		storageTest('flips readyForAgent without writing needsRevision', async ({ f }) => {
			const { storage, changeId, slice } = await createChangeWithSlice(f, { title: 'Foo', body: 'b' })

			await storage.setSliceReadyForAgent(changeId, slice.id, true)
			let store = JSON.parse(
				await readFile(path.join(f.changesDir, `${changeId}-p`, 'slices', `${slice.id}-foo`, 'store.json'), 'utf8'),
			)
			expect(store.readyForAgent).toBe(true)
			expect(store).not.toHaveProperty('needsRevision')

			await storage.setSliceReadyForAgent(changeId, slice.id, false)
			store = JSON.parse(await readFile(path.join(f.changesDir, `${changeId}-p`, 'slices', `${slice.id}-foo`, 'store.json'), 'utf8'))
			expect(store.readyForAgent).toBe(false)
			expect(store).not.toHaveProperty('needsRevision')
		})

		storageTest('finalizeSlice stamps closedAt', async ({ f }) => {
			const { storage, changeId, slice } = await createChangeWithSlice(f, { title: 'Foo', body: 'b' })

			await storage.finalizeSlice(changeId, slice.id)
			const store = JSON.parse(
				await readFile(path.join(f.changesDir, `${changeId}-p`, 'slices', `${slice.id}-foo`, 'store.json'), 'utf8'),
			)
			expect(store.closedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
		})

		storageTest('updates blockedBy as a full-array replace', async ({ f }) => {
			const storage = createFileStorage(f.deps)
			const { id: changeId } = await createMaterialisedChange(storage)
			const s = await createMaterialisedSlice(storage, changeId, { title: 'Foo', body: 'b', blockedBy: ['old1', 'old2'] })

			await storage.setSliceBlockers(changeId, s.id, ['new1'])
			const found = (await storage.findSlices(changeId)).find((x) => x.id === s.id)!
			expect(found.blockedBy).toEqual(['new1'])

			// Empty array clears blockers.
			await storage.setSliceBlockers(changeId, s.id, [])
			const found2 = (await storage.findSlices(changeId)).find((x) => x.id === s.id)!
			expect(found2.blockedBy).toEqual([])
		})

		storageTest('throws when the slice does not exist', async ({ f }) => {
			const storage = createFileStorage(f.deps)
			const { id: changeId } = await storage.createChange({ title: 'P', body: 'b' })
			await expect(storage.setSliceReadyForAgent(changeId, 'zzzzzz', true)).rejects.toThrow(/no slice/i)
		})
	})
}
