import { runCloseOutReview } from './change-review.ts'
import { classify } from './classify.ts'
import { createEffectiveSliceReader } from './effective-slices.ts'
import { processSlice } from './process-slice.ts'
import type { ClassifiedSlice } from './slice-types.ts'
import type { ClassifySliceConfig } from './types.ts'
import type { TurnIn, TurnOut } from './verdict.ts'
import type { Role } from '../prompts/load.ts'
import type { Change, Slice, Storage } from '../storages/types.ts'
import { collectChangeStateFacts, computeChangeState, type ChangeStateFacts } from '../utils/change-state.ts'
import type { GhOps } from '../utils/gh-ops.ts'
import type { GitOps } from '../utils/git-ops.ts'

export type ProjectLoopConfig = {
	pr: boolean
	audit: boolean
	perSliceBranches: boolean
	maxConcurrent: number | null
	mergeNoVerify: boolean
	loopPollSeconds: number
	needsRevisionLabel?: string
}

export type ProjectLoopDeps = {
	storage: Storage
	git: GitOps
	gh: GhOps
	spawnTurn: (changeId: string, args: { role: Role; slice?: ClassifiedSlice; change?: Pick<Change, 'id' | 'title' | 'body'>; branch: string; turnIn: TurnIn }) => Promise<TurnOut>
	log: (msg: string) => void
	config: ProjectLoopConfig
	projectRoot?: string
}

export type ProjectLoopOptions = {
	loop?: boolean
	sleep?: (ms: number) => Promise<void>
}

type Claim =
	| { kind: 'slice'; change: Change; slice: ClassifiedSlice; key: string; branchKey: string | null }
	| { kind: 'close-out-review'; change: Change; key: string; branchKey: string }

type ProjectLoopState = {
	deps: ProjectLoopDeps
	opts: ProjectLoopOptions
	failedSlices: Set<string>
	deferredSlices: Set<string>
	attemptedCloseOutReviews: Set<string>
	running: Map<string, Promise<void>>
	runningBranches: Set<string>
	reportedStates: Map<string, string>
	claims: number
	idlePolls: number
}

type ChangeWorkSnapshot = { change: Change; slices: ClassifiedSlice[]; state: ReturnType<typeof computeChangeState>; facts: ChangeStateFacts }

export async function runProjectLoop(deps: ProjectLoopDeps, opts: ProjectLoopOptions = {}): Promise<void> {
	const state = projectLoopState(deps, opts)
	while (true) {
		await fillProjectSlots(state)
		if (state.running.size > 0) {
			state.idlePolls = 0
			await Promise.race(state.running.values())
			continue
		}
		if (await projectHasActionableClaim(state)) continue
		if (!(await handleProjectIdle(state))) return
	}
}

function projectLoopState(deps: ProjectLoopDeps, opts: ProjectLoopOptions): ProjectLoopState {
	return {
		deps,
		opts,
		failedSlices: new Set(),
		deferredSlices: new Set(),
		attemptedCloseOutReviews: new Set(),
		running: new Map(),
		runningBranches: new Set(),
		reportedStates: new Map(),
		claims: 0,
		idlePolls: 0,
	}
}

async function fillProjectSlots(state: ProjectLoopState): Promise<void> {
	const claimed = new Set<string>()
	const claimedBranches = new Set<string>()
	while (state.running.size < effectiveConcurrency(state.deps.config.maxConcurrent)) {
		const claim = await findNextClaim(state, claimed, claimedBranches)
		if (!claim) return
		claimed.add(claim.key)
		if (claim.branchKey !== null) claimedBranches.add(claim.branchKey)
		state.claims += 1
		state.deps.log(claimLogLine(state.claims, claim))
		launchClaim(state, claim)
	}
}

function effectiveConcurrency(configCap: number | null): number {
	const cap = configCap ?? Number.POSITIVE_INFINITY
	return Math.max(1, Math.floor(cap))
}

async function findNextClaim(state: ProjectLoopState, claimed: Set<string>, claimedBranches: Set<string>): Promise<Claim | null> {
	for (const snapshot of await readProjectSnapshots(state.deps)) {
		const claim = actionableClaimForSnapshot(state, snapshot, claimed, claimedBranches)
		if (claim) return claim
	}
	return null
}

