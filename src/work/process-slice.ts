import { classify } from './classify.ts'
import type { LoopDeps } from './loop.ts'
import { integrateSlice, landAddress, landAudit, landImplement, landReview, prepareAddress, prepareAudit, prepareImplement, prepareReview, type PhaseDeps } from './phases.ts'
import type { TurnOut } from './verdict.ts'
import type { Role } from '../prompts/load.ts'
import type { ClassifiedSlice, ClassifySliceConfig, PhaseOutcome, ResumeState, Slice } from '../storages/types.ts'

export type ProcessOutcome = 'done' | 'partial' | 'no-work'

type LoopPhaseCtx = { changeId: string; changeBranch: string; config: ClassifySliceConfig }
type SliceStepResult = { outcome: ProcessOutcome } | { outcome: 'progress' }

const SANDBOX_ROLES = new Set<ResumeState>(['implement', 'audit', 'review', 'address'])

const PROCESS_OUTCOME_BY_PHASE: Record<PhaseOutcome, ProcessOutcome | null> = {
	done: 'done',
	'no-work': 'no-work',
	partial: 'partial',
	progress: null,
}

export async function processSlice(changeId: string, initial: ClassifiedSlice, deps: LoopDeps): Promise<ProcessOutcome> {
	const ctx = loopPhaseCtx(changeId, deps)
	const tag = `[work change-${changeId} slice-${initial.id}]`
	const initialOutcome = initialProcessOutcome(initial, ctx, tag, deps)
	if (initialOutcome) return initialOutcome

	const stepResult = await processSliceStep(initial, ctx, tag, deps)
	return stepResult.outcome === 'progress' ? 'no-work' : stepResult.outcome
}

function loopPhaseCtx (changeId: string, deps: LoopDeps): LoopPhaseCtx {
	return {
		changeId,
		changeBranch: deps.changeBranch,
		config: { usePrs: deps.config.usePrs, audit: deps.config.audit, perSliceBranches: deps.config.perSliceBranches },
	}
}

function initialProcessOutcome(slice: ClassifiedSlice, ctx: LoopPhaseCtx, tag: string, deps: LoopDeps): ProcessOutcome | null {
	if (classify(slice, ctx.config, ctx.changeBranch) !== 'blocked') return null
	deps.log(`${tag} blocked by [${slice.blockedBy.join(', ')}]; skipping`)
	return 'no-work'
}

async function processSliceStep(slice: ClassifiedSlice, ctx: LoopPhaseCtx, tag: string, deps: LoopDeps): Promise<SliceStepResult> {
	const state = classify(slice, ctx.config, ctx.changeBranch)
	const terminal = terminalOutcomeForState(state)
	if (terminal) return { outcome: terminal }
	if (state === 'finalize') return finalizeLandedSlice(slice, ctx, tag, deps)
	if (state === 'integrate') return integrateImplementedSlice(slice, ctx, tag, deps)
	if (!SANDBOX_ROLES.has(state)) return unexpectedStateOutcome(state, tag, deps)
	const outcome = await runSlicePhase(state as Role, slice, ctx, tag, deps)
	const processOutcome = PROCESS_OUTCOME_BY_PHASE[outcome]
	return { outcome: processOutcome ?? 'progress' }
}

function terminalOutcomeForState(state: ResumeState): ProcessOutcome | null {
	if (state === 'done') return 'done'
	if (state === 'blocked') return 'no-work'
	return null
}

async function finalizeLandedSlice(slice: ClassifiedSlice, ctx: LoopPhaseCtx, tag: string, deps: LoopDeps): Promise<SliceStepResult> {
	await deps.storage.updateSlice(ctx.changeId, slice.id, { closedAt: new Date().toISOString() })
	deps.log(`${tag} finalized landed slice`)
	return { outcome: 'progress' }
}

async function integrateImplementedSlice(slice: ClassifiedSlice, ctx: LoopPhaseCtx, tag: string, deps: LoopDeps): Promise<SliceStepResult> {
	deps.log(`${tag} state=${slice.state} action=integrate: "${slice.title}"`)
	const outcome = await integrateSlice(phaseDepsFor(deps), slice, ctx)
	return { outcome: PROCESS_OUTCOME_BY_PHASE[outcome] ?? 'progress' }
}

function unexpectedStateOutcome(state: ResumeState, tag: string, deps: LoopDeps): SliceStepResult {
	deps.log(`${tag} unexpected state ${state}; treating as partial`)
	return { outcome: 'partial' }
}

async function runSlicePhase(role: Role, slice: ClassifiedSlice, ctx: LoopPhaseCtx, tag: string, deps: LoopDeps): Promise<PhaseOutcome> {
	deps.log(`${tag} state=${slice.state} action=${role}: "${slice.title}"`)
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

function callPrepare(phaseDeps: PhaseDeps, role: Role, slice: Slice, ctx: LoopPhaseCtx) {
	if (role === 'implement') return prepareImplement(phaseDeps, slice, ctx)
	if (role === 'audit') return prepareAudit(phaseDeps, slice, ctx)
	if (role === 'review') return prepareReview(phaseDeps, slice, ctx)
	return prepareAddress(phaseDeps, slice, ctx)
}

function callLand(phaseDeps: PhaseDeps, role: Role, slice: Slice, verdict: TurnOut, ctx: LoopPhaseCtx) {
	if (role === 'implement') return landImplement(phaseDeps, slice, verdict, ctx)
	if (role === 'audit') return landAudit(phaseDeps, slice, verdict, ctx)
	if (role === 'review') return landReview(phaseDeps, slice, verdict, ctx)
	return landAddress(phaseDeps, slice, verdict, ctx)
}
