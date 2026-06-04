import { confirm as inqConfirm } from '@inquirer/prompts'

import { deleteBranchIfPresent, restoreStartingBranch, type CloseBranchRuntime, type OpenPr } from './branch.ts'
import type { StorageKind } from '../../storages/registry.ts'
import type { ClassifiedSlice, ChangeRecord, Slice, SlicePatch, Storage } from '../../storages/types.ts'
import type { GhOps } from '../../utils/gh-ops.ts'
import type { GitOps } from '../../utils/git-ops.ts'
import { withMutationLock } from '../../utils/mutation-lock.ts'
import { slug as slugify } from '../../utils/slug.ts'
import { classifySlicesForChange } from '../../work/slice-states.ts'
import { buildStorage, exitOnCommandError, loadCommandBase, type CommandBase } from '../runtime.ts'

type AbortRuntime = CloseBranchRuntime & {
	storage: Storage
}

type AbortSliceRuntime = AbortRuntime & {
	gh: GhOps
	usePrs: boolean
	perSliceBranches: boolean
}

async function runAbortChange(changeId: string, rt: AbortRuntime): Promise<void> {
	const back = await rt.git.currentBranch()
	const change = await findChangeOrThrow(changeId, rt.storage)
	const targetBranch = await changeTargetBranch(change, rt)

	if (!(await abortOpenChangeSlices(changeId, rt))) return
	await abortChangeRecord(changeId, change, rt)
	await deleteBranchIfPresent(change.branch, targetBranch, rt)
	await restoreStartingBranch(back, targetBranch, rt)
}

async function findChangeOrThrow(changeId: string, storage: Storage): Promise<ChangeRecord> {
	const change = await storage.findChange(changeId)
	if (!change) throw new Error(`Change '${changeId}' not found`)
	return change
}

async function changeTargetBranch(change: ChangeRecord, rt: AbortRuntime): Promise<string> {
	return change.targetBranch ?? await rt.git.baseBranch()
}

async function abortOpenChangeSlices(changeId: string, rt: AbortRuntime): Promise<boolean> {
	const openSlices = (await rt.storage.findSlices(changeId)).filter((s) => s.closedAt === null)
	if (openSlices.length === 0) return true
	const ids = openSlices.map((s) => s.id).join(', ')
	const ok = await rt.confirm(`Change has ${openSlices.length} open slices: ${ids}. Auto-close all? [y/N]`)
	if (!ok) {
		rt.stdout('Aborted; nothing changed.\n')
		return false
	}
	for (const s of openSlices) await rt.storage.updateSlice(changeId, s.id, { closedAt: new Date().toISOString() })
	return true
}

async function abortChangeRecord(changeId: string, change: ChangeRecord, rt: AbortRuntime): Promise<void> {
	if (change.state === 'OPEN') {
		await rt.storage.closeChange(changeId)
	} else {
		rt.stdout(`Change '${changeId}' already closed in store.\n`)
	}
}

async function runAbortSlice(sliceId: string, rt: AbortSliceRuntime): Promise<void> {
	const { changeId } = await findSliceOrThrow(sliceId, rt.storage)
	const back = await rt.git.currentBranch()
	const sliceMergeTarget = await sliceMergeTargetBranch(changeId, rt)
	const target = await findClassifiedSliceOrThrow(sliceId, changeId, rt)

	if (!(await abortSliceRecord(changeId, sliceId, target, rt))) return
	await deleteSliceBranchIfPresent(changeId, target, sliceMergeTarget, rt)
	await restoreStartingBranch(back, sliceMergeTarget, rt)
}

async function findSliceOrThrow(sliceId: string, storage: Storage): Promise<{ changeId: string; slice: Slice }> {
	const hit = await storage.findSlice(sliceId)
	if (!hit) throw new Error(`slice '${sliceId}' not found`)
	return hit
}

async function sliceMergeTargetBranch(changeId: string, rt: AbortSliceRuntime): Promise<string> {
	const change = await rt.storage.findChange(changeId)
	return change?.branch ?? await rt.git.baseBranch()
}

async function findClassifiedSliceOrThrow(sliceId: string, changeId: string, rt: AbortSliceRuntime): Promise<ClassifiedSlice> {
	const siblings = await classifySlicesForChange({ storage: rt.storage, gh: rt.gh, changeId, usePrs: rt.usePrs })
	const target = siblings.find((s) => s.id === sliceId)
	if (!target) throw new Error(`slice '${sliceId}' disappeared between findSlice and findSlices`)
	return target
}

