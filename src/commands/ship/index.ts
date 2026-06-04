import type { StorageKind } from '../../storages/registry.ts'
import type { ChangeRecord, ChangeState, ClassifiedSlice, DeleteBranchPolicy, ShipMergeMethod, Storage } from '../../storages/types.ts'
import { classifyChange } from '../../utils/change-state.ts'
import type { GhOps } from '../../utils/gh-ops.ts'
import type { GitOps } from '../../utils/git-ops.ts'
import { withMutationLock } from '../../utils/mutation-lock.ts'
import { cleanupChange, refuseCurrentCleanupBranch } from '../../work/cleanup.ts'
import { runCloseOut } from '../../work/close-out.ts'
import { reconcileEntity } from '../../work/reconcile.ts'
import { classifySlicesForChange } from '../../work/slice-states.ts'
import { restoreStartingBranch, type OpenPr } from '../abort/branch.ts'
import { buildStorage, exitOnCommandError, loadCommandBase, type CommandBase } from '../runtime.ts'

type ShipRuntime = {
	projectRoot: string
	storage: Storage
	git: GitOps
	gh: GhOps
	usePrs: boolean
	mergeNoVerify: boolean
	mergeMethod: ShipMergeMethod
	deleteBranchPolicy: DeleteBranchPolicy
	interactive: boolean
	confirm: (msg: string) => Promise<boolean>
	stdout: (s: string) => void
	listOpenPrs: (branch: string) => Promise<OpenPr[]>
}

type ShipContext = {
	change: ChangeRecord
	slices: ClassifiedSlice[]
	state: ChangeState
	targetBranch: string
}

async function runShip(changeId: string, rt: ShipRuntime): Promise<void> {
	await requireCleanTree(rt)
	const backTo = await rt.git.currentBranch()
	const context = await loadShipContext(changeId, rt)
	if (shipMayRunCleanup(context.state)) await refuseCurrentCleanupBranch({ change: context.change, slices: context.slices, rt })
	try {
		await shipByState(context, rt)
	} finally {
		await restoreStartingBranch(backTo, context.targetBranch, rt)
	}
}

function shipMayRunCleanup(state: ChangeState): boolean {
	return state === 'ready' || state === 'in-flight' || state === 'landed' || state === 'done'
}

async function shipByState(context: ShipContext, rt: ShipRuntime): Promise<void> {
	switch (context.state) {
		case 'open':
			throw notReadyError(context.change.id, nonDoneSlices(context.slices))
		case 'ready':
			await cleanupAfterShip(context.change, context.targetBranch, rt, await shipReadyChange(context.change, context.targetBranch, rt))
			return
		case 'in-flight':
			await cleanupAfterShip(context.change, context.targetBranch, rt, await shipInFlightChange(context.change, context.targetBranch, rt))
			return
		case 'landed':
			await finalizeLandedChange(context.change, rt)
			await cleanupAfterShip(context.change, context.targetBranch, rt, true)
			return
		case 'done':
			rt.stdout(`Change ${context.change.id} is already done; running cleanup.\n`)
			await cleanupAfterShip(context.change, context.targetBranch, rt, true)
			return
		case 'aborted':
			throw abortedChangeError(context.change.id)
	}
}

async function loadShipContext(changeId: string, rt: ShipRuntime): Promise<ShipContext> {
	const change = await reconciledChange(changeId, rt)
	const slices = await classifySlicesForChange({ storage: rt.storage, gh: rt.gh, changeId, usePrs: rt.usePrs })
	return {
		change,
		slices,
		state: await classifyChange(change, slices, { gh: rt.gh, git: rt.git }),
		targetBranch: change.targetBranch ?? await rt.git.baseBranch(),
	}
}

function nonDoneSlices(slices: ClassifiedSlice[]): ClassifiedSlice[] {
	return slices.filter((slice) => slice.state !== 'done')
}

