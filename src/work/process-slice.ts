import { classify } from './classify.ts'
import type { LoopDeps } from './loop.ts'
import { landAddress, landImplement, landReview, prepareAddress, prepareImplement, prepareReview, type PhaseDeps } from './phases.ts'
import { enrichSlicePrStates } from './pr-flow.ts'
import type { TurnOut } from './verdict.ts'
import type { Role } from '../prompts/load.ts'
import type { ClassifiedSlice, ClassifySliceConfig, PhaseOutcome, ResumeState, Slice } from '../storages/types.ts'
import { classifySlices } from '../utils/bucket.ts'

export type ProcessOutcome = 'done' | 'partial' | 'no-work'

type LoopPhaseCtx = { prdId: string; integrationBranch: string; config: ClassifySliceConfig }
type SliceStepResult = { outcome: ProcessOutcome } | { slice: ClassifiedSlice }

const SANDBOX_ROLES = new Set<ResumeState>(['implement', 'review', 'address'])

const PROCESS_OUTCOME_BY_PHASE: Record<PhaseOutcome, ProcessOutcome | null> = {
	done: 'done',
	'no-work': 'no-work',
	partial: 'partial',
	progress: null,
}

export async function processSlice(prdId: string, initial: ClassifiedSlice, deps: LoopDeps): Promise<ProcessOutcome> {
	const ctx = loopPhaseCtx(prdId, deps)
	const tag = `[work prd-${prdId} slice-${initial.id}]`
	const initialOutcome = initialProcessOutcome(initial, ctx, tag, deps)
	if (initialOutcome) return initialOutcome

	let slice: ClassifiedSlice = initial
	for (let step = 0; step < deps.config.sliceStepCap; step++) {
		const stepResult = await processSliceStep(slice, ctx, tag, deps)
		if ('outcome' in stepResult) return stepResult.outcome
		slice = stepResult.slice
	}
	deps.log(`${tag} step-cap reached after ${deps.config.sliceStepCap} step(s); returning partial`)
	return 'partial'
}

function loopPhaseCtx(prdId: string, deps: LoopDeps): LoopPhaseCtx {
	return {
		prdId,
		integrationBranch: deps.integrationBranch,
		config: { usePrs: deps.config.usePrs, review: deps.config.review, perSliceBranches: deps.config.perSliceBranches },
	}
}

function initialProcessOutcome(slice: ClassifiedSlice, ctx: LoopPhaseCtx, tag: string, deps: LoopDeps): ProcessOutcome | null {
	if (classify(slice, ctx.config) !== 'blocked') return null
	deps.log(`${tag} blocked by [${slice.blockedBy.join(', ')}]; skipping`)
	return 'no-work'
}

async function processSliceStep(slice: ClassifiedSlice, ctx: LoopPhaseCtx, tag: string, deps: LoopDeps): Promise<SliceStepResult> {
	const state = classify(slice, ctx.config)
	const terminal = terminalOutcomeForState(state)
	if (terminal) return { outcome: terminal }
	if (!SANDBOX_ROLES.has(state)) return unexpectedStateOutcome(state, tag, deps)
	const outcome = await runSlicePhase(state as Role, slice, ctx, tag, deps)
	const processOutcome = PROCESS_OUTCOME_BY_PHASE[outcome]
	return processOutcome ? { outcome: processOutcome } : refreshSliceResult(slice, ctx, deps)
}

function terminalOutcomeForState(state: ResumeState): ProcessOutcome | null {
	if (state === 'done') return 'done'
	if (state === 'blocked') return 'no-work'
	return null
}

function unexpectedStateOutcome(state: ResumeState, tag: string, deps: LoopDeps): SliceStepResult {
	deps.log(`${tag} unexpected state ${state}; treating as partial`)
	return { outcome: 'partial' }
}

async function runSlicePhase(role: Role, slice: ClassifiedSlice, ctx: LoopPhaseCtx, tag: string, deps: LoopDeps): Promise<PhaseOutcome> {
	deps.log(`${tag} state=${role}: "${slice.title}"`)
	const phaseDeps = phaseDepsFor(deps)
	const prep = await callPrepare(phaseDeps, role, slice, ctx)
	deps.log(`${tag} spawning ${role} sandbox on ${prep.branch}`)
	const verdict = await deps.spawnTurn({ role, slice, branch: prep.branch, turnIn: prep.turnIn })
	deps.log(`${tag} ${role} verdict: ${verdict.verdict}, ${verdict.commits} commit(s)`)
	return callLand(phaseDeps, role, slice, verdict, ctx)
}

function phaseDepsFor(deps: LoopDeps): PhaseDeps {
	return { storage: deps.storage, git: deps.git, gh: deps.gh, log: deps.log, mergeNoVerify: deps.config.mergeNoVerify, projectRoot: deps.projectRoot }
}

async function refreshSliceResult(slice: ClassifiedSlice, ctx: LoopPhaseCtx, deps: LoopDeps): Promise<SliceStepResult> {
	const raw = await deps.storage.findSlices(ctx.prdId)
	const enriched = ctx.config.usePrs ? await enrichSlicePrStates(deps.gh, ctx.prdId, raw) : raw
	const refreshed = classifySlices(enriched).find((s) => s.id === slice.id)
	return refreshed ? { slice: refreshed } : { outcome: 'partial' }
}

function callPrepare(phaseDeps: PhaseDeps, role: Role, slice: Slice, ctx: LoopPhaseCtx) {
	if (role === 'implement') return prepareImplement(phaseDeps, slice, ctx)
	if (role === 'review') return prepareReview(phaseDeps, slice, ctx)
	return prepareAddress(phaseDeps, slice, ctx)
}

function callLand(phaseDeps: PhaseDeps, role: Role, slice: Slice, verdict: TurnOut, ctx: LoopPhaseCtx) {
	if (role === 'implement') return landImplement(phaseDeps, slice, verdict, ctx)
	if (role === 'review') return landReview(phaseDeps, slice, verdict, ctx)
	return landAddress(phaseDeps, slice, verdict, ctx)
}
