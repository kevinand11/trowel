import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { classifySlices } from '../../utils/bucket.ts'
import { generateId } from '../../utils/id.ts'
import { slug as slugify } from '../../utils/slug.ts'
import {
	landAddress,
	landImplement,
	landReview,
	prepareAddress,
	prepareImplement,
	prepareReview,
	type PhaseDeps,
} from '../../work/phases.ts'
import type {
	ClassifiedSlice,
	PrdRecord,
	PrdSpec,
	PrdSummary,
	Slice,
	SlicePatch,
	SliceSpec,
	Storage,
	StorageDeps,
	StorageFactory,
} from '../types.ts'

type PrdStore = { id: string; slug: string; title: string; createdAt: string; closedAt: string | null }
type SliceStore = PrdStore & { readyForAgent: boolean; needsRevision: boolean; blockedBy: string[] }

export const createFileStorage: StorageFactory = (deps: StorageDeps): Storage => {
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

	async function createPrd(spec: PrdSpec): Promise<{ id: string; branch: string }> {
		const slug = slugify(spec.title)
		const id = await generateId()
		const dir = path.join(deps.prdsDir, `${id}-${slug}`)
		const branch = `${id}-${slug}`

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

		await deps.git.createLocalBranch(branch, await deps.git.baseBranch())
		await deps.git.pushSetUpstream(branch)

		return { id, branch }
	}

	async function listPrds(opts: { state: 'open' | 'closed' | 'all' }): Promise<PrdSummary[]> {
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
				const isClosed = store.closedAt !== null
				if (opts.state === 'open' && isClosed) continue
				if (opts.state === 'closed' && !isClosed) continue
				summaries.push({
					id: store.id,
					title: store.title,
					branch: `${store.id}-${store.slug}`,
					createdAt: store.createdAt,
				})
			} catch {
				continue
			}
		}
		return summaries
	}

	async function closePrd(id: string): Promise<void> {
		const dir = await findPrdDir(id)
		const storePath = path.join(dir, 'store.json')
		const store: PrdStore = JSON.parse(await readFile(storePath, 'utf8'))
		if (store.closedAt !== null) return // idempotent: already closed in store
		store.closedAt = new Date().toISOString()
		await writeFile(storePath, JSON.stringify(store, null, 2) + '\n')
	}

	async function createSlice(prdId: string, spec: SliceSpec): Promise<Slice> {
		const slug = slugify(spec.title)
		const id = await generateId()
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
			blockedBy: spec.blockedBy,
		}
		await writeFile(path.join(dir, 'store.json'), JSON.stringify(store, null, 2) + '\n')

		return sliceFromStore(store, spec.body)
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
		const result: Slice[] = []
		for (const entry of entries) {
			const dir = path.join(slicesPath, entry)
			try {
				const store: SliceStore = JSON.parse(await readFile(path.join(dir, 'store.json'), 'utf8'))
				const body = await readFile(path.join(dir, 'README.md'), 'utf8')
				result.push(sliceFromStore(store, body))
			} catch {
				continue
			}
		}
		return result
	}

	async function updateSlice(prdId: string, sliceId: string, patch: SlicePatch): Promise<void> {
		const dir = await findSliceDir(prdId, sliceId)
		const storePath = path.join(dir, 'store.json')
		const store: SliceStore = JSON.parse(await readFile(storePath, 'utf8'))

		if (patch.readyForAgent !== undefined) store.readyForAgent = patch.readyForAgent
		if (patch.needsRevision !== undefined) store.needsRevision = patch.needsRevision
		if (patch.blockedBy !== undefined) store.blockedBy = [...patch.blockedBy]
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
			blockedBy: store.blockedBy ?? [],
			prState: null,
			branchAhead: false,
		}
	}

	async function findPrd(id: string): Promise<PrdRecord | null> {
		try {
			const store = await readPrdStore(id)
			return {
				id: store.id,
				branch: `${store.id}-${store.slug}`,
				title: store.title,
				state: store.closedAt === null ? 'OPEN' : 'CLOSED',
			}
		} catch {
			return null
		}
	}

	return {
		createPrd,
		findPrd,
		listPrds,
		closePrd,
		createSlice,
		findSlices,
		updateSlice,
	}
}

