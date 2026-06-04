import { runCloseOut } from './close-out.ts'
import type { EntityLoopDeps, LoopEntity } from './entity-loop.ts'
import { callFixLand, callFixPrepare, classifyFix, type FixPhaseConfig, type FixPhaseDeps } from './fix-phases.ts'
import type { LoopConfig } from './loop.ts'
import type { Role } from '../prompts/load.ts'
import type { FixRecord, Slice } from '../storages/types.ts'
import type { GhOps } from '../utils/gh-ops.ts'

export type FixLoopEntity = Extract<LoopEntity, { kind: 'fix' }>
type FixEntityLoopDeps = EntityLoopDeps

type FixStepResult = 'progress' | 'stop'

export async function runFixEntity(entity: FixLoopEntity, deps: FixEntityLoopDeps): Promise<void> {
	const fixPhaseDeps = fixPhaseDepsFor(deps)
	while (true) {
		const result = await runFixEntityStep(entity, deps, fixPhaseDeps)
		if (result === 'stop') return
	}
}

function fixPhaseDepsFor(deps: FixEntityLoopDeps): FixPhaseDeps {
	return {
		storage: deps.storage,
		git: deps.git,
		gh: deps.gh,
		log: deps.log,
		projectRoot: deps.projectRoot,
		config: fixPhaseConfig(deps.config),
	}
}

async function runFixEntityStep(entity: FixLoopEntity, deps: FixEntityLoopDeps, fixPhaseDeps: FixPhaseDeps): Promise<FixStepResult> {
	const fix = await openFixOrStop(entity, deps)
	if (!fix) return 'stop'
	const enriched = await enrichFixIfNeeded(deps, fix)
	const resume = classifyFix(enriched, { usePrs: deps.config.usePrs, review: deps.config.review })
	if (await stopAfterDoneFixResume(entity, enriched, resume, deps)) return 'stop'
	const outcome = await runFixPhase(entity, enriched, resume as Role, deps, fixPhaseDeps)
	return stopAfterFixOutcome(entity, outcome, deps) ? 'stop' : 'progress'
}

async function openFixOrStop(entity: FixLoopEntity, deps: FixEntityLoopDeps): Promise<FixRecord | null> {
	const fix = await deps.storage.findFix(entity.id)
	if (!fix) throw new Error(`Fix '${entity.id}' not found`)
	if (fix.state !== 'CLOSED') return fix
	deps.log(`[work fix-${entity.id}] CLOSED`)
	return null
}

function enrichFixIfNeeded(deps: FixEntityLoopDeps, fix: FixRecord): Promise<FixRecord> | FixRecord {
	return deps.config.usePrs ? enrichFixPrState(deps.gh, fix) : fix
}

async function stopAfterDoneFixResume(entity: FixLoopEntity, enriched: FixRecord, resume: ReturnType<typeof classifyFix>, deps: FixEntityLoopDeps): Promise<boolean> {
	if (resume !== 'done') return false
	if (deps.config.usePrs) await ensureFixCloseOutPrReady(entity, enriched, deps)
	return true
}

async function ensureFixCloseOutPrReady(entity: FixLoopEntity, fix: FixRecord, deps: FixEntityLoopDeps): Promise<void> {
	deps.log(`[work fix-${entity.id}] no agent action; running Close-out to ensure PR ready`)
	await runCloseOut(
		{ kind: 'fix', id: entity.id, branch: entity.branch, targetBranch: fix.targetBranch, title: entity.title },
		{
			storage: deps.storage,
			git: deps.git,
			gh: deps.gh,
			log: deps.log,
			config: { usePrs: true, deleteBranch: deps.config.usePrs ? 'never' : 'prompt', mergeNoVerify: deps.config.mergeNoVerify },
			projectRoot: deps.projectRoot,
		},
	)
}

async function runFixPhase(entity: FixLoopEntity, fix: FixRecord, role: Role, deps: FixEntityLoopDeps, fixPhaseDeps: FixPhaseDeps) {
	deps.log(`[work fix-${entity.id}] state=${role}: "${fix.title}"`)
	const prep = await callFixPrepare(role, fixPhaseDeps, fix)
	const slice = sliceFromFix(fix)
	const verdict = await deps.spawnTurn({ role, slice, branch: prep.branch, turnIn: prep.turnIn })
	deps.log(`[work fix-${entity.id}] ${role} verdict: ${verdict.verdict}, ${verdict.commits} commit(s)`)
	return callFixLand(role, fixPhaseDeps, fix, verdict)
}

function sliceFromFix(fix: FixRecord): Slice {
	return {
		id: fix.id,
		title: fix.title,
		body: fix.body,
		state: fix.state,
		readyForAgent: fix.readyForAgent,
		needsRevision: fix.needsRevision,
		blockedBy: fix.blockedBy,
		prState: fix.prState,
	}
}

function stopAfterFixOutcome(entity: FixLoopEntity, outcome: Awaited<ReturnType<typeof callFixLand>>, deps: FixEntityLoopDeps): boolean {
	if (outcome === 'partial') deps.log(`[work fix-${entity.id}] partial; stopping for this run`)
	return outcome !== 'progress'
}

async function enrichFixPrState(gh: GhOps, fix: FixRecord): Promise<FixRecord> {
	try {
		const open = await gh.listOpenPrs()
		const found = open.find((p) => p.headRefName === fix.branch)
		return { ...fix, prState: found ? 'draft' : null }
	} catch {
		return fix
	}
}

function fixPhaseConfig(c: LoopConfig): FixPhaseConfig {
	return {
		usePrs: c.usePrs,
		review: c.review,
		mergeNoVerify: c.mergeNoVerify,
		// deleteBranch policy is overridden by Close-out's auto-coercion ('prompt' → 'never') — pass
		// 'prompt' through here; the inline Close-out call inside landFixImplement will respect it.
		deleteBranch: 'prompt',
	}
}
