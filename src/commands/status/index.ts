import path from 'node:path'

import { renderStatus, renderStatusSlice } from './render.ts'
import { loadConfig } from '../../config.ts'
import { getStorage } from '../../storages/registry.ts'
import type { ClassifiedSlice, ChangeRecord, Slice, Storage, StorageDeps } from '../../storages/types.ts'
import { classifyChange } from '../../utils/change-state.ts'
import { createGh, type GhOps } from '../../utils/gh-ops.ts'
import { branchStableGitFacts, branchStableGitOps, createRepoGit, type GitOps, type ReadOnlyGitFacts } from '../../utils/git-ops.ts'
import { classifySlicesForChange } from '../../work/slice-states.ts'

type StatusRuntime = {
	storage: Storage
	gh: GhOps
	git: ReadOnlyGitFacts
	usePrs: boolean
	stdout: (s: string) => void
}

type BuiltStatusStorage = { storage: Storage; projectRoot: string; gh: GhOps; git: ReadOnlyGitFacts; usePrs: boolean }
type StatusCommandDeps = {
	buildStatusStorage?: (opts: { storage?: string }) => Promise<BuiltStatusStorage>
	stdout?: (s: string) => void
}

async function runStatus(changeId: string, rt: StatusRuntime): Promise<void> {
	const change = await rt.storage.findChange(changeId)
	if (!change) throw new Error(`Change '${changeId}' not found`)
	const slices = await classifySlicesForChange({ storage: rt.storage, gh: rt.gh, changeId, usePrs: rt.usePrs })
	const state = await classifyChange(change, slices, { gh: rt.gh, git: rt.git })
	writeStatusText(rt.stdout, renderStatus({ ...change, state }, slices))
}

async function buildStatusStorage(opts: { storage?: string }): Promise<{ storage: Storage; projectRoot: string; gh: GhOps; git: ReadOnlyGitFacts; usePrs: boolean }> {
	const { config, projectRoot } = await loadConfig()
	if (!projectRoot) {
		process.stderr.write('trowel status: no project root found\n')
		process.exit(1)
	}
	const storageKind = opts.storage ?? config.storage
	const gh = createGh()
	const git = branchStableGitOps(createRepoGit(projectRoot))
	const storageDeps: StorageDeps = {
		gh,
		git,
		repoRoot: projectRoot,
		projectRoot,
		changesDir: path.resolve(projectRoot, config.docs.changesDir),
		labels: config.labels,
		abortOptions: config.abort,
	}
	return { storage: getStorage(storageKind, storageDeps), projectRoot, gh, git: branchStableGitFacts(git), usePrs: config.ship.pr }
}

function statusRuntime(storage: Storage, gh: GhOps, git: ReadOnlyGitFacts, usePrs: boolean, stdout: (s: string) => void = (s) => process.stdout.write(s)): StatusRuntime {
	return { storage, gh, git, usePrs, stdout }
}

async function exitOnStatusError(fn: () => Promise<void>): Promise<void> {
	try {
		await fn()
	} catch (error) {
		process.stderr.write(`trowel status: ${(error as Error).message}\n`)
		process.exit(1)
	}
}

export async function statusChange(changeId: string, opts: { storage?: string }, deps: StatusCommandDeps = {}): Promise<void> {
	const { storage, gh, git, usePrs } = await (deps.buildStatusStorage ?? buildStatusStorage)(opts)
	await exitOnStatusError(() => runStatus(changeId, statusRuntime(storage, gh, git, usePrs, deps.stdout)))
}

export async function statusSlice(sliceId: string, opts: { storage?: string }, deps: StatusCommandDeps = {}): Promise<void> {
	const { storage, gh, git, usePrs } = await (deps.buildStatusStorage ?? buildStatusStorage)(opts)
	await exitOnStatusError(() => runStatusSlice(sliceId, statusRuntime(storage, gh, git, usePrs, deps.stdout)))
}

