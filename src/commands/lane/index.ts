import { mkdir, rm } from 'node:fs/promises'
import path from 'node:path'

import type { Config } from '../../config'
import { getHarness } from '../../harnesses/registry.ts'
import { loadPrompt } from '../../prompts/load.ts'
import type { DeleteBranchPolicy } from '../../storages/types.ts'
import { createRepoGit, type GitOps } from '../../utils/git-ops.ts'
import { withMutationLock } from '../../utils/mutation-lock.ts'
import {
	allocateNextLaneId,
	computeLaneState,
	laneBranchName,
	laneMergeWorktreePath,
	laneWorktreePath,
	listLanes,
	markLaneClosed,
	pathExists,
	readLane,
	writeLane,
	type Lane,
	type LaneState,
} from '../../work/lanes.ts'
import { formatMergeConflictDetails, formatMergeConflictPreflightError, runMergeConflictPreflight, type MergeConflictSummary } from '../../work/merge-conflict-preflight.ts'
import { copyWorktreeEntries } from '../../work/worktrees.ts'
import { exitOnCommandError, loadCommandBase } from '../runtime.ts'

type LaneRuntime = {
	projectRoot: string
	invocationCwd: string
	repoGit: GitOps
	cwdGit: GitOps
	config: Config
	interactive: boolean
	confirm: (msg: string) => Promise<boolean>
	stdout: (s: string) => void
	now: () => Date
	runInteractive: (args: { cwd: string; promptText: string; initialPrompt?: string; harnessKind: string }) => Promise<void>
	copyToWorktree: (worktreePath: string) => Promise<void>
	assertHarnessInstalled: (harnessKind: string) => Promise<void>
}

type LaneStartOpts = { base?: string; harness?: string }
type LaneContinueOpts = { harness?: string }

type StartedLane = { lane: Lane; harnessKind: string }

async function runLaneStart(title: string, opts: LaneStartOpts, rt: LaneRuntime): Promise<void> {
	const trimmedTitle = title.trim()
	if (!trimmedTitle) throw new Error('lane title is required')
	const harnessKind = opts.harness ?? rt.config.agent.harness
	await rt.assertHarnessInstalled(harnessKind)
	const started = await withMutationLock(rt.projectRoot, () => createLane(trimmedTitle, opts.base ?? 'HEAD', harnessKind, rt))
	const promptText = await loadPrompt('lane')
	await rt.runInteractive({ cwd: started.lane.worktreePath, promptText, initialPrompt: trimmedTitle, harnessKind: started.harnessKind })
}

async function createLane(title: string, baseRef: string, harnessKind: string, rt: LaneRuntime): Promise<StartedLane> {
	const targetBranch = await laneTargetBranch(rt)
	await assertCleanInvocationWorktree(rt)
	await rt.cwdGit.resolveRef(baseRef)
	const lane = await newLaneRecord(title, baseRef, targetBranch, rt)
	await assertLaneBranchAvailable(lane.branch, rt)
	await assertLaneWorktreePathAvailable(lane.worktreePath)
	await rt.cwdGit.worktreeAddNewBranch(lane.worktreePath, lane.branch, baseRef)
	await rt.copyToWorktree(lane.worktreePath)
	await writeLane(rt.projectRoot, lane)
	printStartedLane(lane, rt)
	return { lane, harnessKind }
}

async function laneTargetBranch(rt: LaneRuntime): Promise<string> {
	const targetBranch = await rt.cwdGit.currentBranch()
	if (!targetBranch || targetBranch === 'HEAD') throw new Error('lane start requires a checked-out local target branch; currently detached')
	return targetBranch
}

async function assertCleanInvocationWorktree(rt: LaneRuntime): Promise<void> {
	if (!(await rt.cwdGit.isWorkingTreeClean())) throw new Error('working tree is dirty; commit or stash before starting a Lane')
}

async function newLaneRecord(title: string, baseRef: string, targetBranch: string, rt: LaneRuntime): Promise<Lane> {
	const id = await allocateNextLaneId(rt.projectRoot)
	const branch = laneBranchName(id, title)
	return {
		schemaVersion: 1,
		id,
		title,
		branch,
		targetBranch,
		baseRef,
		worktreePath: laneWorktreePath(rt.projectRoot, id),
		createdAt: rt.now().toISOString(),
		closedAt: null,
		mergedAt: null,
	}
}

