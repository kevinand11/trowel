import { confirm as inqConfirm } from '@inquirer/prompts'

import { deleteBranchIfPresent, restoreStartingBranch, type CloseBranchRuntime, type OpenPr } from './branch.ts'
import type { StorageKind } from '../../storages/registry.ts'
import type { ClassifiedSlice, FixRecord, PrdRecord, Slice, SlicePatch, Storage } from '../../storages/types.ts'
import type { GhOps } from '../../utils/gh-ops.ts'
import type { GitOps } from '../../utils/git-ops.ts'
import { withMutationLock } from '../../utils/mutation-lock.ts'
import { slug as slugify } from '../../utils/slug.ts'
import { classifySlicesForPrd } from '../../work/slice-buckets.ts'
import { buildStorage, exitOnCommandError, loadCommandBase, type CommandBase } from '../runtime.ts'

type CloseRuntime = CloseBranchRuntime & {
	storage: Storage
}

type CloseSliceRuntime = CloseRuntime & {
	gh: GhOps
	usePrs: boolean
	perSliceBranches: boolean
}

async function runClosePrd(prdId: string, rt: CloseRuntime): Promise<void> {
	const back = await rt.git.currentBranch()
	const prd = await findPrdOrThrow(prdId, rt.storage)
	const targetBranch = await prdTargetBranch(prd, rt)

	if (!(await closeOpenPrdSlices(prdId, rt))) return
	await closePrdRecord(prdId, prd, rt)
	await deleteBranchIfPresent(prd.branch, targetBranch, rt)
	await restoreStartingBranch(back, targetBranch, rt)
}

async function findPrdOrThrow(prdId: string, storage: Storage): Promise<PrdRecord> {
	const prd = await storage.findPrd(prdId)
	if (!prd) throw new Error(`PRD '${prdId}' not found`)
	return prd
}

async function prdTargetBranch(prd: PrdRecord, rt: CloseRuntime): Promise<string> {
	return prd.targetBranch ?? await rt.git.baseBranch()
}

async function closeOpenPrdSlices(prdId: string, rt: CloseRuntime): Promise<boolean> {
	const openSlices = (await rt.storage.findSlices(prdId)).filter((s) => s.state === 'OPEN')
	if (openSlices.length === 0) return true
	const ids = openSlices.map((s) => s.id).join(', ')
	const ok = await rt.confirm(`PRD has ${openSlices.length} open slices: ${ids}. Auto-close all? [y/N]`)
	if (!ok) {
		rt.stdout('Aborted; nothing changed.\n')
		return false
	}
	for (const s of openSlices) await rt.storage.updateSlice(prdId, s.id, { state: 'CLOSED' })
	return true
}

async function closePrdRecord(prdId: string, prd: PrdRecord, rt: CloseRuntime): Promise<void> {
	if (prd.state === 'OPEN') {
		await rt.storage.closePrd(prdId)
	} else {
		rt.stdout(`PRD '${prdId}' already closed in store.\n`)
	}
}

async function runCloseSlice(sliceId: string, rt: CloseSliceRuntime): Promise<void> {
	const { prdId } = await findSliceOrThrow(sliceId, rt.storage)
	const back = await rt.git.currentBranch()
	const sliceMergeTarget = await sliceMergeTargetBranch(prdId, rt)
	const target = await findClassifiedSliceOrThrow(sliceId, prdId, rt)

	if (!(await closeSliceRecord(prdId, sliceId, target, rt))) return
	await deleteSliceBranchIfPresent(prdId, target, sliceMergeTarget, rt)
	await restoreStartingBranch(back, sliceMergeTarget, rt)
}

async function findSliceOrThrow(sliceId: string, storage: Storage): Promise<{ prdId: string; slice: Slice }> {
	const hit = await storage.findSlice(sliceId)
	if (!hit) throw new Error(`slice '${sliceId}' not found`)
	return hit
}

async function sliceMergeTargetBranch(prdId: string, rt: CloseSliceRuntime): Promise<string> {
	const prd = await rt.storage.findPrd(prdId)
	return prd?.branch ?? await rt.git.baseBranch()
}

