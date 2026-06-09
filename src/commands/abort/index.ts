import { confirm as inqConfirm, input as inqInput } from '@inquirer/prompts'

import { restoreStartingBranch, type OpenPr } from './branch.ts'
import type { Change, DeleteBranchPolicy, Storage } from '../../storages/types.ts'
import { classifyChange } from '../../utils/change-state.ts'
import type { GhOps } from '../../utils/gh-ops.ts'
import type { GitOps } from '../../utils/git-ops.ts'
import { withMutationLock } from '../../utils/mutation-lock.ts'
import type { ChangeState } from '../../work/change-types.ts'
import { cleanupChange, refuseCurrentCleanupBranch } from '../../work/cleanup.ts'
import { classifySlicesForChange } from '../../work/slice-states.ts'
import type { ClassifiedSlice } from '../../work/slice-types.ts'
import { buildStorage, exitOnCommandError, loadCommandBase, type CommandBase } from '../runtime.ts'

type AbortRuntime = {
	projectRoot?: string
	storage: Storage
	git: GitOps
	gh: GhOps
	pr: boolean
	deleteBranchPolicy: DeleteBranchPolicy
	abortComment: string | null
	needsRevisionLabel?: string
	interactive?: boolean
	confirm: (msg: string) => Promise<boolean>
	confirmExact: (msg: string, expected: string) => Promise<boolean>
	stdout: (s: string) => void
	listOpenPrs: (branch: string) => Promise<OpenPr[]>
}

type ClassifiedChange = {
	change: Change
	slices: ClassifiedSlice[]
	state: ChangeState
}

async function runAbortChange(changeId: string, rt: AbortRuntime): Promise<void> {
	const back = await rt.git.currentBranch()
	const { change, slices, state } = await classifiedChangeOrThrow(changeId, rt)
	const targetBranch = await changeTargetBranch(change, rt)
	if (abortMayRunCleanup(state)) await refuseCurrentCleanupBranch({ change, slices, targetBranch, rt })
	try {
		await abortChangeByState({ change, slices, state }, targetBranch, rt)
	} finally {
		await restoreStartingBranch(back, targetBranch, rt)
	}
}

function abortMayRunCleanup(state: ChangeState): boolean {
	return state === 'open' || state === 'ready' || state === 'awaiting-review' || state === 'needs-revision' || state === 'aborted'
}

async function classifiedChangeOrThrow(changeId: string, rt: AbortRuntime): Promise<ClassifiedChange> {
	const change = await rt.storage.findChange(changeId)
	if (!change) throw new Error(`Change '${changeId}' not found`)
	const slices = await classifySlicesForChange({ storage: rt.storage, gh: rt.gh, changeId, pr: rt.pr })
	return { change, slices, state: await classifyChange(change, slices, { gh: rt.gh, git: rt.git, needsRevisionLabel: rt.needsRevisionLabel }) }
}

async function changeTargetBranch(change: Change, _rt: AbortRuntime): Promise<string> {
	return change.targetBranch
}

async function abortChangeByState(target: ClassifiedChange, targetBranch: string, rt: AbortRuntime): Promise<void> {
	switch (target.state) {
		case 'open':
		case 'ready':
			await abortOpenOrReadyChange(target.change, target.slices, targetBranch, rt)
			return
		case 'awaiting-review':
		case 'needs-revision':
			await abortCloseOutPrChange(target.change, target.slices, targetBranch, target.state, rt)
			return
		case 'aborted':
			rt.stdout(`Change ${target.change.id} is already aborted; running cleanup.\n`)
			await cleanupAfterAbort(target.change, target.slices, targetBranch, rt)
			return
		case 'landed':
		case 'done':
			throw new Error(
				`Change ${target.change.id} is ${target.state}; abort would discard shipped work. Run: trowel change ship ${target.change.id}`,
			)
	}
}