async function assertLaneBranchAvailable(branch: string, rt: LaneRuntime): Promise<void> {
	if (await rt.repoGit.localBranchExists(branch)) throw new Error(`lane branch '${branch}' already exists`)
}

async function assertLaneWorktreePathAvailable(worktreePath: string): Promise<void> {
	if (await pathExists(worktreePath)) throw new Error(`lane worktree path '${worktreePath}' already exists; move it aside before retrying`)
}

function printStartedLane(lane: Lane, rt: LaneRuntime): void {
	rt.stdout(`Started Lane ${lane.id}\n`)
	rt.stdout(`Branch: ${lane.branch}\n`)
	rt.stdout(`Target: ${lane.targetBranch}\n`)
	rt.stdout(`Worktree: ${lane.worktreePath}\n\n`)
}

async function runLaneContinue(id: string, opts: LaneContinueOpts, rt: LaneRuntime): Promise<void> {
	const lane = await requireExistingLane(rt.projectRoot, id)
	if (lane.closedAt !== null) throw new Error(`Lane ${id} is closed`)
	const harnessKind = opts.harness ?? rt.config.agent.harness
	await rt.assertHarnessInstalled(harnessKind)
	await requireLocalBranch(lane.branch, rt.repoGit, `Lane ${id} branch '${lane.branch}' is missing`)
	await requireRegisteredWorktree(lane, rt.repoGit)
	const promptText = await loadPrompt('lane')
	await rt.runInteractive({ cwd: lane.worktreePath, promptText, harnessKind })
}

async function runLaneList(rt: LaneRuntime): Promise<void> {
	const lanes = await listLanes(rt.projectRoot)
	if (lanes.length === 0) {
		rt.stdout('No Lanes found.\n')
		return
	}
	const rows = await Promise.all(lanes.map(async (lane) => laneListRow(rt, lane, await computeLaneState(rt.projectRoot, lane, rt.repoGit))))
	printLaneRows(rt, rows)
}

type LaneListRow = { id: string; state: LaneState; title: string; branch: string; target: string; worktree: string }

function laneListRow(rt: LaneRuntime, lane: Lane, state: LaneState): LaneListRow {
	return {
		id: lane.id,
		state,
		title: truncate(lane.title, 28),
		branch: truncate(lane.branch, 34),
		target: lane.targetBranch,
		worktree: displayPath(rt.projectRoot, lane.worktreePath),
	}
}

function printLaneRows(rt: LaneRuntime, rows: LaneListRow[]): void {
	const all = [{ id: 'ID', state: 'STATE', title: 'TITLE', branch: 'BRANCH', target: 'TARGET', worktree: 'WORKTREE' }, ...rows]
	const widths = {
		id: maxWidth(all.map((r) => r.id)),
		state: maxWidth(all.map((r) => r.state)),
		title: maxWidth(all.map((r) => r.title)),
		branch: maxWidth(all.map((r) => r.branch)),
		target: maxWidth(all.map((r) => r.target)),
	}
	for (const row of all) rt.stdout(`${row.id.padEnd(widths.id)}  ${row.state.padEnd(widths.state)}  ${row.title.padEnd(widths.title)}  ${row.branch.padEnd(widths.branch)}  ${row.target.padEnd(widths.target)}  ${row.worktree}\n`)
}

function maxWidth(values: string[]): number {
	return Math.max(...values.map((v) => v.length))
}

function truncate(input: string, max: number): string {
	return input.length <= max ? input : `${input.slice(0, max - 1)}…`
}

function displayPath(projectRoot: string, p: string): string {
	const rel = path.relative(projectRoot, p)
	return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : p
}

async function runLaneClose(id: string, rt: LaneRuntime): Promise<void> {
	await withMutationLock(rt.projectRoot, () => closeLane(id, rt))
}

async function closeLane(id: string, rt: LaneRuntime): Promise<void> {
	const lane = await requireClosableLane(id, rt)
	const closePlan = await planLaneClose(lane, rt)
	await requireMergeConfirmation(lane, closePlan.conflict, rt)
	if (closePlan.mergePlan) await mergeLaneIntoTarget(lane, closePlan.mergePlan, rt)
	await finishLaneClose(lane, rt)
}