async function readProjectSnapshots(deps: ProjectLoopDeps): Promise<ChangeWorkSnapshot[]> {
	const changes = (await deps.storage.listChanges()).slice().sort((a, b) => a.createdAt.localeCompare(b.createdAt))
	const reader = createEffectiveSliceReader({
		storage: deps.storage,
		gh: deps.gh,
		pr: deps.config.pr,
		needsRevisionLabel: deps.config.needsRevisionLabel,
	})
	const snapshots: ChangeWorkSnapshot[] = []
	for (const change of changes) {
		const slices = await reader.findSlices(change.id)
		const facts = await collectChangeStateFacts(change, slices, { gh: deps.gh, git: deps.git, needsRevisionLabel: deps.config.needsRevisionLabel })
		snapshots.push({ change, slices, facts, state: computeChangeState(change, slices, facts, { needsRevisionLabel: deps.config.needsRevisionLabel }) })
	}
	return snapshots
}

function actionableClaimForSnapshot(state: ProjectLoopState, snapshot: ChangeWorkSnapshot, claimed: Set<string>, claimedBranches: Set<string>): Claim | null {
	if (snapshot.state === 'needs-revision') return closeOutReviewClaim(state, snapshot, claimed, claimedBranches)
	if (snapshot.state === 'open') return sliceClaim(state, snapshot.change, snapshot.slices, claimed, claimedBranches)
	reportProjectState(state, snapshot)
	return null
}

function closeOutReviewClaim(state: ProjectLoopState, snapshot: ChangeWorkSnapshot, claimed: Set<string>, claimedBranches: Set<string>): Claim | null {
	const change = snapshot.change
	const key = closeOutReviewKey(change.id)
	const branchKey = change.changeBranch
	if (state.attemptedCloseOutReviews.has(change.id)) {
		reportProjectState(state, snapshot)
		return null
	}
	if (!claimAvailable(state, key, branchKey, claimed, claimedBranches)) return null
	return { kind: 'close-out-review', change, key, branchKey }
}

function sliceClaim(state: ProjectLoopState, change: Change, slices: ClassifiedSlice[], claimed: Set<string>, claimedBranches: Set<string>): Claim | null {
	const config = sliceConfig(state.deps.config)
	for (const slice of slices) {
		const key = sliceKey(change.id, slice.id)
		const branchKey = schedulerBranchKey(slice, { perSliceBranches: state.deps.config.perSliceBranches, changeBranch: change.changeBranch })
		if (state.failedSlices.has(key)) continue
		if (state.deferredSlices.has(key)) continue
		if (!claimAvailable(state, key, branchKey, claimed, claimedBranches)) continue
		const resume = classify(slice, config, change.changeBranch)
		if (resume === 'done' || resume === 'blocked') continue
		return { kind: 'slice', change, slice, key, branchKey }
	}
	return null
}

function sliceConfig(config: ProjectLoopConfig): ClassifySliceConfig {
	return { pr: config.pr, audit: config.audit, perSliceBranches: config.perSliceBranches }
}

function schedulerBranchKey(slice: Pick<Slice, 'sliceBranch'>, opts: { perSliceBranches: boolean; changeBranch: string }): string | null {
	if (slice.sliceBranch !== null) return slice.sliceBranch
	return opts.perSliceBranches ? null : opts.changeBranch
}

function claimAvailable(state: ProjectLoopState, key: string, branchKey: string | null, claimed: Set<string>, claimedBranches: Set<string>): boolean {
	if (state.running.has(key)) return false
	if (claimed.has(key)) return false
	if (branchKey === null) return true
	return !state.runningBranches.has(branchKey) && !claimedBranches.has(branchKey)
}

function launchClaim(state: ProjectLoopState, claim: Claim): void {
	if (claim.branchKey !== null) state.runningBranches.add(claim.branchKey)
	const task = processProjectClaim(state, claim).finally(() => {
		state.running.delete(claim.key)
		if (claim.branchKey !== null) state.runningBranches.delete(claim.branchKey)
	})
	state.running.set(claim.key, task)
}

async function processProjectClaim(state: ProjectLoopState, claim: Claim): Promise<void> {
	if (claim.kind === 'slice') return processSliceClaim(state, claim)
	return processCloseOutReviewClaim(state, claim)
}