async function abortOpenOrReadyChange(
	change: Change,
	slices: ClassifiedSlice[],
	targetBranch: string,
	rt: AbortRuntime,
): Promise<void> {
	await closeOpenSlicePrs(slices, rt)
	await closeOpenSliceRecords(change.id, slices, rt)
	await rt.storage.abortChange(change.id, abortStorageOptions(rt))
	await cleanupAfterAbort(change, slices, targetBranch, rt)
}

async function abortCloseOutPrChange(change: Change, slices: ClassifiedSlice[], targetBranch: string, state: ChangeState, rt: AbortRuntime): Promise<void> {
	if (!(await confirmAbortCloseOutPrChange(change.id, state, rt))) return
	await closeOpenCloseOutPr(change, rt)
	await closeOpenSlicePrs(slices, rt)
	await closeOpenSliceRecords(change.id, slices, rt)
	await rt.storage.abortChange(change.id, abortStorageOptions(rt))
	await cleanupAfterAbort(change, slices, targetBranch, rt)
}

async function confirmAbortCloseOutPrChange(changeId: string, state: ChangeState, rt: AbortRuntime): Promise<boolean> {
	if (rt.interactive === false)
		throw new Error(`Change ${changeId} is ${state}; abort requires an interactive terminal and exact-id confirmation.`)
	const ok = await rt.confirmExact(
		`Change ${changeId} is ${state} with an open Close-out PR. Type '${changeId}' to close it without merging and abort:`,
		changeId,
	)
	if (ok) return true
	rt.stdout('Aborted; nothing changed.\n')
	return false
}

async function closeOpenSlicePrs(slices: ClassifiedSlice[], rt: AbortRuntime): Promise<void> {
	if (!rt.pr) return
	const storedSliceHeads = new Set(slices.map((slice) => slice.sliceBranch).filter((branch): branch is string => branch !== null))
	for (const pr of await rt.gh.listOpenPrs()) {
		if (storedSliceHeads.has(pr.headRefName)) await closePrWithoutMerging(pr.number, rt)
	}
}

async function closeOpenCloseOutPr(change: Change, rt: AbortRuntime): Promise<void> {
	const pr = await rt.gh.findAnyPrByHead(change.changeBranch)
	if (pr?.state === 'OPEN') await closePrWithoutMerging(pr.number, rt)
}

async function closePrWithoutMerging(prNumber: number, rt: AbortRuntime): Promise<void> {
	if (rt.abortComment === null) await rt.gh.closePr(prNumber)
	else await rt.gh.closePr(prNumber, { comment: rt.abortComment })
}

async function closeOpenSliceRecords(changeId: string, slices: ClassifiedSlice[], rt: AbortRuntime): Promise<void> {
	for (const slice of slices) {
		if (slice.closedAt === null) await rt.storage.abortSlice(changeId, slice.id, abortStorageOptions(rt))
	}
}

function abortStorageOptions(rt: AbortRuntime): { comment?: string } | undefined {
	return rt.abortComment === null ? undefined : { comment: rt.abortComment }
}