async function requireClosableLane(id: string, rt: LaneRuntime): Promise<Lane> {
	const lane = await requireExistingLane(rt.projectRoot, id)
	if (lane.closedAt !== null) throw new Error(`Lane ${id} is closed`)
	if (isInside(lane.worktreePath, rt.invocationCwd)) throw new Error(`Lane ${id} cleanup may remove the current worktree. Switch directories first, then retry.`)
	await requireLocalBranch(lane.branch, rt.repoGit, `Lane ${id} branch '${lane.branch}' is missing`)
	await requireLocalBranch(lane.targetBranch, rt.repoGit, `Lane ${id} target branch '${lane.targetBranch}' is missing`)
	return lane
}

type LaneClosePlan = { mergePlan: LaneMergePlan | null; conflict: MergeConflictSummary | null }

async function planLaneClose(lane: Lane, rt: LaneRuntime): Promise<LaneClosePlan> {
	const alreadyMerged = await rt.repoGit.isAncestor(lane.branch, lane.targetBranch)
	await assertLaneWorktreeCleanOrAlreadyMerged(lane, alreadyMerged, rt)
	const mergePlan = alreadyMerged ? null : await planLaneMerge(lane, rt)
	return { mergePlan, conflict: mergePlan ? await preflightLaneMerge(lane, mergePlan, rt) : null }
}

async function finishLaneClose(lane: Lane, rt: LaneRuntime): Promise<void> {
	await removeLaneWorktree(lane, rt)
	await maybeDeleteLaneBranch(lane, rt.config.ship.deleteBranch, rt)
	const closed = await markLaneClosed(rt.projectRoot, lane.id, rt.now().toISOString())
	rt.stdout(`Closed Lane ${closed.id}\n`)
	rt.stdout(`Merged ${closed.branch} into ${closed.targetBranch}.\n`)
	rt.stdout(`Worktree: ${closed.worktreePath}\n`)
}

async function requireExistingLane(projectRoot: string, id: string): Promise<Lane> {
	const lane = await readLane(projectRoot, id)
	if (!lane) throw new Error(`Lane '${id}' not found`)
	return lane
}

async function requireLocalBranch(branch: string, git: GitOps, message: string): Promise<void> {
	if (!(await git.localBranchExists(branch))) throw new Error(message)
}

async function requireRegisteredWorktree(lane: Lane, git: GitOps): Promise<void> {
	const registered = (await git.worktreeList()).find((w) => pathsEqual(w.path, lane.worktreePath))
	if (!registered) throw new Error(`Lane ${lane.id} worktree is missing. If the branch was already merged, run: trowel lane close ${lane.id}`)
	if (registered.branch !== lane.branch) throw new Error(`Lane ${lane.id} worktree is registered for branch '${registered.branch ?? '(detached)'}', expected '${lane.branch}'`)
}

async function requireMergeConfirmation(lane: Lane, conflict: MergeConflictSummary | null, rt: LaneRuntime): Promise<void> {
	if (!rt.interactive) throw nonInteractiveLaneCloseError(conflict)
	if (await rt.confirm(laneMergeConfirmationMessage(lane, conflict))) return
	throw new Error('lane close cancelled')
}

function nonInteractiveLaneCloseError(conflict: MergeConflictSummary | null): Error {
	return conflict ? new Error(formatMergeConflictPreflightError(conflict)) : new Error('lane close requires an interactive terminal for merge confirmation')
}

function laneMergeConfirmationMessage(lane: Lane, conflict: MergeConflictSummary | null): string {
	return conflict ? laneConflictConfirmationMessage(lane, conflict) : `Merge Lane ${lane.id} "${lane.title}" into ${lane.targetBranch}? [y/N]`
}

function laneConflictConfirmationMessage(lane: Lane, conflict: MergeConflictSummary): string {
	return `Merge conflict preflight predicted conflicts for Lane ${lane.id} "${lane.title}".\n${formatMergeConflictDetails(conflict)}\n\nMerge anyway? [y/N]`
}

