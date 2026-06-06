import {
	allocateNextId,
	loadChanges,
	loadNode,
	writeNode,
	type ChangeStore,
	type ChangeStoreDraft,
	type Node,
	type SliceStore,
	type SliceStoreDraft,
} from './tree'
import type { Change, CreateChange, CreateSlice, Slice, Storage, StorageDeps, StorageFactory } from '../../types'
type TestSliceSpec = CreateSlice & { blockedBy?: string[] }
type SlicePatch = Partial<Pick<Slice, 'readyForAgent' | 'closedAt' | 'implementedAt' | 'auditedAt' | 'blockedBy'>>

function applyValuePatch<T, K extends keyof T>(store: T, key: K, value: T[K] | undefined): void {
	if (value !== undefined) store[key] = value
}

function validateChangeStore(store: ChangeStoreDraft): ChangeStore {
	if (!store.changeBranch || typeof store.changeBranch !== 'string') throw new Error(`${store.id} is missing required change branch`)
	if (!store.targetBranch || typeof store.targetBranch !== 'string') throw new Error(`${store.id} is missing required target branch`)
	return store as ChangeStore
}

function validateSliceStore(store: SliceStoreDraft): SliceStore {
	if (store.sliceBranch !== null && typeof store.sliceBranch !== 'string') throw new Error(`${store.id} is missing required slice branch`)
	return store as SliceStore
}

const entityIdToNodeId = (id: string): number => Number(id)