async function processSliceClaim(state: ProjectLoopState, claim: Extract<Claim, { kind: 'slice' }>): Promise<void> {
	try {
		const outcome = await processSlice(claim.change.id, claim.slice, loopDepsForChange(state, claim.change))
		if (outcome === 'partial') {
			state.deps.log(`[work change-${claim.change.id} slice-${claim.slice.id}] partial; skipping for the rest of this run`)
			state.failedSlices.add(claim.key)
		}
		if (outcome === 'skipped') state.failedSlices.add(claim.key)
		if (outcome === 'deferred') state.deferredSlices.add(claim.key)
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error)
		state.deps.log(`[work change-${claim.change.id} slice-${claim.slice.id}] error: ${msg}; skipping for the rest of this run`)
		state.failedSlices.add(claim.key)
	}
}

async function processCloseOutReviewClaim(state: ProjectLoopState, claim: Extract<Claim, { kind: 'close-out-review' }>): Promise<void> {
	state.attemptedCloseOutReviews.add(claim.change.id)
	try {
		const outcome = await runCloseOutReview(claim.change, {
			git: state.deps.git,
			gh: state.deps.gh,
			spawnTurn: (args) => state.deps.spawnTurn(claim.change.id, args),
			log: state.deps.log,
			needsRevisionLabel: state.deps.config.needsRevisionLabel,
			projectRoot: state.deps.projectRoot,
		})
		if (outcome === 'partial') state.deps.log(`[work change-${claim.change.id}] partial; skipping Close-out PR revision for the rest of this run`)
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error)
		state.deps.log(`[work change-${claim.change.id}] error: ${msg}; skipping Close-out PR revision for the rest of this run`)
	}
}

function loopDepsForChange(state: ProjectLoopState, change: Change) {
	return {
		storage: state.deps.storage,
		git: state.deps.git,
		gh: state.deps.gh,
		changeBranch: change.changeBranch,
		spawnTurn: (args: { role: Role; slice?: ClassifiedSlice; change?: Pick<Change, 'id' | 'title' | 'body'>; branch: string; turnIn: TurnIn }) => state.deps.spawnTurn(change.id, args),
		log: state.deps.log,
		config: state.deps.config,
		projectRoot: state.deps.projectRoot,
	}
}

async function projectHasActionableClaim(state: ProjectLoopState): Promise<boolean> {
	return (await findNextClaim(state, new Set(), new Set())) !== null
}

async function handleProjectIdle(state: ProjectLoopState): Promise<boolean> {
	if (!state.opts.loop) {
		state.deps.log(`[work] no actionable work; exiting after ${state.claims} claim(s)`)
		return false
	}
	if (!(await projectHasNonTerminalChanges(state))) return false
	state.idlePolls += 1
	logIdlePoll(state)
	await (state.opts.sleep ?? sleep)(state.deps.config.loopPollSeconds * 1000)
	state.deferredSlices.clear()
	return true
}

async function projectHasNonTerminalChanges(state: ProjectLoopState): Promise<boolean> {
	return (await readProjectSnapshots(state.deps)).some((snapshot) => snapshot.state !== 'done' && snapshot.state !== 'aborted')
}

function logIdlePoll(state: ProjectLoopState): void {
	if (state.idlePolls === 1) state.deps.log(`[work] no actionable work; polling every ${state.deps.config.loopPollSeconds}s`)
	else if (state.idlePolls % 10 === 0) state.deps.log(`[work] still no actionable work after ${state.idlePolls} polls`)
}

function reportProjectState(state: ProjectLoopState, snapshot: ChangeWorkSnapshot): void {
	const closeOutPr = snapshot.facts.closeOutPr
	const stateKey = `${snapshot.state}:${closeOutPr?.isDraft ? `draft:${closeOutPr.number}` : ''}`
	const previous = state.reportedStates.get(snapshot.change.id)
	if (previous === stateKey) return
	state.reportedStates.set(snapshot.change.id, stateKey)
	state.deps.log(projectStateMessage(snapshot))
}