async function findClassifiedSliceOrThrow(sliceId: string, prdId: string, rt: CloseSliceRuntime): Promise<ClassifiedSlice> {
	const siblings = await classifySlicesForPrd({ storage: rt.storage, gh: rt.gh, prdId, usePrs: rt.usePrs })
	const target = siblings.find((s) => s.id === sliceId)
	if (!target) throw new Error(`slice '${sliceId}' disappeared between findSlice and findSlices`)
	return target
}

async function closeSliceRecord(prdId: string, sliceId: string, target: ClassifiedSlice, rt: CloseSliceRuntime): Promise<boolean> {
	if (target.state === 'CLOSED') {
		rt.stdout(`Slice '${sliceId}' already closed.\n`)
		return true
	}
	if (target.bucket !== 'done' && !(await confirmCloseNonDoneSlice(sliceId, target, rt))) return false
	await rt.storage.updateSlice(prdId, sliceId, { state: 'CLOSED' })
	return true
}

async function confirmCloseNonDoneSlice(sliceId: string, target: ClassifiedSlice, rt: CloseSliceRuntime): Promise<boolean> {
	const ok = await rt.confirm(`Slice '${sliceId}' is in bucket '${target.bucket}', not 'done'. Close anyway? [y/N]`)
	if (ok) return true
	rt.stdout('Aborted; nothing changed.\n')
	return false
}

async function deleteSliceBranchIfPresent(prdId: string, target: ClassifiedSlice, sliceMergeTarget: string, rt: CloseSliceRuntime): Promise<void> {
	if (!rt.perSliceBranches) return
	await deleteBranchIfPresent(sliceBranchName(prdId, target), sliceMergeTarget, rt)
}