export const createFileStorage: StorageFactory = (deps) => {
	async function closeChangeStore(changeId: string): Promise<void> {
		const node = await loadNode(deps.changesDir, { type: 'change', id: entityIdToNodeId(changeId) })
		if (node.store.closedAt !== null) return
		node.store.closedAt = new Date().toISOString()
		await writeNode(deps.changesDir, { type: 'change', id: entityIdToNodeId(changeId) }, { store: node.store })
	}

	async function updateSliceStore(changeId: string, sliceId: string, patch: SlicePatch): Promise<void> {
		const node = await loadNode(deps.changesDir, { type: 'slice', changeId: entityIdToNodeId(changeId), id: entityIdToNodeId(sliceId) })
		applyValuePatch(node.store, 'readyForAgent', patch.readyForAgent)
		applyValuePatch(node.store, 'closedAt', patch.closedAt)
		applyValuePatch(node.store, 'implementedAt', patch.implementedAt)
		applyValuePatch(node.store, 'auditedAt', patch.auditedAt)
		if (patch.blockedBy !== undefined) node.store.blockedBy = [...patch.blockedBy]
		await writeNode(
			deps.changesDir,
			{ type: 'slice', changeId: entityIdToNodeId(changeId), id: entityIdToNodeId(sliceId) },
			{ store: node.store },
		)
	}

	function changeFromNode(node: Node<ChangeStoreDraft>): Change {
		const store = validateChangeStore(node.store)
		return {
			id: String(store.id),
			title: store.title,
			body: node.body,
			createdAt: store.createdAt,
			closedAt: store.closedAt,
			targetBranch: store.targetBranch,
			changeBranch: store.changeBranch,
		}
	}

	function sliceFromNode(node: Node<SliceStoreDraft>): Slice {
		const store = validateSliceStore(node.store)
		return {
			id: String(store.id),
			title: store.title,
			body: node.body,
			closedAt: store.closedAt,
			implementedAt: store.implementedAt,
			auditedAt: store.auditedAt,
			readyForAgent: store.readyForAgent,
			blockedBy: store.blockedBy,
			sliceBranch: store.sliceBranch,
		}
	}

	return {
		createChange: async (spec) => {
			const id = await allocateNextId(deps.changesDir)
			await writeNode(
				deps.changesDir,
				{ type: 'change', id },
				{
					body: spec.body,
					store: { id, title: spec.title, createdAt: new Date().toISOString(), closedAt: null },
				},
			)

			return { id: String(id), title: spec.title }
		},
		findChange: async (id) => {
			try {
				const node = await loadNode(deps.changesDir, { type: 'change', id: entityIdToNodeId(id) })
				return changeFromNode(node)
			} catch (error) {
				if (error instanceof Error && /no node found for/.test(error.message)) return null
				throw error
			}
		},
		listChanges: async () => Promise.all((await loadChanges(deps.changesDir)).map(changeFromNode)),
		finalizeChange: async (id) => closeChangeStore(id),
		abortChange: async (id) => closeChangeStore(id),
		updateChangeMetadata: async (changeId, patch) => {
			const node = await loadNode(deps.changesDir, { type: 'change', id: entityIdToNodeId(changeId) })
			applyValuePatch(node.store, 'targetBranch', patch.targetBranch)
			applyValuePatch(node.store, 'changeBranch', patch.changeBranch)
			await writeNode(deps.changesDir, { type: 'change', id: entityIdToNodeId(changeId) }, { store: node.store })
		},
		createSlice: async (changeId, spec) => {
			const id = await allocateNextId(deps.changesDir)
			await writeNode(
				deps.changesDir,
				{ type: 'slice', changeId: entityIdToNodeId(changeId), id },
				{
					body: spec.body,
					store: {
						id,
						title: spec.title,
						createdAt: new Date().toISOString(),
						closedAt: null,
						implementedAt: null,
						auditedAt: null,
						sliceBranch: null,
						readyForAgent: false,
						blockedBy: [],
					},
				},
			)

			return { id: String(id), title: spec.title }
		},
		findSlices: async (changeId) => {
			const node = await loadNode(deps.changesDir, { type: 'change', id: entityIdToNodeId(changeId) })
			return node.slices.map(sliceFromNode)
		},
		setSliceReadyForAgent: async (changeId, sliceId, ready) => updateSliceStore(changeId, sliceId, { readyForAgent: ready }),
		setSliceBlockers: async (changeId, sliceId, blockedBy) => updateSliceStore(changeId, sliceId, { blockedBy }),
		markSliceImplemented: async (changeId, sliceId, at) => updateSliceStore(changeId, sliceId, { implementedAt: at }),
		markSliceAudited: async (changeId, sliceId, at) => updateSliceStore(changeId, sliceId, { auditedAt: at }),
		finalizeSlice: async (changeId, sliceId) => updateSliceStore(changeId, sliceId, { closedAt: new Date().toISOString() }),
		abortSlice: async (changeId, sliceId) => updateSliceStore(changeId, sliceId, { closedAt: new Date().toISOString() }),
		updateSliceMetadata: async (changeId, sliceId, patch) => {
			const node = await loadNode(deps.changesDir, {
				type: 'slice',
				changeId: entityIdToNodeId(changeId),
				id: entityIdToNodeId(sliceId),
			})
			applyValuePatch(node.store, 'sliceBranch', patch.sliceBranch)
			await writeNode(
				deps.changesDir,
				{ type: 'slice', changeId: entityIdToNodeId(changeId), id: entityIdToNodeId(sliceId) },
				{ store: node.store },
			)
		},
	}
}

