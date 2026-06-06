import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'

const STORE_FILE_NAME = 'store.json'
const BODY_FILE_NAME = 'README.md'

export type ChangeStore = {
	id: number
	title: string
	createdAt: string
	closedAt: string | null
	targetBranch: string
	changeBranch: string
}
export type ChangeStoreDraft = Omit<ChangeStore, 'targetBranch' | 'changeBranch'> &
	Partial<Pick<ChangeStore, 'targetBranch' | 'changeBranch'>>

export type SliceStore = Omit<ChangeStore, 'targetBranch' | 'changeBranch'> & {
	implementedAt: string | null
	auditedAt: string | null
	sliceBranch: string | null
	readyForAgent: boolean
	blockedBy: string[]
}
export type SliceStoreDraft = SliceStore

export type Node<Store> = {
	body: string
	store: Store
}

export async function allocateNextId(changesDir: string): Promise<number> {
	const changes = await loadChanges(changesDir)
	const ids: number[] = []
	await Promise.all((changes.map(async (change) => {
		const node = await loadNode(changesDir, { type: 'change', id: change.store.id })
		ids.push(change.store.id, ...node.slices.map((slice) => slice.store.id))
	})))
	return ids.length === 0 ? 1 : Math.max(...ids) + 1
}

type NodeType = { type: 'change'; id: number } | { type: 'slice'; changeId: number; id: number }
type NodeStore<T extends NodeType> = T['type'] extends 'change' ? ChangeStoreDraft : SliceStoreDraft
type LoadedNode<T extends NodeType> = T['type'] extends 'change'
	? Node<ChangeStoreDraft> & { slices: { body: string; store: SliceStoreDraft }[] }
	: Node<SliceStoreDraft>

async function exists(p: string, dir = false): Promise<boolean> {
	try {
		const stats = await stat(p)
		return stats.isDirectory() === dir
	} catch {
		return false
	}
}

async function readNodeDir<T = Record<string, any>>(dir: string): Promise<{ body: string; store: T } | null> {
	const storePath = path.join(dir, STORE_FILE_NAME)
	const bodyPath = path.join(dir, BODY_FILE_NAME)
	if (!(await exists(storePath))) return null
	if (!(await exists(bodyPath))) throw new Error(`${dir} has store.json but no README.md`)
	const storeJSON = await readFile(path.join(dir, STORE_FILE_NAME), 'utf-8')
	// TODO: add pipe validation with parse-json.ts
	const store = JSON.parse(storeJSON)
	const body = await readFile(path.join(dir, BODY_FILE_NAME), 'utf8')
	return { store, body }
}

async function listAllNodesInDir<T extends { id: number }>(dir: string) {
	if (!(await exists(dir, true))) return []
	const contentPaths = await readdir(dir)
	const nodes = await contentPaths.map(async (contentPath) => {
		const fullPath = path.join(dir, contentPath)
		const node = await readNodeDir<T>(fullPath)
		if (!node) return []
		if (contentPath !== String(node.store.id))
		assertDeterministicNodeId(contentPath, node.store.id)
		return [node]
	})
	return (await Promise.all(nodes)).flat()
}

function assertDeterministicNodeId(pathName: string, storeId: number): void {
	if (pathName === String(storeId)) return
	throw new Error(`path '${pathName}' does not match store.json id '${storeId}'`)
}

export async function writeNode<T extends NodeType>(changesDir: string, node: T, data: { store?: NodeStore<T>; body?: string }) {
	const nodeDir =
		node.type === 'change' ? path.join(changesDir, `${node.id}`) : path.join(changesDir, `${node.changeId}`, 'slices', `${node.id}`)
	await mkdir(nodeDir, { recursive: true })
	if ('body' in data && data.body !== undefined) await writeFile(path.join(nodeDir, 'README.md'), data.body)
	if ('store' in data && data.store !== undefined) await writeFile(path.join(nodeDir, 'store.json'), JSON.stringify(data.store, null, 2))
}

