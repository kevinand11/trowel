import { createWriteStream } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { buildStorage, loadCommandBase } from './runtime.ts'
import { getHarness, type HarnessKind } from '../harnesses/registry.ts'
import { loadPrompt, type Role } from '../prompts/load.ts'
import type { Config } from '../schema.ts'
import type { StorageKind } from '../storages/registry.ts'
import type { PhaseCtx, Storage, Slice } from '../storages/types.ts'
import { createGh } from '../utils/gh-ops.ts'
import { tryExec } from '../utils/shell.ts'
import { runEntityLoop, type LoopEntity } from '../work/entity-loop.ts'
import { landAudit, landImplement, landReview, prepareAudit, prepareImplement, prepareReview, type PhaseDeps } from '../work/phases.ts'
import { spawnTurn } from '../work/turn.ts'
import type { TurnIn, TurnOut } from '../work/verdict.ts'
import { ensureTrowelDir, type TurnWorktree } from '../work/worktrees.ts'

type LoopWiring = {
	config: Config
	projectRoot: string
	storage: Storage
	gh: ReturnType<typeof createGh>
	changeBranch: (changeId: string) => Promise<string>
	runOnePhase: (changeId: string, slice: Slice, role: Role) => Promise<void>
	runEntityLoopFor: (entity: LoopEntity) => Promise<void>
}

export async function buildLoopWiring(opts: { storage?: StorageKind; harness?: HarnessKind }): Promise<LoopWiring> {
	const base = await loadCommandBase('work')
	const { config, projectRoot, git, gh } = base
	const storageKind = opts.storage ?? config.storage
	const harnessKind = opts.harness ?? config.agent.harness
	const harness = getHarness(harnessKind)
	const log = (m: string) => process.stdout.write(`${new Date().toISOString()} ${m}\n`)
	const storage = buildStorage(base, storageKind, { log })

	await ensureTrowelDir(projectRoot)

	const runAgent = async ({ worktree, logPath, role }: { worktree: TurnWorktree; logPath: string; role: Role; branch: string }): Promise<{ commits: number }> => {
			const rendered = await loadPrompt(role)
			const promptFile = path.join(worktree.worktreePath, '.trowel', `prompt-${role}.md`)
			await writeFile(promptFile, rendered)

			await mkdir(path.dirname(logPath), { recursive: true })
			const logStream = createWriteStream(logPath, { flags: 'a' })

			const startedAt = new Date().toISOString()
			logStream.write(`\n=== ${startedAt} · change-${worktree.changeId} · ${role} · harness=${harness.kind} ===\n`)

			const baseHead = await gitStdoutOr(worktree.worktreePath, ['rev-parse', 'HEAD'], '')
			const { waitForExit } = await harness.spawnPrint({
				model: config.agent.model,
				prompt: rendered,
				cwd: worktree.worktreePath,
				logStream,
			})
			const exitCode = await waitForExit
			const endedAt = new Date().toISOString()
			logStream.write(`\n=== ${endedAt} · exit=${exitCode} ===\n`)
			logStream.end()
			logHarnessExitIfFailed(exitCode, worktree, harness.kind, logPath, log)

			const headAfter = await gitStdoutOr(worktree.worktreePath, ['rev-parse', 'HEAD'], baseHead)
			const commits = await gitCountOrZero(worktree.worktreePath, `${baseHead}..${headAfter}`)
			return { commits }
		}

	const makeSpawnTurnFor = (scopeId: string) => async (args: { role: Role; slice: Slice; branch: string; turnIn: TurnIn }) =>
		spawnTurn(args, {
			changeId: scopeId,
			projectRoot,
			copyToWorktree: config.turn.copyToWorktree,
			git,
			runAgent,
			log,
		})

	const changeBranch = async (changeId: string): Promise<string> => {
		const change = await storage.findChange(changeId)
		if (!change) throw new Error(`Change '${changeId}' not found`)
		return change.changeBranch
	}

	const runOnePhase = async (changeId: string, slice: Slice, role: Role): Promise<void> => {
		const branch = await changeBranch(changeId)
		const ctx = { changeId, changeBranch: branch, config: { usePrs: config.ship.pr, audit: config.work.audit, perSliceBranches: config.work.perSliceBranches } }
		const phaseDeps: PhaseDeps = { storage, git, gh, log, mergeNoVerify: config.work.mergeNoVerify, projectRoot, needsRevisionLabel: config.labels.needsRevision }
		const prep = await prepareOnePhase(role, phaseDeps, slice, ctx)
		const verdict: TurnOut = await makeSpawnTurnFor(changeId)({ role, slice, branch: prep.branch, turnIn: prep.turnIn })
		await landOnePhase(role, phaseDeps, slice, verdict, ctx)
	}

	const runEntityLoopFor = async (entity: LoopEntity): Promise<void> => {
		await runEntityLoop(entity, {
			storage,
			git,
			gh,
			spawnTurn: makeSpawnTurnFor(entity.id),
			log,
			config: {
				usePrs: config.ship.pr,
				audit: config.work.audit,
				perSliceBranches: config.work.perSliceBranches,
				maxConcurrent: config.turn.maxConcurrent,
				mergeNoVerify: config.work.mergeNoVerify,
				needsRevisionLabel: config.labels.needsRevision,
			},
			projectRoot,
		})
	}

	return { config, projectRoot, storage, gh, changeBranch, runOnePhase, runEntityLoopFor }
}

async function gitStdoutOr(cwd: string, args: string[], fallback: string): Promise<string> {
	const result = await tryExec('git', ['-C', cwd, ...args])
	return result.ok ? result.stdout.trim() : fallback
}

async function gitCountOrZero(cwd: string, revRange: string): Promise<number> {
	const raw = await gitStdoutOr(cwd, ['rev-list', '--count', revRange], '0')
	const count = parseInt(raw, 10)
	return Number.isFinite(count) ? count : 0
}

function logHarnessExitIfFailed(exitCode: number, worktree: TurnWorktree, harnessKind: string, logPath: string, log: (m: string) => void): void {
	if (exitCode !== 0) log(`[work change-${worktree.changeId} slice-${worktree.branch}] ${harnessKind} exited ${exitCode}; see ${logPath}`)
}

function prepareOnePhase(role: Role, phaseDeps: PhaseDeps, slice: Slice, ctx: PhaseCtx) {
	if (role === 'implement') return prepareImplement(phaseDeps, slice, ctx)
	if (role === 'audit') return prepareAudit(phaseDeps, slice, ctx)
	return prepareReview(phaseDeps, slice, ctx)
}

function landOnePhase(role: Role, phaseDeps: PhaseDeps, slice: Slice, verdict: TurnOut, ctx: PhaseCtx) {
	if (role === 'implement') return landImplement(phaseDeps, slice, verdict, ctx)
	if (role === 'audit') return landAudit(phaseDeps, slice, verdict, ctx)
	return landReview(phaseDeps, slice, verdict, ctx)
}