type StatusSliceRuntime = {
	storage: Storage
	gh: GhOps
	git: ReadOnlyGitFacts
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
	const { mkdir, mkdtemp, rm } = await import('node:fs/promises')
	const { recordingGhOps } = await import('../../test-utils/gh-ops-recorder.ts')
	const { noopGitOps } = await import('../../test-utils/git-ops-fixtures.ts')
	const { withMutationLock } = await import('../../utils/mutation-lock.ts')

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
			updateChangeMetadata: async () => {},
			createSlice: async () => {
				throw new Error('nyi')
			},
			findSlices: async () => state.rawSlices,
			findSlice: async () => null,
			updateSlice: async () => {},
			updateSliceMetadata: async () => {},
		}
	}

	const change: ChangeRecord = { id: 'ab12cd', changeBranch: 'change/ab12cd-feature', targetBranch: 'main', title: 'Add SSO', state: 'OPEN', closedAt: null }
	const renderedChange = { ...change, state: 'open' as const }
	const unmergedGit = () => branchStableGitFacts(noopGitOps({ remoteBranchExists: async () => false, branchExists: async () => false }))
	const rawStatusSlice = (overrides: Partial<Slice> = {}): Slice => ({
		id: '42',
		title: 'Implement tab parser',
		body: '',
		state: 'open',
		closedAt: null,
		readyForAgent: true,
		needsRevision: false,
		blockedBy: [],
		sliceBranch: `change-ab12cd/slice-${overrides.id ?? '42'}-implement-tab-parser`,
		prState: null,
		...overrides,
	})

	async function expectCompletesWhileMutationLockHeld(action: (projectRoot: string) => Promise<void>): Promise<void> {
		const testTmpRoot = path.join(process.cwd(), '.trowel')
		await mkdir(testTmpRoot, { recursive: true })
		const projectRoot = await mkdtemp(path.join(testTmpRoot, 'status-lock-'))
		let releaseHeldLock: (() => void) | undefined
		let held: Promise<void> | undefined
		const lockAcquired = new Promise<void>((resolve) => {
			held = withMutationLock(projectRoot, async () => {
				resolve()
				await new Promise<void>((release) => {
					releaseHeldLock = release
				})
			})
		})
		try {
			await lockAcquired
			const completed = action(projectRoot).then(() => 'completed' as const)
			const result = await Promise.race([completed, delay(150).then(() => 'blocked' as const)])
			releaseHeldLock?.()
			await completed
			expect(result).toBe('completed')
		} finally {
			releaseHeldLock?.()
			await held?.catch(() => undefined)
			await rm(projectRoot, { recursive: true, force: true })
		}
	}

	async function delay(ms: number): Promise<void> {
		await new Promise((resolve) => setTimeout(resolve, ms))
	}

	function branchSensitiveGit(calls: string[]): GitOps {
		const mutate = async (op: string): Promise<void> => {
			calls.push(op)
			throw new Error(`${op} must not run during entity read commands`)
		}
		return noopGitOps({
			remoteBranchExists: async (branch) => {
				calls.push(`remoteBranchExists(${branch})`)
				return true
			},
			fetch: async (branch) => { calls.push(`fetch(${branch})`) },
			commitsAhead: async (branch, base) => {
				calls.push(`commitsAhead(${branch},${base})`)
				return 0
			},
			branchExists: async (branch) => {
				calls.push(`branchExists(${branch})`)
				return true
			},
			isMerged: async (branch, base) => {
				calls.push(`isMerged(${branch},${base})`)
				return true
			},
			baseBranch: async () => {
				calls.push('baseBranch')
				return 'main'
			},
			checkout: async (branch) => { await mutate(`checkout(${branch})`) },
			createLocalBranch: async (branch, base) => { await mutate(`createLocalBranch(${branch},${base})`) },
			createRemoteBranch: async (branch, base) => { await mutate(`createRemoteBranch(${branch},${base})`) },
			deleteBranch: async (branch) => { await mutate(`deleteBranch(${branch})`) },
		})
	}

	function expectNoBranchMutations(calls: string[]): void {
		expect(calls.filter((call) => /^(checkout|createLocalBranch|createRemoteBranch|deleteBranch)\(/.test(call))).toEqual([])
	}

	describe('status commands are entity reads', () => {
		test('change status completes while the Mutation lock is held elsewhere', async () => {
			const storage = fakeStorage({ change, rawSlices: [] })
			const { gh } = recordingGhOps()
			let buf = ''
			await expectCompletesWhileMutationLockHeld(async (projectRoot) => {
				await statusChange(change.id, {}, {
					buildStatusStorage: async () => ({ storage, projectRoot, gh, git: unmergedGit(), usePrs: false }),
					stdout: (s) => (buf += s),
				})
			})
			expect(buf).toContain('State:               open')
		})

		test('slice status completes while the Mutation lock is held elsewhere', async () => {
			const rawSlice = rawStatusSlice()
			const storage: Storage = {
				createChange: async () => { throw new Error('nyi') },
				findChange: async (id) => (id === change.id ? change : null),
				listChanges: async () => [],
				closeChange: async () => {},
				updateChangeMetadata: async () => {},
				createSlice: async () => { throw new Error('nyi') },
				findSlices: async () => [rawSlice],
				findSlice: async (sliceId) => (sliceId === rawSlice.id ? { changeId: change.id, slice: rawSlice } : null),
				updateSlice: async () => {},
				updateSliceMetadata: async () => {},
			}
			const { gh } = recordingGhOps()
			let buf = ''
			await expectCompletesWhileMutationLockHeld(async (projectRoot) => {
				await statusSlice(rawSlice.id, {}, {
					buildStatusStorage: async () => ({ storage, projectRoot, gh, git: unmergedGit(), usePrs: false }),
					stdout: (s) => (buf += s),
				})
			})
			expect(buf).toContain(`Slice ${rawSlice.id}  ${rawSlice.title}`)
		})

		test('change status uses branch-stable git facts without mutating the checkout', async () => {
			const doneSlice = rawStatusSlice({ state: 'done', closedAt: '2026-06-04T00:00:00.000Z', readyForAgent: false })
			const storage = fakeStorage({ change, rawSlices: [doneSlice] })
			const { gh } = recordingGhOps({ findAnyPrByHead: async () => null })
			const gitCalls: string[] = []
			let buf = ''

			await statusChange(change.id, {}, {
				buildStatusStorage: async () => ({ storage, projectRoot: process.cwd(), gh, git: branchStableGitFacts(branchSensitiveGit(gitCalls)), usePrs: false }),
				stdout: (s) => (buf += s),
			})

			expect(buf).toContain('State:               landed')
			expect(gitCalls).toContain(`remoteBranchExists(${change.changeBranch})`)
			expect(gitCalls).toContain(`fetch(${change.changeBranch})`)
			expect(gitCalls).toContain('fetch(main)')
			expect(gitCalls).toContain(`commitsAhead(origin/${change.changeBranch},origin/main)`)
			expectNoBranchMutations(gitCalls)
		})

		test('slice status does not mutate branches while reading Slice state', async () => {
			const rawSlice = rawStatusSlice()
			const storage: Storage = {
				createChange: async () => { throw new Error('nyi') },
				findChange: async (id) => (id === change.id ? change : null),
				listChanges: async () => [],
				closeChange: async () => {},
				updateChangeMetadata: async () => {},
				createSlice: async () => { throw new Error('nyi') },
				findSlices: async () => [rawSlice],
				findSlice: async (sliceId) => (sliceId === rawSlice.id ? { changeId: change.id, slice: rawSlice } : null),
				updateSlice: async () => {},
				updateSliceMetadata: async () => {},
			}
			const { gh } = recordingGhOps()
			const gitCalls: string[] = []
			let buf = ''

			await statusSlice(rawSlice.id, {}, {
				buildStatusStorage: async () => ({ storage, projectRoot: process.cwd(), gh, git: branchStableGitFacts(branchSensitiveGit(gitCalls)), usePrs: false }),
				stdout: (s) => (buf += s),
			})

			expect(buf).toContain(`Slice ${rawSlice.id}  ${rawSlice.title}`)
			expectNoBranchMutations(gitCalls)
		})

		test('change status shows landed for a merged Close-out PR without finalizing the Change', async () => {
			const storage = fakeStorage({ change, rawSlices: [] })
			const closed: string[] = []
			storage.closeChange = async (id) => { closed.push(id) }
			const { gh } = recordingGhOps({ findAnyPrByHead: async () => ({ number: 7, state: 'MERGED' }) })
			let buf = ''

			await statusChange(change.id, {}, {
				buildStatusStorage: async () => ({ storage, projectRoot: process.cwd(), gh, git: unmergedGit(), usePrs: false }),
				stdout: (s) => (buf += s),
			})

			expect(buf).toContain('State:               landed')
			expect(buf).toContain(`Guidance:            merged to Target branch but not finalized; run trowel change ship ${change.id}`)
			expect(closed).toEqual([])
		})
	})

	describe('status: tracer (no slices)', () => {
		test('renders header + "(no slices)" summary', async () => {
			const storage = fakeStorage({ change, rawSlices: [] })
			const { gh } = recordingGhOps()
			let buf = ''
			await runStatus('ab12cd', { storage, gh, git: unmergedGit(), usePrs: false, stdout: (s) => (buf += s) })
			expect(buf).toContain('Change ab12cd  Add SSO')
			expect(buf).toContain('State:               open')
			expect(buf).toContain('Target branch:       main')
			expect(buf).toContain('Change branch:       change/ab12cd-feature')
			expect(buf).toContain('Guidance:            work remains')
			expect(buf).toContain('(no slices)')
		})

		test('error when Change not found', async () => {
			const storage = fakeStorage({ change: null, rawSlices: [] })
			const { gh } = recordingGhOps()
			await expect(runStatus('zzzzzz', { storage, gh, git: unmergedGit(), usePrs: false, stdout: () => {} })).rejects.toThrow(/'zzzzzz' not found/)
		})

		test('usePrs:true renders a ready storage slice with an open PR as in-flight', async () => {
			const storage = fakeStorage({
				change,
				rawSlices: [{ id: '124', title: 'Read query-shape validation', body: '', state: 'open', closedAt: null, readyForAgent: true, needsRevision: false, blockedBy: [], sliceBranch: `change-${change.id}/slice-124-read-query-shape-validation`, prState: null }],
			})
			const { gh } = recordingGhOps({
				listOpenPrs: async () => [{ number: 130, headRefName: `change-${change.id}/slice-124-read-query-shape-validation`, isDraft: false }],
			})
			let buf = ''
			await runStatus(change.id, { storage, gh, git: unmergedGit(), usePrs: true, stdout: (s) => (buf += s) })
			expect(buf).toContain('1 in-flight')
			expect(buf).toMatch(/^ {2}in-flight$/m)
			expect(buf).not.toMatch(/^ {2}open$/m)
		})
	})

	describe('status: per-state rendering', () => {
		const slice = (overrides: Partial<ClassifiedSlice>): ClassifiedSlice => ({
			id: 's1',
			title: 'a slice',
			body: '',
			state: 'draft',
			closedAt: null,
			readyForAgent: false,
			needsRevision: false,
			blockedBy: [],
			sliceBranch: `change-ab12cd/slice-${overrides.id ?? 's1'}-a-slice`,
			prState: null,
			...overrides,
		})

		test('"done" section appears for done slices', () => {
			const out = renderStatus(renderedChange, [slice({ id: '142', title: 'Schema migration', state: 'done', closedAt: '2026-06-04T00:00:00.000Z' })])
			expect(out).toMatch(/^ {2}done$/m)
			expect(out).toMatch(/142 +Schema migration/)
		})

		test('"open" section appears for open slices', () => {
			const out = renderStatus(renderedChange, [slice({ id: '147', title: 'Audit log', state: 'open', readyForAgent: true })])
			expect(out).toMatch(/^ {2}open$/m)
			expect(out).toMatch(/147 +Audit log/)
		})

		test('"draft" section appears for draft slices', () => {
			const out = renderStatus(renderedChange, [slice({ id: '149', title: 'TBD', state: 'draft' })])
			expect(out).toMatch(/^ {2}draft$/m)
		})

		test('"needs-revision" section appears for needsRevision slices', () => {
			const out = renderStatus(renderedChange, [slice({ id: '150', title: 'Fix me', state: 'needs-revision', needsRevision: true })])
			expect(out).toMatch(/^ {2}needs-revision$/m)
		})

		test('"in-flight" section appears for in-flight slices', () => {
			const out = renderStatus(renderedChange, [slice({ id: '145', title: 'Session middleware', state: 'in-flight', prState: 'draft' })])
			expect(out).toMatch(/^ {2}in-flight$/m)
		})

		test('"blocked" section shows blockedBy ids in the right column', () => {
			const out = renderStatus(renderedChange, [slice({ id: '146', title: 'SSO admin UI', state: 'blocked', readyForAgent: true, blockedBy: ['145', '147'] })])
			expect(out).toMatch(/^ {2}blocked$/m)
			expect(out).toContain('blocked by: 145, 147')
		})

		test('empty states are omitted from the rendering', () => {
			const out = renderStatus(renderedChange, [
				slice({ id: '142', title: 'A', state: 'done', closedAt: 'x' }),
				slice({ id: '147', title: 'B', state: 'open', readyForAgent: true }),
			])
			expect(out).toMatch(/^ {2}done$/m)
			expect(out).toMatch(/^ {2}open$/m)
			expect(out).not.toMatch(/^ {2}draft$/m)
			expect(out).not.toMatch(/^ {2}in-flight$/m)
		})

		test('summary line shows counts only for non-empty states', () => {
			const out = renderStatus(renderedChange, [
				slice({ id: 'd1', state: 'done', closedAt: 'x' }),
				slice({ id: 'd2', state: 'done', closedAt: 'x' }),
				slice({ id: 'r1', state: 'open', readyForAgent: true }),
			])
			expect(out).toContain('2 done · 1 open')
		})
	})

	describe('runStatusSlice', () => {
		function sliceStorage(change: ChangeRecord, rawSlices: Slice[]): Storage {
			const byId = new Map(rawSlices.map((s) => [s.id, s]))
			return {
				createChange: async () => ({ id: 'x', title: 'x' }),
				findChange: async (id) => (id === change.id ? change : null),
				listChanges: async () => [],
				closeChange: async () => {},
				updateChangeMetadata: async () => {},
				createSlice: async () => { throw new Error('nyi') },
				findSlices: async () => rawSlices,
				findSlice: async (sliceId) => {
					const s = byId.get(sliceId)
					return s ? { changeId: change.id, slice: s } : null
				},
				updateSlice: async () => {},
				updateSliceMetadata: async () => {},
			}
		}

		const rawSlice = (overrides: Partial<Slice>): Slice => ({
			id: '42',
			title: 'Implement tab parser',
			body: '',
			state: 'open',
			closedAt: null,
			readyForAgent: true,
			needsRevision: false,
			blockedBy: [],
			sliceBranch: `change-ab12cd/slice-${overrides.id ?? 's1'}-a-slice`,
			prState: null,
			...overrides,
		})

		async function renderSliceStatus(slices: Slice[]): Promise<string> {
			const storage = sliceStorage(change, slices)
			const { gh } = recordingGhOps()
			let buf = ''
			await runStatusSlice('42', { storage, gh, git: unmergedGit(), usePrs: false, stdout: (s) => (buf += s) })
			return buf
		}

		test('renders slice header + parent Change ref + state', async () => {
			const buf = await renderSliceStatus([rawSlice({ id: '42' })])
			expect(buf).toContain('Slice 42  Implement tab parser')
			expect(buf).toContain(`Change:  ${change.id}  ${change.title}`)
			expect(buf).toContain('State:   open')
		})

		test('renders blockedBy with each blocker state', async () => {
			const buf = await renderSliceStatus([
				rawSlice({ id: '40', title: 'Migration', state: 'done', closedAt: 'x' }),
				rawSlice({ id: '41', title: 'Constants', state: 'open', readyForAgent: true }),
				rawSlice({ id: '42', title: 'Tab parser', state: 'blocked', blockedBy: ['40', '41'] }),
			])
			expect(buf).toContain('Blocked by:')
			expect(buf).toMatch(/40.*done.*Migration/)
			expect(buf).toMatch(/41.*open.*Constants/)
		})

		test('errors when slice id not found', async () => {
			const storage = sliceStorage(change, [])
			const { gh } = recordingGhOps()
			await expect(runStatusSlice('999', { storage, gh, git: unmergedGit(), usePrs: false, stdout: () => {} })).rejects.toThrow(/slice '999' not found/)
		})
	})
}