async function abortSliceRecord(changeId: string, sliceId: string, target: ClassifiedSlice, rt: AbortSliceRuntime): Promise<boolean> {
	if (target.state === 'done') {
		rt.stdout(`Slice '${sliceId}' already closed.\n`)
		return true
	}
	if (!(await confirmCloseNonDoneSlice(sliceId, target, rt))) return false
	await rt.storage.updateSlice(changeId, sliceId, { closedAt: new Date().toISOString() })
	return true
}

async function confirmCloseNonDoneSlice(sliceId: string, target: ClassifiedSlice, rt: AbortSliceRuntime): Promise<boolean> {
	const ok = await rt.confirm(`Slice '${sliceId}' is in state '${target.state}', not 'done'. Close anyway? [y/N]`)
	if (ok) return true
	rt.stdout('Aborted; nothing changed.\n')
	return false
}

async function deleteSliceBranchIfPresent(changeId: string, target: ClassifiedSlice, sliceMergeTarget: string, rt: AbortSliceRuntime): Promise<void> {
	if (!rt.perSliceBranches) return
	await deleteBranchIfPresent(sliceBranchName(changeId, target), sliceMergeTarget, rt)
}

function sliceBranchName(changeId: string, slice: Slice): string {
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

async function buildAbortRuntime(opts: { storage?: StorageKind }): Promise<{ base: CommandBase; storage: Storage; confirm: (msg: string) => Promise<boolean>; listOpenPrs: (branch: string) => Promise<OpenPr[]> }> {
	const base = await loadCommandBase('close')
	const confirm = (msg: string) => inqConfirm({ message: msg, default: false })
	const storage = buildStorage(base, opts.storage ?? base.config.storage, { confirm })
	return { base, storage, confirm, listOpenPrs: listOpenPrsFor(base) }
}

function abortRuntime(base: CommandBase, storage: Storage, confirm: (msg: string) => Promise<boolean>, listOpenPrs: (branch: string) => Promise<OpenPr[]>): AbortRuntime {
	return {
		storage,
		deleteBranchPolicy: base.config.abort.deleteBranch,
		confirm,
		stdout: (s) => process.stdout.write(s),
		git: base.git,
		listOpenPrs,
	}
}

export async function abortChange(changeId: string, opts: { storage?: StorageKind }): Promise<void> {
	const { base, storage, confirm, listOpenPrs } = await buildAbortRuntime(opts)
	await exitOnCommandError('abort', () => withMutationLock(base.projectRoot, () => runAbortChange(changeId, abortRuntime(base, storage, confirm, listOpenPrs))))
}

export async function abortSlice(sliceId: string, opts: { storage?: StorageKind }): Promise<void> {
	const { base, storage, confirm, listOpenPrs } = await buildAbortRuntime(opts)
	await exitOnCommandError('abort', () =>
		withMutationLock(base.projectRoot, () =>
			runAbortSlice(sliceId, {
				...abortRuntime(base, storage, confirm, listOpenPrs),
				gh: base.gh,
				usePrs: base.config.work.usePrs,
				perSliceBranches: base.config.work.perSliceBranches,
			}),
		),
	)
}

if (import.meta.vitest) {
	const { describe, test, expect } = import.meta.vitest
	const { recordingGhOps } = await import('../../test-utils/gh-ops-recorder.ts')
	const { noopGitOps } = await import('../../test-utils/git-ops-fixtures.ts')
	const { fakeSliceStorage } = await import('../../test-utils/storage-fixtures.ts')

	const noPrGh = () => recordingGhOps().gh

	type FakeStorageState = {
		change: { id: string; branch: string; targetBranch?: string; title: string; state: 'OPEN' | 'CLOSED' } | null
		slices: Array<{ id: string; title: string; body: string; state: 'OPEN' | 'CLOSED'; readyForAgent: boolean; needsRevision: boolean }>
	}

	function fakeStorage(state: FakeStorageState): { storage: Storage; calls: string[] } {
		const calls: string[] = []
		const storage: Storage = {
			createChange: async () => {
				throw new Error('not implemented')
			},
			findChange: async (id) => {
				calls.push(`findChange(${id})`)
				if (!state.change || state.change.id !== id) return null
				return { ...state.change }
			},
			listChanges: async () => (state.change && state.change.state === 'OPEN' ? [{ ...state.change, createdAt: '2026-05-13T00:00:00.000Z' }] : []),
			closeChange: async (id) => {
				calls.push(`abortChange(${id})`)
				if (state.change && state.change.id === id) state.change.state = 'CLOSED'
			},
			createSlice: async () => {
				throw new Error('not implemented')
			},
			findSlices: async () => {
				calls.push('findSlices')
				return state.slices.map((s) => ({
					...s,
					state: s.state === 'CLOSED' ? 'done' as const : (s.readyForAgent ? 'open' as const : 'draft' as const),
					closedAt: s.state === 'CLOSED' ? '2026-06-04T00:00:00.000Z' : null,
					blockedBy: [],
					prState: null,
				}))
			},
			findSlice: async () => null,
			updateSlice: async (_pid, sliceId, patch) => {
				calls.push(`updateSlice(${sliceId},${JSON.stringify(patch)})`)
				applyFakeSlicePatch(state.slices.find((x) => x.id === sliceId), patch)
			},
		}
		return { storage, calls }
	}

	function applyFakeSlicePatch(slice: FakeStorageState['slices'][number] | undefined, patch: SlicePatch): void {
		if (!slice) return
		closeFakeSliceIfRequested(slice, patch.closedAt)
		setFakeReadyForAgent(slice, patch.readyForAgent)
		setFakeNeedsRevision(slice, patch.needsRevision)
	}

	function closeFakeSliceIfRequested(slice: FakeStorageState['slices'][number], closedAt: SlicePatch['closedAt']): void {
		if (closedAt !== undefined) slice.state = closedAt === null ? 'OPEN' : 'CLOSED'
	}

	function setFakeReadyForAgent(slice: FakeStorageState['slices'][number], value: boolean | undefined): void {
		if (value !== undefined) slice.readyForAgent = value
	}

	function setFakeNeedsRevision(slice: FakeStorageState['slices'][number], value: boolean | undefined): void {
		if (value !== undefined) slice.needsRevision = value
	}

	type GitState = {
		current: string
		branches: Set<string>
		mergedAncestors: Map<string, string[]> // branch → ancestors (i.e. base branches it's merged into)
	}

	function fakeGit(state: GitState): { git: GitOps; calls: string[] } {
		const calls: string[] = []
		const git: GitOps = noopGitOps({
			currentBranch: async () => state.current,
			baseBranch: async () => 'main',
			branchExists: async (b) => state.branches.has(b),
			isMerged: async (b, base) => {
				calls.push(`isMerged(${b},${base})`)
				return (state.mergedAncestors.get(b) ?? []).includes(base)
			},
			checkout: async (b) => {
				calls.push(`checkout(${b})`)
				state.current = b
			},
			deleteBranch: async (b) => {
				calls.push(`deleteBranch(${b})`)
				state.branches.delete(b)
			},
		})
		return { git, calls }
	}

	function changeState(state: 'OPEN' | 'CLOSED' = 'OPEN', overrides: Partial<NonNullable<FakeStorageState['change']>> = {}, slices: FakeStorageState['slices'] = []): FakeStorageState {
		return { change: { id: '42', branch: '42-feature', title: 'F', state, ...overrides }, slices }
	}

	function branchState(current = 'main', branches = ['main', '42-feature'], mergedAncestors: GitState['mergedAncestors'] = new Map()): GitState {
		return { current, branches: new Set(branches), mergedAncestors }
	}

	async function runAbortChangeWith(
		state: FakeStorageState,
		gitState: GitState,
		overrides: Partial<Omit<AbortRuntime, 'storage' | 'git'>> = {},
	): Promise<{ storageCalls: string[]; gitCalls: string[]; stdoutBuf: string }> {
		const { storage, calls: storageCalls } = fakeStorage(state)
		const { git, calls: gitCalls } = fakeGit(gitState)
		let stdoutBuf = ''
		await runAbortChange('42', {
			storage,
			deleteBranchPolicy: 'never',
			confirm: async () => false,
			stdout: (s) => {
				stdoutBuf += s
			},
			git,
			listOpenPrs: async () => [],
			...overrides,
		})
		return { storageCalls, gitCalls, stdoutBuf }
	}

	describe('abort: Change not found', () => {
		test('throws when storage.findChange returns null', async () => {
			const state: FakeStorageState = { change: null, slices: [] }
			const gitState: GitState = { current: 'main', branches: new Set(['main']), mergedAncestors: new Map() }
			const { storage } = fakeStorage(state)
			const { git } = fakeGit(gitState)
			await expect(
				runAbortChange('99', {
					storage,
					deleteBranchPolicy: 'never',
					confirm: async () => false,
					stdout: () => {},
					git,
					listOpenPrs: async () => [],
				}),
			).rejects.toThrow(/Change '99' not found/)
		})
	})

	describe('abort: idempotent on already-closed Change', () => {
		test('does not call storage abort when change state is CLOSED', async () => {
			const { storageCalls, stdoutBuf } = await runAbortChangeWith(changeState('CLOSED'), branchState())
			expect(storageCalls).not.toContain('abortChange(42)')
			expect(stdoutBuf).toMatch(/already closed/i)
		})

		test('still attempts branch delete on a closed Change when branch still exists', async () => {
			const { gitCalls } = await runAbortChangeWith(changeState('CLOSED'), branchState('main', ['main', '42-feature'], new Map([['42-feature', ['main']]])), { deleteBranchPolicy: 'always' })
			expect(gitCalls).toContain('deleteBranch(42-feature)')
		})
	})

	describe('abort: open slices', () => {
		const baseSlice = { title: 'X', body: '', readyForAgent: false, needsRevision: false }

		test('warns with slice ids and confirms before auto-closing', async () => {
			const state = changeState('OPEN', {}, [
				{ id: 's1', ...baseSlice, state: 'OPEN' },
				{ id: 's2', ...baseSlice, state: 'CLOSED' },
				{ id: 's3', ...baseSlice, state: 'OPEN' },
			])
			let confirmMsg = ''
			const { storageCalls } = await runAbortChangeWith(state, branchState(), {
				confirm: async (m) => {
					confirmMsg = m
					return true
				},
			})
			expect(confirmMsg).toMatch(/2 open slices/i)
			expect(confirmMsg).toContain('s1')
			expect(confirmMsg).toContain('s3')
			expect(confirmMsg).not.toContain('s2')
			expect(state.slices.every((s) => s.state === 'CLOSED')).toBe(true)
			expect(storageCalls).toContain('abortChange(42)')
		})

		test('declining the warn → no auto-close, no storage abort, no branch ops', async () => {
			const state = changeState('OPEN', {}, [{ id: 's1', ...baseSlice, state: 'OPEN' }])
			const { storageCalls, gitCalls, stdoutBuf } = await runAbortChangeWith(state, branchState(), { deleteBranchPolicy: 'always' })
			expect(state.slices[0]!.state).toBe('OPEN')
			expect(state.change!.state).toBe('OPEN')
			expect(storageCalls).not.toContain('abortChange(42)')
			expect(gitCalls.find((c) => c.startsWith('deleteBranch'))).toBeUndefined()
			expect(stdoutBuf).toMatch(/aborted/i)
		})

		test('no open slices → no prompt, proceeds straight to storage abort', async () => {
			let confirmCalled = 0
			const { storageCalls } = await runAbortChangeWith(changeState('OPEN', {}, [{ id: 's1', ...baseSlice, state: 'CLOSED' }]), branchState(), {
				confirm: async () => {
					confirmCalled++
					return false
				},
			})
			expect(confirmCalled).toBe(0)
			expect(storageCalls).toContain('abortChange(42)')
		})
	})

	describe('abort: tracer (Change open, no slices, policy=never)', () => {
		test('calls storage abort, leaves branch intact, returns user to BACK_TO', async () => {
			const state = changeState('OPEN', { title: 'Feature' })
			const gitState = branchState()
			const { storageCalls, gitCalls } = await runAbortChangeWith(state, gitState)
			expect(state.change!.state).toBe('CLOSED')
			expect(storageCalls).toContain('abortChange(42)')
			expect(gitCalls.find((c) => c.startsWith('deleteBranch'))).toBeUndefined()
			expect(gitState.branches.has('42-feature')).toBe(true)
			expect(gitState.current).toBe('main')
		})
	})

	describe('abort: branch deletion policy', () => {
		function happyState(): { state: FakeStorageState; gitState: GitState } {
			return {
				state: { change: { id: '42', branch: '42-feature', title: 'F', state: 'OPEN' }, slices: [] },
				gitState: {
					current: 'main',
					branches: new Set(['main', '42-feature']),
					mergedAncestors: new Map([['42-feature', ['main']]]),
				},
			}
		}

		test("policy='always' + merged + no open PRs → deletes without confirm", async () => {
			const { state, gitState } = happyState()
			let confirmCalls = 0
			const { gitCalls } = await runAbortChangeWith(state, gitState, {
				deleteBranchPolicy: 'always',
				confirm: async () => {
					confirmCalls++
					return true
				},
			})
			expect(confirmCalls).toBe(0)
			expect(gitCalls).toContain('deleteBranch(42-feature)')
			expect(gitState.branches.has('42-feature')).toBe(false)
		})

		test('Change branch deletion safety compares against the Change targetBranch', async () => {
			const state = changeState('OPEN', { targetBranch: 'release/1.2' })
			const gitState = branchState('main', ['main', 'release/1.2', '42-feature'], new Map([['42-feature', ['release/1.2']]]))

			const { gitCalls } = await runAbortChangeWith(state, gitState, { deleteBranchPolicy: 'always', confirm: async () => true })

			expect(gitCalls).toContain('isMerged(42-feature,release/1.2)')
			expect(gitCalls).toContain('deleteBranch(42-feature)')
		})

		test("policy='prompt' → asks once; user declines → no delete", async () => {
			const { state, gitState } = happyState()
			const { storage } = fakeStorage(state)
			const { git, calls: gCalls } = fakeGit(gitState)
			const msgs: string[] = []
			await runAbortChange('42', {
				storage,
				deleteBranchPolicy: 'prompt',
				confirm: async (m) => {
					msgs.push(m)
					return false
				},
				stdout: () => {},
				git,
				listOpenPrs: async () => [],
			})
			expect(msgs).toHaveLength(1)
			expect(msgs[0]).toMatch(/delete integration branch '42-feature'/i)
			expect(gCalls.find((c) => c.startsWith('deleteBranch'))).toBeUndefined()
			expect(gitState.branches.has('42-feature')).toBe(true)
		})

		test("policy='prompt' + accept → deletes; merged so no extra warnings", async () => {
			const { state, gitState } = happyState()
			const { storage } = fakeStorage(state)
			const { git } = fakeGit(gitState)
			const msgs: string[] = []
			await runAbortChange('42', {
				storage,
				deleteBranchPolicy: 'prompt',
				confirm: async (m) => {
					msgs.push(m)
					return true
				},
				stdout: () => {},
				git,
				listOpenPrs: async () => [],
			})
			expect(msgs).toHaveLength(1)
			expect(gitState.branches.has('42-feature')).toBe(false)
		})

		test("policy='never' → never prompts and never deletes", async () => {
			const { state, gitState } = happyState()
			let confirmCalls = 0
			const { gitCalls } = await runAbortChangeWith(state, gitState, {
				confirm: async () => {
					confirmCalls++
					return true
				},
			})
			expect(confirmCalls).toBe(0)
			expect(gitCalls.find((c) => c.startsWith('deleteBranch'))).toBeUndefined()
		})

		function expectBranchKeptAfterPrompt(msgs: string[], pattern: RegExp, gitState: GitState): void {
			expect(msgs.some((m) => pattern.test(m))).toBe(true)
			expect(gitState.branches.has('42-feature')).toBe(true)
		}

		test('open slice PRs → warn + confirm before delete; decline → keep branch', async () => {
			const { state, gitState } = happyState()
			const msgs: string[] = []
			const { stdoutBuf } = await runAbortChangeWith(state, gitState, {
				deleteBranchPolicy: 'always',
				confirm: async (m) => {
					msgs.push(m)
					return false // decline
				},
				listOpenPrs: async (b) => [{ number: 99, url: `https://github.com/o/r/pull/99 base=${b}` }],
			})
			expect(stdoutBuf).toContain('#99')
			expectBranchKeptAfterPrompt(msgs, /deleting the branch will close these PRs/i, gitState)
		})

		test('unmerged branch → warn + confirm; decline → keep branch', async () => {
			const { state, gitState } = happyState()
			gitState.mergedAncestors = new Map() // branch not merged
			const msgs: string[] = []
			await runAbortChangeWith(state, gitState, {
				deleteBranchPolicy: 'always',
				confirm: async (m) => {
					msgs.push(m)
					return false
				},
			})
			expectBranchKeptAfterPrompt(msgs, /contains commits not on 'main'/i, gitState)
		})

		test('unmerged + accept → deletes', async () => {
			const { state, gitState } = happyState()
			gitState.mergedAncestors = new Map()
			await runAbortChangeWith(state, gitState, { deleteBranchPolicy: 'always', confirm: async () => true })
			expect(gitState.branches.has('42-feature')).toBe(false)
		})
	})

	describe('abort: BACK_TO restoration', () => {
		test('currently on integration branch + delete → switches to baseBranch + stays there', async () => {
			const gitState = branchState('42-feature', ['main', '42-feature'], new Map([['42-feature', ['main']]]))
			const { gitCalls, stdoutBuf } = await runAbortChangeWith(changeState(), gitState, { deleteBranchPolicy: 'always', confirm: async () => true })
			expect(gitCalls).toContain('checkout(main)')
			expect(gitState.current).toBe('main')
			expect(stdoutBuf).toMatch(/Switched to 'main' \(was on deleted branch '42-feature'\)/)
		})

		test('currently on baseBranch → no checkout calls', async () => {
			const { gitCalls } = await runAbortChangeWith(changeState(), branchState('main', ['main', '42-feature'], new Map([['42-feature', ['main']]])), { deleteBranchPolicy: 'always', confirm: async () => true })
			expect(gitCalls.filter((c) => c.startsWith('checkout'))).toEqual([])
		})

		test('currently on unrelated branch + delete integration → restores user to BACK_TO branch', async () => {
			const gitState = branchState('experiment', ['main', '42-feature', 'experiment'], new Map([['42-feature', ['main']]]))
			await runAbortChangeWith(changeState(), gitState, { deleteBranchPolicy: 'always', confirm: async () => true })
			expect(gitState.current).toBe('experiment')
			expect(gitState.branches.has('42-feature')).toBe(false)
		})
	})

	describe('close slice', () => {
		type SliceRow = { id: string; title: string; body: string; state: 'OPEN' | 'CLOSED'; readyForAgent: boolean; needsRevision: boolean }

		function sliceStorage(changeId: string, slices: SliceRow[]): { storage: Storage; calls: string[] } {
			const calls: string[] = []
			const byId = new Map(slices.map((s) => [s.id, s]))
			const toSlice = (s: SliceRow): Slice => ({
				id: s.id,
				title: s.title,
				body: s.body,
				state: s.state === 'CLOSED' ? 'done' : (s.readyForAgent ? 'open' : 'draft'),
				closedAt: s.state === 'CLOSED' ? '2026-06-04T00:00:00.000Z' : null,
				readyForAgent: s.readyForAgent,
				needsRevision: s.needsRevision,
				blockedBy: [],
				prState: null,
			})
			const storage = fakeSliceStorage(slices.map(toSlice), changeId, {
				findChange: async (id) => (id === changeId ? { id, branch: `${changeId}-feature`, title: 'F', state: 'OPEN' } : null),
				updateSlice: async (_p, sliceId, patch) => {
					calls.push(`updateSlice(${sliceId},${JSON.stringify(patch)})`)
					const s = byId.get(sliceId)
					if (s && patch.closedAt !== undefined) s.state = patch.closedAt === null ? 'OPEN' : 'CLOSED'
				},
			})
			return { storage, calls }
		}

		function runAbortSliceWith(storage: Storage, git: GitOps, perSliceBranches: boolean): Promise<void> {
			return runAbortSlice('s1', {
				storage,
				deleteBranchPolicy: 'always',
				confirm: async () => true,
				stdout: () => {},
				git,
				gh: noPrGh(),
				usePrs: false,
				listOpenPrs: async () => [],
				perSliceBranches,
			})
		}

		test('throws when slice id not found', async () => {
			const { storage } = sliceStorage('42', [])
			const { git } = fakeGit({ current: 'main', branches: new Set(['main']), mergedAncestors: new Map() })
			await expect(
				runAbortSlice('zzz', {
					storage,
					deleteBranchPolicy: 'never',
					confirm: async () => false,
					stdout: () => {},
					git,
					gh: noPrGh(),
					usePrs: false,
					listOpenPrs: async () => [],
					perSliceBranches: false,
				}),
			).rejects.toThrow(/slice 'zzz' not found/)
		})

		test('done slice + perSliceBranches:false: marks CLOSED, no confirm, no branch ops', async () => {
			const { storage, calls } = sliceStorage('42', [{ id: 's1', title: 'A', body: '', state: 'CLOSED', readyForAgent: false, needsRevision: false }])
			const { git, calls: gCalls } = fakeGit({ current: 'main', branches: new Set(['main']), mergedAncestors: new Map() })
			let buf = ''
			let confirmCount = 0
			await runAbortSlice('s1', {
				storage,
				deleteBranchPolicy: 'always',
				confirm: async () => { confirmCount++; return true },
				stdout: (s) => (buf += s),
				git,
				gh: noPrGh(),
				usePrs: false,
				listOpenPrs: async () => [],
				perSliceBranches: false,
			})
			expect(buf).toMatch(/already closed/i)
			expect(confirmCount).toBe(0)
			expect(calls.find((c) => c.startsWith('updateSlice'))).toBeUndefined()
			expect(gCalls.find((c) => c[0] === 'deleteBranch')).toBeUndefined()
		})

		test('non-done state → confirm; decline → no updateSlice', async () => {
			const { storage, calls } = sliceStorage('42', [{ id: 's1', title: 'A', body: '', state: 'OPEN', readyForAgent: true, needsRevision: false }])
			const { git } = fakeGit({ current: 'main', branches: new Set(['main']), mergedAncestors: new Map() })
			let prompt = ''
			let buf = ''
			await runAbortSlice('s1', {
				storage,
				deleteBranchPolicy: 'never',
				confirm: async (m) => { prompt = m; return false },
				stdout: (s) => (buf += s),
				git,
				gh: noPrGh(),
				usePrs: false,
				listOpenPrs: async () => [],
				perSliceBranches: false,
			})
			expect(prompt).toMatch(/state 'open'/)
			expect(buf).toMatch(/aborted/i)
			expect(calls.find((c) => c.startsWith('updateSlice'))).toBeUndefined()
		})

		test('non-done state → confirm accept → updateSlice closedAt runs', async () => {
			const { storage, calls } = sliceStorage('42', [{ id: 's1', title: 'A', body: '', state: 'OPEN', readyForAgent: true, needsRevision: false }])
			const { git } = fakeGit({ current: 'main', branches: new Set(['main']), mergedAncestors: new Map() })
			await runAbortSlice('s1', {
				storage,
				deleteBranchPolicy: 'never',
				confirm: async () => true,
				stdout: () => {},
				git,
				gh: noPrGh(),
				usePrs: false,
				listOpenPrs: async () => [],
				perSliceBranches: false,
			})
			expect(calls.some((c) => /^updateSlice\(s1,\{"closedAt":"\d{4}-\d{2}-\d{2}T/.test(c))).toBe(true)
		})

		test('perSliceBranches:true → applies deleteBranch policy against the Change integration branch', async () => {
			const sliceBranch = 'change-42/slice-s1-a'
			const { storage } = sliceStorage('42', [{ id: 's1', title: 'A', body: '', state: 'CLOSED', readyForAgent: false, needsRevision: false }])
			const { git, calls: gCalls } = fakeGit({
				current: 'main',
				branches: new Set(['main', '42-feature', sliceBranch]),
				mergedAncestors: new Map([[sliceBranch, ['42-feature']]]),
			})
			await runAbortSliceWith(storage, git, true)
			expect(gCalls).toContain(`isMerged(${sliceBranch},42-feature)`)
			expect(gCalls).toContain(`deleteBranch(${sliceBranch})`)
		})

		test('perSliceBranches:true + branch absent → no branch ops', async () => {
			const { storage } = sliceStorage('42', [{ id: 's1', title: 'A', body: '', state: 'CLOSED', readyForAgent: false, needsRevision: false }])
			const { git, calls: gCalls } = fakeGit({ current: 'main', branches: new Set(['main']), mergedAncestors: new Map() })
			await runAbortSliceWith(storage, git, true)
			expect(gCalls.find((c) => c[0] === 'deleteBranch')).toBeUndefined()
		})
	})
}
