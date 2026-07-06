import { mkdir, rm, writeFile } from 'node:fs/promises'
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
import { formatMergeConflictPreflightError, runMergeConflictPreflight, type MergeConflictSummary } from '../../work/merge-conflict-preflight.ts'
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

type LaneStartOpts = { harness?: string }
type LaneContinueOpts = { harness?: string }

type StartedLane = { lane: Lane; harnessKind: string }

async function runLaneStart(title: string, opts: LaneStartOpts, rt: LaneRuntime): Promise<void> {
	const trimmedTitle = title.trim()
	if (!trimmedTitle) throw new Error('lane title is required')
	const harnessKind = opts.harness ?? rt.config.agent.harness
	await rt.assertHarnessInstalled(harnessKind)
	const started = await withMutationLock(rt.projectRoot, () => createLane(trimmedTitle, harnessKind, rt))
	const promptText = await loadPrompt('lane')
	await rt.runInteractive({ cwd: started.lane.worktreePath, promptText, initialPrompt: trimmedTitle, harnessKind: started.harnessKind })
}

async function createLane(title: string, harnessKind: string, rt: LaneRuntime): Promise<StartedLane> {
	const targetBranch = await laneTargetBranch(rt)
	await confirmCleanOrContinueInvocationWorktree(rt)
	const lane = await newLaneRecord(title, targetBranch, rt)
	await assertLaneBranchAvailable(lane.branch, rt)
	await assertLaneWorktreePathAvailable(lane.worktreePath)
	await rt.cwdGit.worktreeAddNewBranch(lane.worktreePath, lane.branch, targetBranch)
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

async function confirmCleanOrContinueInvocationWorktree(rt: LaneRuntime): Promise<void> {
	if (await rt.cwdGit.isWorkingTreeClean()) return
	await printDirtyInvocationStatus(rt)
	if (await shouldContinueWithDirtyInvocationWorktree(rt)) return
	throw new Error('working tree is dirty')
}

async function printDirtyInvocationStatus(rt: LaneRuntime): Promise<void> {
	const statusShort = await rt.cwdGit.statusShort()
	if (statusShort.trim()) rt.stdout(`\nDirty working tree:\n${statusShort.trimEnd()}\n\n`)
}

async function shouldContinueWithDirtyInvocationWorktree(rt: LaneRuntime): Promise<boolean> {
	return rt.interactive ? rt.confirm(dirtyLaneStartConfirmationMessage()) : false
}

function dirtyLaneStartConfirmationMessage(): string {
	return 'Working tree is dirty. Commit/stash first for a clean Lane, or continue and create the Lane from the captured Target branch while your current changes stay in this worktree. Continue with dirty tree?'
}

async function newLaneRecord(title: string, targetBranch: string, rt: LaneRuntime): Promise<Lane> {
	const id = await allocateNextLaneId(rt.projectRoot)
	const branch = laneBranchName(id, title)
	return {
		schemaVersion: 1,
		id,
		title,
		branch,
		targetBranch,
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
	await requireLaneCloseConfirmation(lane, closePlan, rt)
	const integration = closePlan.mergePlan ? await squashLaneIntoTarget(lane, closePlan, rt) : 'already-integrated'
	await finishLaneClose(lane, integration, rt)
}

async function requireClosableLane(id: string, rt: LaneRuntime): Promise<Lane> {
	const lane = await requireExistingLane(rt.projectRoot, id)
	if (lane.closedAt !== null) throw new Error(`Lane ${id} is closed`)
	if (isInside(lane.worktreePath, rt.invocationCwd)) throw new Error(`Lane ${id} cleanup may remove the current worktree. Switch directories first, then retry.`)
	await requireLocalBranch(lane.branch, rt.repoGit, `Lane ${id} branch '${lane.branch}' is missing`)
	await requireLocalBranch(lane.targetBranch, rt.repoGit, `Lane ${id} target branch '${lane.targetBranch}' is missing`)
	return lane
}

type LaneClosePlan = { mergePlan: LaneMergePlan | null; commitSubjects: string[] }
type LaneCloseIntegration = 'already-integrated' | 'squashed' | 'no-net-diff'

async function planLaneClose(lane: Lane, rt: LaneRuntime): Promise<LaneClosePlan> {
	const alreadyMerged = await rt.repoGit.isAncestor(lane.branch, lane.targetBranch)
	await assertLaneWorktreeCleanOrAlreadyMerged(lane, alreadyMerged, rt)
	if (alreadyMerged) return { mergePlan: null, commitSubjects: [] }
	const mergePlan = await planLaneMerge(lane, rt)
	const conflict = await preflightLaneMerge(lane, mergePlan, rt)
	if (conflict) throw new Error(formatMergeConflictPreflightError(conflict))
	return { mergePlan, commitSubjects: await rt.repoGit.nonMergeCommitSubjects(lane.targetBranch, lane.branch) }
}

async function finishLaneClose(lane: Lane, integration: LaneCloseIntegration, rt: LaneRuntime): Promise<void> {
	await removeLaneWorktree(lane, rt)
	await maybeDeleteLaneBranch(lane, rt.config.ship.deleteBranch, rt)
	const closed = await markLaneClosed(rt.projectRoot, lane.id, rt.now().toISOString())
	rt.stdout(`Closed Lane ${closed.id}\n`)
	rt.stdout(formatLaneCloseIntegration(closed, integration))
	rt.stdout(`Worktree: ${closed.worktreePath}\n`)
}

function formatLaneCloseIntegration(lane: Lane, integration: LaneCloseIntegration): string {
	if (integration === 'squashed') return `Squashed ${lane.branch} into ${lane.targetBranch}.\n`
	if (integration === 'no-net-diff') return `No net diff from ${lane.branch} into ${lane.targetBranch}; no commit created.\n`
	return `Lane branch ${lane.branch} was already integrated into ${lane.targetBranch}.\n`
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
	if (!registered) throw new Error(`Lane ${lane.id} worktree is missing. If the branch was already integrated, run: trowel lane close ${lane.id}`)
	if (registered.branch !== lane.branch) throw new Error(`Lane ${lane.id} worktree is registered for branch '${registered.branch ?? '(detached)'}', expected '${lane.branch}'`)
}

async function requireLaneCloseConfirmation(lane: Lane, plan: LaneClosePlan, rt: LaneRuntime): Promise<void> {
	if (!rt.interactive) throw new Error('lane close requires an interactive terminal for squash confirmation and commit editor')
	if (await rt.confirm(laneCloseConfirmationMessage(lane, plan))) return
	throw new Error('lane close cancelled')
}

function laneCloseConfirmationMessage(lane: Lane, plan: LaneClosePlan): string {
	return [
		`Squash close Lane ${lane.id} "${lane.title}" into ${lane.targetBranch}? [y/N]`,
		`Target: ${lane.targetBranch}`,
		`Lane branch: ${lane.branch}`,
		'Commits to squash:',
		...formatCommitSubjects(plan.commitSubjects),
		'This will open your git commit editor with an editable squash commit template.',
	].join('\n')
}

function formatCommitSubjects(subjects: string[]): string[] {
	return subjects.length > 0 ? subjects.map((subject) => `  - ${subject}`) : ['  (no non-merge Lane commits found)']
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

async function squashLaneIntoTarget(lane: Lane, closePlan: LaneClosePlan, rt: LaneRuntime): Promise<LaneCloseIntegration> {
	if (!closePlan.mergePlan) return 'already-integrated'
	if (closePlan.mergePlan.kind === 'target-worktree') return squashInTargetWorktree(lane, closePlan.mergePlan.path, closePlan.commitSubjects, rt)
	return squashInDetachedWorktree(lane, closePlan.mergePlan.path, closePlan.commitSubjects, rt)
}

async function squashInTargetWorktree(lane: Lane, targetPath: string, commitSubjects: string[], rt: LaneRuntime): Promise<LaneCloseIntegration> {
	if (!(await rt.repoGit.isWorkingTreeCleanIn(targetPath))) {
		const status = (await rt.repoGit.statusShortIn(targetPath)).trimEnd()
		throw new Error(`target worktree is dirty; commit, stash, or discard before closing Lane ${lane.id}.\n${status}`)
	}
	try {
		await rt.repoGit.mergeSquashIn(targetPath, lane.branch)
		if (await squashProducedNoNetDiff(targetPath, rt)) return 'no-net-diff'
		await commitLaneSquash(lane, targetPath, commitSubjects, rt)
		rt.stdout(`Target worktree updated:\n  ${targetPath}\n`)
		return 'squashed'
	} catch (error) {
		throw new Error(`${(error as Error).message}\nSquash close state preserved at ${targetPath}; Lane ${lane.id} remains open.`)
	}
}

async function squashInDetachedWorktree(lane: Lane, mergePath: string, commitSubjects: string[], rt: LaneRuntime): Promise<LaneCloseIntegration> {
	try {
		await prepareLaneMergeWorktree(mergePath, lane, rt)
		await rt.repoGit.mergeSquashIn(mergePath, lane.branch)
		if (await squashProducedNoNetDiff(mergePath, rt)) {
			await removeWorktreePath(mergePath, rt.repoGit)
			return 'no-net-diff'
		}
		await commitLaneSquash(lane, mergePath, commitSubjects, rt)
		const squashedHead = await rt.repoGit.resolveRef('HEAD', mergePath)
		await rt.repoGit.updateLocalBranchRef(lane.targetBranch, squashedHead)
		await removeWorktreePath(mergePath, rt.repoGit)
		return 'squashed'
	} catch (error) {
		throw new Error(`${(error as Error).message}\nSquash close worktree preserved at ${mergePath}; Lane ${lane.id} remains open.`)
	}
}

async function squashProducedNoNetDiff(worktreePath: string, rt: LaneRuntime): Promise<boolean> {
	return rt.repoGit.isWorkingTreeCleanIn(worktreePath)
}

async function commitLaneSquash(lane: Lane, worktreePath: string, commitSubjects: string[], rt: LaneRuntime): Promise<void> {
	const templatePath = await writeLaneSquashCommitTemplate(lane, commitSubjects, rt)
	await rt.repoGit.commitWithTemplateIn(worktreePath, templatePath, { noVerify: rt.config.work.mergeNoVerify })
	await rm(templatePath, { force: true }).catch(() => undefined)
}

async function writeLaneSquashCommitTemplate(lane: Lane, commitSubjects: string[], rt: LaneRuntime): Promise<string> {
	const templatePath = path.join(rt.projectRoot, '.trowel', `lane-${lane.id}-squash-commit-message.txt`)
	await mkdir(path.dirname(templatePath), { recursive: true })
	await writeFile(templatePath, laneSquashCommitTemplate(lane, commitSubjects), 'utf8')
	return templatePath
}

function laneSquashCommitTemplate(lane: Lane, commitSubjects: string[]): string {
	return [
		oneLine(lane.title) || `Close Lane ${lane.id}`,
		'',
		`Lane: ${lane.id}`,
		`Branch: ${lane.branch}`,
		`Target: ${lane.targetBranch}`,
		'',
		'Squashed commits:',
		...formatCommitSubjects(commitSubjects).map((line) => line.trimStart()),
		'',
	].join('\n')
}

function oneLine(input: string): string {
	return input.replace(/\s+/g, ' ').trim()
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
	return rt.confirm(`Delete local branch for Lane ${lane.id}?\n  ${lane.branch}\nThe Lane was integrated by squash, so Git may not consider this branch merged even though its net diff was closed.\n[y/N]`)
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

		function startGit(overrides: Partial<GitOps> = {}): { git: GitOps; added: () => { worktreePath: string; branch: string; baseBranch: string } | null } {
			const branches = new Set<string>()
			let added: { worktreePath: string; branch: string; baseBranch: string } | null = null
			const git = noopGitOps({
				currentBranch: async () => 'main',
				isWorkingTreeClean: async () => true,
				localBranchExists: async (branch) => branches.has(branch),
				worktreeAddNewBranch: async (worktreePath, branch, baseBranch) => {
					branches.add(branch)
					added = { worktreePath, branch, baseBranch }
					await mkdir(worktreePath, { recursive: true })
				},
				...overrides,
			})
			return { git, added: () => added }
		}

		test('creates lane metadata/worktree and starts the harness in the lane cwd', async () => {
			const { git, added } = startGit()
			const { rt, interactiveCalls } = makeRt({ projectRoot: root, cwdGit: git, repoGit: git })

			await runLaneStart('Add cache invalidation', {}, rt)

			expect(added()).toEqual({ worktreePath: laneWorktreePath(root, '1'), branch: 'lane-1-add-cache-invalidation', baseBranch: 'main' })
			expect(await readLane(root, '1')).toMatchObject({ id: '1', title: 'Add cache invalidation', branch: 'lane-1-add-cache-invalidation', targetBranch: 'main' })
			expect(interactiveCalls).toEqual([{ cwd: laneWorktreePath(root, '1'), initialPrompt: 'Add cache invalidation', harnessKind: defaultConfig.agent.harness }])
		})

		test('dirty invocation worktree can continue after confirmation', async () => {
			const { git, added } = startGit({
				isWorkingTreeClean: async () => false,
				statusShort: async () => ' M README.md\n',
			})
			const prompts: string[] = []
			const { rt, out } = makeRt({
				projectRoot: root,
				cwdGit: git,
				repoGit: git,
				confirm: async (message) => {
					prompts.push(message)
					return true
				},
			})

			await runLaneStart('Add cache invalidation', {}, rt)

			expect(out.join('')).toContain('Dirty working tree')
			expect(out.join('')).toContain('M README.md')
			expect(prompts.join('\n')).toContain('Continue with dirty tree?')
			expect(added()).toMatchObject({ branch: 'lane-1-add-cache-invalidation' })
		})

		test('dirty invocation worktree cancels lane start when confirmation is declined', async () => {
			const { git, added } = startGit({
				isWorkingTreeClean: async () => false,
				statusShort: async () => ' M README.md\n',
			})
			const { rt } = makeRt({
				projectRoot: root,
				cwdGit: git,
				repoGit: git,
				confirm: async () => false,
			})

			await expect(runLaneStart('Add cache invalidation', {}, rt)).rejects.toThrow(/working tree is dirty/)

			expect(added()).toBeNull()
		})

		test('continues an existing open lane without an initial prompt', async () => {
			const lane = {
				schemaVersion: 1 as const,
				id: '1',
				title: 'Add cache invalidation',
				branch: 'lane-1-add-cache-invalidation',
				targetBranch: 'main',
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

		function laneCloseGit(lane: ReturnType<typeof testLane>, calls: string[], opts: { squashProducesDiff?: boolean; commitFails?: boolean; targetCheckedOut?: boolean } = {}): GitOps {
			let squashed = false
			let worktrees = [
				{ path: lane.worktreePath, branch: lane.branch, head: '1' },
				...(opts.targetCheckedOut === false ? [] : [{ path: root, branch: 'main', head: '2' }]),
			]
			return noopGitOps({
				localBranchExists: async (branch) => branch === lane.branch || branch === 'main',
				worktreeList: async () => worktrees,
				isAncestor: async () => false,
				isWorkingTreeCleanIn: async (worktreePath) => worktreePath === lane.worktreePath || !(opts.squashProducesDiff && squashed),
				mergeSquashIn: async (worktreePath, branch) => {
					calls.push(`mergeSquashIn(${worktreePath},${branch})`)
					squashed = true
				},
				commitWithTemplateIn: async (worktreePath, templatePath, commitOpts) => {
					calls.push(`commitWithTemplateIn(${worktreePath},${path.basename(templatePath)},noVerify=${String(commitOpts?.noVerify)})`)
					if (opts.commitFails) throw new Error('commit editor aborted')
					squashed = false
				},
				nonMergeCommitSubjects: async () => ['chunk one', 'chunk two'],
				resolveRef: async (ref, worktreePath) => {
					calls.push(`resolveRef(${ref},${worktreePath})`)
					return 'squashed-head'
				},
				updateLocalBranchRef: async (branch, ref) => { calls.push(`updateLocalBranchRef(${branch},${ref})`) },
				worktreeAdd: async (worktreePath, branch) => {
					calls.push(`worktreeAdd(${worktreePath},${branch})`)
					worktrees = [...worktrees, { path: worktreePath, branch, head: 'merge' }]
					await mkdir(worktreePath, { recursive: true })
				},
				checkoutDetached: async (worktreePath, ref) => { calls.push(`checkoutDetached(${worktreePath},${ref})`) },
				worktreeRemove: async (worktreePath) => {
					calls.push(`worktreeRemove(${worktreePath})`)
					worktrees = worktrees.filter((w) => w.path !== worktreePath)
				},
				deleteBranch: async (branch) => { calls.push(`deleteBranch(${branch})`) },
			})
		}

		test('closes a clean lane by squash committing into a checked-out target worktree and marking metadata closed', async () => {
			const lane = await writeTestLane()
			const calls: string[] = []
			const config = { ...defaultConfig, ship: { ...defaultConfig.ship, deleteBranch: 'always' as const }, work: { ...defaultConfig.work, mergeNoVerify: true } }
			const { rt } = makeRt({ projectRoot: root, invocationCwd: root, repoGit: laneCloseGit(lane, calls, { squashProducesDiff: true }), config })

			await runLaneClose('1', rt)

			expect(calls).toEqual([
				`mergeSquashIn(${root},${lane.branch})`,
				`commitWithTemplateIn(${root},lane-1-squash-commit-message.txt,noVerify=true)`,
				`worktreeRemove(${lane.worktreePath})`,
				`deleteBranch(${lane.branch})`,
			])
			expect(await readLane(root, '1')).toMatchObject({ closedAt: '2026-01-01T00:00:00.000Z', mergedAt: '2026-01-01T00:00:00.000Z' })
		})

		test('refuses lane close before mutation when conflict preflight predicts conflicts', async () => {
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
					return true
				},
			})

			await expect(runLaneClose('1', rt)).rejects.toThrow(/Merge conflict preflight predicted conflicts/)

			expect(prompts).toEqual([])
			expect(calls).toEqual([])
		})

		test('confirmation shows target, lane branch, and commits to squash', async () => {
			const lane = await writeTestLane()
			const calls: string[] = []
			let prompt = ''
			const { rt } = makeRt({
				projectRoot: root,
				invocationCwd: root,
				repoGit: laneCloseGit(lane, calls),
				confirm: async (message) => {
					prompt = message
					return false
				},
			})

			await expect(runLaneClose('1', rt)).rejects.toThrow(/lane close cancelled/)

			expect(prompt).toContain('Target: main')
			expect(prompt).toContain(`Lane branch: ${lane.branch}`)
			expect(prompt).toContain('chunk one')
			expect(prompt).toContain('chunk two')
			expect(calls).toEqual([])
		})

		test('closes without a commit when squash produces no net diff', async () => {
			const lane = await writeTestLane()
			const calls: string[] = []
			const config = { ...defaultConfig, ship: { ...defaultConfig.ship, deleteBranch: 'always' as const } }
			const { rt, out } = makeRt({ projectRoot: root, invocationCwd: root, repoGit: laneCloseGit(lane, calls), config })

			await runLaneClose('1', rt)

			expect(calls).toEqual([
				`mergeSquashIn(${root},${lane.branch})`,
				`worktreeRemove(${lane.worktreePath})`,
				`deleteBranch(${lane.branch})`,
			])
			expect(out.join('')).toContain('No net diff')
			expect(await readLane(root, '1')).toMatchObject({ closedAt: '2026-01-01T00:00:00.000Z', mergedAt: '2026-01-01T00:00:00.000Z' })
		})

		test('failed squash commit preserves close state and leaves lane open', async () => {
			const lane = await writeTestLane()
			const calls: string[] = []
			const config = { ...defaultConfig, ship: { ...defaultConfig.ship, deleteBranch: 'always' as const } }
			const { rt } = makeRt({ projectRoot: root, invocationCwd: root, repoGit: laneCloseGit(lane, calls, { squashProducesDiff: true, commitFails: true }), config })

			await expect(runLaneClose('1', rt)).rejects.toThrow(/Squash close state preserved/)

			expect(calls).toEqual([
				`mergeSquashIn(${root},${lane.branch})`,
				`commitWithTemplateIn(${root},lane-1-squash-commit-message.txt,noVerify=false)`,
			])
			expect(await readLane(root, '1')).toMatchObject({ closedAt: null, mergedAt: null })
		})

		test('detached squash close commits in a merge worktree then updates the target ref', async () => {
			const lane = await writeTestLane()
			const calls: string[] = []
			const config = { ...defaultConfig, ship: { ...defaultConfig.ship, deleteBranch: 'always' as const } }
			const mergePath = laneMergeWorktreePath(root, lane.id)
			const { rt } = makeRt({
				projectRoot: root,
				invocationCwd: root,
				repoGit: laneCloseGit(lane, calls, { squashProducesDiff: true, targetCheckedOut: false }),
				config,
			})

			await runLaneClose('1', rt)

			expect(calls).toEqual([
				`worktreeAdd(${mergePath},main)`,
				`checkoutDetached(${mergePath},main)`,
				`mergeSquashIn(${mergePath},${lane.branch})`,
				`commitWithTemplateIn(${mergePath},lane-1-squash-commit-message.txt,noVerify=false)`,
				`resolveRef(HEAD,${mergePath})`,
				'updateLocalBranchRef(main,squashed-head)',
				`worktreeRemove(${mergePath})`,
				`worktreeRemove(${lane.worktreePath})`,
				`deleteBranch(${lane.branch})`,
			])
			expect(await readLane(root, '1')).toMatchObject({ closedAt: '2026-01-01T00:00:00.000Z', mergedAt: '2026-01-01T00:00:00.000Z' })
		})
	})
}