if (import.meta.vitest) {
	const { describe, test, expect, beforeEach, afterEach } = import.meta.vitest
	const path = await import('node:path')
	const { mkdir, rm, readFile, stat, writeFile } = await import('node:fs/promises')
	const { exec } = await import('../../utils/shell.ts')
	const { setupTestRepoWithBare } = await import('../../test-utils/git-repo.ts')
	const { recordingGhOps } = await import('../../test-utils/gh-ops-recorder.ts')

	type Fixture = {
		work: string
		bare: string
		prdsDir: string
		deps: StorageDeps
		calls: { git: Array<[string, ...string[]]>; log: string[] }
	}

	async function setup(): Promise<Fixture> {
		const repo = await setupTestRepoWithBare({ prefix: 'trowel-file-' })
		const work = repo.work
		const bare = repo.bare
		const prdsDir = path.join(work, 'docs', 'prds')
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
			deleteRemoteBranch: async (b: string) => {
				calls.git.push(['deleteRemoteBranch', b])
				await realGit.deleteRemoteBranch(b)
			},
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
			isMerged: async (b: string, base: string) => {
				const r = await realGit.isMerged(b, base)
				calls.git.push(['isMerged', b, base])
				return r
			},
			deleteBranch: async (b: string) => {
				calls.git.push(['deleteBranch', b])
				await realGit.deleteBranch(b)
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
		}
		const { gh } = recordingGhOps()
		const deps: StorageDeps = {
			gh,
			repoRoot: work,
			projectRoot: work,
			prdsDir,
			labels: { prd: 'prd', readyForAgent: 'ready-for-agent', needsRevision: 'needs-revision' },
			closeOptions: { comment: null, deleteBranch: 'never' },
			confirm: async () => false,
			git,
			log: (m) => {
				calls.log.push(m)
			},
		}
		return { work, bare, prdsDir, deps, calls }
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

	describe('file storage: phase primitives', () => {
		function makeOpenSlice(overrides: Partial<ClassifiedSlice> = {}): ClassifiedSlice {
			return {
				id: 's1',
				title: 'Implement A',
				body: 'spec',
				state: 'OPEN',
				readyForAgent: true,
				needsRevision: false,
				bucket: 'ready',
				blockedBy: [],
				prState: null,
				branchAhead: false,
				...overrides,
			}
		}

		function makePhaseDeps(f: Fixture, storage: Storage): PhaseDeps {
			return { storage, git: f.deps.git!, gh: f.deps.gh, log: f.deps.log! }
		}

		test('prepareImplement: branch is the integration branch; turnIn carries the slice', async () => {
			const f = await setup()
			try {
				const storage = createFileStorage(f.deps)
				const prep = await prepareImplement(makePhaseDeps(f, storage), makeOpenSlice(), {
					prdId: 'p1',
					integrationBranch: 'prd/p1-x',
					config: { usePrs: false, review: false, perSliceBranches: false },
				})
				expect(prep.branch).toBe('prd/p1-x')
				expect(prep.turnIn.slice).toEqual({ id: 's1', title: 'Implement A', body: 'spec' })
			} finally {
				await teardown(f)
			}
		})

		test('landImplement + ready: pushes integration, closes slice, returns done', async () => {
			const f = await setup()
			try {
				const storage = createFileStorage(f.deps)
				const result = await storage.createPrd({ title: 'X', body: 'b' })
				const slice = await storage.createSlice(result.id, { title: 'Implement A', body: 'spec', blockedBy: [] })
				await storage.updateSlice(result.id, slice.id, { readyForAgent: true })
				f.calls.git.length = 0

				const outcome = await landImplement(
					makePhaseDeps(f, storage),
					{ ...slice, readyForAgent: true },
					{ verdict: 'ready', commits: 1 },
					{
						prdId: result.id,
						integrationBranch: result.branch,
						config: { usePrs: false, review: false, perSliceBranches: false },
					},
				)

				expect(outcome).toBe('done')
				expect(f.calls.git).toContainEqual(['push', result.branch])
				const after = await storage.findSlices(result.id)
				expect(after[0]!.state).toBe('CLOSED')
			} finally {
				await teardown(f)
			}
		})

		test('landImplement + no-work-needed: clears readyForAgent, returns no-work, does not push', async () => {
			const f = await setup()
			try {
				const storage = createFileStorage(f.deps)
				const result = await storage.createPrd({ title: 'X', body: 'b' })
				const slice = await storage.createSlice(result.id, { title: 'A', body: 'spec', blockedBy: [] })
				await storage.updateSlice(result.id, slice.id, { readyForAgent: true })
				f.calls.git.length = 0

				const outcome = await landImplement(
					makePhaseDeps(f, storage),
					{ ...slice, readyForAgent: true },
					{ verdict: 'no-work-needed', commits: 0 },
					{
						prdId: result.id,
						integrationBranch: result.branch,
						config: { usePrs: false, review: false, perSliceBranches: false },
					},
				)

				expect(outcome).toBe('no-work')
				expect(f.calls.git.find((c) => c[0] === 'push')).toBeUndefined()
				const after = await storage.findSlices(result.id)
				expect(after[0]!.state).toBe('OPEN')
				expect(after[0]!.readyForAgent).toBe(false)
			} finally {
				await teardown(f)
			}
		})

		test('landImplement + partial: no host action, returns partial', async () => {
			const f = await setup()
			try {
				const storage = createFileStorage(f.deps)
				const result = await storage.createPrd({ title: 'X', body: 'b' })
				const slice = await storage.createSlice(result.id, { title: 'A', body: 'spec', blockedBy: [] })
				await storage.updateSlice(result.id, slice.id, { readyForAgent: true })
				f.calls.git.length = 0

				const outcome = await landImplement(
					makePhaseDeps(f, storage),
					{ ...slice, readyForAgent: true },
					{ verdict: 'partial', commits: 0 },
					{
						prdId: result.id,
						integrationBranch: result.branch,
						config: { usePrs: false, review: false, perSliceBranches: false },
					},
				)

				expect(outcome).toBe('partial')
				expect(f.calls.git).toEqual([])
				const after = await storage.findSlices(result.id)
				expect(after[0]!.state).toBe('OPEN')
				expect(after[0]!.readyForAgent).toBe(true)
			} finally {
				await teardown(f)
			}
		})

		test('prepareImplement + perSliceBranches:true: creates slice branch via git, turnIn carries the slice', async () => {
			const f = await setup()
			try {
				const storage = createFileStorage(f.deps)
				const { id: prdId, branch } = await storage.createPrd({ title: 'X', body: 'b' })
				const slice = await storage.createSlice(prdId, { title: 'Implement A', body: 'spec', blockedBy: [] })
				f.calls.git.length = 0

				const prep = await prepareImplement(makePhaseDeps(f, storage), { ...slice, bucket: 'ready' } as ClassifiedSlice, {
					prdId,
					integrationBranch: branch,
					config: { usePrs: false, review: false, perSliceBranches: true },
				})
				expect(prep.branch).toBe(`prd-${prdId}/slice-${slice.id}-implement-a`)
				expect(f.calls.git).toContainEqual(['createRemoteBranch', prep.branch, branch])
				expect(f.calls.git).toContainEqual(['fetch', prep.branch])
			} finally {
				await teardown(f)
			}
		})

		test('landImplement + perSliceBranches:true + usePrs:false + ready: slice branch → host-merge → updateSlice CLOSED; returns done', async () => {
			const f = await setup()
			try {
				const storage = createFileStorage(f.deps)
				const { id: prdId, branch: integration } = await storage.createPrd({ title: 'X', body: 'b' })
				const slice = await storage.createSlice(prdId, { title: 'Implement A', body: 'spec', blockedBy: [] })
				await storage.updateSlice(prdId, slice.id, { readyForAgent: true })
				const sliceBranch = `prd-${prdId}/slice-${slice.id}-implement-a`
				// Replace the spy git with a recording no-op for this matrix cell — we want to assert the
				// call sequence, not exercise real git state on a synthetic slice branch.
				const calls: Array<[string, ...string[]]> = []
				const recordingGit = {
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
					createLocalBranch: async () => {},
					pushSetUpstream: async () => {},
					currentBranch: async () => integration,
					baseBranch: async () => 'main',
					branchExists: async () => true,
					isMerged: async () => false,
					deleteBranch: async () => {},
					worktreeAdd: async () => {},
					worktreeRemove: async () => {},
					worktreeList: async () => [],
					restoreAll: async () => {},
					cleanUntracked: async () => {},
				}
				const deps: PhaseDeps = { storage, git: recordingGit, gh: f.deps.gh, log: f.deps.log! }

				const outcome = await landImplement(
					deps,
					{ ...slice, readyForAgent: true } as Slice,
					{ verdict: 'ready', commits: 1 },
					{ prdId, integrationBranch: integration, config: { usePrs: false, review: false, perSliceBranches: true } },
				)

				expect(outcome).toBe('done')
				expect(calls.map((c) => c[0])).toEqual(['push', 'checkout', 'mergeNoFf', 'push', 'deleteRemoteBranch'])
				expect(calls).toContainEqual(['push', sliceBranch])
				expect(calls).toContainEqual(['checkout', integration])
				expect(calls).toContainEqual(['mergeNoFf', sliceBranch])
				expect(calls).toContainEqual(['deleteRemoteBranch', sliceBranch])
				const after = await storage.findSlices(prdId)
				expect(after[0]!.state).toBe('CLOSED')
			} finally {
				await teardown(f)
			}
		})

		test('landImplement + perSliceBranches:true + usePrs:true + ready: opens a draft PR, returns progress, slice stays OPEN (capability gate retired)', async () => {
			const f = await setup()
			try {
				const storage = createFileStorage(f.deps)
				const { id: prdId, branch: integration } = await storage.createPrd({ title: 'X', body: 'b' })
				const slice = await storage.createSlice(prdId, { title: 'Implement A', body: 'spec', blockedBy: [] })
				await storage.updateSlice(prdId, slice.id, { readyForAgent: true })
				const sliceBranch = `prd-${prdId}/slice-${slice.id}-implement-a`
				const gitCalls: Array<[string, ...string[]]> = []
				const recordingGit = {
					fetch: async (b: string) => {
						gitCalls.push(['fetch', b])
					},
					push: async (b: string) => {
						gitCalls.push(['push', b])
					},
					checkout: async (b: string) => {
						gitCalls.push(['checkout', b])
					},
					mergeNoFf: async (b: string) => {
						gitCalls.push(['mergeNoFf', b])
					},
					deleteRemoteBranch: async (b: string) => {
						gitCalls.push(['deleteRemoteBranch', b])
					},
					createRemoteBranch: async (n: string, b: string) => {
						gitCalls.push(['createRemoteBranch', n, b])
					},
					createLocalBranch: async () => {},
					pushSetUpstream: async () => {},
					currentBranch: async () => integration,
					baseBranch: async () => 'develop',
					branchExists: async () => true,
					isMerged: async () => false,
					deleteBranch: async () => {},
					worktreeAdd: async () => {},
					worktreeRemove: async () => {},
					worktreeList: async () => [],
					restoreAll: async () => {},
					cleanUntracked: async () => {},
				}
				const { gh, calls: ghCalls } = recordingGhOps()
				const deps: PhaseDeps = { storage, git: recordingGit, gh, log: f.deps.log! }

				const outcome = await landImplement(
					deps,
					{ ...slice, readyForAgent: true } as Slice,
					{ verdict: 'ready', commits: 1 },
					{ prdId, integrationBranch: integration, config: { usePrs: true, review: false, perSliceBranches: true } },
				)

				expect(outcome).toBe('progress')
				expect(gitCalls).toContainEqual(['push', sliceBranch])
				// No merge/delete on this code path — PR creation is the terminus.
				expect(gitCalls.map((c) => c[0])).not.toContain('mergeNoFf')
				expect(gitCalls.map((c) => c[0])).not.toContain('deleteRemoteBranch')
				// createDraftPr was invoked.
				expect(ghCalls.find((c) => c[0] === 'createDraftPr')).toBeDefined()
				// Slice not closed (PR awaits merge).
				const after = await storage.findSlices(prdId)
				expect(after[0]!.state).toBe('OPEN')
			} finally {
				await teardown(f)
			}
		})

		test('review and address phases on file storage reach the PR-lookup layer (capability gate retired)', async () => {
			const f = await setup()
			try {
				const storage = createFileStorage(f.deps)
				const slice = makeOpenSlice()
				const ctx = { prdId: 'p1', integrationBranch: 'prd/p1-x', config: { usePrs: true, review: true, perSliceBranches: true } }
				const { gh } = recordingGhOps({
					findPrNumberByHead: async (head) => {
						throw new Error(`no PR found for head '${head}'`)
					},
				})
				const deps: PhaseDeps = { storage, git: f.deps.git!, gh, log: f.deps.log! }
				// No PR exists, so findPrNumberByHead throws "no PR found".
				// The point: that's now the failure mode, not "requires capability 'prFlow'".
				await expect(prepareReview(deps, slice, ctx)).rejects.toThrow(/no PR found/)
				await expect(prepareAddress(deps, slice, ctx)).rejects.toThrow(/no PR found/)
				// landReview/landAddress with verdict 'partial' short-circuit before any gh call.
				expect(await landReview(deps, slice, { verdict: 'partial', commits: 0 }, ctx)).toBe('partial')
				expect(await landAddress(deps, slice, { verdict: 'partial', commits: 0 }, ctx)).toBe('partial')
			} finally {
				await teardown(f)
			}
		})
	})

	describe('file storage: createPrd', () => {
		let f: Fixture
		beforeEach(async () => {
			f = await setup()
		})
		afterEach(async () => {
			await teardown(f)
		})

		test('writes README.md and store.json under <prdsDir>/<id>-<slug>/ and returns matching id+branch', async () => {
			const storage = createFileStorage(f.deps)
			const result = await storage.createPrd({ title: 'Fix Tabs', body: '# Hi\n\nthe body' })
			expect(result.branch).toBe(`${result.id}-fix-tabs`)
			const dir = path.join(f.prdsDir, `${result.id}-fix-tabs`)
			expect(await exists(path.join(dir, 'README.md'))).toBe(true)
			expect(await exists(path.join(dir, 'store.json'))).toBe(true)
			const readme = await readFile(path.join(dir, 'README.md'), 'utf8')
			expect(readme).toBe('# Hi\n\nthe body')
			const store = JSON.parse(await readFile(path.join(dir, 'store.json'), 'utf8'))
			expect(store).toMatchObject({ id: result.id, slug: 'fix-tabs', title: 'Fix Tabs', closedAt: null })
			expect(typeof store.createdAt).toBe('string')
		})

		test('creates and pushes the integration branch without auto-committing the PRD files', async () => {
			const storage = createFileStorage(f.deps)
			const result = await storage.createPrd({ title: 'Add ORM', body: 'spec' })
			const localHead = (await exec('git', ['-C', f.work, 'rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim()
			expect(localHead).toBe(result.branch)
			const remoteRefs = (await exec('git', ['-C', f.work, 'ls-remote', '--heads', 'origin'])).stdout
			expect(remoteRefs).toContain(`refs/heads/${result.branch}`)
			// no commits beyond the base branch — the integration branch is empty relative to main
			const commitDelta = (await exec('git', ['-C', f.work, 'rev-list', '--count', `main..${result.branch}`])).stdout.trim()
			expect(commitDelta).toBe('0')
		})
	})

	describe('file storage: listPrds', () => {
		let f: Fixture
		beforeEach(async () => {
			f = await setup()
		})
		afterEach(async () => {
			await teardown(f)
		})

		test('returns empty array when prdsDir does not exist', async () => {
			const storage = createFileStorage(f.deps)
			expect(await storage.listPrds({ state: 'open' })).toEqual([])
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

			const storage = createFileStorage(f.deps)
			const open = await storage.listPrds({ state: 'open' })
			expect(open).toHaveLength(1)
			expect(open[0]).toEqual({ id: 'bbbbbb', title: 'Beta', branch: 'bbbbbb-beta', createdAt: '2026-05-11T00:00:00.000Z' })
		})

		test('returns both open and closed PRDs when called with { state: "all" }', async () => {
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

			const storage = createFileStorage(f.deps)
			const all = await storage.listPrds({ state: 'all' })
			expect(all).toHaveLength(2)
			expect(all.map((p) => p.id).sort()).toEqual(['aaaaaa', 'bbbbbb'])
		})

		test('returns PRDs with their createdAt populated (consumer sorts; see `trowel list`)', async () => {
			const dirs = [
				{ name: 'aaaaaa-old', id: 'aaaaaa', slug: 'old', createdAt: '2026-05-01T00:00:00.000Z' },
				{ name: 'bbbbbb-new', id: 'bbbbbb', slug: 'new', createdAt: '2026-05-12T00:00:00.000Z' },
			]
			for (const d of dirs) {
				const dir = path.join(f.prdsDir, d.name)
				await mkdir(dir, { recursive: true })
				await writeFile(
					path.join(dir, 'store.json'),
					JSON.stringify({ id: d.id, slug: d.slug, title: d.id, createdAt: d.createdAt, closedAt: null }),
				)
			}

			const storage = createFileStorage(f.deps)
			const out = await storage.listPrds({ state: 'open' })
			expect(out.find((p) => p.id === 'aaaaaa')!.createdAt).toBe('2026-05-01T00:00:00.000Z')
			expect(out.find((p) => p.id === 'bbbbbb')!.createdAt).toBe('2026-05-12T00:00:00.000Z')
		})

		test('returns only closed PRDs when called with { state: "closed" }', async () => {
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

			const storage = createFileStorage(f.deps)
			const closed = await storage.listPrds({ state: 'closed' })
			expect(closed).toHaveLength(1)
			expect(closed[0]).toEqual({ id: 'aaaaaa', title: 'Alpha', branch: 'aaaaaa-alpha', createdAt: '2026-05-11T00:00:00.000Z' })
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
			const { id, branch } = await storage.createPrd({ title: 'Alpha', body: 'a' })
			await storage.closePrd(id)
			const storePath = path.join(f.prdsDir, `${id}-alpha`, 'store.json')
			const store = JSON.parse(await readFile(storePath, 'utf8'))
			expect(store.closedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
			// close must not add a commit
			const commitDelta = (await exec('git', ['-C', f.work, 'rev-list', '--count', `main..${branch}`])).stdout.trim()
			expect(commitDelta).toBe('0')
			// branch must still exist — branch deletion is orchestrator's job.
			const remoteRefs = (await exec('git', ['-C', f.work, 'ls-remote', '--heads', 'origin'])).stdout
			expect(remoteRefs).toContain(`refs/heads/${branch}`)
			const localRefs = (await exec('git', ['-C', f.work, 'branch', '--list', branch])).stdout
			expect(localRefs.trim()).not.toBe('')
		})

		test('idempotent: re-running close on a closed PRD is a no-op', async () => {
			const storage = createFileStorage(f.deps)
			const { id } = await storage.createPrd({ title: 'Alpha', body: 'a' })
			await storage.closePrd(id)
			const storePath = path.join(f.prdsDir, `${id}-alpha`, 'store.json')
			const firstClosedAt = JSON.parse(await readFile(storePath, 'utf8')).closedAt
			const commitCountBefore = (await exec('git', ['-C', f.work, 'rev-list', '--count', 'HEAD'])).stdout.trim()
			await storage.closePrd(id)
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

		test('writes README.md and store.json under <prdDir>/slices/<id>-<slug>/ and returns the Slice', async () => {
			const storage = createFileStorage(f.deps)
			const { id: prdId } = await storage.createPrd({ title: 'Add ORM', body: 'prd-spec' })

			const slice = await storage.createSlice(prdId, { title: 'Implement Tab Parser', body: '# spec\nbody', blockedBy: [] })
			expect(slice.title).toBe('Implement Tab Parser')
			expect(slice.body).toBe('# spec\nbody')
			expect(slice.state).toBe('OPEN')
			expect(slice.readyForAgent).toBe(false)
			expect(slice.needsRevision).toBe(false)

			const dir = path.join(f.prdsDir, `${prdId}-add-orm`, 'slices', `${slice.id}-implement-tab-parser`)
			expect(await exists(path.join(dir, 'README.md'))).toBe(true)
			expect(await exists(path.join(dir, 'store.json'))).toBe(true)
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

		test('returns empty array when the PRD has no slices/ directory', async () => {
			const storage = createFileStorage(f.deps)
			const { id: prdId } = await storage.createPrd({ title: 'P', body: 'b' })
			expect(await storage.findSlices(prdId)).toEqual([])
		})

		test('returned slices have prState=null and branchAhead=false (file storage has no PR concept)', async () => {
			const storage = createFileStorage(f.deps)
			const { id: prdId } = await storage.createPrd({ title: 'P', body: 'b' })
			await storage.createSlice(prdId, { title: 'A', body: 'spec', blockedBy: [] })
			const [s] = classifySlices(await storage.findSlices(prdId))
			expect(s!.prState).toBeNull()
			expect(s!.branchAhead).toBe(false)
		})

		test('returns one Slice per slice directory with body from README.md and state from closedAt', async () => {
			const storage = createFileStorage(f.deps)
			const { id: prdId } = await storage.createPrd({ title: 'P', body: 'b' })
			const a = await storage.createSlice(prdId, { title: 'Alpha', body: 'aa', blockedBy: [] })
			const b = await storage.createSlice(prdId, { title: 'Beta', body: 'bb', blockedBy: [] })
			// Mark b as closed and needsRevision via updateSlice
			await storage.updateSlice(prdId, b.id, { state: 'CLOSED', needsRevision: true })

			const slices = classifySlices(await storage.findSlices(prdId))
			expect(slices).toHaveLength(2)
			const byId = Object.fromEntries(slices.map((s) => [s.id, s]))
			expect(byId[a.id]).toMatchObject({ title: 'Alpha', body: 'aa', state: 'OPEN', readyForAgent: false, needsRevision: false })
			expect(byId[b.id]).toMatchObject({ title: 'Beta', body: 'bb', state: 'CLOSED', needsRevision: true })
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
			const { id: prdId } = await storage.createPrd({ title: 'P', body: 'b' })
			const slice = await storage.createSlice(prdId, {
				title: 'Needs others',
				body: 'spec',
				blockedBy: ['abc123', 'def456'],
			})
			expect(slice.blockedBy).toEqual(['abc123', 'def456'])

			const found = (await storage.findSlices(prdId)).find((s) => s.id === slice.id)!
			expect(found.blockedBy).toEqual(['abc123', 'def456'])
		})
	})

	describe('file storage: findSlices computes bucket', () => {
		let f: Fixture
		beforeEach(async () => {
			f = await setup()
		})
		afterEach(async () => {
			await teardown(f)
		})

		test('OPEN slice with no readiness flags → draft', async () => {
			const storage = createFileStorage(f.deps)
			const { id: prdId } = await storage.createPrd({ title: 'P', body: 'b' })
			await storage.createSlice(prdId, { title: 'A', body: 'spec', blockedBy: [] })
			const [s] = classifySlices(await storage.findSlices(prdId))
			expect(s!.bucket).toBe('draft')
		})

		test('readyForAgent and no deps → ready', async () => {
			const storage = createFileStorage(f.deps)
			const { id: prdId } = await storage.createPrd({ title: 'P', body: 'b' })
			const s = await storage.createSlice(prdId, { title: 'A', body: 'spec', blockedBy: [] })
			await storage.updateSlice(prdId, s.id, { readyForAgent: true })
			const [updated] = classifySlices(await storage.findSlices(prdId))
			expect(updated!.bucket).toBe('ready')
		})

		test('needsRevision → needs-revision (regardless of readyForAgent)', async () => {
			const storage = createFileStorage(f.deps)
			const { id: prdId } = await storage.createPrd({ title: 'P', body: 'b' })
			const s = await storage.createSlice(prdId, { title: 'A', body: 'spec', blockedBy: [] })
			await storage.updateSlice(prdId, s.id, { needsRevision: true, readyForAgent: true })
			const [updated] = classifySlices(await storage.findSlices(prdId))
			expect(updated!.bucket).toBe('needs-revision')
		})

		test('CLOSED → done', async () => {
			const storage = createFileStorage(f.deps)
			const { id: prdId } = await storage.createPrd({ title: 'P', body: 'b' })
			const s = await storage.createSlice(prdId, { title: 'A', body: 'spec', blockedBy: [] })
			await storage.updateSlice(prdId, s.id, { state: 'CLOSED' })
			const [updated] = classifySlices(await storage.findSlices(prdId))
			expect(updated!.bucket).toBe('done')
		})

		test('slice with Depends-on: pointing to a non-done slice → blocked', async () => {
			const storage = createFileStorage(f.deps)
			const { id: prdId } = await storage.createPrd({ title: 'P', body: 'b' })
			const a = await storage.createSlice(prdId, { title: 'A', body: 'spec', blockedBy: [] })
			const b = await storage.createSlice(prdId, { title: 'B', body: 'b spec', blockedBy: [a.id] })
			await storage.updateSlice(prdId, b.id, { readyForAgent: true })
			const slices = classifySlices(await storage.findSlices(prdId))
			const bAfter = slices.find((s) => s.id === b.id)!
			expect(bAfter.bucket).toBe('blocked')
		})

		test('slice with Depends-on: pointing to a done slice → ready (dep satisfied)', async () => {
			const storage = createFileStorage(f.deps)
			const { id: prdId } = await storage.createPrd({ title: 'P', body: 'b' })
			const a = await storage.createSlice(prdId, { title: 'A', body: 'spec', blockedBy: [] })
			const b = await storage.createSlice(prdId, { title: 'B', body: 'b spec', blockedBy: [a.id] })
			await storage.updateSlice(prdId, a.id, { state: 'CLOSED' })
			await storage.updateSlice(prdId, b.id, { readyForAgent: true })
			const slices = classifySlices(await storage.findSlices(prdId))
			const bAfter = slices.find((s) => s.id === b.id)!
			expect(bAfter.bucket).toBe('ready')
		})

		test('file storage never returns in-flight (no PR concept)', async () => {
			const storage = createFileStorage(f.deps)
			const { id: prdId } = await storage.createPrd({ title: 'P', body: 'b' })
			const s = await storage.createSlice(prdId, { title: 'A', body: 'spec', blockedBy: [] })
			await storage.updateSlice(prdId, s.id, { readyForAgent: true })
			const slices = classifySlices(await storage.findSlices(prdId))
			expect(slices.every((x) => x.bucket !== 'in-flight')).toBe(true)
		})
	})

	describe('file storage: findPrd', () => {
		let f: Fixture
		beforeEach(async () => {
			f = await setup()
		})
		afterEach(async () => {
			await teardown(f)
		})

		test('returns null when no PRD exists for id', async () => {
			const storage = createFileStorage(f.deps)
			expect(await storage.findPrd('zzzzzz')).toBeNull()
		})

		test('returns PrdRecord with state=OPEN for an open PRD', async () => {
			const storage = createFileStorage(f.deps)
			const { id, branch } = await storage.createPrd({ title: 'Alpha', body: 'a' })
			expect(await storage.findPrd(id)).toEqual({ id, branch, title: 'Alpha', state: 'OPEN' })
		})

		test('returns PrdRecord with state=CLOSED after close', async () => {
			const deps: StorageDeps = { ...f.deps, closeOptions: { comment: null, deleteBranch: 'never' } }
			const storage = createFileStorage(deps)
			const { id, branch } = await storage.createPrd({ title: 'Beta', body: 'b' })
			await storage.closePrd(id)
			expect(await storage.findPrd(id)).toEqual({ id, branch, title: 'Beta', state: 'CLOSED' })
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

		test('flips readyForAgent and needsRevision', async () => {
			const storage = createFileStorage(f.deps)
			const { id: prdId } = await storage.createPrd({ title: 'P', body: 'b' })
			const s = await storage.createSlice(prdId, { title: 'Foo', body: 'b', blockedBy: [] })

			await storage.updateSlice(prdId, s.id, { readyForAgent: true })
			let store = JSON.parse(await readFile(path.join(f.prdsDir, `${prdId}-p`, 'slices', `${s.id}-foo`, 'store.json'), 'utf8'))
			expect(store.readyForAgent).toBe(true)
			expect(store.needsRevision).toBe(false)

			await storage.updateSlice(prdId, s.id, { needsRevision: true, readyForAgent: false })
			store = JSON.parse(await readFile(path.join(f.prdsDir, `${prdId}-p`, 'slices', `${s.id}-foo`, 'store.json'), 'utf8'))
			expect(store.readyForAgent).toBe(false)
			expect(store.needsRevision).toBe(true)
		})

		test('setting state CLOSED stamps closedAt; setting state OPEN clears it', async () => {
			const storage = createFileStorage(f.deps)
			const { id: prdId } = await storage.createPrd({ title: 'P', body: 'b' })
			const s = await storage.createSlice(prdId, { title: 'Foo', body: 'b', blockedBy: [] })

			await storage.updateSlice(prdId, s.id, { state: 'CLOSED' })
			let store = JSON.parse(await readFile(path.join(f.prdsDir, `${prdId}-p`, 'slices', `${s.id}-foo`, 'store.json'), 'utf8'))
			expect(store.closedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)

			await storage.updateSlice(prdId, s.id, { state: 'OPEN' })
			store = JSON.parse(await readFile(path.join(f.prdsDir, `${prdId}-p`, 'slices', `${s.id}-foo`, 'store.json'), 'utf8'))
			expect(store.closedAt).toBeNull()
		})

		test('updates blockedBy as a full-array replace', async () => {
			const storage = createFileStorage(f.deps)
			const { id: prdId } = await storage.createPrd({ title: 'P', body: 'b' })
			const s = await storage.createSlice(prdId, { title: 'Foo', body: 'b', blockedBy: ['old1', 'old2'] })

			await storage.updateSlice(prdId, s.id, { blockedBy: ['new1'] })
			const found = (await storage.findSlices(prdId)).find((x) => x.id === s.id)!
			expect(found.blockedBy).toEqual(['new1'])

			// Empty array clears blockers.
			await storage.updateSlice(prdId, s.id, { blockedBy: [] })
			const found2 = (await storage.findSlices(prdId)).find((x) => x.id === s.id)!
			expect(found2.blockedBy).toEqual([])
		})

		test('throws when the slice does not exist', async () => {
			const storage = createFileStorage(f.deps)
			const { id: prdId } = await storage.createPrd({ title: 'P', body: 'b' })
			await expect(storage.updateSlice(prdId, 'zzzzzz', { readyForAgent: true })).rejects.toThrow(/no slice/i)
		})
	})
}
