import { createWriteStream } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

import type { Config } from '../config'
import { buildStorage, loadCommandBase } from './runtime.ts'
import { getHarness, type HarnessKind } from '../harnesses/registry.ts'
import { loadPrompt, type Role } from '../prompts/load.ts'
import type { Change, Storage } from '../storages/types.ts'
import { createGh } from '../utils/gh-ops.ts'
import { tryExec } from '../utils/shell.ts'
import { runEntityLoop, type LoopEntity } from '../work/entity-loop.ts'
import { runProjectLoop } from '../work/project-loop.ts'
import type { ClassifiedSlice } from '../work/slice-types.ts'
import { spawnTurn } from '../work/turn.ts'
import type { TurnIn } from '../work/verdict.ts'
import { ensureTrowelDir, type TurnWorktree } from '../work/worktrees.ts'

type LoopWiring = {
	config: Config
	projectRoot: string
	storage: Storage
	gh: ReturnType<typeof createGh>
	runEntityLoopFor: (entity: LoopEntity, opts?: { loop?: boolean }) => Promise<void>
	runProjectLoop: (opts?: { loop?: boolean }) => Promise<void>
}

export async function buildLoopWiring(opts: { storage?: string; harness?: HarnessKind }): Promise<LoopWiring> {
	const base = await loadCommandBase('work')
	const { config, projectRoot, git, gh } = base
	const harnessKind = opts.harness ?? config.agent.harness
	const harness = getHarness(harnessKind)
	const log = (m: string) => process.stdout.write(`${new Date().toISOString()} ${m}\n`)
	const storage = buildStorage(base, opts.storage ?? config.storage)

	await ensureTrowelDir(projectRoot)

	const runAgent = async ({
		worktree,
		logPath,
		role,
	}: {
		worktree: TurnWorktree
		logPath: string
		role: Role
		branch: string
	}): Promise<{ commits: number }> => {
		const rendered = await loadPrompt(role)
		const promptFile = path.join(worktree.worktreePath, '.trowel', `prompt-${role}.md`)
		await writeFile(promptFile, rendered)

		await mkdir(path.dirname(logPath), { recursive: true })
		const logStream = createWriteStream(logPath, { flags: 'a' })

		const startedAt = new Date().toISOString()
		logStream.write(`\n=== ${startedAt} · change-${worktree.changeId} · ${role} · harness=${harness.name} ===\n`)

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
		logHarnessExitIfFailed(exitCode, worktree, harness.name, logPath, log)

		const headAfter = await gitStdoutOr(worktree.worktreePath, ['rev-parse', 'HEAD'], baseHead)
		const commits = await gitCountOrZero(worktree.worktreePath, `${baseHead}..${headAfter}`)
		return { commits }
	}

	const makeSpawnTurnFor = (scopeId: string) => async (args: { role: Role; slice?: ClassifiedSlice; change?: Pick<Change, 'id' | 'title' | 'body'>; branch: string; turnIn: TurnIn }) =>
		spawnTurn(args, {
			changeId: scopeId,
			projectRoot,
			copyToWorktree: config.turn.copyToWorktree,
			git,
			runAgent,
			log,
		})

	const loopConfig = {
		pr: config.ship.pr,
		audit: config.work.audit,
		perSliceBranches: config.work.perSliceBranches,
		maxConcurrent: config.turn.maxConcurrent,
		mergeNoVerify: config.work.mergeNoVerify,
		loopPollSeconds: config.work.loopPollSeconds,
		needsRevisionLabel: config.labels.needsRevision,
	}

	const runEntityLoopFor = async (entity: LoopEntity, opts: { loop?: boolean } = {}): Promise<void> => {
		await runEntityLoop(entity, {
			storage,
			git,
			gh,
			spawnTurn: makeSpawnTurnFor(entity.id),
			log,
			config: loopConfig,
			projectRoot,
		}, opts)
	}

	const runProjectLoopFor = async (opts: { loop?: boolean } = {}): Promise<void> => {
		await runProjectLoop({
			storage,
			git,
			gh,
			spawnTurn: (changeId, args) => makeSpawnTurnFor(changeId)(args),
			log,
			config: loopConfig,
			projectRoot,
		}, opts)
	}

	return { config, projectRoot, storage, gh, runEntityLoopFor, runProjectLoop: runProjectLoopFor }
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

function logHarnessExitIfFailed(
	exitCode: number,
	worktree: TurnWorktree,
	harnessKind: string,
	logPath: string,
	log: (m: string) => void,
): void {
	if (exitCode !== 0) log(`[work change-${worktree.changeId} slice-${worktree.branch}] ${harnessKind} exited ${exitCode}; see ${logPath}`)
}

