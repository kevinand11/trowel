import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { allocateNextId } from '../../utils/id.ts'
import { withMutationLock } from '../../utils/mutation-lock.ts'
import { classifySlices } from '../../utils/slice-state.ts'
import { slug as slugify } from '../../utils/slug.ts'
import { landImplement, landReview, prepareImplement, prepareReview, type PhaseDeps } from '../../work/phases.ts'
import type {
	ChangeMetadataPatch,
	ChangeRecord,
	ChangeSpec,
	ChangeSummary,
	ClassifiedSlice,
	CreatedChange,
	CreatedSlice,
	PhaseCtx,
	Slice,
	SliceMetadataPatch,
	SlicePatch,
	SliceSpec,
	Storage,
	StorageDeps,
	StorageFactory,
} from '../types.ts'

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
type MutableStore = {
	readyForAgent: boolean
	blockedBy: string[]
	closedAt: string | null
	implementedAt: string | null
	auditedAt: string | null
}
type StateFilter = { state: 'open' | 'closed' | 'all' }
type SliceHit = { changeId: string; slice: Slice }

function applyMutablePatch(store: MutableStore, patch: SlicePatch): void {
	applyOptionalPatchValue(store, 'readyForAgent', patch.readyForAgent)
	applyBlockedByPatch(store, patch.blockedBy)
	applyTimestampPatch(store, 'closedAt', patch.closedAt)
	applyTimestampPatch(store, 'implementedAt', patch.implementedAt)
	applyTimestampPatch(store, 'auditedAt', patch.auditedAt)
}

function applyOptionalPatchValue<K extends 'readyForAgent'>(store: MutableStore, key: K, value: MutableStore[K] | undefined): void {
	if (value !== undefined) store[key] = value
}

function applyBlockedByPatch(store: MutableStore, blockedBy: string[] | undefined): void {
	if (blockedBy !== undefined) store.blockedBy = [...blockedBy]
}

function applyTimestampPatch<K extends 'closedAt' | 'implementedAt' | 'auditedAt'>(
	store: MutableStore,
	key: K,
	value: MutableStore[K] | undefined,
): void {
	if (value !== undefined) store[key] = value
}

function applyValuePatch<T, K extends keyof T>(store: T, key: K, value: T[K] | undefined): void {
	if (value !== undefined) store[key] = value
}

const STATE_FILTERS: Record<StateFilter['state'], (store: { closedAt: string | null }) => boolean> = {
	all: () => true,
	open: (store) => store.closedAt === null,
	closed: (store) => store.closedAt !== null,
}

function acceptsState(store: { closedAt: string | null }, opts: StateFilter): boolean {
	return STATE_FILTERS[opts.state](store)
}

function jsonWithNewline(value: unknown): string {
	return `${JSON.stringify(value, null, 2)}\n`
}

function baseStore(id: string, slug: string, title: string): Omit<ChangeStore, 'targetBranch' | 'changeBranch'> {
	return { id, slug, title, createdAt: new Date().toISOString(), closedAt: null }
}

async function listStoreSummaries(root: string, opts: StateFilter): Promise<ChangeSummary[]> {
	const summaries: ChangeSummary[] = []
	for (const entry of await readdirOrEmpty(root)) {
		const summary = await readStoreSummary(path.join(root, entry, 'store.json'), opts)
		if (summary) summaries.push(summary)
	}
	return summaries
}

async function readStoreSummary(storePath: string, opts: StateFilter): Promise<ChangeSummary | null> {
	const store = validateChangeStore(JSON.parse(await readFile(storePath, 'utf8')), storePath)
	if (!acceptsState(store, opts)) return null
	return { id: store.id, title: store.title, changeBranch: store.changeBranch, createdAt: store.createdAt }
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
	const missing = requiredStringKeys(store, ['targetBranch', 'changeBranch'])
	if (missing.length > 0) throw new Error(`${source} is missing required Change branch metadata: ${missing.join(', ')}`)
	return store as ChangeStore
}

function validateSliceStore(value: unknown, source: string): SliceStore {
	const store = value as Partial<SliceStore>
	if (!validSliceBranchValue(store.sliceBranch)) throw new Error(`${source} is missing required Slice branch metadata: sliceBranch`)
	return store as SliceStore
}

function validSliceBranchValue(value: unknown): value is string | null {
	return value === null || (typeof value === 'string' && value.length > 0)
}

function requiredStringKeys(value: Record<string, unknown>, keys: string[]): string[] {
	return keys.filter((key) => typeof value[key] !== 'string' || value[key] === '')
}

