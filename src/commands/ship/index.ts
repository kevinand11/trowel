import type { Change, DeleteBranchPolicy, ShipMergeMethod, Storage } from '../../storages/types.ts'
import { classifyChange } from '../../utils/change-state.ts'
import type { GhOps, PrMergeabilityFacts } from '../../utils/gh-ops.ts'
import type { GitOps } from '../../utils/git-ops.ts'
import { withMutationLock } from '../../utils/mutation-lock.ts'
import type { ChangeState } from '../../work/change-types.ts'
import { cleanupChange, refuseCurrentCleanupBranch } from '../../work/cleanup.ts'
import { runCloseOut } from '../../work/close-out.ts'
import { formatMergeConflictDetails, type MergeConflictSummary } from '../../work/merge-conflict-preflight.ts'
import { classifySlicesForChange } from '../../work/slice-states.ts'
import type { ClassifiedSlice } from '../../work/slice-types.ts'
import { restoreStartingBranch, type OpenPr } from '../abort/branch.ts'
import { buildStorage, exitOnCommandError, loadCommandBase, type CommandBase } from '../runtime.ts'

type ShipRuntime = {
	projectRoot: string
	storage: Storage
	git: GitOps
	gh: GhOps
	pr: boolean
	mergeNoVerify: boolean
	mergeMethod: ShipMergeMethod
	mergeabilityPollSeconds: number
	deleteBranchPolicy: DeleteBranchPolicy
	needsRevisionLabel?: string
	interactive: boolean
	confirm: (msg: string) => Promise<boolean>
	stdout: (s: string) => void
	listOpenPrs: (branch: string) => Promise<OpenPr[]>
	sleep: (ms: number) => Promise<void>
}

type ShipContext = {
	change: Change
	slices: ClassifiedSlice[]
	state: ChangeState
	targetBranch: string
}

async function runShip(changeId: string, rt: ShipRuntime): Promise<void> {
	await requireCleanTree(rt)
	const backTo = await rt.git.currentBranch()
	let context = await loadShipContext(changeId, rt)
	assertPrCloseOutBranchTopology(context, rt)
	let shipSucceeded = false
	try {
		context = await offerSlicePrMergesBeforeCloseOut(context, rt)
		if (shipMayRunCleanup(context.state))
			await refuseCurrentCleanupBranch({ change: context.change, slices: context.slices, targetBranch: context.targetBranch, rt })
		await shipByState(context, rt)
		shipSucceeded = true
	} finally {
		await restoreStartingBranch(backTo, context.targetBranch, rt)
		if (shipSucceeded) await syncLocalTargetBranchWhenCurrent(context.targetBranch, rt)
	}
}

function shipMayRunCleanup(state: ChangeState): boolean {
	return state === 'ready' || state === 'awaiting-review' || state === 'landed' || state === 'done'
}

function assertPrCloseOutBranchTopology(context: ShipContext, rt: ShipRuntime): void {
	if (!rt.pr || context.state === 'done' || context.state === 'aborted') return
	if (context.change.changeBranch !== context.targetBranch) return
	throw new Error(
		`Cannot ship Change ${context.change.id} with ship.pr: true: Change branch '${context.change.changeBranch}' equals Target branch '${context.targetBranch}', so a Close-out PR cannot be opened. Set ship.pr: false or repair branch metadata.`,
	)
}