if (import.meta.vitest) {
	const { describe, test, expect } = import.meta.vitest
	const path = await import('node:path')
	const { slug: slugify } = await import('../../../utils/slug')
	const { mkdtemp, mkdir, rm } = await import('node:fs/promises')
	const { tmpdir } = await import('node:os')
	const { recordingGhOps } = await import('../../../test-utils/gh-ops-recorder')
	const { noopGitOps } = await import('../../../test-utils/git-ops-fixtures')

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
			await mkdir(changesDir, { recursive: true })
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

	async function writeChangeStoreFixture(
		f: Fixture,
		entry: { id: number; slug: string; title: string; createdAt: string; closedAt: string | null },
	): Promise<void> {
		await writeNode(
			f.changesDir,
			{ type: 'change', id: entry.id },
			{
				body: `${entry.title} body`,
				store: {
					id: entry.id,
					title: entry.title,
					createdAt: entry.createdAt,
					closedAt: entry.closedAt,
					targetBranch: 'main',
					changeBranch: `change-${entry.id}-${entry.slug}`,
				},
			},
		)
	}

	async function readChangeStoreJson(f: Fixture, id: string): Promise<Record<string, unknown>> {
		const node = await loadNode(f.changesDir, { type: 'change', id: entityIdToNodeId(id) })
		return node.store
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
		const slices = await storage.findSlices(changeId)
		const slice = slices.find((s) => s.id === created.id)
		if (!slice) throw new Error('created slice not found')
		return slice
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
		storageTest('writes changes node and returns matching id+title', async ({ f }) => {
			const storage = createFileStorage(f.deps)
			const result = await storage.createChange({ title: 'Fix Tabs', body: '# Hi\n\nthe body' })
			expect(result.title).toBe('Fix Tabs')
			const nodeId = entityIdToNodeId(result.id)
			const node = await loadNode(f.changesDir, { type: 'change', id: nodeId })
			expect(node.store).toMatchObject({ id: nodeId, title: 'Fix Tabs', closedAt: null })
			expect(typeof node.store.createdAt).toBe('string')
		})

		storageTest('updateChangeMetadata persists targetBranch and changeBranch', async ({ f }) => {
			const storage = createFileStorage(f.deps)
			const result = await storage.createChange({ title: 'Ship From Release', body: 'spec' })
			await storage.updateChangeMetadata(result.id, { targetBranch: 'release/1.2', changeBranch: `${result.id}-ship-from-release` })

			const node = await loadNode(f.changesDir, { type: 'change', id: entityIdToNodeId(result.id) })
			expect(node.store.targetBranch).toBe('release/1.2')
			expect(node.store.changeBranch).toBe(`${result.id}-ship-from-release`)
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
				id: 1,
				slug: 'alpha',
				title: 'Alpha',
				createdAt: '2026-05-11T00:00:00.000Z',
				closedAt: '2026-05-11T01:00:00.000Z',
			})
			await writeChangeStoreFixture(f, {
				id: 2,
				slug: 'beta',
				title: 'Beta',
				createdAt: '2026-05-11T00:00:00.000Z',
				closedAt: null,
			})

			const storage = createFileStorage(f.deps)
			const all = await storage.listChanges()
			expect(all).toHaveLength(2)
			expect(all.map((p) => p.id).sort()).toEqual(['1', '2'])
		})

		storageTest('returns Changes with their createdAt populated', async ({ f }) => {
			const dirs = [
				{ name: 'aaaaaa-old', id: 1, slug: 'old', createdAt: '2026-05-01T00:00:00.000Z' },
				{ name: 'bbbbbb-new', id: 2, slug: 'new', createdAt: '2026-05-12T00:00:00.000Z' },
			]
			for (const d of dirs)
				await writeNode(
					f.changesDir,
					{ type: 'change', id: d.id },
					{
						body: `${d.id} body`,
						store: {
							id: d.id,
							title: `${d.id}`,
							createdAt: d.createdAt,
							closedAt: null,
							targetBranch: 'main',
							changeBranch: `change-${d.id}-${d.slug}`,
						},
					},
				)

			const storage = createFileStorage(f.deps)
			const out = await storage.listChanges()
			expect(out.find((p) => p.id === '1')!.createdAt).toBe('2026-05-01T00:00:00.000Z')
			expect(out.find((p) => p.id === '2')!.createdAt).toBe('2026-05-12T00:00:00.000Z')
		})
	})

	describe('file storage: close', () => {
		storageTest('sets closedAt', async ({ f }) => {
			const storage = createFileStorage(f.deps)
			const { id } = await createMaterialisedChange(storage, { title: 'Alpha', body: 'a' })
			await storage.finalizeChange(id)
			expect((await readChangeStoreJson(f, id)).closedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
		})

		storageTest('idempotent: re-running close on a closed Change keeps the same closedAt', async ({ f }) => {
			const storage = createFileStorage(f.deps)
			const { id } = await createMaterialisedChange(storage, { title: 'Alpha', body: 'a' })
			await storage.finalizeChange(id)
			const firstClosedAt = (await readChangeStoreJson(f, id)).closedAt
			await storage.finalizeChange(id)
			const secondClosedAt = (await readChangeStoreJson(f, id)).closedAt
			expect(secondClosedAt).toBe(firstClosedAt)
		})
	})

	describe('file storage: createSlice', () => {
		storageTest('writes slice node and returns id+title', async ({ f }) => {
			const storage = createFileStorage(f.deps)
			const { id: changeId } = await storage.createChange({ title: 'Add ORM', body: 'change-spec' })

			const slice = await storage.createSlice(changeId, { title: 'Implement Tab Parser', body: '# spec\nbody' })
			expect(slice.title).toBe('Implement Tab Parser')

			const nodeId = entityIdToNodeId(slice.id)
			const node = await loadNode(f.changesDir, { type: 'slice', changeId: entityIdToNodeId(changeId), id: nodeId })
			expect(node.store.sliceBranch).toBeNull()
			expect((await storage.findSlices(changeId))[0]).toMatchObject({ id: slice.id, sliceBranch: null })
		})
	})

	describe('file storage: findSlices', () => {
		storageTest('returns empty array when the Change has no slices/ directory', async ({ f }) => {
			const storage = createFileStorage(f.deps)
			const { id: changeId } = await storage.createChange({ title: 'P', body: 'b' })
			expect(await storage.findSlices(changeId)).toEqual([])
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
		storageTest('persists spec.blockedBy and findSlices returns it on Slice', async ({ f }) => {
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
			await writeNode(
				f.deps.changesDir,
				{ type: 'change', id: 1 },
				{
					body: 'body',
					store: {
						id: 1,
						title: 'Missing',
						createdAt: '2026-05-17T00:00:00.000Z',
						closedAt: null,
					},
				},
			)
			const storage = createFileStorage(f.deps)

			await expect(storage.findChange('1')).rejects.toThrow(/missing required change branch/)
		})

		storageTest('findSlices fails loudly when required Slice branch metadata is missing', async ({ f }) => {
			await writeChangeStoreFixture(f, { id: 1, slug: 'p', title: 'P', createdAt: '2026-05-17T00:00:00.000Z', closedAt: null })
			await writeNode(
				f.deps.changesDir,
				{ type: 'slice', changeId: 1, id: 2 },
				{
					body: 'body',
					store: {
						id: 2,
						title: 'S',
						createdAt: '2026-05-17T00:00:00.000Z',
						closedAt: null,
						readyForAgent: false,
						blockedBy: [],
						implementedAt: null,
						auditedAt: null,
						sliceBranch: undefined as any,
					},
				},
			)
			const storage = createFileStorage(f.deps)

			await expect(storage.findSlices('1')).rejects.toThrow(/missing required slice branch/)
		})
	})

	describe('file storage: updateSlice', () => {
		storageTest('flips readyForAgent', async ({ f }) => {
			const { storage, changeId, slice } = await createChangeWithSlice(f, { title: 'Foo', body: 'b' })

			await storage.setSliceReadyForAgent(changeId, slice.id, true)
			let node = await loadNode(f.changesDir, { type: 'slice', changeId: entityIdToNodeId(changeId), id: entityIdToNodeId(slice.id) })
			expect(node.store.readyForAgent).toBe(true)

			await storage.setSliceReadyForAgent(changeId, slice.id, false)
			node = await loadNode(f.changesDir, { type: 'slice', changeId: entityIdToNodeId(changeId), id: entityIdToNodeId(slice.id) })
			expect(node.store.readyForAgent).toBe(false)
		})

		storageTest('finalizeSlice stamps closedAt', async ({ f }) => {
			const { storage, changeId, slice } = await createChangeWithSlice(f, { title: 'Foo', body: 'b' })

			await storage.finalizeSlice(changeId, slice.id)
			const node = await loadNode(f.changesDir, {
				type: 'slice',
				changeId: entityIdToNodeId(changeId),
				id: entityIdToNodeId(slice.id),
			})
			expect(node.store.closedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
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
			await expect(storage.setSliceReadyForAgent(changeId, 'zzzzzz', true)).rejects.toThrow(/no node found for/i)
		})
	})
}