export const createFileStorage: StorageFactory = (deps: StorageDeps): Storage => {
	async function findEntityDir(root: string, kind: 'Change', id: string): Promise<string> {
		let entries: string[]
		try {
			entries = await readdir(root)
		} catch {
			throw new Error(`no ${kind} directory found for id '${id}' (changesDir does not exist)`)
		}
		const match = entries.find((e) => e.startsWith(`${id}-`))
		if (!match) throw new Error(`no ${kind} directory found for id '${id}'`)
		return path.join(root, match)
	}

	async function findChangeDir(id: string): Promise<string> {
		return findEntityDir(deps.changesDir, 'Change', id)
	}

	async function readChangeStore(id: string): Promise<ChangeStore> {
		const dir = await findChangeDir(id)
		const storePath = path.join(dir, 'store.json')
		return validateChangeStore(JSON.parse(await readFile(storePath, 'utf8')), storePath)
	}

	async function slicesDir(changeId: string): Promise<string> {
		const dir = await findChangeDir(changeId)
		return path.join(dir, 'slices')
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

	async function allocateEntity(title: string, root: string): Promise<{ id: string; slug: string; dir: string }> {
		const slug = slugify(title)
		const id = await allocateNextId(deps.changesDir)
		return { id, slug, dir: path.join(root, `${id}-${slug}`) }
	}

	async function createChange(spec: ChangeSpec): Promise<CreatedChange> {
		return withMutationLock(deps.projectRoot, async () => {
			const { id, slug, dir } = await allocateEntity(spec.title, deps.changesDir)

			await mkdir(dir, { recursive: true })
			await writeFile(path.join(dir, 'README.md'), spec.body)
			await writeFile(path.join(dir, 'store.json'), jsonWithNewline(baseStore(id, slug, spec.title)))

			return { id, title: spec.title }
		})
	}

	async function listChanges(opts: { state: 'open' | 'closed' | 'all' }): Promise<ChangeSummary[]> {
		return listStoreSummaries(deps.changesDir, opts)
	}

	async function closeStore(dir: string): Promise<void> {
		const storePath = path.join(dir, 'store.json')
		const store = validateChangeStore(JSON.parse(await readFile(storePath, 'utf8')), storePath)
		if (store.closedAt !== null) return
		store.closedAt = new Date().toISOString()
		await writeFile(storePath, jsonWithNewline(store))
	}

	async function closeChange(id: string): Promise<void> {
		return withMutationLock(deps.projectRoot, async () => closeStore(await findChangeDir(id)))
	}

	async function updateChangeMetadata(changeId: string, patch: ChangeMetadataPatch): Promise<void> {
		return withMutationLock(deps.projectRoot, async () => {
			const storePath = path.join(await findChangeDir(changeId), 'store.json')
			const store = JSON.parse(await readFile(storePath, 'utf8')) as ChangeStoreDraft
			applyValuePatch(store, 'targetBranch', patch.targetBranch)
			applyValuePatch(store, 'changeBranch', patch.changeBranch)
			await writeFile(storePath, jsonWithNewline(store))
		})
	}

	async function createSlice(changeId: string, spec: SliceSpec): Promise<CreatedSlice> {
		return withMutationLock(deps.projectRoot, async () => {
			const slug = slugify(spec.title)
			const id = await allocateNextId(deps.changesDir)
			const slicesPath = await slicesDir(changeId)
			const dir = path.join(slicesPath, `${id}-${slug}`)

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
				blockedBy: spec.blockedBy,
			}
			await writeFile(path.join(dir, 'store.json'), jsonWithNewline(store))

			return { id, title: spec.title }
		})
	}

	async function findSlices(changeId: string): Promise<Slice[]> {
		const slicesPath = await slicesDirOrNull(changeId)
		if (!slicesPath) return []
		const result: Slice[] = []
		for (const entry of await readdirOrEmpty(slicesPath)) {
			const slice = await readSliceFromDir(path.join(slicesPath, entry))
			if (slice) result.push(slice)
		}
		return classifySlices(result)
	}

	async function slicesDirOrNull(changeId: string): Promise<string | null> {
		try {
			return await slicesDir(changeId)
		} catch {
			return null
		}
	}

	async function readSliceFromDir(dir: string): Promise<Slice | null> {
		const storePath = path.join(dir, 'store.json')
		const store = validateSliceStore(JSON.parse(await readFile(storePath, 'utf8')), storePath)
		const body = await readFile(path.join(dir, 'README.md'), 'utf8')
		return sliceFromStore(store, body)
	}

	async function updateStore<T extends MutableStore>(dir: string, patch: SlicePatch): Promise<void> {
		const storePath = path.join(dir, 'store.json')
		const store: T = JSON.parse(await readFile(storePath, 'utf8'))
		applyMutablePatch(store, patch)
		await writeFile(storePath, jsonWithNewline(store))
	}

	async function updateSliceMetadata(changeId: string, sliceId: string, patch: SliceMetadataPatch): Promise<void> {
		return withMutationLock(deps.projectRoot, async () => {
			const storePath = path.join(await findSliceDir(changeId, sliceId), 'store.json')
			const store = JSON.parse(await readFile(storePath, 'utf8')) as SliceStoreDraft
			applyValuePatch(store, 'sliceBranch', patch.sliceBranch)
			await writeFile(storePath, jsonWithNewline(store))
		})
	}

	async function updateSlice(changeId: string, sliceId: string, patch: SlicePatch): Promise<void> {
		return withMutationLock(deps.projectRoot, async () => updateStore<SliceStore>(await findSliceDir(changeId, sliceId), patch))
	}

	function sliceFromStore(store: SliceStore, body: string): Slice {
		return {
			id: store.id,
			title: store.title,
			body,
			state: store.closedAt === null ? 'draft' : 'done',
			closedAt: store.closedAt,
			implementedAt: store.implementedAt ?? null,
			auditedAt: store.auditedAt ?? null,
			readyForAgent: store.readyForAgent,
			needsRevision: false,
			blockedBy: store.blockedBy ?? [],
			sliceBranch: store.sliceBranch,
			prState: null,
		}
	}

	async function findSlice(sliceId: string): Promise<SliceHit | null> {
		for (const changeEntry of await readdirOrEmpty(deps.changesDir)) {
			const hit = await findSliceInChangeEntry(sliceId, changeEntry)
			if (hit !== undefined) return hit
		}
		return null
	}

	async function findSliceInChangeEntry(sliceId: string, changeEntry: string): Promise<SliceHit | null | undefined> {
		const changeId = changeIdFromDirName(changeEntry)
		if (!changeId) return undefined
		const slicesPath = path.join(deps.changesDir, changeEntry, 'slices')
		const match = (await readdirOrEmpty(slicesPath)).find((e) => e.startsWith(`${sliceId}-`))
		if (!match) return undefined
		return readSliceHit(changeId, path.join(slicesPath, match))
	}

	function changeIdFromDirName(changeEntry: string): string | null {
		return /^([^-]+)-/.exec(changeEntry)?.[1] ?? null
	}

	async function readSliceHit(changeId: string, dir: string): Promise<SliceHit | null> {
		const slice = await readSliceFromDir(dir)
		return slice ? { changeId, slice } : null
	}

	async function findChange(id: string): Promise<ChangeRecord | null> {
		try {
			const store = await readChangeStore(id)
			return {
				id: store.id,
				changeBranch: store.changeBranch,
				targetBranch: store.targetBranch,
				title: store.title,
				state: store.closedAt === null ? 'OPEN' : 'CLOSED',
				closedAt: store.closedAt,
			}
		} catch (error) {
			if (error instanceof Error && /no Change directory found/.test(error.message)) return null
			throw error
		}
	}

	return {
		createChange,
		findChange,
		listChanges,
		closeChange,
		updateChangeMetadata,
		createSlice,
		findSlices,
		findSlice,
		updateSlice,
		updateSliceMetadata,
	}
}