async function cleanupAfterAbort(change: Change, slices: ClassifiedSlice[], targetBranch: string, rt: AbortRuntime): Promise<void> {
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

async function buildAbortRuntime(opts: { storage?: string }): Promise<{ base: CommandBase; rt: AbortRuntime }> {
	const base = await loadCommandBase('change abort')
	const storage = buildStorage(base, opts.storage ?? base.config.storage)
	return {
		base,
		rt: {
			projectRoot: base.projectRoot,
			storage,
			git: base.git,
			gh: base.gh,
			pr: base.config.ship.pr,
			deleteBranchPolicy: base.config.abort.deleteBranch,
			abortComment: base.config.abort.comment,
			needsRevisionLabel: base.config.labels.needsRevision,
			interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
			confirm: (msg) => inqConfirm({ message: msg, default: false }),
			confirmExact: async (message, expected) => (await inqInput({ message })) === expected,
			stdout: (s) => process.stdout.write(s),
			listOpenPrs: listOpenPrsFor(base),
		},
	}
}

export async function abortChange(changeId: string, opts: { storage?: string }): Promise<void> {
	const { base, rt } = await buildAbortRuntime(opts)
	await exitOnCommandError('change abort', () => withMutationLock(base.projectRoot, () => runAbortChange(changeId, rt)))
}

if (import.meta.vitest) {
	const { describe, test, expect } = import.meta.vitest
	const { recordingGhOps } = await import('../../test-utils/gh-ops-recorder.ts')
	const { noopGitOps } = await import('../../test-utils/git-ops-fixtures.ts')

	type FakeStorageState = {
		change: Change | null
		slices: ClassifiedSlice[]
	}

	type GitState = {
		current: string
		branches: Set<string>
		remoteBranches: Set<string>
		ahead: Map<string, number>
		mergedIntoTarget: boolean
	}

	function fakeChange(overrides: Partial<Change> = {}): Change {
		return {
			id: '42',
			title: 'Feature',
			body: '',
			createdAt: '2026-01-01T00:00:00.000Z',
			closedAt: null,
			targetBranch: 'main',
			changeBranch: 'change-42-feature',
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
			implementedAt: null,
			auditedAt: null,
			readyForAgent: true,
			needsRevision: false,
			blockedBy: [],
			sliceBranch: `change-42/slice-${overrides.id ?? 's1'}-first-slice`,
			prState: null,
			...overrides,
		}
	}

	function fakeStorage(state: FakeStorageState): { storage: Storage; calls: string[] } {
		const calls: string[] = []
		const storage: Storage = {
			createChange: async () => {
				throw new Error('not implemented')
			},
			findChange: async (id) => {
				calls.push(`findChange(${id})`)
				return state.change && state.change.id === id ? { ...state.change } : null
			},
			listChanges: async () => [],
			updateChangeMetadata: async () => {},
			finalizeChange: async () => {},
			abortChange: async (id) => {
				calls.push(`abortChange(${id})`)
				if (state.change && state.change.id === id) state.change.closedAt = new Date().toISOString()
			},
			createSlice: async () => {
				throw new Error('not implemented')
			},
			findSlices: async () => {
				calls.push('findSlices')
				return state.slices.map((slice) => ({ ...slice }))
			},
			updateSliceMetadata: async () => {},
			setSliceReadyForAgent: async () => {},
			setSliceBlockers: async () => {},
			markSliceImplemented: async () => {},
			markSliceAudited: async () => {},
			finalizeSlice: async () => {},
			abortSlice: async (_changeId, sliceId) => {
				calls.push(`abortSlice(${sliceId})`)
				const slice = state.slices.find((s) => s.id === sliceId)
				if (slice) slice.closedAt = new Date().toISOString()
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
			fetch: async (branch) => {
				calls.push(`fetch(${branch})`)
			},
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

	async function runAbortChangeWith(
		args: {
			storageState?: FakeStorageState
			gitState?: Partial<GitState>
			gh?: Partial<GhOps>
			runtime?: Partial<Omit<AbortRuntime, 'storage' | 'git' | 'gh'>>
		} = {},
	): Promise<{
		storageState: FakeStorageState
		storageCalls: string[]
		gitCalls: string[]
		ghCalls: unknown[][]
		stdout: string
		gitState: GitState
	}> {
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
			pr: false,
			deleteBranchPolicy: 'never',
			abortComment: 'Closed via trowel',
			interactive: true,
			confirm: async () => false,
			confirmExact: async () => false,
			stdout: (s) => {
				stdout += s
			},
			listOpenPrs: async () => [],
			...args.runtime,
		})
		return { storageState, storageCalls, gitCalls, ghCalls, stdout, gitState }
	}

	describe('runAbortChange', () => {
		test('throws when the Change is missing', async () => {
			await expect(runAbortChangeWith({ storageState: { change: null, slices: [] } })).rejects.toThrow(/Change '42' not found/)
		})

		test('refuses before exact-id prompting when the current branch is a Cleanup candidate under abort prompt policy', async () => {
			let confirmExactCalls = 0
			const storageState = {
				change: fakeChange(),
				slices: [fakeSlice({ state: 'done', closedAt: '2026-06-04T00:00:00.000Z', readyForAgent: false })],
			}

			await expect(
				runAbortChangeWith({
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
				}),
			).rejects.toThrow(/Switch branches first/)
			expect(confirmExactCalls).toBe(0)
			expect(storageState.change.closedAt).toBeNull()
		})

		test('refuses before closing records when the current branch is a Cleanup candidate under abort always policy', async () => {
			const storageState = { change: fakeChange(), slices: [fakeSlice()] }

			await expect(
				runAbortChangeWith({
					storageState,
					gitState: { current: 'change-42-feature', branches: new Set(['main', 'change-42-feature']) },
					runtime: { deleteBranchPolicy: 'always' },
				}),
			).rejects.toThrow(/Switch branches first/)
			expect(storageState.change.closedAt).toBeNull()
			expect(storageState.slices[0]!.closedAt).toBeNull()
		})

		test('does not refuse the current Cleanup candidate when abort deletion policy is never', async () => {
			const { storageCalls, gitCalls, gitState } = await runAbortChangeWith({
				storageState: { change: fakeChange(), slices: [] },
				gitState: { current: 'change-42-feature', branches: new Set(['main', 'change-42-feature']) },
				runtime: { deleteBranchPolicy: 'never' },
			})

			expect(storageCalls).toContain('abortChange(42)')
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
				runtime: { pr: true, deleteBranchPolicy: 'always' },
			})

			expect(ghCalls).toContainEqual(['closePr', 10, { comment: 'Closed via trowel' }])
			expect(ghCalls.map((call) => call[0])).not.toContain('mergePr')
			expect(storageCalls).toContain('abortSlice(s1)')
			expect(storageCalls).toContain('abortChange(42)')
			expect(storageState.change!.closedAt).not.toBeNull()
			expect(gitCalls).toContain('deleteBranch(change-42-feature)')
			expect(gitCalls).toContain(`deleteBranch(${sliceBranch})`)
		})

		test('open Change: closes Slice PRs only when their heads match stored Slice branches exactly', async () => {
			const storedSliceBranch = '42/s1-first-slice'
			const legacyPrefixBranch = 'change-42/slice-stale-old-title'
			const newPrefixBranch = '42/stale-new-prefix'
			const { ghCalls } = await runAbortChangeWith({
				storageState: { change: fakeChange(), slices: [fakeSlice({ id: 's1', sliceBranch: storedSliceBranch })] },
				gh: {
					listOpenPrs: async () => [
						{ number: 10, headRefName: storedSliceBranch, isDraft: true },
						{ number: 11, headRefName: legacyPrefixBranch, isDraft: true },
						{ number: 12, headRefName: newPrefixBranch, isDraft: true },
					],
				},
				runtime: { pr: true },
			})

			expect(ghCalls).toContainEqual(['closePr', 10, { comment: 'Closed via trowel' }])
			expect(ghCalls).not.toContainEqual(['closePr', 11, { comment: 'Closed via trowel' }])
			expect(ghCalls).not.toContainEqual(['closePr', 12, { comment: 'Closed via trowel' }])
		})

		test('ready Change: closes any open Slice PRs, closes the Change, and does not touch already-done slice records', async () => {
			const doneSlice = fakeSlice({ id: 's1', state: 'done', closedAt: '2026-06-04T00:00:00.000Z', readyForAgent: false })
			const { storageCalls, ghCalls } = await runAbortChangeWith({
				storageState: { change: fakeChange(), slices: [doneSlice] },
				gh: { listOpenPrs: async () => [{ number: 11, headRefName: 'change-42/slice-s1-first-slice', isDraft: false }] },
				runtime: { pr: true },
			})

			expect(ghCalls).toContainEqual(['closePr', 11, { comment: 'Closed via trowel' }])
			expect(storageCalls).toContain('abortChange(42)')
			expect(storageCalls.find((call) => call.startsWith('updateSlice'))).toBeUndefined()
		})

		test('awaiting-review Change: declining exact-id confirmation leaves PRs and records untouched', async () => {
			const { storageCalls, ghCalls, stdout } = await runAbortChangeWith({
				storageState: {
					change: fakeChange(),
					slices: [fakeSlice({ state: 'done', closedAt: '2026-06-04T00:00:00.000Z', readyForAgent: false })],
				},
				gh: { findAnyPrByHead: async () => ({ number: 20, state: 'OPEN' }) },
				runtime: { confirmExact: async () => false },
			})

			expect(stdout).toMatch(/Aborted; nothing changed/)
			expect(storageCalls).not.toContain('abortChange(42)')
			expect(ghCalls.find((call) => call[0] === 'closePr')).toBeUndefined()
		})

		test('awaiting-review Change: exact-id confirmation closes Close-out and Slice PRs without merging before cleanup', async () => {
			const slice = fakeSlice({ id: 's1', title: 'First Slice' })
			const sliceBranch = 'change-42/slice-s1-first-slice'
			const { storageCalls, ghCalls } = await runAbortChangeWith({
				storageState: { change: fakeChange(), slices: [slice] },
				gh: {
					findAnyPrByHead: async (head) => (head === 'change-42-feature' ? { number: 20, state: 'OPEN' } : null),
					listOpenPrs: async () => [{ number: 21, headRefName: sliceBranch, isDraft: false }],
				},
				runtime: { pr: true, confirmExact: async (_msg, expected) => expected === '42' },
			})

			expect(ghCalls).toContainEqual(['closePr', 20, { comment: 'Closed via trowel' }])
			expect(ghCalls).toContainEqual(['closePr', 21, { comment: 'Closed via trowel' }])
			expect(ghCalls.map((call) => call[0])).not.toContain('mergePr')
			expect(storageCalls).toContain('abortChange(42)')
		})

		test('already aborted Change: runs cleanup only', async () => {
			const { storageCalls, gitCalls, stdout } = await runAbortChangeWith({
				storageState: { change: fakeChange({ closedAt: '2026-06-04T00:00:00.000Z' }), slices: [] },
				runtime: { deleteBranchPolicy: 'always' },
			})

			expect(stdout).toMatch(/already aborted; running cleanup/)
			expect(storageCalls).not.toContain('abortChange(42)')
			expect(gitCalls).toContain('deleteBranch(change-42-feature)')
		})

		test('landed Change is refused with ship guidance', async () => {
			await expect(
				runAbortChangeWith({
					storageState: {
						change: fakeChange(),
						slices: [fakeSlice({ state: 'done', closedAt: '2026-06-04T00:00:00.000Z', readyForAgent: false })],
					},
					gitState: { mergedIntoTarget: true },
				}),
			).rejects.toThrow(/Run: trowel change ship 42/)
		})

		test('done Change is refused with ship guidance', async () => {
			await expect(
				runAbortChangeWith({
					storageState: {
						change: fakeChange({ closedAt: '2026-06-04T00:00:00.000Z' }),
						slices: [fakeSlice({ state: 'done', closedAt: '2026-06-04T00:00:00.000Z', readyForAgent: false })],
					},
					gitState: { mergedIntoTarget: true },
				}),
			).rejects.toThrow(/Run: trowel change ship 42/)
		})

		test('null abort comment closes PRs silently', async () => {
			const sliceBranch = 'change-42/slice-s1-first-slice'
			const { ghCalls } = await runAbortChangeWith({
				storageState: { change: fakeChange(), slices: [fakeSlice()] },
				gh: { listOpenPrs: async () => [{ number: 10, headRefName: sliceBranch, isDraft: true }] },
				runtime: { pr: true, abortComment: null },
			})

			expect(ghCalls).toContainEqual(['closePr', 10])
		})
	})
}