async function assertLaneWorktreeCleanOrAlreadyMerged(lane: Lane, alreadyMerged: boolean, rt: LaneRuntime): Promise<void> {
	const registered = (await rt.repoGit.worktreeList()).some((w) => pathsEqual(w.path, lane.worktreePath))
	if (!registered) {
		if (alreadyMerged) return
		throw new Error(`Lane ${lane.id} worktree is missing and branch '${lane.branch}' is not merged into '${lane.targetBranch}'`)
	}
	if (!(await rt.repoGit.isWorkingTreeCleanIn(lane.worktreePath))) {
		const status = (await rt.repoGit.statusShortIn(lane.worktreePath)).trimEnd()
		throw new Error(`Lane ${lane.id} worktree is dirty; commit, stash, or discard before closing.\n${status}`)
	}
}

type LaneMergePlan =
	| { kind: 'target-worktree'; path: string }
	| { kind: 'detached-worktree'; path: string }

async function planLaneMerge(lane: Lane, rt: LaneRuntime): Promise<LaneMergePlan> {
	const targetWorktrees = (await rt.repoGit.worktreeList()).filter((w) => w.branch === lane.targetBranch)
	if (targetWorktrees.length > 1) throw new Error(`Target branch '${lane.targetBranch}' is checked out in multiple worktrees:\n${targetWorktrees.map((w) => `  ${w.path}`).join('\n')}`)
	if (targetWorktrees.length === 1) return { kind: 'target-worktree', path: targetWorktrees[0]!.path }
	return { kind: 'detached-worktree', path: laneMergeWorktreePath(rt.projectRoot, lane.id) }
}

async function preflightLaneMerge(lane: Lane, mergePlan: LaneMergePlan, rt: LaneRuntime): Promise<MergeConflictSummary | null> {
	return runMergeConflictPreflight({
		git: rt.repoGit,
		destinationRef: lane.targetBranch,
		sourceRef: lane.branch,
		destinationBranch: lane.targetBranch,
		sourceBranch: lane.branch,
		mergeLocation: mergePlan.path,
	})
}

async function mergeLaneIntoTarget(lane: Lane, mergePlan: LaneMergePlan, rt: LaneRuntime): Promise<void> {
	if (mergePlan.kind === 'target-worktree') {
		await mergeInTargetWorktree(lane, mergePlan.path, rt)
		return
	}
	await mergeInDetachedWorktree(lane, mergePlan.path, rt)
}

async function mergeInTargetWorktree(lane: Lane, targetPath: string, rt: LaneRuntime): Promise<void> {
	if (!(await rt.repoGit.isWorkingTreeCleanIn(targetPath))) {
		const status = (await rt.repoGit.statusShortIn(targetPath)).trimEnd()
		throw new Error(`target worktree is dirty; commit, stash, or discard before closing Lane ${lane.id}.\n${status}`)
	}
	try {
		await rt.repoGit.mergeNoFfIn(targetPath, lane.branch, { noVerify: rt.config.work.mergeNoVerify })
		rt.stdout(`Target worktree updated:\n  ${targetPath}\n`)
	} catch (error) {
		throw new Error(`${(error as Error).message}\nMerge conflict preserved at ${targetPath}`)
	}
}

async function mergeInDetachedWorktree(lane: Lane, mergePath: string, rt: LaneRuntime): Promise<void> {
	try {
		await prepareLaneMergeWorktree(mergePath, lane, rt)
		await rt.repoGit.mergeNoFfIn(mergePath, lane.branch, { noVerify: rt.config.work.mergeNoVerify })
		const mergedHead = await rt.repoGit.resolveRef('HEAD', mergePath)
		await rt.repoGit.updateLocalBranchRef(lane.targetBranch, mergedHead)
		await removeWorktreePath(mergePath, rt.repoGit)
	} catch (error) {
		throw new Error(`${(error as Error).message}\nMerge worktree preserved at ${mergePath}`)
	}
}