function projectStateMessage(snapshot: ChangeWorkSnapshot): string {
	const change = snapshot.change
	const state = snapshot.state
	const closeOutPr = snapshot.facts.closeOutPr
	const ship = `trowel change ship ${change.id}`
	switch (state) {
		case 'ready':
			return `[work change-${change.id}] state=ready; all Slices are done; run: ${ship}`
		case 'needs-revision':
			return `[work change-${change.id}] state=needs-revision; Close-out PR needs revision; restart work to retry Reviewer if needed`
		case 'awaiting-review':
			if (closeOutPr?.isDraft) return `[work change-${change.id}] state=awaiting-review; existing draft Close-out PR #${closeOutPr.number}; make it ready or close it before retrying`
			return `[work change-${change.id}] state=awaiting-review; Close-out PR awaiting review or merge; run: ${ship}`
		case 'landed':
			return `[work change-${change.id}] non-work state=landed; merged to Target branch but not finalized; run: ${ship}`
		case 'done':
			return `[work change-${change.id}] non-work state=done; shipped and finalized; no work to run`
		case 'aborted':
			return `[work change-${change.id}] non-work state=aborted; Change is aborted; no work to run`
		case 'open':
			return `[work change-${change.id}] state=open; work remains`
	}
}

function claimLogLine(claimNumber: number, claim: Claim): string {
	if (claim.kind === 'slice') return `[work] claim ${claimNumber}: change ${claim.change.id} slice ${claim.slice.id}`
	return `[work] claim ${claimNumber}: change ${claim.change.id} Close-out Reviewer`
}

function sliceKey(changeId: string, sliceId: string): string {
	return `${changeId}:slice:${sliceId}`
}

function closeOutReviewKey(changeId: string): string {
	return `${changeId}:close-out-review`
}

async function sleep(ms: number): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, ms))
}