async function shipReadyChange(change: ChangeRecord, targetBranch: string, rt: ShipRuntime): Promise<boolean> {
	return rt.usePrs ? shipViaPr(change, targetBranch, rt) : shipViaMerge(change, targetBranch, rt)
}

async function shipInFlightChange(change: ChangeRecord, targetBranch: string, rt: ShipRuntime): Promise<boolean> {
	return shipViaPr(change, targetBranch, rt)
}

async function finalizeLandedChange(change: ChangeRecord, rt: ShipRuntime): Promise<void> {
	await rt.storage.closeChange(change.id)
	rt.stdout(`Change ${change.id} has landed; finalized before cleanup.\n`)
}

async function requireCleanTree(rt: ShipRuntime): Promise<void> {
	if (!(await rt.git.isWorkingTreeClean())) throw new Error('working tree is dirty; commit or stash before shipping')
}

async function reconciledChange(changeId: string, rt: ShipRuntime): Promise<NonNullable<Awaited<ReturnType<Storage['findChange']>>>> {
	const initial = await rt.storage.findChange(changeId)
	if (!initial) throw new Error(`Change '${changeId}' not found`)
	await reconcileEntity({ kind: 'change', id: changeId, branch: initial.branch }, { storage: rt.storage, gh: rt.gh, log: rt.stdout })
	const change = await rt.storage.findChange(changeId)
	if (!change) throw new Error(`Change '${changeId}' not found`)
	return change
}

function notReadyError(changeId: string, blockers: ClassifiedSlice[]): Error {
	const sliceLines = blockers.length > 0 ? blockers.map((s) => `  ${s.id}  ${s.state}  ${s.title}`).join('\n') : '  (none)'
	return new Error(`Change ${changeId} is open and not ready to ship.\n\nNon-done slices:\n${sliceLines}\n\nRun: trowel change work ${changeId}`)
}

function abortedChangeError(changeId: string): Error {
	return new Error(`Change ${changeId} is aborted and cannot be shipped. Run: trowel change abort ${changeId} to clean up abandoned work.`)
}

async function shipViaMerge(change: ChangeRecord, targetBranch: string, rt: ShipRuntime): Promise<boolean> {
	await runCloseOut(
		{ kind: 'change', id: change.id, branch: change.branch, targetBranch, title: change.title },
		{ storage: rt.storage, git: rt.git, gh: rt.gh, log: rt.stdout, projectRoot: rt.projectRoot, config: { usePrs: false, deleteBranch: 'never', mergeNoVerify: rt.mergeNoVerify } },
	)
	return true
}

async function shipViaPr(change: ChangeRecord, targetBranch: string, rt: ShipRuntime): Promise<boolean> {
	await ensureRemoteIntegrationBranch(change.branch, rt)
	await runCloseOut(
		{ kind: 'change', id: change.id, branch: change.branch, targetBranch, title: change.title },
		{ storage: rt.storage, git: rt.git, gh: rt.gh, log: rt.stdout, config: { usePrs: true, deleteBranch: 'never', mergeNoVerify: rt.mergeNoVerify } },
	)
	const prNumber = await rt.gh.findPrNumberByHead(change.branch)
	if (!(await optionalConfirm(rt, `Merge Close-out PR #${prNumber} now? [y/N]`))) return false
	await rt.gh.mergePr(prNumber, rt.mergeMethod)
	return await branchCleanupAllowedAfterCloseOut(change.id, rt)
}

async function branchCleanupAllowedAfterCloseOut(changeId: string, rt: ShipRuntime): Promise<boolean> {
	const context = await loadShipContext(changeId, rt)
	if (context.state === 'landed') {
		await finalizeLandedChange(context.change, rt)
		return true
	}
	return context.state === 'done'
}

async function cleanupAfterShip(change: ChangeRecord, targetBranch: string, rt: ShipRuntime, branchCleanupAllowed: boolean): Promise<void> {
	const slices = await rt.storage.findSlices(change.id)
	await cleanupChange({
		change,
		slices,
		targetBranch,
		rt: {
			projectRoot: rt.projectRoot,
			git: rt.git,
			deleteBranchPolicy: branchCleanupAllowed ? rt.deleteBranchPolicy : 'never',
			interactive: rt.interactive,
			confirm: rt.confirm,
			stdout: rt.stdout,
		},
	})
}