async function prepareLaneMergeWorktree(mergePath: string, lane: Lane, rt: LaneRuntime): Promise<void> {
	const existing = (await rt.repoGit.worktreeList()).find((w) => pathsEqual(w.path, mergePath))
	if (existing) {
		rt.stdout(`Warning: reusing existing Lane merge worktree at ${mergePath}; resetting it before merge.\n`)
		await rt.repoGit.mergeAbortIn(mergePath).catch(() => undefined)
		await rt.repoGit.checkoutDetached(mergePath, lane.targetBranch)
		await rt.repoGit.resetHard(mergePath, lane.targetBranch)
		await rt.repoGit.cleanAll(mergePath)
		return
	}
	if (await pathExists(mergePath)) throw new Error(`Lane merge worktree path '${mergePath}' already exists but is not a registered git worktree; move it aside before retrying`)
	await mkdir(path.dirname(mergePath), { recursive: true })
	await rt.repoGit.worktreeAdd(mergePath, lane.targetBranch)
	await rt.repoGit.checkoutDetached(mergePath, lane.targetBranch)
}

async function removeLaneWorktree(lane: Lane, rt: LaneRuntime): Promise<void> {
	if (!(await registeredWorktreePath(lane.worktreePath, rt.repoGit))) return
	await removeWorktreePath(lane.worktreePath, rt.repoGit)
}

async function registeredWorktreePath(worktreePath: string, git: GitOps): Promise<boolean> {
	return (await git.worktreeList()).some((w) => pathsEqual(w.path, worktreePath))
}

async function removeWorktreePath(worktreePath: string, git: GitOps): Promise<void> {
	try {
		await git.worktreeRemove(worktreePath)
	} catch {
		// fall through to filesystem cleanup; caller has already checked safety for Lane worktrees.
	}
	await rm(worktreePath, { recursive: true, force: true })
}

async function maybeDeleteLaneBranch(lane: Lane, policy: DeleteBranchPolicy, rt: LaneRuntime): Promise<void> {
	if (!(await shouldDeleteLaneBranch(lane, policy, rt))) return
	await rt.repoGit.deleteBranch(lane.branch)
}

async function shouldDeleteLaneBranch(lane: Lane, policy: DeleteBranchPolicy, rt: LaneRuntime): Promise<boolean> {
	if (policy === 'always') return true
	if (policy === 'never') return false
	return confirmPromptBranchDeletion(lane, rt)
}

async function confirmPromptBranchDeletion(lane: Lane, rt: LaneRuntime): Promise<boolean> {
	if (!rt.interactive) {
		rt.stdout(`Skipping local branch deletion for Lane ${lane.id}; prompt policy requires an interactive terminal.\n`)
		return false
	}
	return rt.confirm(`Delete local branch for Lane ${lane.id}?\n  ${lane.branch}\n[y/N]`)
}

