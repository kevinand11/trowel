import { confirm as inqConfirm, input as inqInput } from '@inquirer/prompts'

import { restoreStartingBranch, type OpenPr } from './branch.ts'
import type { StorageKind } from '../../storages/registry.ts'
import type { ChangeRecord, ChangeState, ClassifiedSlice, DeleteBranchPolicy, Storage } from '../../storages/types.ts'
import { classifyChange } from '../../utils/change-state.ts'
import type { GhOps } from '../../utils/gh-ops.ts'
import type { GitOps } from '../../utils/git-ops.ts'
import { withMutationLock } from '../../utils/mutation-lock.ts'
import { slug as slugify } from '../../utils/slug.ts'
import { cleanupChange, refuseCurrentCleanupBranch } from '../../work/cleanup.ts'
import { classifySlicesForChange } from '../../work/slice-states.ts'
import { buildStorage, exitOnCommandError, loadCommandBase, type CommandBase } from '../runtime.ts'

type AbortRuntime = {
	projectRoot?: string
	storage: Storage
	git: GitOps
	gh: GhOps
	usePrs: boolean
	deleteBranchPolicy: DeleteBranchPolicy
	abortComment: string | null
	interactive?: boolean
	confirm: (msg: string) => Promise<boolean>
	confirmExact: (msg: string, expected: string) => Promise<boolean>
	stdout: (s: string) => void
	listOpenPrs: (branch: string) => Promise<OpenPr[]>
}

type ClassifiedChange = {
	change: ChangeRecord
	slices: ClassifiedSlice[]
	state: ChangeState
}

async function runAbortChange(changeId: string, rt: AbortRuntime): Promise<void> {
	const back = await rt.git.currentBranch()
	const { change, slices, state } = await classifiedChangeOrThrow(changeId, rt)
	const targetBranch = await changeTargetBranch(change, rt)
	if (abortMayRunCleanup(state)) await refuseCurrentCleanupBranch({ change, slices, rt })
	try {
		await abortChangeByState({ change, slices, state }, targetBranch, rt)
	} finally {
		await restoreStartingBranch(back, targetBranch, rt)
	}
}

function abortMayRunCleanup(state: ChangeState): boolean {
	return state === 'open' || state === 'ready' || state === 'in-flight' || state === 'aborted'
}

async function classifiedChangeOrThrow(changeId: string, rt: AbortRuntime): Promise<ClassifiedChange> {
	const change = await rt.storage.findChange(changeId)
	if (!change) throw new Error(`Change '${changeId}' not found`)
	const slices = await classifySlicesForChange({ storage: rt.storage, gh: rt.gh, changeId, usePrs: rt.usePrs })
	return { change, slices, state: await classifyChange(change, slices, { gh: rt.gh, git: rt.git }) }
}

async function changeTargetBranch(change: ChangeRecord, rt: AbortRuntime): Promise<string> {
	return change.targetBranch ?? await rt.git.baseBranch()
}

async function abortChangeByState(target: ClassifiedChange, targetBranch: string, rt: AbortRuntime): Promise<void> {
	switch (target.state) {
		case 'open':
		case 'ready':
			await abortOpenOrReadyChange(target.change, target.slices, targetBranch, rt)
			return
		case 'in-flight':
			await abortInFlightChange(target.change, target.slices, targetBranch, rt)
			return
		case 'aborted':
			rt.stdout(`Change ${target.change.id} is already aborted; running cleanup.\n`)
			await cleanupAfterAbort(target.change, target.slices, targetBranch, rt)
			return
		case 'landed':
		case 'done':
			throw new Error(`Change ${target.change.id} is ${target.state}; abort would discard shipped work. Run: trowel change ship ${target.change.id}`)
	}
}

async function abortOpenOrReadyChange(change: ChangeRecord, slices: ClassifiedSlice[], targetBranch: string, rt: AbortRuntime): Promise<void> {
	await closeOpenSlicePrs(change.id, slices, rt)
	await closeOpenSliceRecords(change.id, slices, rt)
	await rt.storage.closeChange(change.id)
	await cleanupAfterAbort(change, slices, targetBranch, rt)
}