async function ensureRemoteIntegrationBranch(branch: string, rt: ShipRuntime): Promise<void> {
	await rt.git.fetch(branch).catch(() => undefined)
	if (!(await rt.git.remoteBranchExists(branch))) {
		await requiredConfirm(rt, `Remote branch origin/${branch} does not exist. Publish Integration branch before shipping? [Y/n]`)
		await rt.git.pushSetUpstream(branch)
		return
	}
	const ahead = await rt.git.commitsAhead(branch, `origin/${branch}`)
	if (ahead <= 0) return
	await requiredConfirm(rt, `Integration branch has ${ahead} local commit(s) not on origin/${branch}. Push before shipping? [Y/n]`)
	await rt.git.push(branch)
}

async function requiredConfirm(rt: ShipRuntime, msg: string): Promise<void> {
	if (!rt.interactive) throw new Error(msg)
	if (!(await rt.confirm(msg))) throw new Error('ship cancelled')
}

async function optionalConfirm(rt: ShipRuntime, msg: string): Promise<boolean> {
	return rt.interactive ? rt.confirm(msg) : false
}

function listOpenPrsFor(base: CommandBase): (branch: string) => Promise<OpenPr[]> {
	return async (branch) => (await base.gh.listOpenPrs({ base: branch })).map((pr) => ({ number: pr.number, url: pr.url ?? `#${pr.number}` }))
}

async function buildShipRuntime(opts: { storage?: StorageKind }): Promise<{ base: CommandBase; rt: ShipRuntime }> {
	const base = await loadCommandBase('change ship')
	const storageKind = opts.storage ?? base.config.storage
	const storage = buildStorage(base, storageKind)
	const { confirm } = await import('@inquirer/prompts')
	return {
		base,
		rt: {
			projectRoot: base.projectRoot,
			storage,
			git: base.git,
			gh: base.gh,
			usePrs: base.config.work.usePrs,
			mergeNoVerify: base.config.work.mergeNoVerify,
			mergeMethod: base.config.ship.mergeMethod,
			deleteBranchPolicy: base.config.ship.deleteBranch,
			interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
			confirm: (message) => confirm({ message, default: confirmDefault(message) }),
			stdout: (s) => process.stdout.write(s),
			listOpenPrs: listOpenPrsFor(base),
		},
	}
}

function confirmDefault(message: string): boolean {
	return message.includes('[Y/n]')
}

export async function shipChange(changeId: string, opts: { storage?: StorageKind }): Promise<void> {
	const { base, rt } = await buildShipRuntime(opts)
	await exitOnCommandError('change ship', () => withMutationLock(base.projectRoot, () => runShip(changeId, rt)))
}