if (import.meta.vitest) {
	const { describe, test, expect } = import.meta.vitest
	const { recordingGhOps } = await import('../test-utils/gh-ops-recorder.ts')
	const { noopGitOps } = await import('../test-utils/git-ops-fixtures.ts')

	function change(overrides: Partial<Change> = {}): Change {
		return {
			id: '1',
			title: `Change ${overrides.id ?? '1'}`,
			body: '',
			createdAt: '2026-01-01T00:00:00.000Z',
			closedAt: null,
			targetBranch: 'main',
			changeBranch: `change-${overrides.id ?? '1'}`,
			...overrides,
		}
	}

	function slice(overrides: Partial<Slice> = {}): Slice {
		return {
			id: 's1',
			title: `Slice ${overrides.id ?? 's1'}`,
			body: '',
			closedAt: null,
			implementedAt: null,
			auditedAt: null,
			readyForAgent: true,
			blockedBy: [],
			sliceBranch: `change-1/slice-${overrides.id ?? 's1'}`,
			...overrides,
		}
	}

	function storage(changes: Change[], slicesByChange: Record<string, Slice[]>): Storage {
		return {
			createChange: async () => ({ id: 'x', title: 'x' }),
			findChange: async (id) => changes.find((entry) => entry.id === id) ?? null,
			listChanges: async () => changes,
			finalizeChange: async () => {},
			abortChange: async () => {},
			updateChangeMetadata: async () => {},
			createSlice: async () => ({ id: 'x', title: 'x' }),
			findSlices: async (changeId) => slicesByChange[changeId] ?? [],
			setSliceReadyForAgent: async () => {},
			setSliceBlockers: async () => {},
			markSliceImplemented: async () => {},
			markSliceAudited: async () => {},
			finalizeSlice: async () => {},
			abortSlice: async () => {},
			updateSliceMetadata: async () => {},
		}
	}

	function deps(overrides: Partial<ProjectLoopDeps> = {}): ProjectLoopDeps {
		const { gh } = recordingGhOps()
		return {
			storage: storage([], {}),
			git: noopGitOps(),
			gh,
			spawnTurn: async () => ({ verdict: 'partial', commits: 0 }),
			log: () => {},
			config: { pr: false, audit: false, perSliceBranches: true, maxConcurrent: 1, mergeNoVerify: false, loopPollSeconds: 30 },
			...overrides,
		}
	}

	describe('runProjectLoop', () => {
		test('one-shot drains currently actionable Changes oldest-first', async () => {
			const old = change({ id: 'old', createdAt: '2026-01-01T00:00:00.000Z', changeBranch: 'change-old' })
			const newer = change({ id: 'new', createdAt: '2026-01-02T00:00:00.000Z', changeBranch: 'change-new' })
			const calls: string[] = []
			await runProjectLoop(deps({
				storage: storage([newer, old], {
					old: [slice({ id: 's-old', sliceBranch: 'change-old/slice' })],
					new: [slice({ id: 's-new', sliceBranch: 'change-new/slice' })],
				}),
				spawnTurn: async (changeId, args) => {
					calls.push(`${changeId}:${args.slice?.id}`)
					return { verdict: 'partial', commits: 0 }
				},
			}))
			expect(calls).toEqual(['old:s-old', 'new:s-new'])
		})

		test('global branch safety serializes same branch across Changes', async () => {
			const a = change({ id: 'a', createdAt: '2026-01-01T00:00:00.000Z', changeBranch: 'change-a' })
			const b = change({ id: 'b', createdAt: '2026-01-02T00:00:00.000Z', changeBranch: 'change-b' })
			let releaseFirst!: () => void
			let firstStarted!: () => void
			const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve })
			const startedGate = new Promise<void>((resolve) => { firstStarted = resolve })
			const events: string[] = []
			const running = runProjectLoop(deps({
				storage: storage([a, b], {
					a: [slice({ id: 's-a', sliceBranch: 'shared' })],
					b: [slice({ id: 's-b', sliceBranch: 'shared' })],
				}),
				config: { pr: false, audit: false, perSliceBranches: true, maxConcurrent: 2, mergeNoVerify: false, loopPollSeconds: 30 },
				spawnTurn: async (changeId) => {
					events.push(`${changeId}:start`)
					if (changeId === 'a') {
						firstStarted()
						await firstGate
					}
					events.push(`${changeId}:finish`)
					return { verdict: 'partial', commits: 0 }
				},
			}))
			await startedGate
			expect(events).toEqual(['a:start'])
			releaseFirst()
			await running
			expect(events).toEqual(['a:start', 'a:finish', 'b:start', 'b:finish'])
		})

		test('runs one Close-out Reviewer claim for a needs-revision Change', async () => {
			const c = change({ id: '3', changeBranch: 'change-3' })
			const { gh } = recordingGhOps({
				findAnyPrByHead: async (head) => (head === 'change-3' ? { number: 12, state: 'OPEN', labels: [{ name: 'needs-revision' }] } : null),
				findPrNumberByHead: async () => 12,
				fetchPrThread: async () => [{ author: { login: 'reviewer' }, createdAt: '2026-01-01T00:00:00.000Z', body: 'please revise' }],
			})
			const calls: string[] = []
			await runProjectLoop(deps({
				storage: storage([c], { 3: [slice({ closedAt: '2026-06-04T00:00:00.000Z', readyForAgent: false })] }),
				git: noopGitOps({ commitsAhead: async () => 1 }),
				gh,
				config: { pr: true, audit: false, perSliceBranches: true, maxConcurrent: 1, mergeNoVerify: false, loopPollSeconds: 30 },
				spawnTurn: async (changeId, args) => {
					calls.push(`${changeId}:${args.role}:${args.change?.id}:${args.branch}`)
					return { verdict: 'partial', commits: 0 }
				},
			}))
			expect(calls).toEqual(['3:review:3:change-3'])
		})

		test('skips Close-out Reviewer when revision signals have no Fresh PR feedback', async () => {
			const c = change({ id: '3', changeBranch: 'change-3' })
			const logs: string[] = []
			const { gh } = recordingGhOps({
				findAnyPrByHead: async (head) => (head === 'change-3' ? { number: 12, state: 'OPEN', labels: [{ name: 'needs-revision' }] } : null),
				findPrNumberByHead: async () => 12,
				fetchPrThread: async () => [{ author: { login: 'reviewer' }, createdAt: '2025-12-31T23:59:59.000Z', body: 'old revise' }],
			})
			let spawnCalls = 0
			await runProjectLoop(deps({
				storage: storage([c], { 3: [slice({ closedAt: '2026-06-04T00:00:00.000Z', readyForAgent: false })] }),
				git: noopGitOps({ commitsAhead: async () => 1 }),
				gh,
				log: (m) => logs.push(m),
				config: { pr: true, audit: false, perSliceBranches: true, maxConcurrent: 1, mergeNoVerify: false, loopPollSeconds: 30 },
				spawnTurn: async () => {
					spawnCalls += 1
					return { verdict: 'ready', commits: 0 }
				},
			}))
			expect(spawnCalls).toBe(0)
			expect(logs.join('\n')).toContain('no Fresh PR feedback after latest commit')
		})
	})
}