async function shipByState(context: ShipContext, rt: ShipRuntime): Promise<void> {
	switch (context.state) {
		case 'open':
			throw notReadyError(context.change.id, nonDoneSlices(context.slices))
		case 'ready':
			await cleanupAfterShip(
				context.change,
				context.targetBranch,
				rt,
				await shipReadyChange(context.change, context.targetBranch, rt),
			)
			return
		case 'awaiting-review':
			await cleanupAfterShip(
				context.change,
				context.targetBranch,
				rt,
				await shipAwaitingReviewChange(context.change, context.targetBranch, rt),
			)
			return
		case 'needs-revision':
			throw new Error(`Change ${context.change.id} Close-out PR needs revision. Run: trowel change work ${context.change.id}`)
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
	const change = await loadChange(changeId, rt)
	const slices = await classifySlicesForChange({ storage: rt.storage, gh: rt.gh, changeId, pr: rt.pr, needsRevisionLabel: rt.needsRevisionLabel })
	return {
		change,
		slices,
		state: await classifyChange(change, slices, { gh: rt.gh, git: rt.git, needsRevisionLabel: rt.needsRevisionLabel }),
		targetBranch: change.targetBranch,
	}
}

function nonDoneSlices(slices: ClassifiedSlice[]): ClassifiedSlice[] {
	return slices.filter((slice) => slice.state !== 'done')
}

async function shipReadyChange(change: Change, targetBranch: string, rt: ShipRuntime): Promise<boolean> {
	return rt.pr ? shipViaPr(change, targetBranch, rt) : shipViaMerge(change, targetBranch, rt)
}

async function shipAwaitingReviewChange(change: Change, targetBranch: string, rt: ShipRuntime): Promise<boolean> {
	return rt.pr ? shipViaPr(change, targetBranch, rt) : shipViaMerge(change, targetBranch, rt)
}

async function finalizeLandedChange(change: Change, rt: ShipRuntime): Promise<void> {
	await rt.storage.finalizeChange(change.id)
	rt.stdout(`Change ${change.id} has landed; finalized before cleanup.\n`)
}

async function requireCleanTree(rt: ShipRuntime): Promise<void> {
	if (!(await rt.git.isWorkingTreeClean())) throw new Error('working tree is dirty; commit or stash before shipping')
}

async function loadChange(changeId: string, rt: ShipRuntime): Promise<NonNullable<Awaited<ReturnType<Storage['findChange']>>>> {
	const change = await rt.storage.findChange(changeId)
	if (!change) throw new Error(`Change '${changeId}' not found`)
	return change
}

function notReadyError(changeId: string, blockers: ClassifiedSlice[]): Error {
	const sliceLines = blockers.length > 0 ? blockers.map((s) => `  ${s.id}  ${s.state}  ${s.title}`).join('\n') : '  (none)'
	return new Error(
		`Change ${changeId} is open and not ready to ship.\n\nNon-done slices:\n${sliceLines}\n\nRun: trowel change work ${changeId}`,
	)
}

function abortedChangeError(changeId: string): Error {
	return new Error(
		`Change ${changeId} is aborted and cannot be shipped. Run: trowel change abort ${changeId} to clean up abandoned work.`,
	)
}

async function shipViaMerge(change: Change, targetBranch: string, rt: ShipRuntime): Promise<boolean> {
	await runCloseOut(
		{ kind: 'change', id: change.id, changeBranch: change.changeBranch, targetBranch, title: change.title },
		{
			storage: rt.storage,
			git: rt.git,
			gh: rt.gh,
			log: rt.stdout,
			projectRoot: rt.projectRoot,
			confirmMergeConflict: rt.interactive ? (summary) => confirmShipConflict(summary, rt) : undefined,
			config: { pr: false, deleteBranch: 'never', mergeNoVerify: rt.mergeNoVerify },
		},
	)
	return true
}

async function confirmShipConflict(summary: MergeConflictSummary, rt: ShipRuntime): Promise<boolean> {
	return rt.confirm(`Merge conflict preflight predicted conflicts.\n${formatMergeConflictDetails(summary)}\n\nAttempt merge anyway? [y/N]`)
}

async function shipViaPr(change: Change, targetBranch: string, rt: ShipRuntime): Promise<boolean> {
	await ensureRemoteChangeBranch(change.changeBranch, rt)
	await runCloseOut(
		{ kind: 'change', id: change.id, changeBranch: change.changeBranch, targetBranch, title: change.title },
		{
			storage: rt.storage,
			git: rt.git,
			gh: rt.gh,
			log: rt.stdout,
			config: { pr: true, deleteBranch: 'never', mergeNoVerify: rt.mergeNoVerify },
		},
	)
	const existing = await rt.gh.findAnyPrByHead(change.changeBranch)
	if (existing?.state === 'OPEN' && existing.isDraft) {
		rt.stdout(`[ship change-${change.id}] Close-out PR #${existing.number} is draft; make it ready or close it before retrying\n`)
		return false
	}
	const prNumber = existing?.state === 'OPEN' ? existing.number : await rt.gh.findPrNumberByHead(change.changeBranch)
	if (!rt.interactive) return false
	const mergeability = await waitForMergeablePr(prNumber, rt)
	if (!mergeability.mergeable) {
		rt.stdout(`[ship change-${change.id}] Close-out PR #${prNumber} is not mergeable: ${mergeability.reason}\n`)
		return false
	}
	if (!(await optionalConfirm(rt, `Merge Close-out PR #${prNumber} for Change ${change.id} "${change.title}"? [y/N]`))) return false
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

async function offerSlicePrMergesBeforeCloseOut(context: ShipContext, rt: ShipRuntime): Promise<ShipContext> {
	if (!rt.pr || !rt.interactive || context.state === 'aborted' || context.state === 'done' || context.state === 'landed') return context
	const draftPrs = context.slices.filter((slice) => slice.prState === 'draft' && slice.sliceBranch !== null)
	for (const slice of draftPrs) await reportDraftSlicePr(context.change, slice, rt)
	const candidates = context.slices.filter((slice) => slice.state === 'awaiting-review' && slice.prState === 'ready' && slice.sliceBranch !== null)
	if (candidates.length === 0) return context
	for (const slice of candidates) await offerSlicePrMerge(context.change, slice, rt)
	return loadShipContext(context.change.id, rt)
}

async function reportDraftSlicePr(change: Change, slice: ClassifiedSlice, rt: ShipRuntime): Promise<void> {
	const branch = slice.sliceBranch
	if (branch === null) return
	const prNumber = await rt.gh.findPrNumberByHead(branch)
	rt.stdout(`[ship change-${change.id} slice-${slice.id}] Slice PR #${prNumber} is draft; make it ready or close it before retrying\n`)
}

async function offerSlicePrMerge(change: Change, slice: ClassifiedSlice, rt: ShipRuntime): Promise<void> {
	const branch = slice.sliceBranch
	if (branch === null) return
	const tag = `[ship change-${change.id} slice-${slice.id}]`
	const prNumber = await rt.gh.findPrNumberByHead(branch)
	const mergeability = await waitForMergeablePr(prNumber, rt)
	if (!mergeability.mergeable) {
		rt.stdout(`${tag} PR #${prNumber} is not mergeable: ${mergeability.reason}\n`)
		return
	}
	if (!(await optionalConfirm(rt, `Merge Slice PR #${prNumber} for Slice ${slice.id} "${slice.title}"? [y/N]`))) return
	await rt.gh.mergePr(prNumber, rt.mergeMethod)
	rt.stdout(`${tag} merged PR #${prNumber}\n`)
	await finalizeSliceAfterObservedMerge(change.id, slice, prNumber, rt)
}

async function finalizeSliceAfterObservedMerge(changeId: string, slice: ClassifiedSlice, prNumber: number, rt: ShipRuntime): Promise<void> {
	const tag = `[ship change-${changeId} slice-${slice.id}]`
	const observed = await waitForSliceMergedState(changeId, slice.id, rt)
	if (observed?.state === 'done') return
	if (observed?.state === 'landed') {
		await rt.storage.finalizeSlice(changeId, slice.id)
		rt.stdout(`${tag} finalized landed slice\n`)
		return
	}
	rt.stdout(`${tag} merged PR #${prNumber} but Slice was not observed landed after ${rt.mergeabilityPollSeconds}s; leaving unfinalized\n`)
}

async function waitForSliceMergedState(changeId: string, sliceId: string, rt: ShipRuntime): Promise<ClassifiedSlice | null> {
	const deadline = Date.now() + rt.mergeabilityPollSeconds * 1000
	while (true) {
		const slice = (await classifySlicesForChange({ storage: rt.storage, gh: rt.gh, changeId, pr: rt.pr, needsRevisionLabel: rt.needsRevisionLabel })).find((s) => s.id === sliceId) ?? null
		if (slice?.state === 'landed' || slice?.state === 'done') return slice
		const remaining = deadline - Date.now()
		if (remaining <= 0) return slice
		await rt.sleep(Math.min(1000, remaining))
	}
}

type PrMergeability = { mergeable: true } | { mergeable: false; reason: string }
type PrMergeabilityCheck = PrMergeability & { retryableUnknown?: boolean }

async function waitForMergeablePr(prNumber: number, rt: ShipRuntime): Promise<PrMergeability> {
	const deadline = Date.now() + rt.mergeabilityPollSeconds * 1000
	while (true) {
		const check = describePrMergeability(await rt.gh.viewPrMergeability(prNumber), rt.mergeabilityPollSeconds)
		if (check.mergeable || !check.retryableUnknown) return check
		const remaining = deadline - Date.now()
		if (remaining <= 0) return { mergeable: false, reason: `mergeability unknown after ${rt.mergeabilityPollSeconds}s` }
		await rt.sleep(Math.min(1000, remaining))
	}
}

function describePrMergeability(facts: PrMergeabilityFacts, pollSeconds: number): PrMergeabilityCheck {
	if (facts.state !== 'OPEN') return { mergeable: false, reason: `PR is ${facts.state.toLowerCase()}` }
	if (facts.isDraft) return { mergeable: false, reason: 'draft' }
	const mergeable = facts.mergeable ?? 'UNKNOWN'
	const status = facts.mergeStateStatus ?? 'UNKNOWN'
	if (mergeable === 'MERGEABLE' && status === 'CLEAN') return { mergeable: true }
	if (mergeable === 'UNKNOWN' || status === 'UNKNOWN')
		return { mergeable: false, reason: `mergeability unknown after ${pollSeconds}s`, retryableUnknown: true }
	if (mergeable === 'CONFLICTING' || status === 'DIRTY') return { mergeable: false, reason: 'conflicts' }
	if (status === 'DRAFT') return { mergeable: false, reason: 'draft' }
	if (status === 'BLOCKED') return { mergeable: false, reason: 'blocked by branch protection or required review' }
	if (status === 'BEHIND') return { mergeable: false, reason: 'branch is behind' }
	if (status === 'UNSTABLE') return { mergeable: false, reason: 'required checks pending or failing' }
	return { mergeable: false, reason: `GitHub reported ${status !== 'CLEAN' ? status : mergeable}` }
}

async function cleanupAfterShip(change: Change, targetBranch: string, rt: ShipRuntime, branchCleanupAllowed: boolean): Promise<void> {
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

async function syncLocalTargetBranchWhenCurrent(targetBranch: string, rt: ShipRuntime): Promise<void> {
	try {
		if ((await rt.git.currentBranch()) !== targetBranch) return
		await rt.git.fetch(targetBranch)
		await rt.git.fastForward(`origin/${targetBranch}`)
	} catch (error) {
		rt.stdout(`Warning: could not fast-forward local Target branch '${targetBranch}': ${(error as Error).message}\n`)
	}
}

async function ensureRemoteChangeBranch(branch: string, rt: ShipRuntime): Promise<void> {
	await rt.git.fetch(branch).catch(() => undefined)
	if (!(await rt.git.remoteBranchExists(branch))) {
		await requiredConfirm(rt, `Remote Change branch origin/${branch} does not exist. Publish Change branch before shipping? [Y/n]`)
		await rt.git.pushSetUpstream(branch)
		return
	}
	const ahead = await rt.git.commitsAhead(branch, `origin/${branch}`)
	if (ahead <= 0) return
	await requiredConfirm(rt, `Change branch has ${ahead} local commit(s) not on origin/${branch}. Push before shipping? [Y/n]`)
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
	return async (branch) =>
		(await base.gh.listOpenPrs({ base: branch })).map((pr) => ({ number: pr.number, url: pr.url ?? `#${pr.number}` }))
}

async function buildShipRuntime(opts: { storage?: string }): Promise<{ base: CommandBase; rt: ShipRuntime }> {
	const base = await loadCommandBase('change ship')
	const storage = buildStorage(base, opts.storage ?? base.config.storage)
	const { confirm } = await import('@inquirer/prompts')
	return {
		base,
		rt: {
			projectRoot: base.projectRoot,
			storage,
			git: base.git,
			gh: base.gh,
			pr: base.config.ship.pr,
			mergeNoVerify: base.config.work.mergeNoVerify,
			mergeMethod: base.config.ship.mergeMethod,
			mergeabilityPollSeconds: base.config.ship.mergeabilityPollSeconds,
			deleteBranchPolicy: base.config.ship.deleteBranch,
			needsRevisionLabel: base.config.labels.needsRevision,
			interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
			confirm: (message) => confirm({ message, default: confirmDefault(message) }),
			stdout: (s) => process.stdout.write(s),
			listOpenPrs: listOpenPrsFor(base),
			sleep,
		},
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms))
}

function confirmDefault(message: string): boolean {
	return message.includes('[Y/n]')
}

export async function shipChange(changeId: string, opts: { storage?: string }): Promise<void> {
	const { base, rt } = await buildShipRuntime(opts)
	await exitOnCommandError('change ship', () => withMutationLock(base.projectRoot, () => runShip(changeId, rt)))
}

if (import.meta.vitest) {
	const { describe, test, expect } = import.meta.vitest
	const { recordingGhOps } = await import('../../test-utils/gh-ops-recorder.ts')
	const { noopGitOps } = await import('../../test-utils/git-ops-fixtures.ts')
	const { fakeClassifiedSlice, fakeSliceStorage } = await import('../../test-utils/storage-fixtures.ts')

	function fakeChange(id: string, overrides: Partial<Change> = {}): Change {
		return {
			id,
			title: 'X',
			body: '',
			createdAt: '2026-01-01T00:00:00.000Z',
			closedAt: null,
			targetBranch: 'main',
			changeBranch: 'change-3-x',
			...overrides,
		}
	}

	function makeRt(args: Partial<ShipRuntime> & { storage?: Storage } = {}): {
		rt: ShipRuntime
		gitCalls: string[]
		ghCalls: unknown[][]
		out: string[]
		closed: string[]
	} {
		const gitCalls: string[] = []
		const out: string[] = []
		const closed: string[] = []
		let changeClosed = false
		const storage =
			args.storage ??
			fakeSliceStorage(
				[
					fakeClassifiedSlice({
						id: 's1',
						title: 'Done',
						state: 'done',
						closedAt: '2026-06-04T00:00:00.000Z',
						readyForAgent: true,
					}),
				],
				'3',
				{
					findChange: async (id) => fakeChange(id, { closedAt: changeClosed ? '2026-06-04T00:00:00.000Z' : null }),
					finalizeChange: async (id) => {
						closed.push(id)
						changeClosed = true
					},
				},
			)
		const git = noopGitOps({
			currentBranch: async () => 'back',
			baseBranch: async () => 'main',
			checkout: async (b) => {
				gitCalls.push(`checkout(${b})`)
			},
			mergeNoFf: async (b) => {
				gitCalls.push(`mergeNoFf(${b})`)
			},
			mergeNoFfIn: async (p, b) => {
				gitCalls.push(`mergeNoFfIn(${p},${b})`)
			},
			mergeAbort: async () => {
				gitCalls.push('mergeAbort')
			},
			push: async (b) => {
				gitCalls.push(`push(${b})`)
			},
			pushHeadTo: async (p, b) => {
				gitCalls.push(`pushHeadTo(${p},${b})`)
			},
			updateLocalBranchRef: async (b, ref) => {
				gitCalls.push(`updateLocalBranchRef(${b},${ref})`)
			},
			pushSetUpstream: async (b) => {
				gitCalls.push(`pushSetUpstream(${b})`)
			},
			fetch: async (b) => {
				gitCalls.push(`fetch(${b})`)
			},
			deleteBranch: async (b) => {
				gitCalls.push(`deleteBranch(${b})`)
			},
			worktreeAdd: async (p, b) => {
				gitCalls.push(`worktreeAdd(${p},${b})`)
			},
			branchExists: async () => true,
			listLocalBranches: async () => ['change-3-x'],
			remoteBranchExists: async () => true,
			commitsAhead: async (branch) => (branch.startsWith('origin/') ? 1 : 0),
		})
		const { gh, calls } = recordingGhOps({ findPrNumberByHead: async () => 9, findAnyPrByHead: async () => null })
		return {
			rt: {
				projectRoot: '/tmp/trowel-ship-test-project',
				storage,
				git,
				gh,
				pr: false,
				mergeNoVerify: false,
				mergeMethod: 'merge',
				mergeabilityPollSeconds: 0,
				deleteBranchPolicy: 'never',
				interactive: true,
				confirm: async () => true,
				stdout: (s) => out.push(s),
				listOpenPrs: async () => [],
				sleep: async () => {},
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

		test('done Change exits successfully through cleanup', async () => {
			const storage = fakeSliceStorage([fakeClassifiedSlice({ state: 'done', closedAt: '2026-06-04T00:00:00.000Z' })], '3', {
				findChange: async (id) => fakeChange(id, { closedAt: '2026-06-04T00:00:00.000Z' }),
			})
			const { rt, out } = makeRt({
				storage,
				gh: recordingGhOps({ findAnyPrByHead: async () => ({ number: 9, state: 'MERGED' }) }).gh,
			})
			await runShip('3', rt)
			expect(out.join('')).toContain('already done')
		})

		test('PR mode fails loudly when the Change branch equals the Target branch', async () => {
			const storage = fakeSliceStorage([fakeClassifiedSlice({ state: 'done', closedAt: '2026-06-04T00:00:00.000Z' })], '3', {
				findChange: async (id) => fakeChange(id, { changeBranch: 'main', targetBranch: 'main' }),
			})
			const { rt, ghCalls } = makeRt({
				storage,
				pr: true,
				git: noopGitOps({
					currentBranch: async () => 'main',
					isWorkingTreeClean: async () => true,
					listLocalBranches: async () => ['main'],
					remoteBranchExists: async () => true,
					commitsAhead: async () => 0,
				}),
			})

			await expect(runShip('3', rt)).rejects.toThrow(/ship\.pr: true.*Change branch 'main' equals Target branch 'main'/)
			expect(ghCalls.map((call) => call[0])).not.toContain('createPr')
		})

		test('open Changes fail with non-done slice details and no cleanup', async () => {
			const storage = fakeSliceStorage(
				[fakeClassifiedSlice({ id: 's2', title: 'Needs work', state: 'open', readyForAgent: true })],
				'3',
				{
					findChange: async (id) => fakeChange(id),
				},
			)
			const { rt, gitCalls, closed } = makeRt({ storage, deleteBranchPolicy: 'always' })
			await expect(runShip('3', rt)).rejects.toThrow(/s2 {2}open {2}Needs work/)
			expect(closed).toEqual([])
			expect(gitCalls.find((c) => c.startsWith('deleteBranch'))).toBeUndefined()
		})

		test('aborted Changes refuse ship and point to abort cleanup', async () => {
			const storage = fakeSliceStorage(
				[fakeClassifiedSlice({ id: 's1', state: 'done', closedAt: '2026-06-04T00:00:00.000Z' })],
				'3',
				{
					findChange: async (id) => fakeChange(id, { closedAt: '2026-06-04T00:00:00.000Z' }),
				},
			)
			const { rt, gitCalls } = makeRt({ storage, deleteBranchPolicy: 'always' })
			await expect(runShip('3', rt)).rejects.toThrow(/trowel change abort 3/)
			expect(gitCalls.find((c) => c.startsWith('deleteBranch'))).toBeUndefined()
		})

		test('refuses before prompting when the current branch is a Cleanup candidate under ship prompt policy', async () => {
			let current = 'change-3-x'
			let confirmCalls = 0
			const { rt, ghCalls } = makeRt({
				pr: true,
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
					commitsAhead: async (branch) => (branch.startsWith('origin/') ? 1 : 0),
					checkout: async (branch) => {
						current = branch
					},
				}),
			})

			await expect(runShip('3', rt)).rejects.toThrow(/Switch branches first/)
			expect(confirmCalls).toBe(0)
			expect(ghCalls.map((call) => call[0])).not.toContain('createPr')
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
					checkout: async (branch) => {
						current = branch
					},
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
				pr: true,
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
					commitsAhead: async (branch) => (branch.startsWith('origin/') ? 1 : 0),
					checkout: async (branch) => {
						current = branch
					},
					worktreeList: async () => [],
				}),
			})

			await runShip('3', rt)

			expect(confirmCalls).toBe(1)
			expect(ghCalls.map((call) => call[0])).toContain('createPr')
			expect(current).toBe('change-3-x')
		})

		test('non-PR mode merges ready Changes, closes, preserves the main checkout, and applies local delete policy', async () => {
			const { rt, gitCalls, closed } = makeRt({ deleteBranchPolicy: 'always' })
			await runShip('3', rt)
			expect(gitCalls).toContain('mergeNoFfIn(/tmp/trowel-ship-test-project/.trowel/worktrees/changes/3/__merge-change,change-3-x)')
			expect(gitCalls).toContain('pushHeadTo(/tmp/trowel-ship-test-project/.trowel/worktrees/changes/3/__merge-change,main)')
			expect(gitCalls.find((call) => call.startsWith('checkout'))).toBeUndefined()
			expect(closed).toEqual(['3'])
			expect(gitCalls).toContain('deleteBranch(change-3-x)')
		})

		test('PR mode missing remote publishes before opening PR', async () => {
			const { rt, gitCalls, ghCalls } = makeRt({
				pr: true,
				git: noopGitOps({
					currentBranch: async () => 'back',
					isWorkingTreeClean: async () => true,
					remoteBranchExists: async () => false,
					pushSetUpstream: async (b) => {
						gitCalls.push(`pushSetUpstream(${b})`)
					},
					fetch: async (b) => {
						gitCalls.push(`fetch(${b})`)
					},
					branchExists: async () => true,
				}),
			})
			await runShip('3', rt)
			expect(gitCalls).toContain('pushSetUpstream(change-3-x)')
			expect(ghCalls.map((c) => c[0])).toContain('createPr')
		})

		test('PR mode optional merge uses configured method', async () => {
			const { rt, ghCalls } = makeRt({
				pr: true,
				mergeMethod: 'squash',
				confirm: async (msg) => msg.startsWith('Merge Close-out PR'),
			})
			await runShip('3', rt)
			expect(ghCalls).toContainEqual(['mergePr', 9, 'squash'])
		})

		test('PR mode skips Close-out merge prompt when GitHub says PR is not mergeable', async () => {
			let confirmCalls = 0
			const { gh, calls } = recordingGhOps({
				findPrNumberByHead: async () => 9,
				findAnyPrByHead: async () => null,
				viewPrMergeability: async () => ({ state: 'OPEN', isDraft: false, mergeable: 'MERGEABLE', mergeStateStatus: 'BLOCKED' }),
			})
			const { rt, out } = makeRt({
				gh,
				pr: true,
				confirm: async () => {
					confirmCalls += 1
					return true
				},
			})

			await runShip('3', rt)

			expect(confirmCalls).toBe(0)
			expect(calls.map((c) => c[0])).not.toContain('mergePr')
			expect(out.join('')).toContain('Close-out PR #9 is not mergeable: blocked by branch protection or required review')
		})

		test('PR mode polls unknown Close-out mergeability before prompting', async () => {
			let mergeabilityCalls = 0
			const sleeps: number[] = []
			const { gh, calls } = recordingGhOps({
				findPrNumberByHead: async () => 9,
				findAnyPrByHead: async () => null,
				viewPrMergeability: async () => {
					mergeabilityCalls += 1
					return mergeabilityCalls === 1
						? { state: 'OPEN', isDraft: false, mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' }
						: { state: 'OPEN', isDraft: false, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' }
				},
			})
			const { rt } = makeRt({
				gh,
				pr: true,
				mergeabilityPollSeconds: 30,
				sleep: async (ms) => {
					sleeps.push(ms)
				},
				confirm: async (msg) => msg.startsWith('Merge Close-out PR'),
			})

			await runShip('3', rt)

			expect(sleeps).toEqual([1000])
			expect(calls).toContainEqual(['mergePr', 9, 'merge'])
		})

		test('PR mode prompts for mergeable Slice PRs, reclassifies, finalizes, then rechecks Change readiness', async () => {
			const slice = fakeClassifiedSlice({ id: 's1', title: 'Parser', sliceBranch: 'change-3/slice-s1-parser', closedAt: null })
			let slicePrMerged = false
			const finalized: string[] = []
			const storage = fakeSliceStorage([slice], '3', {
				findChange: async (id) => fakeChange(id),
				finalizeSlice: async (_changeId, sliceId) => {
					finalized.push(sliceId)
					slice.closedAt = '2026-06-09T00:00:00.000Z'
				},
			})
			const { gh, calls } = recordingGhOps({
				listOpenPrs: async () =>
					slicePrMerged
						? []
						: [{ number: 12, headRefName: 'change-3/slice-s1-parser', isDraft: false, reviewDecision: 'APPROVED' }],
				findPrNumberByHead: async (head) => (head === 'change-3/slice-s1-parser' ? 12 : 9),
				findAnyPrByHead: async (head) => (head === 'change-3/slice-s1-parser' && slicePrMerged ? { number: 12, state: 'MERGED' } : null),
				mergePr: async (prNumber) => {
					if (prNumber === 12) slicePrMerged = true
				},
			})
			const { rt, out } = makeRt({
				storage,
				gh,
				pr: true,
				confirm: async (msg) => msg.startsWith('Merge Slice PR'),
			})

			await runShip('3', rt)

			expect(calls).toContainEqual(['mergePr', 12, 'merge'])
			expect(calls).not.toContainEqual(['mergePr', 9, 'merge'])
			expect(finalized).toEqual(['s1'])
			expect(out.join('')).toContain('[ship change-3 slice-s1] finalized landed slice')
		})

		test('declining one Slice PR continues offering later mergeable Slice PRs, then reports remaining non-done slices', async () => {
			const first = fakeClassifiedSlice({ id: 's1', title: 'Parser', sliceBranch: 'change-3/slice-s1-parser', closedAt: null })
			const second = fakeClassifiedSlice({ id: 's2', title: 'Renderer', sliceBranch: 'change-3/slice-s2-renderer', closedAt: null })
			let secondMerged = false
			const finalized: string[] = []
			const storage = fakeSliceStorage([first, second], '3', {
				findChange: async (id) => fakeChange(id),
				finalizeSlice: async (_changeId, sliceId) => {
					finalized.push(sliceId)
					if (sliceId === 's2') second.closedAt = '2026-06-09T00:00:00.000Z'
				},
			})
			const { gh, calls } = recordingGhOps({
				listOpenPrs: async () => [
					{ number: 11, headRefName: 'change-3/slice-s1-parser', isDraft: false },
					...(secondMerged ? [] : [{ number: 12, headRefName: 'change-3/slice-s2-renderer', isDraft: false }]),
				],
				findPrNumberByHead: async (head) => (head === 'change-3/slice-s1-parser' ? 11 : 12),
				findAnyPrByHead: async (head) => (head === 'change-3/slice-s2-renderer' && secondMerged ? { number: 12, state: 'MERGED' } : null),
				mergePr: async (prNumber) => {
					if (prNumber === 12) secondMerged = true
				},
			})
			const { rt } = makeRt({
				storage,
				gh,
				pr: true,
				confirm: async (msg) => msg.includes('Slice s2'),
			})

			await expect(runShip('3', rt)).rejects.toThrow(/s1 {2}awaiting-review {2}Parser/)

			expect(calls).toContainEqual(['mergePr', 12, 'merge'])
			expect(calls).not.toContainEqual(['mergePr', 11, 'merge'])
			expect(finalized).toEqual(['s2'])
		})

		test('non-interactive PR mode does not merge Slice PRs automatically', async () => {
			const slice = fakeClassifiedSlice({ id: 's1', title: 'Parser', sliceBranch: 'change-3/slice-s1-parser', closedAt: null })
			const storage = fakeSliceStorage([slice], '3', { findChange: async (id) => fakeChange(id) })
			const { gh, calls } = recordingGhOps({
				listOpenPrs: async () => [{ number: 12, headRefName: 'change-3/slice-s1-parser', isDraft: false }],
				findPrNumberByHead: async () => 12,
			})
			const { rt } = makeRt({ storage, gh, pr: true, interactive: false })

			await expect(runShip('3', rt)).rejects.toThrow(/s1 {2}awaiting-review {2}Parser/)

			expect(calls.map((c) => c[0])).not.toContain('mergePr')
			expect(calls.map((c) => c[0])).not.toContain('findPrNumberByHead')
		})

		test('PR mode reports draft Close-out PR guidance instead of merging', async () => {
			const { gh } = recordingGhOps({
				findAnyPrByHead: async () => ({ number: 9, state: 'OPEN', isDraft: true }),
				findPrNumberByHead: async () => 9,
			})
			const { rt, out } = makeRt({ gh, pr: true })

			await runShip('3', rt)

			expect(out.join('')).toContain('Close-out PR #9 is draft; make it ready or close it before retrying')
		})

		test('PR mode reports draft Slice PR guidance before refusing an open Change', async () => {
			const slice = fakeClassifiedSlice({ id: 's1', title: 'Parser', sliceBranch: 'change-3/slice-s1-parser', implementedAt: '2026-06-04T00:00:00.000Z', prState: 'draft', closedAt: null })
			const storage = fakeSliceStorage([slice], '3', { findChange: async (id) => fakeChange(id) })
			const { gh } = recordingGhOps({
				listOpenPrs: async () => [{ number: 12, headRefName: 'change-3/slice-s1-parser', isDraft: true }],
				findPrNumberByHead: async () => 12,
			})
			const { rt, out } = makeRt({ storage, gh, pr: true })

			await expect(runShip('3', rt)).rejects.toThrow(/s1/)

			expect(out.join('')).toContain('Slice PR #12 is draft; make it ready or close it before retrying')
		})

		test('PR mode awaiting-review Change uses the existing Close-out PR and keeps branches when not done', async () => {
			const { gh, calls } = recordingGhOps({
				findAnyPrByHead: async () => ({ number: 9, state: 'OPEN' }),
				findPrNumberByHead: async () => 9,
			})
			const { rt, gitCalls } = makeRt({
				gh,
				pr: true,
				deleteBranchPolicy: 'always',
				confirm: async (msg) => !msg.startsWith('Merge Close-out PR'),
			})

			await runShip('3', rt)

			expect(calls.map((c) => c[0])).not.toContain('createPr')
			expect(calls.map((c) => c[0])).not.toContain('createPr')
			expect(calls.map((c) => c[0])).not.toContain('mergePr')
			expect(gitCalls.find((c) => c.startsWith('deleteBranch'))).toBeUndefined()
		})

		test('needs-revision Change blocks with Work guidance before Cleanup', async () => {
			const { gh, calls } = recordingGhOps({
				findAnyPrByHead: async () => ({ number: 9, state: 'OPEN', labels: [{ name: 'needs-revision' }] }),
				findPrNumberByHead: async () => 9,
			})
			const { rt, gitCalls } = makeRt({ gh, pr: true, deleteBranchPolicy: 'always' })

			await expect(runShip('3', rt)).rejects.toThrow(/needs revision.*trowel change work 3/)

			expect(calls.map((c) => c[0])).not.toContain('mergePr')
			expect(gitCalls.find((c) => c.startsWith('deleteBranch'))).toBeUndefined()
		})

		test('merge mode awaiting-review Change uses host-merge behavior instead of the existing Close-out PR', async () => {
			const { gh, calls } = recordingGhOps({
				findAnyPrByHead: async () => ({ number: 9, state: 'OPEN' }),
				findPrNumberByHead: async () => 9,
			})
			const { rt, gitCalls, closed } = makeRt({ gh, pr: false, deleteBranchPolicy: 'always' })

			await runShip('3', rt)

			expect(calls.map((c) => c[0])).not.toContain('createPr')
			expect(calls.map((c) => c[0])).not.toContain('mergePr')
			expect(gitCalls).toContain('mergeNoFfIn(/tmp/trowel-ship-test-project/.trowel/worktrees/changes/3/__merge-change,change-3-x)')
			expect(closed).toEqual(['3'])
			expect(gitCalls).toContain('deleteBranch(change-3-x)')
		})

		test('awaiting-review Change performs full cleanup only after the Close-out PR makes it done', async () => {
			let merged = false
			const { gh, calls } = recordingGhOps({
				findAnyPrByHead: async () => ({ number: 9, state: merged ? 'MERGED' : 'OPEN' }),
				findPrNumberByHead: async () => 9,
				mergePr: async () => {
					merged = true
				},
			})
			const { rt, gitCalls, closed } = makeRt({ gh, pr: true, deleteBranchPolicy: 'always' })

			await runShip('3', rt)

			expect(calls).toContainEqual(['mergePr', 9, 'merge'])
			expect(closed).toEqual(['3'])
			expect(gitCalls).toContain('deleteBranch(change-3-x)')
		})

		test('syncs the local Target branch after a successful Ship when restored onto the Target branch', async () => {
			const gitCalls: string[] = []
			const git = noopGitOps({
				currentBranch: async () => 'main',
				isWorkingTreeClean: async () => true,
				listLocalBranches: async () => ['main', 'change-3-x'],
				remoteBranchExists: async () => true,
				localBranchExists: async () => false,
				fetch: async (branch) => {
					gitCalls.push(`fetch(${branch})`)
				},
				commitsAhead: async (branch) => (branch.startsWith('origin/') ? 1 : 0),
				resolveRef: async (ref, worktreePath) => {
					gitCalls.push(`resolveRef(${ref},${worktreePath ?? ''})`)
					return ref === 'HEAD' ? 'pushed-head' : ref
				},
				worktreeAdd: async (path, branch) => {
					gitCalls.push(`worktreeAdd(${path},${branch})`)
				},
				mergeNoFfIn: async (path, branch) => {
					gitCalls.push(`mergeNoFfIn(${path},${branch})`)
				},
				pushHeadTo: async (path, branch) => {
					gitCalls.push(`pushHeadTo(${path},${branch})`)
				},
				updateLocalBranchRef: async (branch, ref) => {
					gitCalls.push(`updateLocalBranchRef(${branch},${ref})`)
				},
				deleteBranch: async (branch) => {
					gitCalls.push(`deleteBranch(${branch})`)
				},
				fastForward: async (ref) => {
					gitCalls.push(`fastForward(${ref})`)
				},
			})
			const { rt, closed } = makeRt({ git, deleteBranchPolicy: 'always' })

			await runShip('3', rt)

			expect(closed).toEqual(['3'])
			expect(gitCalls).toContain('fetch(main)')
			expect(gitCalls).toContain('fastForward(origin/main)')
		})

		test('already done Change still best-effort syncs the local Target branch after cleanup', async () => {
			const gitCalls: string[] = []
			const storage = fakeSliceStorage([fakeClassifiedSlice({ state: 'done', closedAt: '2026-06-04T00:00:00.000Z' })], '3', {
				findChange: async (id) => fakeChange(id, { closedAt: '2026-06-04T00:00:00.000Z' }),
			})
			const { rt } = makeRt({
				storage,
				gh: recordingGhOps({ findAnyPrByHead: async () => ({ number: 9, state: 'MERGED' }) }).gh,
				git: noopGitOps({
					currentBranch: async () => 'main',
					isWorkingTreeClean: async () => true,
					listLocalBranches: async () => ['main'],
					fetch: async (branch) => {
						gitCalls.push(`fetch(${branch})`)
					},
					fastForward: async (ref) => {
						gitCalls.push(`fastForward(${ref})`)
					},
				}),
			})

			await runShip('3', rt)

			expect(gitCalls).toEqual(['fetch(main)', 'fastForward(origin/main)'])
		})

		test('Target sync failures warn and do not fail Ship', async () => {
			const storage = fakeSliceStorage([fakeClassifiedSlice({ state: 'done', closedAt: '2026-06-04T00:00:00.000Z' })], '3', {
				findChange: async (id) => fakeChange(id, { closedAt: '2026-06-04T00:00:00.000Z' }),
			})
			const { rt, out } = makeRt({
				storage,
				gh: recordingGhOps({ findAnyPrByHead: async () => ({ number: 9, state: 'MERGED' }) }).gh,
				git: noopGitOps({
					currentBranch: async () => 'main',
					isWorkingTreeClean: async () => true,
					listLocalBranches: async () => ['main'],
					fetch: async () => {
						throw new Error('network down')
					},
				}),
			})

			await runShip('3', rt)

			expect(out.join('')).toContain("Warning: could not fast-forward local Target branch 'main': network down")
		})

		test('landed Change from merged Close-out PR is finalized before cleanup without running Close-out', async () => {
			const gitCalls: string[] = []
			const git = noopGitOps({
				currentBranch: async () => 'back',
				baseBranch: async () => 'main',
				checkout: async (b) => {
					gitCalls.push(`checkout(${b})`)
				},
				mergeNoFf: async (b) => {
					gitCalls.push(`mergeNoFf(${b})`)
				},
				deleteBranch: async (b) => {
					gitCalls.push(`deleteBranch(${b})`)
				},
				branchExists: async () => true,
				listLocalBranches: async () => ['change-3-x'],
				remoteBranchExists: async () => true,
				fetch: async (b) => {
					gitCalls.push(`fetch(${b})`)
				},
				commitsAhead: async () => 0,
			})
			const { gh, calls } = recordingGhOps({ findAnyPrByHead: async () => ({ number: 9, state: 'MERGED' }) })
			const { rt, closed, out } = makeRt({ git, gh, deleteBranchPolicy: 'always' })

			await runShip('3', rt)

			const stdout = out.join('')
			expect(closed).toEqual(['3'])
			expect(stdout).toContain('has landed; finalized before cleanup')
			expect(stdout).not.toContain('already done')
			expect(gitCalls).not.toContain('mergeNoFf(change-3-x)')
			expect(calls.map((c) => c[0])).not.toContain('createPr')
			expect(gitCalls).toContain('deleteBranch(change-3-x)')
		})
	})
}