export async function loadNode<T extends NodeType>(changesDir: string, node: T): Promise<LoadedNode<T>> {
	const nodeDir =
		node.type === 'change' ? path.join(changesDir, `${node.id}`) : path.join(changesDir, `${node.changeId}`, 'slices', `${node.id}`)
	const read = await readNodeDir<ChangeStoreDraft | SliceStoreDraft>(nodeDir)
	if (!read) throw new Error(`no node found for ${JSON.stringify(node)}`)
	assertDeterministicNodeId(String(node.id), read.store.id)
	if (node.type === 'slice') return read as LoadedNode<T>
	const slices = await listAllNodesInDir<SliceStoreDraft>(path.join(nodeDir, 'slices'))
	return { ...read, slices } as LoadedNode<T>
}

export async function loadChanges(changesDir: string): Promise<Node<ChangeStoreDraft>[]> {
	return await listAllNodesInDir<ChangeStoreDraft>(changesDir)
}

if (import.meta.vitest) {
	const { describe, test, expect } = import.meta.vitest
	const { mkdtemp, rm } = await import('node:fs/promises')
	const { tmpdir } = await import('node:os')

	describe('file storage tree', () => {
		test('writes and loads Change and Slice stores and bodies', async () => {
			const work = await mkdtemp(path.join(tmpdir(), 'trowel-file-tree-'))
			try {
				const changesDir = path.join(work, 'docs', 'changes')
				await writeNode(
					changesDir,
					{ type: 'change', id: 4 },
					{
						body: 'change body',
						store: {
							id: 4,
							title: 'Change',
							createdAt: '2026-05-11T00:00:00.000Z',
							closedAt: null,
							targetBranch: 'main',
							changeBranch: '4-change',
						},
					},
				)
				await writeNode(
					changesDir,
					{ type: 'slice', changeId: 4, id: 5 },
					{
						body: 'slice body',
						store: {
							id: 5,
							title: 'Slice',
							createdAt: '2026-05-11T00:00:00.000Z',
							closedAt: null,
							implementedAt: null,
							auditedAt: null,
							sliceBranch: null,
							readyForAgent: false,
							blockedBy: [],
						},
					},
				)
				expect(await exists(path.join(changesDir, '4', 'README.md'))).toBe(true)
				expect(await exists(path.join(changesDir, '4', 'store.json'))).toBe(true)
				expect(await exists(path.join(changesDir, '4', 'slices', '5', 'README.md'))).toBe(true)
				expect(await exists(path.join(changesDir, '4', 'slices', '5', 'store.json'))).toBe(true)

				const changes = await loadChanges(changesDir)
				expect(changes.length).toBe(1)
				expect(changes[0].store.id).toBe(4)

				const changeNode = await loadNode(changesDir, { type: 'change', id: 4 })
				expect(changeNode).toMatchObject({
					body: 'change body',
					store: {
						id: 4,
						title: 'Change',
						createdAt: '2026-05-11T00:00:00.000Z',
						closedAt: null,
						targetBranch: 'main',
						changeBranch: '4-change',
					},
				})

				const slices = changeNode.slices
				expect(slices.length).toBe(1)
				expect(slices[0].store.id).toBe(5)

				const sliceNode = await loadNode(changesDir, { type: 'slice', changeId: 4, id: 5 })
				expect(sliceNode).toMatchObject({
					body: 'slice body',
					store: {
						id: 5,
						title: 'Slice',
						createdAt: '2026-05-11T00:00:00.000Z',
						closedAt: null,
						implementedAt: null,
						auditedAt: null,
						sliceBranch: null,
						readyForAgent: false,
						blockedBy: [],
					},
				})

				expect(await allocateNextId(changesDir)).toBe(6)
			} finally {
				await rm(work, { recursive: true, force: true })
			}
		})
	})
}