function sliceBranchName(prdId: string, slice: Slice): string {
	return `prd-${prdId}/slice-${slice.id}-${slugify(slice.title)}`
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

async function buildCloseRuntime(opts: { storage?: StorageKind }): Promise<{ base: CommandBase; storage: Storage; confirm: (msg: string) => Promise<boolean>; listOpenPrs: (branch: string) => Promise<OpenPr[]> }> {
	const base = await loadCommandBase('close')
	const confirm = (msg: string) => inqConfirm({ message: msg, default: false })
	const storage = buildStorage(base, opts.storage ?? base.config.storage, { confirm })
	return { base, storage, confirm, listOpenPrs: listOpenPrsFor(base) }
}

function closeRuntime(base: CommandBase, storage: Storage, confirm: (msg: string) => Promise<boolean>, listOpenPrs: (branch: string) => Promise<OpenPr[]>): CloseRuntime {
	return {
		storage,
		deleteBranchPolicy: base.config.close.deleteBranch,
		confirm,
		stdout: (s) => process.stdout.write(s),
		git: base.git,
		listOpenPrs,
	}
}

export async function closePrd(prdId: string, opts: { storage?: StorageKind }): Promise<void> {
	const { base, storage, confirm, listOpenPrs } = await buildCloseRuntime(opts)
	await exitOnCommandError('close', () => withMutationLock(base.projectRoot, () => runClosePrd(prdId, closeRuntime(base, storage, confirm, listOpenPrs))))
}

async function runCloseFix(fixId: string, rt: CloseRuntime): Promise<void> {
	const back = await rt.git.currentBranch()
	const fix = await findFixOrThrow(fixId, rt.storage)
	const targetBranch = await fixTargetBranch(fix, rt)
	await closeFixRecord(fixId, fix, rt)
	await deleteBranchIfPresent(fix.branch, targetBranch, rt)
	await restoreStartingBranch(back, targetBranch, rt)
}

async function findFixOrThrow(fixId: string, storage: Storage): Promise<FixRecord> {
	const fix = await storage.findFix(fixId)
	if (!fix) throw new Error(`Fix '${fixId}' not found`)
	return fix
}

async function fixTargetBranch(fix: FixRecord, rt: CloseRuntime): Promise<string> {
	return fix.targetBranch ?? await rt.git.baseBranch()
}

async function closeFixRecord(fixId: string, fix: FixRecord, rt: CloseRuntime): Promise<void> {
	if (fix.state === 'OPEN') {
		await rt.storage.closeFix(fixId)
	} else {
		rt.stdout(`Fix '${fixId}' already closed in store.\n`)
	}
}

export async function closeFix(fixId: string, opts: { storage?: StorageKind }): Promise<void> {
	const { base, storage, confirm, listOpenPrs } = await buildCloseRuntime(opts)
	await exitOnCommandError('close', () => withMutationLock(base.projectRoot, () => runCloseFix(fixId, closeRuntime(base, storage, confirm, listOpenPrs))))
}

export async function closeSlice(sliceId: string, opts: { storage?: StorageKind }): Promise<void> {
	const { base, storage, confirm, listOpenPrs } = await buildCloseRuntime(opts)
	await exitOnCommandError('close', () =>
		withMutationLock(base.projectRoot, () =>
			runCloseSlice(sliceId, {
				...closeRuntime(base, storage, confirm, listOpenPrs),
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
		prd: { id: string; branch: string; targetBranch?: string; title: string; state: 'OPEN' | 'CLOSED' } | null
		slices: Array<{ id: string; title: string; body: string; state: 'OPEN' | 'CLOSED'; readyForAgent: boolean; needsRevision: boolean }>
	}

	function fakeStorage(state: FakeStorageState): { storage: Storage; calls: string[] } {
		const calls: string[] = []
		const storage: Storage = {
			createPrd: async () => {
				throw new Error('not implemented')
			},
			findPrd: async (id) => {
				calls.push(`findPrd(${id})`)
				if (!state.prd || state.prd.id !== id) return null
				return { ...state.prd }
			},
			listPrds: async () => (state.prd && state.prd.state === 'OPEN' ? [{ ...state.prd, createdAt: '2026-05-13T00:00:00.000Z' }] : []),
			closePrd: async (id) => {
				calls.push(`closePrd(${id})`)
				if (state.prd && state.prd.id === id) state.prd.state = 'CLOSED'
			},
			createSlice: async () => {
				throw new Error('not implemented')
			},
			findSlices: async () => {
				calls.push('findSlices')
				return state.slices.map((s) => ({
					...s,
					blockedBy: [],
					prState: null,
				}))
			},
			findSlice: async () => null,
			updateSlice: async (_pid, sliceId, patch) => {
				calls.push(`updateSlice(${sliceId},${JSON.stringify(patch)})`)
				applyFakeSlicePatch(state.slices.find((x) => x.id === sliceId), patch)
			},
			createFix: async () => ({ id: 'unused-fix', branch: 'unused-fix' }),
			findFix: async () => null,
			listFixes: async () => [],
			updateFix: async () => undefined,
			closeFix: async () => undefined,
		}
		return { storage, calls }
	}

	function applyFakeSlicePatch(slice: FakeStorageState['slices'][number] | undefined, patch: SlicePatch): void {
		if (!slice) return
		closeFakeSliceIfRequested(slice, patch.state)
		setFakeReadyForAgent(slice, patch.readyForAgent)
		setFakeNeedsRevision(slice, patch.needsRevision)
	}

	function closeFakeSliceIfRequested(slice: FakeStorageState['slices'][number], state: SlicePatch['state']): void {
		if (state === 'CLOSED') slice.state = 'CLOSED'
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

	function prdState(state: 'OPEN' | 'CLOSED' = 'OPEN', overrides: Partial<NonNullable<FakeStorageState['prd']>> = {}, slices: FakeStorageState['slices'] = []): FakeStorageState {
		return { prd: { id: '42', branch: '42-feature', title: 'F', state, ...overrides }, slices }
	}

	function branchState(current = 'main', branches = ['main', '42-feature'], mergedAncestors: GitState['mergedAncestors'] = new Map()): GitState {
		return { current, branches: new Set(branches), mergedAncestors }
	}

	async function runClosePrdWith(
		state: FakeStorageState,
		gitState: GitState,
		overrides: Partial<Omit<CloseRuntime, 'storage' | 'git'>> = {},
	): Promise<{ storageCalls: string[]; gitCalls: string[]; stdoutBuf: string }> {
		const { storage, calls: storageCalls } = fakeStorage(state)
		const { git, calls: gitCalls } = fakeGit(gitState)
		let stdoutBuf = ''
		await runClosePrd('42', {
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

	describe('close: PRD not found', () => {
		test('throws when storage.findPrd returns null', async () => {
			const state: FakeStorageState = { prd: null, slices: [] }
			const gitState: GitState = { current: 'main', branches: new Set(['main']), mergedAncestors: new Map() }
			const { storage } = fakeStorage(state)
			const { git } = fakeGit(gitState)
			await expect(
				runClosePrd('99', {
					storage,
					deleteBranchPolicy: 'never',
					confirm: async () => false,
					stdout: () => {},
					git,
					listOpenPrs: async () => [],
				}),
			).rejects.toThrow(/PRD '99' not found/)
		})
	})

	describe('close: idempotent on already-closed PRD', () => {
		test('does not call storage.close when prd state is CLOSED', async () => {
			const { storageCalls, stdoutBuf } = await runClosePrdWith(prdState('CLOSED'), branchState())
			expect(storageCalls).not.toContain('closePrd(42)')
			expect(stdoutBuf).toMatch(/already closed/i)
		})

		test('still attempts branch delete on a closed PRD when branch still exists', async () => {
			const { gitCalls } = await runClosePrdWith(prdState('CLOSED'), branchState('main', ['main', '42-feature'], new Map([['42-feature', ['main']]])), { deleteBranchPolicy: 'always' })
			expect(gitCalls).toContain('deleteBranch(42-feature)')
		})
	})

	describe('close: open slices', () => {
		const baseSlice = { title: 'X', body: '', readyForAgent: false, needsRevision: false }

		test('warns with slice ids and confirms before auto-closing', async () => {
			const state = prdState('OPEN', {}, [
				{ id: 's1', ...baseSlice, state: 'OPEN' },
				{ id: 's2', ...baseSlice, state: 'CLOSED' },
				{ id: 's3', ...baseSlice, state: 'OPEN' },
			])
			let confirmMsg = ''
			const { storageCalls } = await runClosePrdWith(state, branchState(), {
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
			expect(storageCalls).toContain('closePrd(42)')
		})

		test('declining the warn → no auto-close, no storage.close, no branch ops', async () => {
			const state = prdState('OPEN', {}, [{ id: 's1', ...baseSlice, state: 'OPEN' }])
			const { storageCalls, gitCalls, stdoutBuf } = await runClosePrdWith(state, branchState(), { deleteBranchPolicy: 'always' })
			expect(state.slices[0]!.state).toBe('OPEN')
			expect(state.prd!.state).toBe('OPEN')
			expect(storageCalls).not.toContain('closePrd(42)')
			expect(gitCalls.find((c) => c.startsWith('deleteBranch'))).toBeUndefined()
			expect(stdoutBuf).toMatch(/aborted/i)
		})

		test('no open slices → no prompt, proceeds straight to storage.close', async () => {
			let confirmCalled = 0
			const { storageCalls } = await runClosePrdWith(prdState('OPEN', {}, [{ id: 's1', ...baseSlice, state: 'CLOSED' }]), branchState(), {
				confirm: async () => {
					confirmCalled++
					return false
				},
			})
			expect(confirmCalled).toBe(0)
			expect(storageCalls).toContain('closePrd(42)')
		})
	})

	describe('close: tracer (PRD open, no slices, policy=never)', () => {
		test('calls storage.close, leaves branch intact, returns user to BACK_TO', async () => {
			const state = prdState('OPEN', { title: 'Feature' })
			const gitState = branchState()
			const { storageCalls, gitCalls } = await runClosePrdWith(state, gitState)
			expect(state.prd!.state).toBe('CLOSED')
			expect(storageCalls).toContain('closePrd(42)')
			expect(gitCalls.find((c) => c.startsWith('deleteBranch'))).toBeUndefined()
			expect(gitState.branches.has('42-feature')).toBe(true)
			expect(gitState.current).toBe('main')
		})
	})

	describe('close: branch deletion policy', () => {
		function happyState(): { state: FakeStorageState; gitState: GitState } {
			return {
				state: { prd: { id: '42', branch: '42-feature', title: 'F', state: 'OPEN' }, slices: [] },
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
			const { gitCalls } = await runClosePrdWith(state, gitState, {
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

		test('PRD branch deletion safety compares against the PRD targetBranch', async () => {
			const state = prdState('OPEN', { targetBranch: 'release/1.2' })
			const gitState = branchState('main', ['main', 'release/1.2', '42-feature'], new Map([['42-feature', ['release/1.2']]]))

			const { gitCalls } = await runClosePrdWith(state, gitState, { deleteBranchPolicy: 'always', confirm: async () => true })

			expect(gitCalls).toContain('isMerged(42-feature,release/1.2)')
			expect(gitCalls).toContain('deleteBranch(42-feature)')
		})

		test("policy='prompt' → asks once; user declines → no delete", async () => {
			const { state, gitState } = happyState()
			const { storage } = fakeStorage(state)
			const { git, calls: gCalls } = fakeGit(gitState)
			const msgs: string[] = []
			await runClosePrd('42', {
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
			await runClosePrd('42', {
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
			const { gitCalls } = await runClosePrdWith(state, gitState, {
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
			const { stdoutBuf } = await runClosePrdWith(state, gitState, {
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
			await runClosePrdWith(state, gitState, {
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
			await runClosePrdWith(state, gitState, { deleteBranchPolicy: 'always', confirm: async () => true })
			expect(gitState.branches.has('42-feature')).toBe(false)
		})
	})

	describe('close: BACK_TO restoration', () => {
		test('currently on integration branch + delete → switches to baseBranch + stays there', async () => {
			const gitState = branchState('42-feature', ['main', '42-feature'], new Map([['42-feature', ['main']]]))
			const { gitCalls, stdoutBuf } = await runClosePrdWith(prdState(), gitState, { deleteBranchPolicy: 'always', confirm: async () => true })
			expect(gitCalls).toContain('checkout(main)')
			expect(gitState.current).toBe('main')
			expect(stdoutBuf).toMatch(/Switched to 'main' \(was on deleted branch '42-feature'\)/)
		})

		test('currently on baseBranch → no checkout calls', async () => {
			const { gitCalls } = await runClosePrdWith(prdState(), branchState('main', ['main', '42-feature'], new Map([['42-feature', ['main']]])), { deleteBranchPolicy: 'always', confirm: async () => true })
			expect(gitCalls.filter((c) => c.startsWith('checkout'))).toEqual([])
		})

		test('currently on unrelated branch + delete integration → restores user to BACK_TO branch', async () => {
			const gitState = branchState('experiment', ['main', '42-feature', 'experiment'], new Map([['42-feature', ['main']]]))
			await runClosePrdWith(prdState(), gitState, { deleteBranchPolicy: 'always', confirm: async () => true })
			expect(gitState.current).toBe('experiment')
			expect(gitState.branches.has('42-feature')).toBe(false)
		})
	})

	describe('close fix', () => {
		test('branch deletion safety compares against the Fix targetBranch', async () => {
			const storage = fakeSliceStorage([], null, {
				findPrd: async () => null,
				findFix: async () => ({ id: '5', branch: 'fix/5-x', targetBranch: 'hotfix/base', title: 'X', body: 'body', state: 'OPEN', readyForAgent: false, needsRevision: false, blockedBy: [], prState: null }),
			})
			const { git, calls: gCalls } = fakeGit({
				current: 'main',
				branches: new Set(['main', 'hotfix/base', 'fix/5-x']),
				mergedAncestors: new Map([['fix/5-x', ['hotfix/base']]]),
			})

			await runCloseFix('5', {
				storage,
				deleteBranchPolicy: 'always',
				confirm: async () => true,
				stdout: () => {},
				git,
				listOpenPrs: async () => [],
			})

			expect(gCalls).toContain('isMerged(fix/5-x,hotfix/base)')
			expect(gCalls).toContain('deleteBranch(fix/5-x)')
		})
	})

	describe('close slice', () => {
		type SliceRow = { id: string; title: string; body: string; state: 'OPEN' | 'CLOSED'; readyForAgent: boolean; needsRevision: boolean }

		function sliceStorage(prdId: string, slices: SliceRow[]): { storage: Storage; calls: string[] } {
			const calls: string[] = []
			const byId = new Map(slices.map((s) => [s.id, s]))
			const toSlice = (s: SliceRow): Slice => ({ ...s, blockedBy: [], prState: null })
			const storage = fakeSliceStorage(slices.map(toSlice), prdId, {
				findPrd: async (id) => (id === prdId ? { id, branch: `${prdId}-feature`, title: 'F', state: 'OPEN' } : null),
				updateSlice: async (_p, sliceId, patch) => {
					calls.push(`updateSlice(${sliceId},${JSON.stringify(patch)})`)
					const s = byId.get(sliceId)
					if (s && patch.state === 'CLOSED') s.state = 'CLOSED'
				},
			})
			return { storage, calls }
		}

		function runCloseSliceWith(storage: Storage, git: GitOps, perSliceBranches: boolean): Promise<void> {
			return runCloseSlice('s1', {
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
				runCloseSlice('zzz', {
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
			await runCloseSlice('s1', {
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

		test('non-done bucket → confirm; decline → no updateSlice', async () => {
			const { storage, calls } = sliceStorage('42', [{ id: 's1', title: 'A', body: '', state: 'OPEN', readyForAgent: true, needsRevision: false }])
			const { git } = fakeGit({ current: 'main', branches: new Set(['main']), mergedAncestors: new Map() })
			let prompt = ''
			let buf = ''
			await runCloseSlice('s1', {
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
			expect(prompt).toMatch(/bucket 'ready'/)
			expect(buf).toMatch(/aborted/i)
			expect(calls.find((c) => c.startsWith('updateSlice'))).toBeUndefined()
		})

		test('non-done bucket → confirm accept → updateSlice CLOSED runs', async () => {
			const { storage, calls } = sliceStorage('42', [{ id: 's1', title: 'A', body: '', state: 'OPEN', readyForAgent: true, needsRevision: false }])
			const { git } = fakeGit({ current: 'main', branches: new Set(['main']), mergedAncestors: new Map() })
			await runCloseSlice('s1', {
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
			expect(calls).toContain('updateSlice(s1,{"state":"CLOSED"})')
		})

		test('perSliceBranches:true → applies deleteBranch policy against the PRD integration branch', async () => {
			const sliceBranch = 'prd-42/slice-s1-a'
			const { storage } = sliceStorage('42', [{ id: 's1', title: 'A', body: '', state: 'CLOSED', readyForAgent: false, needsRevision: false }])
			const { git, calls: gCalls } = fakeGit({
				current: 'main',
				branches: new Set(['main', '42-feature', sliceBranch]),
				mergedAncestors: new Map([[sliceBranch, ['42-feature']]]),
			})
			await runCloseSliceWith(storage, git, true)
			expect(gCalls).toContain(`isMerged(${sliceBranch},42-feature)`)
			expect(gCalls).toContain(`deleteBranch(${sliceBranch})`)
		})

		test('perSliceBranches:true + branch absent → no branch ops', async () => {
			const { storage } = sliceStorage('42', [{ id: 's1', title: 'A', body: '', state: 'CLOSED', readyForAgent: false, needsRevision: false }])
			const { git, calls: gCalls } = fakeGit({ current: 'main', branches: new Set(['main']), mergedAncestors: new Map() })
			await runCloseSliceWith(storage, git, true)
			expect(gCalls.find((c) => c[0] === 'deleteBranch')).toBeUndefined()
		})
	})
}