async function abortInFlightChange(change: ChangeRecord, slices: ClassifiedSlice[], targetBranch: string, rt: AbortRuntime): Promise<void> {
	if (!(await confirmAbortInFlightChange(change.id, rt))) return
	await closeOpenCloseOutPr(change, rt)
	await closeOpenSlicePrs(change.id, slices, rt)
	await closeOpenSliceRecords(change.id, slices, rt)
	await rt.storage.closeChange(change.id)
	await cleanupAfterAbort(change, slices, targetBranch, rt)
}

async function confirmAbortInFlightChange(changeId: string, rt: AbortRuntime): Promise<boolean> {
	if (rt.interactive === false) throw new Error(`Change ${changeId} is in-flight; abort requires an interactive terminal and exact-id confirmation.`)
	const ok = await rt.confirmExact(`Change ${changeId} is in-flight with an open Close-out PR. Type '${changeId}' to close it without merging and abort:`, changeId)
	if (ok) return true
	rt.stdout('Aborted; nothing changed.\n')
	return false
}

async function closeOpenSlicePrs(changeId: string, slices: ClassifiedSlice[], rt: AbortRuntime): Promise<void> {
	if (!rt.usePrs) return
	const canonicalHeads = new Set(slices.map((slice) => sliceBranchName(changeId, slice)))
	for (const pr of await rt.gh.listOpenPrs()) {
		if (canonicalHeads.has(pr.headRefName) || pr.headRefName.startsWith(sliceBranchPrefix(changeId))) await closePrWithoutMerging(pr.number, rt)
	}
}

function sliceBranchPrefix(changeId: string): string {
	return `change-${changeId}/slice-`
}

async function closeOpenCloseOutPr(change: ChangeRecord, rt: AbortRuntime): Promise<void> {
	const pr = await rt.gh.findAnyPrByHead(change.branch)
	if (pr?.state === 'OPEN') await closePrWithoutMerging(pr.number, rt)
}

async function closePrWithoutMerging(prNumber: number, rt: AbortRuntime): Promise<void> {
	if (rt.abortComment === null) await rt.gh.closePr(prNumber)
	else await rt.gh.closePr(prNumber, { comment: rt.abortComment })
}

async function closeOpenSliceRecords(changeId: string, slices: ClassifiedSlice[], rt: AbortRuntime): Promise<void> {
	const closedAt = new Date().toISOString()
	for (const slice of slices) {
		if (slice.closedAt === null) await rt.storage.updateSlice(changeId, slice.id, { closedAt })
	}
}

async function cleanupAfterAbort(change: ChangeRecord, slices: ClassifiedSlice[], targetBranch: string, rt: AbortRuntime): Promise<void> {
	await cleanupChange({
		change,
		slices,
		targetBranch,
		rt: {
			projectRoot: rt.projectRoot ?? process.cwd(),
			git: rt.git,
			deleteBranchPolicy: rt.deleteBranchPolicy,
			interactive: rt.interactive ?? true,
			confirm: rt.confirm,
			stdout: rt.stdout,
		},
	})
}

function sliceBranchName(changeId: string, slice: Pick<ClassifiedSlice, 'id' | 'title'>): string {
	return `change-${changeId}/slice-${slice.id}-${slugify(slice.title)}`
}

function listOpenPrsFor(base: CommandBase): (branch: string) => Promise<OpenPr[]> {
	return async (branch) => {
		try {
			const prs = await base.gh.listOpenPrs({ base: branch })
			return prs.map((p) => ({ number: p.number, url: p.url ?? '' }))
		} catch {
			return []
		}
	}
}

async function buildAbortRuntime(opts: { storage?: StorageKind }): Promise<{ base: CommandBase; rt: AbortRuntime }> {
	const base = await loadCommandBase('change abort')
	const confirm = (msg: string) => inqConfirm({ message: msg, default: false })
	const storageKind = opts.storage ?? base.config.storage
	const storage = buildStorage(base, storageKind, { confirm })
	return {
		base,
		rt: {
			projectRoot: base.projectRoot,
			storage,
			git: base.git,
			gh: base.gh,
			usePrs: base.config.work.usePrs,
			deleteBranchPolicy: base.config.abort.deleteBranch,
			abortComment: base.config.abort.comment,
			interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
			confirm,
			confirmExact: async (message, expected) => (await inqInput({ message })) === expected,
			stdout: (s) => process.stdout.write(s),
			listOpenPrs: listOpenPrsFor(base),
		},
	}
}