function isInside(root: string, candidate: string): boolean {
	const rel = path.relative(path.resolve(root), path.resolve(candidate))
	return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

function pathsEqual(a: string, b: string): boolean {
	return path.resolve(a) === path.resolve(b)
}

async function buildLaneRuntime(commandName: string): Promise<LaneRuntime> {
	const base = await loadCommandBase(commandName)
	const { confirm } = await import('@inquirer/prompts')
	return {
		projectRoot: base.projectRoot,
		invocationCwd: process.cwd(),
		repoGit: base.git,
		cwdGit: createRepoGit(process.cwd()),
		config: base.config,
		interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
		confirm: (message) => confirm({ message, default: false }),
		stdout: (s) => process.stdout.write(s),
		now: () => new Date(),
		runInteractive: async ({ cwd, promptText, initialPrompt, harnessKind }) => {
			const harness = getHarness(harnessKind)
			const { waitForExit } = await harness.spawnInteractive({ model: base.config.agent.model, systemPrompt: promptText, cwd, initialPrompt })
			const code = await waitForExit
			if (code !== 0) throw new Error(`${harness.name} exited with code ${code}`)
		},
		copyToWorktree: async (worktreePath) => copyWorktreeEntries(base.projectRoot, worktreePath, base.config.turn.copyToWorktree, (s) => process.stdout.write(s)),
		assertHarnessInstalled: assertHarnessInstalled,
	}
}

async function assertHarnessInstalled(harnessKind: string): Promise<void> {
	const harness = getHarness(harnessKind)
	const version = await harness.detectVersion()
	if (!version.installed) throw new Error(`${harness.name} CLI not found on PATH (required for trowel lane with agent.harness=${harness.name})`)
}

export async function laneStart(title: string, opts: LaneStartOpts): Promise<void> {
	const rt = await buildLaneRuntime('lane start')
	await exitOnCommandError('lane start', () => runLaneStart(title, opts, rt))
}

export async function laneContinue(id: string, opts: LaneContinueOpts): Promise<void> {
	const rt = await buildLaneRuntime('lane continue')
	await exitOnCommandError('lane continue', () => runLaneContinue(id, opts, rt))
}

export async function laneClose(id: string): Promise<void> {
	const rt = await buildLaneRuntime('lane close')
	await exitOnCommandError('lane close', () => runLaneClose(id, rt))
}

export async function laneList(): Promise<void> {
	const rt = await buildLaneRuntime('lane list')
	await exitOnCommandError('lane list', () => runLaneList(rt))
}

if (import.meta.vitest) {
	const { describe, test, expect, beforeEach, afterEach } = import.meta.vitest
	const { mkdtemp } = await import('node:fs/promises')
	const { tmpdir } = await import('node:os')
	const { defaultConfig } = await import('../../config')
	const { noopGitOps } = await import('../../test-utils/git-ops-fixtures.ts')

	function makeRt(overrides: Partial<LaneRuntime> = {}): { rt: LaneRuntime; out: string[]; interactiveCalls: Array<{ cwd: string; initialPrompt?: string; harnessKind: string }> } {
		const out: string[] = []
		const interactiveCalls: Array<{ cwd: string; initialPrompt?: string; harnessKind: string }> = []
		const defaults: LaneRuntime = {
			projectRoot: '',
			invocationCwd: '',
			repoGit: noopGitOps(),
			cwdGit: noopGitOps(),
			config: defaultConfig,
			interactive: true,
			confirm: async () => true,
			stdout: (s) => out.push(s),
			now: () => new Date('2026-01-01T00:00:00.000Z'),
			runInteractive: async (args) => { interactiveCalls.push({ cwd: args.cwd, initialPrompt: args.initialPrompt, harnessKind: args.harnessKind }) },
			copyToWorktree: async () => undefined,
			assertHarnessInstalled: async () => undefined,
		}
		return { rt: { ...defaults, ...overrides }, out, interactiveCalls }
	}

	describe('runLaneStart', () => {
		let root: string

		beforeEach(async () => {
			root = await mkdtemp(path.join(tmpdir(), 'trowel-lane-command-'))
		})

		afterEach(async () => {
			await rm(root, { recursive: true, force: true })
		})

		test('creates lane metadata/worktree and starts the harness in the lane cwd', async () => {
			const branches = new Set<string>()
			let added: { worktreePath: string; branch: string; baseRef: string } | null = null
			const git = noopGitOps({
				currentBranch: async () => 'main',
				isWorkingTreeClean: async () => true,
				resolveRef: async (ref) => ref,
				localBranchExists: async (branch) => branches.has(branch),
				worktreeAddNewBranch: async (worktreePath, branch, baseRef) => {
					branches.add(branch)
					added = { worktreePath, branch, baseRef }
					await mkdir(worktreePath, { recursive: true })
				},
			})
			const { rt, interactiveCalls } = makeRt({ projectRoot: root, cwdGit: git, repoGit: git })

			await runLaneStart('Add cache invalidation', {}, rt)

			expect(added).toEqual({ worktreePath: laneWorktreePath(root, '1'), branch: 'lane-1-add-cache-invalidation', baseRef: 'HEAD' })
			expect(await readLane(root, '1')).toMatchObject({ id: '1', title: 'Add cache invalidation', branch: 'lane-1-add-cache-invalidation', targetBranch: 'main' })
			expect(interactiveCalls).toEqual([{ cwd: laneWorktreePath(root, '1'), initialPrompt: 'Add cache invalidation', harnessKind: defaultConfig.agent.harness }])
		})

		test('continues an existing open lane without an initial prompt', async () => {
			const lane = {
				schemaVersion: 1 as const,
				id: '1',
				title: 'Add cache invalidation',
				branch: 'lane-1-add-cache-invalidation',
				targetBranch: 'main',
				baseRef: 'HEAD',
				worktreePath: laneWorktreePath(root, '1'),
				createdAt: '2026-01-01T00:00:00.000Z',
				closedAt: null,
				mergedAt: null,
			}
			await writeLane(root, lane)
			const git = noopGitOps({
				localBranchExists: async () => true,
				worktreeList: async () => [{ path: lane.worktreePath, branch: lane.branch, head: '1' }],
			})
			const { rt, interactiveCalls } = makeRt({ projectRoot: root, repoGit: git })

			await runLaneContinue('1', {}, rt)

			expect(interactiveCalls).toEqual([{ cwd: lane.worktreePath, initialPrompt: undefined, harnessKind: defaultConfig.agent.harness }])
		})

		function testLane() {
			return {
				schemaVersion: 1 as const,
				id: '1',
				title: 'Add cache invalidation',
				branch: 'lane-1-add-cache-invalidation',
				targetBranch: 'main',
				baseRef: 'HEAD',
				worktreePath: laneWorktreePath(root, '1'),
				createdAt: '2026-01-01T00:00:00.000Z',
				closedAt: null,
				mergedAt: null,
			}
		}

		async function writeTestLane() {
			const lane = testLane()
			await writeLane(root, lane)
			await mkdir(lane.worktreePath, { recursive: true })
			return lane
		}

		function laneCloseGit(lane: ReturnType<typeof testLane>, calls: string[]): GitOps {
			let worktrees = [
				{ path: lane.worktreePath, branch: lane.branch, head: '1' },
				{ path: root, branch: 'main', head: '2' },
			]
			return noopGitOps({
				localBranchExists: async (branch) => branch === lane.branch || branch === 'main',
				worktreeList: async () => worktrees,
				isAncestor: async () => false,
				isWorkingTreeCleanIn: async () => true,
				mergeNoFfIn: async (worktreePath, branch) => { calls.push(`mergeNoFfIn(${worktreePath},${branch})`) },
				worktreeRemove: async (worktreePath) => {
					calls.push(`worktreeRemove(${worktreePath})`)
					worktrees = worktrees.filter((w) => w.path !== worktreePath)
				},
				deleteBranch: async (branch) => { calls.push(`deleteBranch(${branch})`) },
			})
		}

		test('closes a clean lane by merging into a checked-out target worktree and marking metadata closed', async () => {
			const lane = await writeTestLane()
			const calls: string[] = []
			const config = { ...defaultConfig, ship: { ...defaultConfig.ship, deleteBranch: 'always' as const } }
			const { rt } = makeRt({ projectRoot: root, invocationCwd: root, repoGit: laneCloseGit(lane, calls), config })

			await runLaneClose('1', rt)

			expect(calls).toEqual([
				`mergeNoFfIn(${root},${lane.branch})`,
				`worktreeRemove(${lane.worktreePath})`,
				`deleteBranch(${lane.branch})`,
			])
			expect(await readLane(root, '1')).toMatchObject({ closedAt: '2026-01-01T00:00:00.000Z', mergedAt: '2026-01-01T00:00:00.000Z' })
		})

		test('cancels lane close before merge when conflict preflight predicts conflicts and user declines', async () => {
			const lane = await writeTestLane()
			const calls: string[] = []
			const prompts: string[] = []
			const git = laneCloseGit(lane, calls)
			git.mergeConflictPreflight = async () => ({ ok: false, files: ['README.md'], messages: 'CONFLICT (content): README.md' })
			const { rt } = makeRt({
				projectRoot: root,
				invocationCwd: root,
				repoGit: git,
				confirm: async (message) => {
					prompts.push(message)
					return false
				},
			})

			await expect(runLaneClose('1', rt)).rejects.toThrow(/lane close cancelled/)

			expect(prompts.join('\n')).toContain('Merge conflict preflight predicted conflicts')
			expect(prompts.join('\n')).toContain('README.md')
			expect(calls).toEqual([])
		})

		test('attempts lane close merge when conflict preflight predicts conflicts and user confirms', async () => {
			const lane = await writeTestLane()
			const calls: string[] = []
			const git = laneCloseGit(lane, calls)
			git.mergeConflictPreflight = async () => ({ ok: false, files: ['README.md'], messages: 'CONFLICT (content): README.md' })
			const { rt } = makeRt({ projectRoot: root, invocationCwd: root, repoGit: git })

			await runLaneClose('1', rt)

			expect(calls[0]).toBe(`mergeNoFfIn(${root},${lane.branch})`)
		})
	})
}