if (import.meta.vitest) {
	const { describe, test, expect } = import.meta.vitest
	const { recordingGhOps } = await import('../../test-utils/gh-ops-recorder.ts')
	const { noopGitOps } = await import('../../test-utils/git-ops-fixtures.ts')
	const { fakeClassifiedSlice, fakeSliceStorage } = await import('../../test-utils/storage-fixtures.ts')

	function makeRt(args: Partial<ShipRuntime> & { storage?: Storage } = {}): { rt: ShipRuntime; gitCalls: string[]; ghCalls: unknown[][]; out: string[]; closed: string[] } {
		const gitCalls: string[] = []
		const out: string[] = []
		const closed: string[] = []
		let changeClosed = false
		const storage = args.storage ?? fakeSliceStorage([fakeClassifiedSlice({ id: 's1', title: 'Done', state: 'done', closedAt: '2026-06-04T00:00:00.000Z', readyForAgent: true })], '3', {
			findChange: async (id) => ({ id, branch: 'change-3-x', title: 'X', state: changeClosed ? 'CLOSED' : 'OPEN', closedAt: changeClosed ? '2026-06-04T00:00:00.000Z' : null }),
			closeChange: async (id) => {
				closed.push(id)
				changeClosed = true
			},
		})
		const git = noopGitOps({
			currentBranch: async () => 'back',
			baseBranch: async () => 'main',
			checkout: async (b) => { gitCalls.push(`checkout(${b})`) },
			mergeNoFf: async (b) => { gitCalls.push(`mergeNoFf(${b})`) },
			mergeNoFfIn: async (p, b) => { gitCalls.push(`mergeNoFfIn(${p},${b})`) },
			mergeAbort: async () => { gitCalls.push('mergeAbort') },
			push: async (b) => { gitCalls.push(`push(${b})`) },
			pushHeadTo: async (p, b) => { gitCalls.push(`pushHeadTo(${p},${b})`) },
			updateLocalBranchRef: async (b, ref) => { gitCalls.push(`updateLocalBranchRef(${b},${ref})`) },
			pushSetUpstream: async (b) => { gitCalls.push(`pushSetUpstream(${b})`) },
			fetch: async (b) => { gitCalls.push(`fetch(${b})`) },
			deleteBranch: async (b) => { gitCalls.push(`deleteBranch(${b})`) },
			worktreeAdd: async (p, b) => { gitCalls.push(`worktreeAdd(${p},${b})`) },
			branchExists: async () => true,
			listLocalBranches: async () => ['change-3-x'],
			remoteBranchExists: async () => true,
			commitsAhead: async (branch) => branch.startsWith('origin/') ? 1 : 0,
		})
		const { gh, calls } = recordingGhOps({ findPrNumberByHead: async () => 9, findAnyPrByHead: async () => null })
		return {
			rt: {
				projectRoot: '/tmp/trowel-ship-test-project',
				storage,
				git,
				gh,
				usePrs: false,
				mergeNoVerify: false,
				mergeMethod: 'merge',
				deleteBranchPolicy: 'never',
				interactive: true,
				confirm: async () => true,
				stdout: (s) => out.push(s),
				listOpenPrs: async () => [],
				...args,
			},
			gitCalls,
			ghCalls: calls,
			out,
			closed,
		}
	}

	describe('runShip', () => {
		test('fails when working tree is dirty', async () => {
			const { rt } = makeRt({ git: noopGitOps({ isWorkingTreeClean: async () => false }) })
			await expect(runShip('3', rt)).rejects.toThrow(/working tree is dirty/)
		})

		test('done Change after reconciliation exits successfully through cleanup', async () => {
			const storage = fakeSliceStorage([fakeClassifiedSlice({ state: 'done', closedAt: '2026-06-04T00:00:00.000Z' })], '3', { findChange: async (id) => ({ id, branch: 'change-3-x', title: 'X', state: 'CLOSED' }) })
			const { rt, out } = makeRt({ storage, gh: recordingGhOps({ findAnyPrByHead: async () => ({ number: 9, state: 'MERGED' }) }).gh })
			await runShip('3', rt)
			expect(out.join('')).toContain('already done')
		})

		test('open Changes fail with non-done slice details and no cleanup', async () => {
			const storage = fakeSliceStorage([fakeClassifiedSlice({ id: 's2', title: 'Needs work', state: 'open', readyForAgent: true })], '3', { findChange: async (id) => ({ id, branch: 'change-3-x', title: 'X', state: 'OPEN', closedAt: null }) })
			const { rt, gitCalls, closed } = makeRt({ storage, deleteBranchPolicy: 'always' })
			await expect(runShip('3', rt)).rejects.toThrow(/s2 {2}open {2}Needs work/)
			expect(closed).toEqual([])
			expect(gitCalls.find((c) => c.startsWith('deleteBranch'))).toBeUndefined()
		})

		test('aborted Changes refuse ship and point to abort cleanup', async () => {
			const storage = fakeSliceStorage([fakeClassifiedSlice({ id: 's1', state: 'done', closedAt: '2026-06-04T00:00:00.000Z' })], '3', { findChange: async (id) => ({ id, branch: 'change-3-x', title: 'X', state: 'CLOSED', closedAt: '2026-06-04T00:00:00.000Z' }) })
			const { rt, gitCalls } = makeRt({ storage, deleteBranchPolicy: 'always' })
			await expect(runShip('3', rt)).rejects.toThrow(/trowel change abort 3/)
			expect(gitCalls.find((c) => c.startsWith('deleteBranch'))).toBeUndefined()
		})

		test('refuses before prompting when the current branch is a Cleanup candidate under ship prompt policy', async () => {
			let current = 'change-3-x'
			let confirmCalls = 0
			const { rt, ghCalls } = makeRt({
				usePrs: true,
				deleteBranchPolicy: 'prompt',
				confirm: async () => {
					confirmCalls += 1
					throw new Error('should not prompt')
				},
				git: noopGitOps({
					currentBranch: async () => current,
					isWorkingTreeClean: async () => true,
					baseBranch: async () => 'main',
					listLocalBranches: async () => ['main', 'change-3-x'],
					remoteBranchExists: async () => true,
					commitsAhead: async (branch) => branch.startsWith('origin/') ? 1 : 0,
					checkout: async (branch) => { current = branch },
				}),
			})

			await expect(runShip('3', rt)).rejects.toThrow(/Switch branches first/)
			expect(confirmCalls).toBe(0)
			expect(ghCalls.map((call) => call[0])).not.toContain('createDraftPr')
			expect(current).toBe('change-3-x')
		})

		test('refuses before Close-out when the current branch is a Cleanup candidate under ship always policy', async () => {
			let current = 'change-3-x'
			const { rt, closed } = makeRt({
				deleteBranchPolicy: 'always',
				git: noopGitOps({
					currentBranch: async () => current,
					isWorkingTreeClean: async () => true,
					baseBranch: async () => 'main',
					listLocalBranches: async () => ['main', 'change-3-x'],
					remoteBranchExists: async () => true,
					commitsAhead: async () => 0,
					checkout: async (branch) => { current = branch },
				}),
			})

			await expect(runShip('3', rt)).rejects.toThrow(/Switch branches first/)
			expect(closed).toEqual([])
			expect(current).toBe('change-3-x')
		})

		test('does not refuse the current Cleanup candidate when ship deletion policy is never', async () => {
			let current = 'change-3-x'
			let confirmCalls = 0
			const { rt, ghCalls } = makeRt({
				usePrs: true,
				deleteBranchPolicy: 'never',
				confirm: async () => {
					confirmCalls += 1
					return false
				},
				git: noopGitOps({
					currentBranch: async () => current,
					isWorkingTreeClean: async () => true,
					baseBranch: async () => 'main',
					listLocalBranches: async () => ['main', 'change-3-x'],
					remoteBranchExists: async () => true,
					fetch: async () => {},
					commitsAhead: async (branch) => branch.startsWith('origin/') ? 1 : 0,
					checkout: async (branch) => { current = branch },
					worktreeList: async () => [],
				}),
			})

			await runShip('3', rt)

			expect(confirmCalls).toBe(1)
			expect(ghCalls.map((call) => call[0])).toContain('createDraftPr')
			expect(current).toBe('change-3-x')
		})

		test('non-PR mode merges ready Changes, closes, preserves the main checkout, and applies local delete policy', async () => {
			const { rt, gitCalls, closed } = makeRt({ deleteBranchPolicy: 'always' })
			await runShip('3', rt)
			expect(gitCalls).toContain('mergeNoFfIn(/tmp/trowel-ship-test-project/.trowel/worktrees/3/__merge-change,change-3-x)')
			expect(gitCalls).toContain('pushHeadTo(/tmp/trowel-ship-test-project/.trowel/worktrees/3/__merge-change,main)')
			expect(gitCalls.find((call) => call.startsWith('checkout'))).toBeUndefined()
			expect(closed).toEqual(['3'])
			expect(gitCalls).toContain('deleteBranch(change-3-x)')
		})

		test('PR mode missing remote publishes before opening PR', async () => {
			const { rt, gitCalls, ghCalls } = makeRt({ usePrs: true, git: noopGitOps({ currentBranch: async () => 'back', isWorkingTreeClean: async () => true, remoteBranchExists: async () => false, pushSetUpstream: async (b) => { gitCalls.push(`pushSetUpstream(${b})`) }, fetch: async (b) => { gitCalls.push(`fetch(${b})`) }, branchExists: async () => true }) })
			await runShip('3', rt)
			expect(gitCalls).toContain('pushSetUpstream(change-3-x)')
			expect(ghCalls.map((c) => c[0])).toContain('createDraftPr')
		})

		test('PR mode optional merge uses configured method', async () => {
			const { rt, ghCalls } = makeRt({ usePrs: true, mergeMethod: 'squash', confirm: async (msg) => msg.startsWith('Merge Close-out PR') })
			await runShip('3', rt)
			expect(ghCalls).toContainEqual(['mergePr', 9, 'squash'])
		})

		test('in-flight Change uses the existing Close-out PR and keeps branches when not done', async () => {
			const { gh, calls } = recordingGhOps({ findAnyPrByHead: async () => ({ number: 9, state: 'OPEN' }), findPrNumberByHead: async () => 9 })
			const { rt, gitCalls } = makeRt({ gh, usePrs: false, deleteBranchPolicy: 'always', confirm: async (msg) => !msg.startsWith('Merge Close-out PR') })

			await runShip('3', rt)

			expect(calls.map((c) => c[0])).not.toContain('createDraftPr')
			expect(calls).toContainEqual(['markPrReady', 9])
			expect(calls.map((c) => c[0])).not.toContain('mergePr')
			expect(gitCalls.find((c) => c.startsWith('deleteBranch'))).toBeUndefined()
		})

		test('in-flight Change performs full cleanup only after the Close-out PR makes it done', async () => {
			let merged = false
			const { gh, calls } = recordingGhOps({
				findAnyPrByHead: async () => ({ number: 9, state: merged ? 'MERGED' : 'OPEN' }),
				findPrNumberByHead: async () => 9,
				mergePr: async () => { merged = true },
			})
			const { rt, gitCalls, closed } = makeRt({ gh, usePrs: false, deleteBranchPolicy: 'always' })

			await runShip('3', rt)

			expect(calls).toContainEqual(['mergePr', 9, 'merge'])
			expect(closed).toEqual(['3'])
			expect(gitCalls).toContain('deleteBranch(change-3-x)')
		})

		test('landed Change is finalized before cleanup without running Close-out', async () => {
			const gitCalls: string[] = []
			const git = noopGitOps({
				currentBranch: async () => 'back',
				baseBranch: async () => 'main',
				checkout: async (b) => { gitCalls.push(`checkout(${b})`) },
				mergeNoFf: async (b) => { gitCalls.push(`mergeNoFf(${b})`) },
				deleteBranch: async (b) => { gitCalls.push(`deleteBranch(${b})`) },
				branchExists: async () => true,
				listLocalBranches: async () => ['change-3-x'],
				remoteBranchExists: async () => true,
				fetch: async (b) => { gitCalls.push(`fetch(${b})`) },
				commitsAhead: async () => 0,
			})
			const { rt, closed, ghCalls } = makeRt({ git, deleteBranchPolicy: 'always' })

			await runShip('3', rt)

			expect(closed).toEqual(['3'])
			expect(gitCalls).not.toContain('mergeNoFf(change-3-x)')
			expect(ghCalls.map((c) => c[0])).not.toContain('createDraftPr')
			expect(gitCalls).toContain('deleteBranch(change-3-x)')
		})
	})
}