export async function abortChange(changeId: string, opts: { storage?: StorageKind }): Promise<void> {
	const { base, rt } = await buildAbortRuntime(opts)
	await exitOnCommandError('change abort', () => withMutationLock(base.projectRoot, () => runAbortChange(changeId, rt)))
}

if (import.meta.vitest) {
	const { describe, test, expect } = import.meta.vitest
	const { recordingGhOps } = await import('../../test-utils/gh-ops-recorder.ts')
	const { noopGitOps } = await import('../../test-utils/git-ops-fixtures.ts')

	type FakeStorageState = {
		change: ChangeRecord | null
		slices: ClassifiedSlice[]
	}

	type GitState = {
		current: string
		branches: Set<string>
		remoteBranches: Set<string>
		ahead: Map<string, number>
		mergedIntoTarget: boolean
	}

	function fakeChange(overrides: Partial<ChangeRecord> = {}): ChangeRecord {
		return {
			id: '42',
			branch: 'change-42-feature',
			targetBranch: 'main',
			title: 'Feature',
			state: 'OPEN',
			closedAt: null,
			...overrides,
		}
	}

	function fakeSlice(overrides: Partial<ClassifiedSlice> = {}): ClassifiedSlice {
		return {
			id: 's1',
			title: 'First Slice',
			body: '',
			state: 'open',
			closedAt: null,
			readyForAgent: true,
			needsRevision: false,
			blockedBy: [],
			prState: null,
			...overrides,
		}
	}

	function fakeStorage(state: FakeStorageState): { storage: Storage; calls: string[] } {
		const calls: string[] = []
		const storage: Storage = {
			createChange: async () => { throw new Error('not implemented') },
			findChange: async (id) => {
				calls.push(`findChange(${id})`)
				return state.change && state.change.id === id ? { ...state.change } : null
			},
			listChanges: async () => [],
			closeChange: async (id) => {
				calls.push(`closeChange(${id})`)
				if (state.change && state.change.id === id) {
					state.change.state = 'CLOSED'
					state.change.closedAt = new Date().toISOString()
				}
			},
			createSlice: async () => { throw new Error('not implemented') },
			findSlices: async () => {
				calls.push('findSlices')
				return state.slices.map((slice) => ({ ...slice }))
			},
			findSlice: async () => null,
			updateSlice: async (_changeId, sliceId, patch) => {
				calls.push(`updateSlice(${sliceId},${JSON.stringify(patch)})`)
				const slice = state.slices.find((s) => s.id === sliceId)
				if (slice && patch.closedAt !== undefined) {
					slice.closedAt = patch.closedAt
					slice.state = patch.closedAt === null ? 'open' : 'done'
				}
			},
		}
		return { storage, calls }
	}

	function fakeGit(state: Partial<GitState> = {}): { git: GitOps; calls: string[]; state: GitState } {
		const full: GitState = {
			current: 'main',
			branches: new Set(['main', 'change-42-feature']),
			remoteBranches: new Set(),
			ahead: new Map(),
			mergedIntoTarget: false,
			...state,
		}
		const calls: string[] = []
		const git = noopGitOps({
			currentBranch: async () => full.current,
			baseBranch: async () => 'main',
			branchExists: async (branch) => full.branches.has(branch),
			listLocalBranches: async () => [...full.branches],
			remoteBranchExists: async (branch) => full.remoteBranches.has(branch),
			fetch: async (branch) => { calls.push(`fetch(${branch})`) },
			commitsAhead: async (branch, base) => {
				calls.push(`commitsAhead(${branch},${base})`)
				return full.ahead.get(`${branch}:${base}`) ?? full.ahead.get(branch) ?? 0
			},
			isMerged: async (branch, base) => {
				calls.push(`isMerged(${branch},${base})`)
				return full.mergedIntoTarget
			},
			checkout: async (branch) => {
				calls.push(`checkout(${branch})`)
				full.current = branch
			},
			deleteBranch: async (branch) => {
				calls.push(`deleteBranch(${branch})`)
				full.branches.delete(branch)
			},
			worktreeList: async () => [],
		})
		return { git, calls, state: full }
	}

	async function runAbortChangeWith(args: {
		storageState?: FakeStorageState
		gitState?: Partial<GitState>
		gh?: Partial<GhOps>
		runtime?: Partial<Omit<AbortRuntime, 'storage' | 'git' | 'gh'>>
	} = {}): Promise<{ storageState: FakeStorageState; storageCalls: string[]; gitCalls: string[]; ghCalls: unknown[][]; stdout: string; gitState: GitState }> {
		const storageState = args.storageState ?? { change: fakeChange(), slices: [] }
		const { storage, calls: storageCalls } = fakeStorage(storageState)
		const { git, calls: gitCalls, state: gitState } = fakeGit(args.gitState)
		const { gh, calls: ghCalls } = recordingGhOps({ findAnyPrByHead: async () => null, ...args.gh })
		let stdout = ''
		await runAbortChange('42', {
			projectRoot: '/tmp/trowel-abort-test-project',
			storage,
			git,
			gh,
			usePrs: false,
			deleteBranchPolicy: 'never',
			abortComment: 'Closed via trowel',
			interactive: true,
			confirm: async () => false,
			confirmExact: async () => false,
			stdout: (s) => { stdout += s },
			listOpenPrs: async () => [],
			...args.runtime,
		})
		return { storageState, storageCalls, gitCalls, ghCalls, stdout, gitState }
	}

	describe('runAbortChange', () => {
		test('throws when the Change is missing', async () => {
			await expect(runAbortChangeWith({ storageState: { change: null, slices: [] } })).rejects.toThrow(/Change '42' not found/)
		})

		test('refuses before exact-id prompting when the current branch is a Cleanup candidate under abort policy', async () => {
			let confirmExactCalls = 0
			const storageState = {
				change: fakeChange(),
				slices: [fakeSlice({ state: 'done', closedAt: '2026-06-04T00:00:00.000Z', readyForAgent: false })],
			}

			await expect(runAbortChangeWith({
				storageState,
				gitState: { current: 'change-42-feature', branches: new Set(['main', 'change-42-feature']) },
				gh: { findAnyPrByHead: async () => ({ number: 20, state: 'OPEN' }) },
				runtime: {
					deleteBranchPolicy: 'prompt',
					confirm: async () => {
						throw new Error('should not prompt')
					},
					confirmExact: async () => {
						confirmExactCalls += 1
						throw new Error('should not prompt')
					},
				},
			})).rejects.toThrow(/Switch branches first/)
			expect(confirmExactCalls).toBe(0)
			expect(storageState.change.closedAt).toBeNull()
		})

		test('does not refuse the current Cleanup candidate when abort deletion policy is never', async () => {
			const { storageCalls, gitCalls, gitState } = await runAbortChangeWith({
				storageState: { change: fakeChange(), slices: [] },
				gitState: { current: 'change-42-feature', branches: new Set(['main', 'change-42-feature']) },
				runtime: { deleteBranchPolicy: 'never' },
			})

			expect(storageCalls).toContain('closeChange(42)')
			expect(gitCalls.find((call) => call.startsWith('deleteBranch'))).toBeUndefined()
			expect(gitState.current).toBe('change-42-feature')
		})

		test('open Change: closes open Slice PRs without merging, closes records, and cleans local branches under abort policy', async () => {
			const slice = fakeSlice({ id: 's1', title: 'First Slice' })
			const sliceBranch = 'change-42/slice-s1-first-slice'
			const { storageState, storageCalls, gitCalls, ghCalls } = await runAbortChangeWith({
				storageState: { change: fakeChange(), slices: [slice] },
				gitState: { branches: new Set(['main', 'change-42-feature', sliceBranch]) },
				gh: { listOpenPrs: async () => [{ number: 10, headRefName: sliceBranch, isDraft: true }] },
				runtime: { usePrs: true, deleteBranchPolicy: 'always' },
			})

			expect(ghCalls).toContainEqual(['closePr', 10, { comment: 'Closed via trowel' }])
			expect(ghCalls.map((call) => call[0])).not.toContain('mergePr')
			expect(storageCalls.some((call) => /^updateSlice\(s1,\{"closedAt":"\d{4}-/.test(call))).toBe(true)
			expect(storageCalls).toContain('closeChange(42)')
			expect(storageState.change!.closedAt).not.toBeNull()
			expect(gitCalls).toContain('deleteBranch(change-42-feature)')
			expect(gitCalls).toContain(`deleteBranch(${sliceBranch})`)
		})

		test('ready Change: closes any open Slice PRs, closes the Change, and does not touch already-done slice records', async () => {
			const doneSlice = fakeSlice({ id: 's1', state: 'done', closedAt: '2026-06-04T00:00:00.000Z', readyForAgent: false })
			const { storageCalls, ghCalls } = await runAbortChangeWith({
				storageState: { change: fakeChange(), slices: [doneSlice] },
				gh: { listOpenPrs: async () => [{ number: 11, headRefName: 'change-42/slice-s1-first-slice', isDraft: false }] },
				runtime: { usePrs: true },
			})

			expect(ghCalls).toContainEqual(['closePr', 11, { comment: 'Closed via trowel' }])
			expect(storageCalls).toContain('closeChange(42)')
			expect(storageCalls.find((call) => call.startsWith('updateSlice'))).toBeUndefined()
		})

		test('in-flight Change: declining exact-id confirmation leaves PRs and records untouched', async () => {
			const { storageCalls, ghCalls, stdout } = await runAbortChangeWith({
				storageState: { change: fakeChange(), slices: [fakeSlice({ state: 'done', closedAt: '2026-06-04T00:00:00.000Z', readyForAgent: false })] },
				gh: { findAnyPrByHead: async () => ({ number: 20, state: 'OPEN' }) },
				runtime: { confirmExact: async () => false },
			})

			expect(stdout).toMatch(/Aborted; nothing changed/)
			expect(storageCalls).not.toContain('closeChange(42)')
			expect(ghCalls.find((call) => call[0] === 'closePr')).toBeUndefined()
		})

		test('in-flight Change: exact-id confirmation closes Close-out and Slice PRs without merging before cleanup', async () => {
			const slice = fakeSlice({ id: 's1', title: 'First Slice' })
			const sliceBranch = 'change-42/slice-s1-first-slice'
			const { storageCalls, ghCalls } = await runAbortChangeWith({
				storageState: { change: fakeChange(), slices: [slice] },
				gh: {
					findAnyPrByHead: async (head) => head === 'change-42-feature' ? { number: 20, state: 'OPEN' } : null,
					listOpenPrs: async () => [{ number: 21, headRefName: sliceBranch, isDraft: false }],
				},
				runtime: { usePrs: true, confirmExact: async (_msg, expected) => expected === '42' },
			})

			expect(ghCalls).toContainEqual(['closePr', 20, { comment: 'Closed via trowel' }])
			expect(ghCalls).toContainEqual(['closePr', 21, { comment: 'Closed via trowel' }])
			expect(ghCalls.map((call) => call[0])).not.toContain('mergePr')
			expect(storageCalls).toContain('closeChange(42)')
		})

		test('already aborted Change: runs cleanup only', async () => {
			const { storageCalls, gitCalls, stdout } = await runAbortChangeWith({
				storageState: { change: fakeChange({ state: 'CLOSED', closedAt: '2026-06-04T00:00:00.000Z' }), slices: [] },
				runtime: { deleteBranchPolicy: 'always' },
			})

			expect(stdout).toMatch(/already aborted; running cleanup/)
			expect(storageCalls).not.toContain('closeChange(42)')
			expect(gitCalls).toContain('deleteBranch(change-42-feature)')
		})

		test('landed Change is refused with ship guidance', async () => {
			await expect(runAbortChangeWith({
				storageState: { change: fakeChange(), slices: [fakeSlice({ state: 'done', closedAt: '2026-06-04T00:00:00.000Z', readyForAgent: false })] },
				gitState: { mergedIntoTarget: true },
			})).rejects.toThrow(/Run: trowel change ship 42/)
		})

		test('done Change is refused with ship guidance', async () => {
			await expect(runAbortChangeWith({
				storageState: { change: fakeChange({ state: 'CLOSED', closedAt: '2026-06-04T00:00:00.000Z' }), slices: [fakeSlice({ state: 'done', closedAt: '2026-06-04T00:00:00.000Z', readyForAgent: false })] },
				gitState: { mergedIntoTarget: true },
			})).rejects.toThrow(/Run: trowel change ship 42/)
		})

		test('null abort comment closes PRs silently', async () => {
			const sliceBranch = 'change-42/slice-s1-first-slice'
			const { ghCalls } = await runAbortChangeWith({
				storageState: { change: fakeChange(), slices: [fakeSlice()] },
				gh: { listOpenPrs: async () => [{ number: 10, headRefName: sliceBranch, isDraft: true }] },
				runtime: { usePrs: true, abortComment: null },
			})

			expect(ghCalls).toContainEqual(['closePr', 10])
		})
	})
}
