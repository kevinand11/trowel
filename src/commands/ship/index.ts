import type { StorageKind } from '../../storages/registry.ts'
import type { ClassifiedSlice, DeleteBranchPolicy, ShipMergeMethod, Storage } from '../../storages/types.ts'
import type { GhOps } from '../../utils/gh-ops.ts'
import type { GitOps } from '../../utils/git-ops.ts'
import { withMutationLock } from '../../utils/mutation-lock.ts'
import { cleanupChange } from '../../work/cleanup.ts'
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

async function runShip(changeId: string, rt: ShipRuntime): Promise<void> {
	await requireCleanTree(rt)
	const backTo = await rt.git.currentBranch()
	const change = await reconciledChange(changeId, rt)
	const targetBranch = change.targetBranch ?? await rt.git.baseBranch()
	try {
		if (change.state === 'CLOSED') {
			rt.stdout(`Change ${changeId} is already CLOSED; running cleanup.\n`)
			await cleanupAfterShip(change, targetBranch, rt, true)
			return
		}
		await requireShippableSlices(changeId, rt)
		const branchCleanupAllowed = await shipOpenChange(change, targetBranch, rt)
		await cleanupAfterShip(change, targetBranch, rt, branchCleanupAllowed)
	} finally {
		await restoreStartingBranch(backTo, targetBranch, rt)
	}
}

async function requireShippableSlices(changeId: string, rt: ShipRuntime): Promise<void> {
	const blockers = (await classifySlicesForChange({ storage: rt.storage, gh: rt.gh, changeId, usePrs: rt.usePrs })).filter((slice) => slice.state !== 'done')
	if (blockers.length > 0) throw notReadyError(changeId, blockers)
}

async function shipOpenChange(change: NonNullable<Awaited<ReturnType<Storage['findChange']>>>, targetBranch: string, rt: ShipRuntime): Promise<boolean> {
	return rt.usePrs ? shipViaPr(change, targetBranch, rt) : shipViaMerge(change, targetBranch, rt)
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
	return new Error(`Change ${changeId} is not ready to ship.\n\nNon-terminal slices:\n${blockers.map((s) => `  ${s.id}  ${s.state}  ${s.title}`).join('\n')}\n\nRun: trowel change work ${changeId}`)
}

async function shipViaMerge(change: NonNullable<Awaited<ReturnType<Storage['findChange']>>>, targetBranch: string, rt: ShipRuntime): Promise<boolean> {
	await runCloseOut(
		{ kind: 'change', id: change.id, branch: change.branch, targetBranch, title: change.title },
		{ storage: rt.storage, git: rt.git, gh: rt.gh, log: rt.stdout, config: { usePrs: false, deleteBranch: 'never', mergeNoVerify: rt.mergeNoVerify } },
	)
	return true
}

async function shipViaPr(change: NonNullable<Awaited<ReturnType<Storage['findChange']>>>, targetBranch: string, rt: ShipRuntime): Promise<boolean> {
	await ensureRemoteIntegrationBranch(change.branch, rt)
	await runCloseOut(
		{ kind: 'change', id: change.id, branch: change.branch, targetBranch, title: change.title },
		{ storage: rt.storage, git: rt.git, gh: rt.gh, log: rt.stdout, config: { usePrs: true, deleteBranch: 'never', mergeNoVerify: rt.mergeNoVerify } },
	)
	const prNumber = await rt.gh.findPrNumberByHead(change.branch)
	if (!(await optionalConfirm(rt, `Merge Close-out PR #${prNumber} now? [y/N]`))) return false
	await rt.gh.mergePr(prNumber, rt.mergeMethod)
	await reconcileEntity({ kind: 'change', id: change.id, branch: change.branch }, { storage: rt.storage, gh: rt.gh, log: rt.stdout })
	return true
}

async function cleanupAfterShip(change: NonNullable<Awaited<ReturnType<Storage['findChange']>>>, targetBranch: string, rt: ShipRuntime, branchCleanupAllowed: boolean): Promise<void> {
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
		const storage = args.storage ?? fakeSliceStorage([fakeClassifiedSlice({ id: 's1', title: 'Done', state: 'done', closedAt: '2026-06-04T00:00:00.000Z', readyForAgent: true })], '3', {
			findChange: async (id) => ({ id, branch: 'change-3-x', title: 'X', state: 'OPEN' }),
			closeChange: async (id) => { closed.push(id) },
		})
		const git = noopGitOps({
			currentBranch: async () => 'back',
			baseBranch: async () => 'main',
			checkout: async (b) => { gitCalls.push(`checkout(${b})`) },
			mergeNoFf: async (b) => { gitCalls.push(`mergeNoFf(${b})`) },
			mergeAbort: async () => { gitCalls.push('mergeAbort') },
			push: async (b) => { gitCalls.push(`push(${b})`) },
			pushSetUpstream: async (b) => { gitCalls.push(`pushSetUpstream(${b})`) },
			fetch: async (b) => { gitCalls.push(`fetch(${b})`) },
			deleteBranch: async (b) => { gitCalls.push(`deleteBranch(${b})`) },
			branchExists: async () => true,
			listLocalBranches: async () => ['change-3-x'],
			remoteBranchExists: async () => true,
			commitsAhead: async () => 0,
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

		test('already CLOSED after reconciliation exits successfully', async () => {
			const storage = fakeSliceStorage([], '3', { findChange: async (id) => ({ id, branch: 'change-3-x', title: 'X', state: 'CLOSED' }) })
			const { rt, out } = makeRt({ storage })
			await runShip('3', rt)
			expect(out.join('')).toContain('already CLOSED')
		})

		test('non-done slices block shipping with id, state, and title', async () => {
			const storage = fakeSliceStorage([fakeClassifiedSlice({ id: 's2', title: 'Needs work', state: 'open', readyForAgent: true })], '3', { findChange: async (id) => ({ id, branch: 'change-3-x', title: 'X', state: 'OPEN' }) })
			const { rt } = makeRt({ storage })
			await expect(runShip('3', rt)).rejects.toThrow(/s2 {2}open {2}Needs work/)
		})

		test('non-PR mode merges, closes, and applies local delete policy', async () => {
			const { rt, gitCalls, closed } = makeRt({ deleteBranchPolicy: 'always' })
			await runShip('3', rt)
			expect(gitCalls).toContain('mergeNoFf(change-3-x)')
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
	})
}