if (import.meta.vitest) {
	const { describe, test, expect, beforeEach, afterEach } = import.meta.vitest
	const path = await import('node:path')
	const { mkdir, rm, readFile, stat, writeFile } = await import('node:fs/promises')
	const { exec } = await import('../../utils/shell.ts')
	const { setupTestRepoWithBare } = await import('../../test-utils/git-repo.ts')
	const { recordingGhOps } = await import('../../test-utils/gh-ops-recorder.ts')
	const { noopGitOps } = await import('../../test-utils/git-ops-fixtures.ts')

	type Fixture = {
		work: string
		bare: string
		changesDir: string
		deps: StorageDeps
		calls: { git: Array<[string, ...string[]]>; log: string[] }
	}

	async function setup(): Promise<Fixture> {
		const repo = await setupTestRepoWithBare({ prefix: 'trowel-file-' })
		const work = repo.work
		const bare = repo.bare
		const changesDir = path.join(work, 'docs', 'changes')
		const calls: { git: Array<[string, ...string[]]>; log: string[] } = { git: [], log: [] }
		const { createRepoGit } = await import('../../utils/git-ops.ts')
		const realGit = createRepoGit(work)
		// Spy wrapper: each method records its call name + args, then delegates to the real bag
		// so file-storage tests can assert against both call sequence AND real git state.
		const git = {
			fetch: async (b: string) => {
				calls.git.push(['fetch', b])
				await realGit.fetch(b)
			},
			push: async (b: string) => {
				calls.git.push(['push', b])
				await realGit.push(b)
			},
			checkout: async (b: string) => {
				calls.git.push(['checkout', b])
				await realGit.checkout(b)
			},
			mergeNoFf: async (b: string) => {
				calls.git.push(['mergeNoFf', b])
				await realGit.mergeNoFf(b)
			},
			mergeNoFfIn: async (p: string, b: string) => {
				calls.git.push(['mergeNoFfIn', p, b])
				await realGit.mergeNoFfIn(p, b)
			},
			mergeAbortIn: async (p: string) => {
				calls.git.push(['mergeAbortIn', p])
				await realGit.mergeAbortIn(p)
			},
			deleteRemoteBranch: async (b: string) => {
				calls.git.push(['deleteRemoteBranch', b])
				await realGit.deleteRemoteBranch(b)
			},
			remoteBranchExists: async (b: string) => realGit.remoteBranchExists(b),
			createRemoteBranch: async (n: string, b: string) => {
				calls.git.push(['createRemoteBranch', n, b])
				await realGit.createRemoteBranch(n, b)
			},
			createLocalBranch: async (n: string, b: string) => {
				calls.git.push(['createLocalBranch', n, b])
				await realGit.createLocalBranch(n, b)
			},
			pushSetUpstream: async (b: string) => {
				calls.git.push(['pushSetUpstream', b])
				await realGit.pushSetUpstream(b)
			},
			fastForward: async (ref: string) => {
				calls.git.push(['fastForward', ref])
				await realGit.fastForward(ref)
			},
			currentBranch: async () => {
				const r = await realGit.currentBranch()
				calls.git.push(['currentBranch'])
				return r
			},
			baseBranch: async () => {
				const r = await realGit.baseBranch()
				calls.git.push(['baseBranch'])
				return r
			},
			branchExists: async (b: string) => {
				const r = await realGit.branchExists(b)
				calls.git.push(['branchExists', b])
				return r
			},
			localBranchExists: async (b: string) => {
				const r = await realGit.localBranchExists(b)
				calls.git.push(['localBranchExists', b])
				return r
			},
			isMerged: async (b: string, base: string) => {
				const r = await realGit.isMerged(b, base)
				calls.git.push(['isMerged', b, base])
				return r
			},
			deleteBranch: async (b: string) => {
				calls.git.push(['deleteBranch', b])
				await realGit.deleteBranch(b)
			},
			listLocalBranches: async () => realGit.listLocalBranches(),
			resolveRef: async (ref: string, p?: string) => realGit.resolveRef(ref, p),
			checkoutDetached: async (p: string, ref: string) => {
				calls.git.push(['checkoutDetached', p, ref])
				await realGit.checkoutDetached(p, ref)
			},
			resetHard: async (p: string, ref: string) => {
				calls.git.push(['resetHard', p, ref])
				await realGit.resetHard(p, ref)
			},
			pushHeadTo: async (p: string, b: string) => {
				calls.git.push(['pushHeadTo', p, b])
				await realGit.pushHeadTo(p, b)
			},
			updateLocalBranchRef: async (b: string, ref: string) => {
				calls.git.push(['updateLocalBranchRef', b, ref])
				await realGit.updateLocalBranchRef(b, ref)
			},
			worktreeAdd: async (p: string, b: string) => {
				await realGit.worktreeAdd(p, b)
			},
			worktreeRemove: async (p: string, opts?: { force?: boolean }) => {
				await realGit.worktreeRemove(p, opts)
			},
			worktreeList: async () => realGit.worktreeList(),
			restoreAll: async (p: string) => {
				await realGit.restoreAll(p)
			},
			cleanUntracked: async (p: string) => {
				await realGit.cleanUntracked(p)
			},
			cleanAll: async (p: string) => {
				await realGit.cleanAll(p)
			},
			isWorkingTreeClean: async () => realGit.isWorkingTreeClean(),
			statusShort: async () => realGit.statusShort(),
			stashPush: async (opts) => realGit.stashPush(opts),
			stashPop: async () => realGit.stashPop(),
			mergeAbort: async () => realGit.mergeAbort(),
			commitsAhead: async (b, base) => realGit.commitsAhead(b, base),
			detectVersion: async () => realGit.detectVersion(),
		}
		const { gh } = recordingGhOps()
		const deps: StorageDeps = {
			gh,
			repoRoot: work,
			projectRoot: work,
			changesDir,
			labels: { change: 'change', readyForAgent: 'ready-for-agent', needsRevision: 'needs-revision' },
			abortOptions: { comment: null, deleteBranch: 'never' },
			confirm: async () => false,
			git,
			log: (m) => {
				calls.log.push(m)
			},
		}
		return { work, bare, changesDir, deps, calls }
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

	async function writeChangeStoreFixture(
		f: Fixture,
		entry: { id: string; slug: string; title: string; createdAt: string; closedAt: string | null },
	): Promise<void> {
		const dir = path.join(f.changesDir, `${entry.id}-${entry.slug}`)
		await mkdir(dir, { recursive: true })
		await writeFile(
			path.join(dir, 'store.json'),
			JSON.stringify({ ...entry, targetBranch: 'main', changeBranch: `change-${entry.id}-${entry.slug}` }),
		)
	}

	async function writeAlphaBetaChangeFixtures(f: Fixture): Promise<void> {
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
	}

	function testChangeBranch(id: string, title: string): string {
		return `${id}-${slugify(title)}`
	}

	function testSliceBranch(changeId: string, sliceId: string, title: string): string {
		return `${changeId}/${sliceId}-${slugify(title)}`
	}

	async function createMaterialisedChange(
		storage: Storage,
		spec: ChangeSpec = { title: 'P', body: 'b' },
		targetBranch = 'main',
	): Promise<{ id: string; title: string; changeBranch: string }> {
		const created = await storage.createChange(spec)
		const changeBranch = testChangeBranch(created.id, created.title)
		await storage.updateChangeMetadata(created.id, { targetBranch, changeBranch })
		return { ...created, changeBranch }
	}

	async function createMaterialisedSlice(
		storage: Storage,
		changeId: string,
		spec: SliceSpec = { title: 'A', body: 'spec', blockedBy: [] },
		sliceBranch?: string,
	): Promise<Slice> {
		const created = await storage.createSlice(changeId, spec)
		await storage.updateSliceMetadata(changeId, created.id, {
			sliceBranch: sliceBranch ?? testSliceBranch(changeId, created.id, created.title),
		})
		return (await storage.findSlices(changeId)).find((s) => s.id === created.id)!
	}

	async function createChangeWithSlice(
		f: Fixture,
		spec: SliceSpec = { title: 'A', body: 'spec', blockedBy: [] },
	): Promise<{ storage: Storage; changeId: string; slice: Slice }> {
		const storage = createFileStorage(f.deps)
		const { id: changeId } = await createMaterialisedChange(storage)
		const slice = await createMaterialisedSlice(storage, changeId, spec)
		return { storage, changeId, slice }
	}

	async function stateForReadySliceBlockedByA(f: Fixture, doneA: boolean): Promise<string> {
		const storage = createFileStorage(f.deps)
		const { id: changeId } = await createMaterialisedChange(storage)
		const a = await createMaterialisedSlice(storage, changeId, { title: 'A', body: 'spec', blockedBy: [] })
		const b = await createMaterialisedSlice(storage, changeId, { title: 'B', body: 'b spec', blockedBy: [a.id] })
		if (doneA) await storage.updateSlice(changeId, a.id, { closedAt: new Date().toISOString() })
		await storage.updateSlice(changeId, b.id, { readyForAgent: true })
		return classifySlices(await storage.findSlices(changeId)).find((s) => s.id === b.id)!.state
	}

	describe('file storage: phase primitives', () => {
		function makeOpenSlice(overrides: Partial<ClassifiedSlice> = {}): ClassifiedSlice {
			return {
				id: 's1',
				title: 'Implement A',
				body: 'spec',
				state: 'open',
				closedAt: null,
				implementedAt: null,
				auditedAt: null,
				readyForAgent: true,
				needsRevision: false,
				blockedBy: [],
				sliceBranch: `change-1/slice-${overrides.id ?? 's1'}-implement-a`,
				prState: null,
				...overrides,
			}
		}

		function makePhaseDeps(f: Fixture, storage: Storage): PhaseDeps {
			return { storage, git: f.deps.git!, gh: f.deps.gh, log: f.deps.log!, mergeNoVerify: false }
		}

		async function createReadySlice(
			f: Fixture,
			storage: Storage,
			title = 'A',
			branchMode: 'shared' | 'distinct' = 'shared',
		): Promise<{ result: { id: string; changeBranch: string }; slice: Slice }> {
			const result = await createMaterialisedChange(storage, { title: 'X', body: 'b' })
			await f.deps.git.createLocalBranch(result.changeBranch, 'main')
			await f.deps.git.pushSetUpstream(result.changeBranch)
			const sliceBranch = branchMode === 'shared' ? result.changeBranch : undefined
			const slice = await createMaterialisedSlice(storage, result.id, { title, body: 'spec', blockedBy: [] }, sliceBranch)
			await storage.updateSlice(result.id, slice.id, { readyForAgent: true })
			f.calls.git.length = 0
			return { result, slice }
		}

		function makeRecordingGit(
			currentBranch: string,
			baseBranch: string,
		): { git: PhaseDeps['git']; calls: Array<[string, ...string[]]> } {
			const calls: Array<[string, ...string[]]> = []
			return {
				calls,
				git: noopGitOps({
					fetch: async (b: string) => {
						calls.push(['fetch', b])
					},
					push: async (b: string) => {
						calls.push(['push', b])
					},
					checkout: async (b: string) => {
						calls.push(['checkout', b])
					},
					mergeNoFf: async (b: string) => {
						calls.push(['mergeNoFf', b])
					},
					deleteRemoteBranch: async (b: string) => {
						calls.push(['deleteRemoteBranch', b])
					},
					createRemoteBranch: async (n: string, b: string) => {
						calls.push(['createRemoteBranch', n, b])
					},
					currentBranch: async () => currentBranch,
					baseBranch: async () => baseBranch,
				}),
			}
		}

		async function landReadySlice(f: Fixture, verdict: { verdict: 'no-work-needed' | 'partial'; commits: number }) {
			const storage = createFileStorage(f.deps)
			const { result, slice } = await createReadySlice(f, storage)
			const outcome = await landImplement(makePhaseDeps(f, storage), { ...slice, readyForAgent: true }, verdict, {
				changeId: result.id,
				changeBranch: result.changeBranch,
				config: { pr: false, audit: false, perSliceBranches: false },
			})
			return { outcome, after: await storage.findSlices(result.id) }
		}

		async function readySliceBranchFixture(f: Fixture, baseBranch: string) {
			const storage = createFileStorage(f.deps)
			const {
				result: { id: changeId, changeBranch },
				slice,
			} = await createReadySlice(f, storage, 'Implement A', 'distinct')
			const sliceBranch = `${changeId}/${slice.id}-implement-a`
			const { git: recordingGit, calls } = makeRecordingGit(changeBranch, baseBranch)
			const deps: PhaseDeps = { storage, git: recordingGit, gh: f.deps.gh, log: f.deps.log!, mergeNoVerify: false }
			return { storage, changeId, changeBranch, slice, sliceBranch, deps, calls }
		}

		test('prepareImplement: shared-branch Slice uses the stored Change branch; turnIn carries the slice', async () => {
			const f = await setup()
			try {
				const storage = createFileStorage(f.deps)
				const { id: changeId, changeBranch } = await createMaterialisedChange(storage, { title: 'X', body: 'b' })
				await f.deps.git.createLocalBranch(changeBranch, 'main')
				await f.deps.git.pushSetUpstream(changeBranch)
				const slice = await createMaterialisedSlice(
					storage,
					changeId,
					{ title: 'Implement A', body: 'spec', blockedBy: [] },
					changeBranch,
				)
				f.calls.git.length = 0

				const prep = await prepareImplement(makePhaseDeps(f, storage), { ...slice, state: 'open' } as ClassifiedSlice, {
					changeId,
					changeBranch,
					config: { pr: false, audit: false, perSliceBranches: false },
				})
				expect(prep.branch).toBe(changeBranch)
				expect(prep.turnIn.slice).toEqual({ id: slice.id, title: 'Implement A', body: 'spec' })
				expect(f.calls.git).toEqual([['fetch', changeBranch]])
			} finally {
				await teardown(f)
			}
		})

		test('landImplement + ready: pushes Change branch and records implementedAt', async () => {
			const f = await setup()
			try {
				const storage = createFileStorage(f.deps)
				const { result, slice } = await createReadySlice(f, storage, 'Implement A')

				const outcome = await landImplement(
					makePhaseDeps(f, storage),
					{ ...slice, readyForAgent: true },
					{ verdict: 'ready', commits: 1 },
					{
						changeId: result.id,
						changeBranch: result.changeBranch,
						config: { pr: false, audit: false, perSliceBranches: false },
					},
				)

				expect(outcome).toBe('progress')
				expect(f.calls.git).toContainEqual(['push', result.changeBranch])
				const after = await storage.findSlices(result.id)
				expect(after[0]!.state).toBe('implemented')
				expect(after[0]!.implementedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
			} finally {
				await teardown(f)
			}
		})

		test('landImplement + no-work-needed: clears readyForAgent, returns no-work, does not push', async () => {
			const f = await setup()
			try {
				const { outcome, after } = await landReadySlice(f, { verdict: 'no-work-needed', commits: 0 })
				expect(outcome).toBe('no-work')
				expect(f.calls.git.find((c) => c[0] === 'push')).toBeUndefined()
				expect(after[0]!.state).toBe('draft')
				expect(after[0]!.readyForAgent).toBe(false)
			} finally {
				await teardown(f)
			}
		})

		test('landImplement + partial: no host action, returns partial', async () => {
			const f = await setup()
			try {
				const { outcome, after } = await landReadySlice(f, { verdict: 'partial', commits: 0 })
				expect(outcome).toBe('partial')
				expect(f.calls.git).toEqual([])
				expect(after[0]!.state).toBe('open')
				expect(after[0]!.readyForAgent).toBe(true)
			} finally {
				await teardown(f)
			}
		})

		test('prepareImplement + distinct stored Slice branch: fetches existing branch without creating it, turnIn carries the slice', async () => {
			const f = await setup()
			try {
				const storage = createFileStorage(f.deps)
				const { id: changeId, changeBranch } = await createMaterialisedChange(storage, { title: 'X', body: 'b' })
				await f.deps.git.createLocalBranch(changeBranch, 'main')
				await f.deps.git.pushSetUpstream(changeBranch)
				const slice = await createMaterialisedSlice(storage, changeId, { title: 'Implement A', body: 'spec', blockedBy: [] })
				await f.deps.git.createRemoteBranch(slice.sliceBranch!, changeBranch)
				f.calls.git.length = 0

				const prep = await prepareImplement(makePhaseDeps(f, storage), { ...slice, state: 'open' } as ClassifiedSlice, {
					changeId,
					changeBranch,
					config: { pr: false, audit: false, perSliceBranches: true },
				})
				expect(prep.branch).toBe(`${changeId}/${slice.id}-implement-a`)
				expect(f.calls.git).toContainEqual(['fetch', prep.branch])
			} finally {
				await teardown(f)
			}
		})

		test('landImplement + perSliceBranches:true + pr:false + ready: records implementedAt without host-merge', async () => {
			const f = await setup()
			try {
				// Replace the spy git with a recording no-op for this matrix cell — we want to assert the
				// call sequence, not exercise real git state on a synthetic slice branch.
				const { storage, changeId, changeBranch, slice, sliceBranch, deps, calls } = await readySliceBranchFixture(f, 'main')

				const outcome = await landImplement(
					deps,
					{ ...slice, readyForAgent: true } as Slice,
					{ verdict: 'ready', commits: 1 },
					{ changeId, changeBranch: changeBranch, config: { pr: false, audit: false, perSliceBranches: true } },
				)

				expect(outcome).toBe('progress')
				expect(calls.map((c) => c[0])).toEqual(['push'])
				expect(calls).toContainEqual(['push', sliceBranch])
				const after = await storage.findSlices(changeId)
				expect(after[0]!.state).toBe('implemented')
			} finally {
				await teardown(f)
			}
		})

		test('landImplement + perSliceBranches:true + pr:true + ready: records implementedAt without opening a PR', async () => {
			const f = await setup()
			try {
				const {
					storage,
					changeId,
					changeBranch,
					slice,
					sliceBranch,
					deps,
					calls: gitCalls,
				} = await readySliceBranchFixture(f, 'develop')
				const { gh, calls: ghCalls } = recordingGhOps()
				deps.gh = gh

				const outcome = await landImplement(
					deps,
					{ ...slice, readyForAgent: true } as Slice,
					{ verdict: 'ready', commits: 1 },
					{ changeId, changeBranch: changeBranch, config: { pr: true, audit: false, perSliceBranches: true } },
				)

				expect(outcome).toBe('progress')
				expect(gitCalls).toContainEqual(['push', sliceBranch])
				expect(gitCalls.map((c) => c[0])).not.toContain('mergeNoFf')
				expect(gitCalls.map((c) => c[0])).not.toContain('deleteRemoteBranch')
				expect(ghCalls.find((c) => c[0] === 'createDraftPr')).toBeUndefined()
				const after = await storage.findSlices(changeId)
				expect(after[0]!.state).toBe('implemented')
			} finally {
				await teardown(f)
			}
		})

		test('review phase on file storage reaches the PR-lookup layer for feedback', async () => {
			const f = await setup()
			try {
				const storage = createFileStorage(f.deps)
				const slice = makeOpenSlice()
				const ctx: PhaseCtx = { changeId: 'p1', changeBranch: 'change/p1-x', config: { pr: true, audit: true, perSliceBranches: true } }
				const { gh } = recordingGhOps({
					findPrNumberByHead: async (head) => {
						throw new Error(`no PR found for head '${head}'`)
					},
				})
				const deps: PhaseDeps = { storage, git: f.deps.git!, gh, log: f.deps.log!, mergeNoVerify: false }
				// No PR exists, so findPrNumberByHead throws "no PR found".
				// The point: that's now the failure mode, not "requires capability 'prFlow'".
				await expect(prepareReview(deps, slice, ctx)).rejects.toThrow(/no PR found/)
				// landReview with verdict 'partial' short-circuits before any gh call.
				expect(await landReview(deps, slice, { verdict: 'partial', commits: 0 }, ctx)).toBe('partial')
			} finally {
				await teardown(f)
			}
		})
	})

	describe('file storage: createChange', () => {
		let f: Fixture
		beforeEach(async () => {
			f = await setup()
		})
		afterEach(async () => {
			await teardown(f)
		})

		test('writes README.md and store.json under <changesDir>/<id>-<slug>/ and returns matching id+title', async () => {
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

		test('does not create or push the Change branch before metadata orchestration', async () => {
			const storage = createFileStorage(f.deps)
			await storage.createChange({ title: 'Add ORM', body: 'spec' })
			const localHead = (await exec('git', ['-C', f.work, 'rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim()
			expect(localHead).toBe('main')
			expect(f.calls.git.map((c) => c[0])).not.toContain('createLocalBranch')
			expect(f.calls.git.map((c) => c[0])).not.toContain('pushSetUpstream')
		})

		test('updateChangeMetadata persists targetBranch and changeBranch', async () => {
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
		let f: Fixture
		beforeEach(async () => {
			f = await setup()
		})
		afterEach(async () => {
			await teardown(f)
		})

		test('returns empty array when changesDir does not exist', async () => {
			const storage = createFileStorage(f.deps)
			expect(await storage.listChanges({ state: 'open' })).toEqual([])
		})

		test('returns one summary per Change with closedAt === null, skipping closed ones', async () => {
			await writeAlphaBetaChangeFixtures(f)

			const storage = createFileStorage(f.deps)
			const open = await storage.listChanges({ state: 'open' })
			expect(open).toHaveLength(1)
			expect(open[0]).toEqual({
				id: 'bbbbbb',
				title: 'Beta',
				changeBranch: 'change-bbbbbb-beta',
				createdAt: '2026-05-11T00:00:00.000Z',
			})
		})

		test('returns both open and closed Changes when called with { state: "all" }', async () => {
			await writeAlphaBetaChangeFixtures(f)

			const storage = createFileStorage(f.deps)
			const all = await storage.listChanges({ state: 'all' })
			expect(all).toHaveLength(2)
			expect(all.map((p) => p.id).sort()).toEqual(['aaaaaa', 'bbbbbb'])
		})

		test('returns Changes with their createdAt populated (consumer sorts; see `trowel list`)', async () => {
			const dirs = [
				{ name: 'aaaaaa-old', id: 'aaaaaa', slug: 'old', createdAt: '2026-05-01T00:00:00.000Z' },
				{ name: 'bbbbbb-new', id: 'bbbbbb', slug: 'new', createdAt: '2026-05-12T00:00:00.000Z' },
			]
			for (const d of dirs) {
				const dir = path.join(f.changesDir, d.name)
				await mkdir(dir, { recursive: true })
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
			const out = await storage.listChanges({ state: 'open' })
			expect(out.find((p) => p.id === 'aaaaaa')!.createdAt).toBe('2026-05-01T00:00:00.000Z')
			expect(out.find((p) => p.id === 'bbbbbb')!.createdAt).toBe('2026-05-12T00:00:00.000Z')
		})

		test('returns only closed Changes when called with { state: "closed" }', async () => {
			await writeAlphaBetaChangeFixtures(f)

			const storage = createFileStorage(f.deps)
			const closed = await storage.listChanges({ state: 'closed' })
			expect(closed).toHaveLength(1)
			expect(closed[0]).toEqual({
				id: 'aaaaaa',
				title: 'Alpha',
				changeBranch: 'change-aaaaaa-alpha',
				createdAt: '2026-05-11T00:00:00.000Z',
			})
		})
	})

	describe('file storage: close', () => {
		let f: Fixture
		beforeEach(async () => {
			f = await setup()
		})
		afterEach(async () => {
			await teardown(f)
		})

		test('sets closedAt in store.json without auto-committing the change', async () => {
			const storage = createFileStorage(f.deps)
			const { id } = await createMaterialisedChange(storage, { title: 'Alpha', body: 'a' })
			await storage.closeChange(id)
			const storePath = path.join(f.changesDir, `${id}-alpha`, 'store.json')
			const store = JSON.parse(await readFile(storePath, 'utf8'))
			expect(store.closedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
			const commitCount = (await exec('git', ['-C', f.work, 'rev-list', '--count', 'HEAD'])).stdout.trim()
			expect(commitCount).toBe('1')
		})

		test('idempotent: re-running close on a closed Change is a no-op', async () => {
			const storage = createFileStorage(f.deps)
			const { id } = await createMaterialisedChange(storage, { title: 'Alpha', body: 'a' })
			await storage.closeChange(id)
			const storePath = path.join(f.changesDir, `${id}-alpha`, 'store.json')
			const firstClosedAt = JSON.parse(await readFile(storePath, 'utf8')).closedAt
			const commitCountBefore = (await exec('git', ['-C', f.work, 'rev-list', '--count', 'HEAD'])).stdout.trim()
			await storage.closeChange(id)
			const secondClosedAt = JSON.parse(await readFile(storePath, 'utf8')).closedAt
			expect(secondClosedAt).toBe(firstClosedAt)
			const commitCountAfter = (await exec('git', ['-C', f.work, 'rev-list', '--count', 'HEAD'])).stdout.trim()
			expect(commitCountAfter).toBe(commitCountBefore)
		})
	})

	describe('file storage: createSlice', () => {
		let f: Fixture
		beforeEach(async () => {
			f = await setup()
		})
		afterEach(async () => {
			await teardown(f)
		})

		test('writes README.md and store.json under <changeDir>/slices/<id>-<slug>/ and returns id+title', async () => {
			const storage = createFileStorage(f.deps)
			const { id: changeId } = await storage.createChange({ title: 'Add ORM', body: 'change-spec' })

			const slice = await storage.createSlice(changeId, { title: 'Implement Tab Parser', body: '# spec\nbody', blockedBy: [] })
			expect(slice.title).toBe('Implement Tab Parser')

			const dir = path.join(f.changesDir, `${changeId}-add-orm`, 'slices', `${slice.id}-implement-tab-parser`)
			expect(await exists(path.join(dir, 'README.md'))).toBe(true)
			expect(await exists(path.join(dir, 'store.json'))).toBe(true)
			const store = JSON.parse(await readFile(path.join(dir, 'store.json'), 'utf8'))
			expect(store.sliceBranch).toBeNull()
			expect(store).not.toHaveProperty('needsRevision')
			expect((await storage.findSlices(changeId))[0]).toMatchObject({ id: slice.id, sliceBranch: null, needsRevision: false })
		})
	})

	describe('file storage: findSlices', () => {
		let f: Fixture
		beforeEach(async () => {
			f = await setup()
		})
		afterEach(async () => {
			await teardown(f)
		})

		test('returns empty array when the Change has no slices/ directory', async () => {
			const storage = createFileStorage(f.deps)
			const { id: changeId } = await storage.createChange({ title: 'P', body: 'b' })
			expect(await storage.findSlices(changeId)).toEqual([])
		})

		test('returned slices have prState=null (file storage has no PR concept)', async () => {
			const { storage, changeId } = await createChangeWithSlice(f)
			const [s] = classifySlices(await storage.findSlices(changeId))
			expect(s!.prState).toBeNull()
		})

		test('returns one Slice per slice directory with body from README.md and state from closedAt', async () => {
			const storage = createFileStorage(f.deps)
			const { id: changeId } = await createMaterialisedChange(storage)
			const a = await createMaterialisedSlice(storage, changeId, { title: 'Alpha', body: 'aa', blockedBy: [] })
			const b = await createMaterialisedSlice(storage, changeId, { title: 'Beta', body: 'bb', blockedBy: [] })
			// Mark b as closed; needs-revision is PR-derived and not stored by file storage.
			await storage.updateSlice(changeId, b.id, { closedAt: new Date().toISOString() })

			const slices = classifySlices(await storage.findSlices(changeId))
			expect(slices).toHaveLength(2)
			const byId = Object.fromEntries(slices.map((s) => [s.id, s]))
			expect(byId[a.id]).toMatchObject({
				title: 'Alpha',
				body: 'aa',
				state: 'draft',
				closedAt: null,
				readyForAgent: false,
				needsRevision: false,
			})
			expect(byId[b.id]).toMatchObject({ title: 'Beta', body: 'bb', state: 'done', needsRevision: false })
		})
	})

	describe('file storage: createSlice round-trips blockedBy', () => {
		let f: Fixture
		beforeEach(async () => {
			f = await setup()
		})
		afterEach(async () => {
			await teardown(f)
		})

		test('persists spec.blockedBy to store.json; findSlices returns it on Slice', async () => {
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

	describe('file storage: findSlices computes state', () => {
		let f: Fixture
		beforeEach(async () => {
			f = await setup()
		})
		afterEach(async () => {
			await teardown(f)
		})

		test('OPEN slice with no readiness flags → draft', async () => {
			const { storage, changeId } = await createChangeWithSlice(f)
			const [s] = classifySlices(await storage.findSlices(changeId))
			expect(s!.state).toBe('draft')
		})

		test('readyForAgent and no deps → open', async () => {
			const { storage, changeId, slice } = await createChangeWithSlice(f)
			await storage.updateSlice(changeId, slice.id, { readyForAgent: true })
			const [updated] = classifySlices(await storage.findSlices(changeId))
			expect(updated!.state).toBe('open')
		})

		test('CLOSED → done', async () => {
			const { storage, changeId, slice } = await createChangeWithSlice(f)
			await storage.updateSlice(changeId, slice.id, { closedAt: new Date().toISOString() })
			const [updated] = classifySlices(await storage.findSlices(changeId))
			expect(updated!.state).toBe('done')
		})

		test('slice with Depends-on: pointing to a non-done slice → blocked', async () => {
			expect(await stateForReadySliceBlockedByA(f, false)).toBe('blocked')
		})

		test('slice with Depends-on: pointing to a done slice → open (dep satisfied)', async () => {
			expect(await stateForReadySliceBlockedByA(f, true)).toBe('open')
		})

		test('file storage never returns in-flight (no PR concept)', async () => {
			const { storage, changeId, slice } = await createChangeWithSlice(f)
			await storage.updateSlice(changeId, slice.id, { readyForAgent: true })
			const slices = classifySlices(await storage.findSlices(changeId))
			expect(slices.every((x) => x.state !== 'in-flight')).toBe(true)
		})
	})

	describe('file storage: findChange', () => {
		let f: Fixture
		beforeEach(async () => {
			f = await setup()
		})
		afterEach(async () => {
			await teardown(f)
		})

		test('returns null when no Change exists for id', async () => {
			const storage = createFileStorage(f.deps)
			expect(await storage.findChange('zzzzzz')).toBeNull()
		})

		test('returns ChangeRecord with state=OPEN for an open Change', async () => {
			const storage = createFileStorage(f.deps)
			const { id, changeBranch } = await createMaterialisedChange(storage, { title: 'Alpha', body: 'a' })
			expect(await storage.findChange(id)).toEqual({
				id,
				changeBranch,
				targetBranch: 'main',
				title: 'Alpha',
				state: 'OPEN',
				closedAt: null,
			})
		})

		test('returns ChangeRecord with state=CLOSED after close', async () => {
			const deps: StorageDeps = { ...f.deps, abortOptions: { comment: null, deleteBranch: 'never' } }
			const storage = createFileStorage(deps)
			const { id, changeBranch } = await createMaterialisedChange(storage, { title: 'Beta', body: 'b' })
			await storage.closeChange(id)
			expect(await storage.findChange(id)).toMatchObject({ id, changeBranch, targetBranch: 'main', title: 'Beta', state: 'CLOSED' })
			expect((await storage.findChange(id))!.closedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
		})
	})

	describe('file storage: findSlice', () => {
		let f: Fixture
		beforeEach(async () => {
			f = await setup()
		})
		afterEach(async () => {
			await teardown(f)
		})

		test('returns null when changesDir does not exist', async () => {
			const storage = createFileStorage(f.deps)
			expect(await storage.findSlice('1')).toBeNull()
		})

		test('returns null when no slice with that id exists', async () => {
			const storage = createFileStorage(f.deps)
			await storage.createChange({ title: 'P', body: 'b' })
			expect(await storage.findSlice('zzz')).toBeNull()
		})

		test('returns { changeId, slice } when the slice is found under a Change', async () => {
			const storage = createFileStorage(f.deps)
			const { id: changeId } = await createMaterialisedChange(storage)
			const slice = await createMaterialisedSlice(storage, changeId, { title: 'Foo', body: 'spec', blockedBy: [] })
			const hit = await storage.findSlice(slice.id)
			expect(hit).not.toBeNull()
			expect(hit!.changeId).toBe(changeId)
			expect(hit!.slice.id).toBe(slice.id)
			expect(hit!.slice.title).toBe('Foo')
		})

		test('finds a slice under a non-first Change (walks all Change dirs)', async () => {
			const storage = createFileStorage(f.deps)
			await createMaterialisedChange(storage, { title: 'First', body: 'a' })
			const { id: changeId } = await createMaterialisedChange(storage, { title: 'Second', body: 'b' })
			const slice = await createMaterialisedSlice(storage, changeId, { title: 'Bar', body: 'spec', blockedBy: [] })
			const hit = await storage.findSlice(slice.id)
			expect(hit!.changeId).toBe(changeId)
		})

		test('integer ids are not confused by prefix match (id "1" must not match dir "10-...")', async () => {
			// allocateNextId returns sequential integers; this test simulates two Changes and a slice
			// in a way that would trip a naive startsWith.
			const storage = createFileStorage(f.deps)
			// Manually craft two Change dirs whose numeric prefixes share a leading digit.
			const { mkdir, writeFile } = await import('node:fs/promises')
			await mkdir(path.join(f.changesDir, '1-one', 'slices', '2-a'), { recursive: true })
			await writeFile(
				path.join(f.changesDir, '1-one', 'store.json'),
				JSON.stringify({
					id: '1',
					slug: 'one',
					title: 'One',
					createdAt: '2026-05-17T00:00:00.000Z',
					closedAt: null,
					targetBranch: 'main',
					changeBranch: 'change-1-one',
				}),
			)
			await writeFile(
				path.join(f.changesDir, '1-one', 'slices', '2-a', 'store.json'),
				JSON.stringify({
					id: '2',
					slug: 'a',
					title: 'A',
					createdAt: '2026-05-17T00:00:00.000Z',
					closedAt: null,
					sliceBranch: 'change-1/slice-2-a',
					readyForAgent: false,
					needsRevision: false,
					blockedBy: [],
				}),
			)
			await writeFile(path.join(f.changesDir, '1-one', 'slices', '2-a', 'README.md'), 'body')
			await mkdir(path.join(f.changesDir, '10-ten', 'slices', '20-b'), { recursive: true })
			await writeFile(
				path.join(f.changesDir, '10-ten', 'store.json'),
				JSON.stringify({
					id: '10',
					slug: 'ten',
					title: 'Ten',
					createdAt: '2026-05-17T00:00:00.000Z',
					closedAt: null,
					targetBranch: 'main',
					changeBranch: 'change-10-ten',
				}),
			)
			await writeFile(
				path.join(f.changesDir, '10-ten', 'slices', '20-b', 'store.json'),
				JSON.stringify({
					id: '20',
					slug: 'b',
					title: 'B',
					createdAt: '2026-05-17T00:00:00.000Z',
					closedAt: null,
					sliceBranch: 'change-10/slice-20-b',
					readyForAgent: false,
					needsRevision: false,
					blockedBy: [],
				}),
			)
			await writeFile(path.join(f.changesDir, '10-ten', 'slices', '20-b', 'README.md'), 'body')

			const hit2 = await storage.findSlice('2')
			expect(hit2!.changeId).toBe('1')
			expect(hit2!.slice.id).toBe('2')

			const hit20 = await storage.findSlice('20')
			expect(hit20!.changeId).toBe('10')
			expect(hit20!.slice.id).toBe('20')
		})
	})

	describe('file storage: allocateNextId via createChange/createSlice', () => {
		let f: Fixture
		beforeEach(async () => {
			f = await setup()
		})
		afterEach(async () => {
			await teardown(f)
		})

		test('first Change gets id "1"', async () => {
			const storage = createFileStorage(f.deps)
			const { id } = await storage.createChange({ title: 'First', body: 'a' })
			expect(id).toBe('1')
		})

		test('Changes and slices share one pool: change(1), slice(2), change(3)', async () => {
			const storage = createFileStorage(f.deps)
			const first = await storage.createChange({ title: 'First', body: 'a' })
			expect(first.id).toBe('1')
			const slice = await storage.createSlice(first.id, { title: 'Foo', body: 'spec', blockedBy: [] })
			expect(slice.id).toBe('2')
			const second = await storage.createChange({ title: 'Second', body: 'b' })
			expect(second.id).toBe('3')
			const slice2 = await storage.createSlice(second.id, { title: 'Bar', body: 'spec', blockedBy: [] })
			expect(slice2.id).toBe('4')
		})

		test('closed Changes reserve their id (counter does not roll back)', async () => {
			const storage = createFileStorage(f.deps)
			const first = await createMaterialisedChange(storage, { title: 'First', body: 'a' })
			await storage.closeChange(first.id)
			const second = await storage.createChange({ title: 'Second', body: 'b' })
			expect(second.id).toBe('2')
		})
	})

	describe('file storage: branch metadata', () => {
		let f: Fixture
		beforeEach(async () => {
			f = await setup()
		})
		afterEach(async () => {
			await teardown(f)
		})

		test('updateChangeMetadata persists one field without clobbering existing branch metadata', async () => {
			const storage = createFileStorage(f.deps)
			const { id } = await createMaterialisedChange(storage, { title: 'Branch Metadata', body: 'b' })

			await storage.updateChangeMetadata(id, { changeBranch: 'change-custom' })

			expect(await storage.findChange(id)).toMatchObject({ id, targetBranch: 'main', changeBranch: 'change-custom' })
		})

		test('updateSliceMetadata persists the stored Slice branch', async () => {
			const storage = createFileStorage(f.deps)
			const { id: changeId } = await storage.createChange({ title: 'P', body: 'b' })
			const slice = await storage.createSlice(changeId, { title: 'Slice', body: 's', blockedBy: [] })

			await storage.updateSliceMetadata(changeId, slice.id, { sliceBranch: 'change-custom/slice' })

			expect((await storage.findSlices(changeId))[0]).toMatchObject({ id: slice.id, sliceBranch: 'change-custom/slice' })
		})

		test('findChange fails loudly when required branch metadata is missing', async () => {
			await mkdir(path.join(f.changesDir, '1-missing'), { recursive: true })
			await writeFile(
				path.join(f.changesDir, '1-missing', 'store.json'),
				JSON.stringify({ id: '1', slug: 'missing', title: 'Missing', createdAt: '2026-05-17T00:00:00.000Z', closedAt: null }),
			)
			const storage = createFileStorage(f.deps)

			await expect(storage.findChange('1')).rejects.toThrow(/missing required Change branch metadata/)
		})

		test('findSlices fails loudly when required Slice branch metadata is missing', async () => {
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
		let f: Fixture
		beforeEach(async () => {
			f = await setup()
		})
		afterEach(async () => {
			await teardown(f)
		})

		test('flips readyForAgent without writing needsRevision', async () => {
			const { storage, changeId, slice } = await createChangeWithSlice(f, { title: 'Foo', body: 'b', blockedBy: [] })

			await storage.updateSlice(changeId, slice.id, { readyForAgent: true })
			let store = JSON.parse(
				await readFile(path.join(f.changesDir, `${changeId}-p`, 'slices', `${slice.id}-foo`, 'store.json'), 'utf8'),
			)
			expect(store.readyForAgent).toBe(true)
			expect(store).not.toHaveProperty('needsRevision')

			await storage.updateSlice(changeId, slice.id, { readyForAgent: false })
			store = JSON.parse(await readFile(path.join(f.changesDir, `${changeId}-p`, 'slices', `${slice.id}-foo`, 'store.json'), 'utf8'))
			expect(store.readyForAgent).toBe(false)
			expect(store).not.toHaveProperty('needsRevision')
		})

		test('setting state CLOSED stamps closedAt; setting state OPEN clears it', async () => {
			const { storage, changeId, slice } = await createChangeWithSlice(f, { title: 'Foo', body: 'b', blockedBy: [] })

			await storage.updateSlice(changeId, slice.id, { closedAt: new Date().toISOString() })
			let store = JSON.parse(
				await readFile(path.join(f.changesDir, `${changeId}-p`, 'slices', `${slice.id}-foo`, 'store.json'), 'utf8'),
			)
			expect(store.closedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)

			await storage.updateSlice(changeId, slice.id, { closedAt: null })
			store = JSON.parse(await readFile(path.join(f.changesDir, `${changeId}-p`, 'slices', `${slice.id}-foo`, 'store.json'), 'utf8'))
			expect(store.closedAt).toBeNull()
		})

		test('updates blockedBy as a full-array replace', async () => {
			const storage = createFileStorage(f.deps)
			const { id: changeId } = await createMaterialisedChange(storage)
			const s = await createMaterialisedSlice(storage, changeId, { title: 'Foo', body: 'b', blockedBy: ['old1', 'old2'] })

			await storage.updateSlice(changeId, s.id, { blockedBy: ['new1'] })
			const found = (await storage.findSlices(changeId)).find((x) => x.id === s.id)!
			expect(found.blockedBy).toEqual(['new1'])

			// Empty array clears blockers.
			await storage.updateSlice(changeId, s.id, { blockedBy: [] })
			const found2 = (await storage.findSlices(changeId)).find((x) => x.id === s.id)!
			expect(found2.blockedBy).toEqual([])
		})

		test('throws when the slice does not exist', async () => {
			const storage = createFileStorage(f.deps)
			const { id: changeId } = await storage.createChange({ title: 'P', body: 'b' })
			await expect(storage.updateSlice(changeId, 'zzzzzz', { readyForAgent: true })).rejects.toThrow(/no slice/i)
		})
	})
}
