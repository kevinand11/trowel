import { randomBytes } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { loadConfig } from '../config.ts'
import { getHarness, type HarnessKind } from '../harnesses/registry.ts'
import type { Config } from '../schema.ts'
import { getStorage, type StorageKind } from '../storages/registry.ts'
import type { Storage, StorageDeps, Slice } from '../storages/types.ts'
import { createGh } from '../utils/gh-ops.ts'
import { createRepoGit } from '../utils/git-ops.ts'
import { tryExec } from '../utils/shell.ts'
import { runLoop } from '../work/loop.ts'
import { landAddress, landImplement, landReview, prepareAddress, prepareImplement, prepareReview, type PhaseDeps } from '../work/phases.ts'
import { loadPrompt, type Role } from '../work/prompts.ts'
import { spawnTurn } from '../work/turn.ts'
import type { TurnIn, TurnOut } from '../work/verdict.ts'
import { ensureTrowelDir, sweepOrphanWorktrees, type TurnWorktree } from '../work/worktrees.ts'

type LoopWiring = {
	config: Config
	projectRoot: string
	storage: Storage
	integrationBranch: (prdId: string) => Promise<string>
	runOnePhase: (prdId: string, slice: Slice, role: Role) => Promise<void>
	runLoopFor: (prdId: string, integrationBranch: string) => Promise<void>
}

export async function buildLoopWiring(opts: { storage?: StorageKind; harness?: HarnessKind }): Promise<LoopWiring> {
	const { config, projectRoot } = await loadConfig()
	if (!projectRoot) throw new Error('no project root found')

	const storageKind = opts.storage ?? config.storage
	const harnessKind = opts.harness ?? config.agent.harness
	const harness = getHarness(harnessKind)

	const log = (m: string) => process.stdout.write(`${m}\n`)
	const git = createRepoGit(projectRoot)
	const gh = createGh()

	const storageDeps: StorageDeps = {
		gh,
		repoRoot: projectRoot,
		projectRoot,
		prdsDir: path.resolve(projectRoot, config.docs.prdsDir),
		labels: config.labels,
		closeOptions: config.close,
		git,
		log,
	}
	const storage = getStorage(storageKind, storageDeps)

	await ensureTrowelDir(projectRoot)

	const runAgent = async ({ worktree, logPath, role }: { worktree: TurnWorktree; logPath: string; role: Role; branch: string }): Promise<{ commits: number }> => {
			const rendered = await loadPrompt(role, {})
			const promptFile = path.join(worktree.worktreePath, '.trowel', `prompt-${role}.md`)
			await writeFile(promptFile, rendered)

			await mkdir(path.dirname(logPath), { recursive: true })
			const logStream = createWriteStream(logPath, { flags: 'a' })

			const baseHeadR = await tryExec('git', ['-C', worktree.worktreePath, 'rev-parse', 'HEAD'])
			const baseHead = baseHeadR.ok ? baseHeadR.stdout.trim() : ''

			const { waitForExit } = await harness.spawnPrint({
				model: config.agent.model,
				prompt: rendered,
				cwd: worktree.worktreePath,
				logStream,
			})
			const exitCode = await waitForExit
			logStream.end()

			if (exitCode !== 0) {
				log(`[work prd-${worktree.prdId} slice-${worktree.branch}] ${harness.kind} exited ${exitCode}; see ${logPath}`)
			}

			const headAfterR = await tryExec('git', ['-C', worktree.worktreePath, 'rev-parse', 'HEAD'])
			const headAfter = headAfterR.ok ? headAfterR.stdout.trim() : baseHead
			const commitsR = await tryExec('git', ['-C', worktree.worktreePath, 'rev-list', '--count', `${baseHead}..${headAfter}`])
			const commits = commitsR.ok ? parseInt(commitsR.stdout.trim(), 10) : 0

			return { commits }
		}

	const makeSpawnTurnFor = (prdId: string) => async (args: { role: Role; slice: Slice; branch: string; turnIn: TurnIn }) =>
		spawnTurn(args, {
			prdId,
			projectRoot,
			copyToWorktree: config.turn.copyToWorktree,
			git,
			runAgent,
			randId: () => randomBytes(3).toString('hex'),
			log,
		})

	const integrationBranch = async (prdId: string): Promise<string> => {
		const prd = await storage.findPrd(prdId)
		if (!prd) throw new Error(`PRD '${prdId}' not found`)
		return prd.branch
	}

	const runOnePhase = async (prdId: string, slice: Slice, role: Role): Promise<void> => {
		const branch = await integrationBranch(prdId)
		const ctx = { prdId, integrationBranch: branch, config: { usePrs: config.work.usePrs, review: config.work.review, perSliceBranches: config.work.perSliceBranches } }
		const phaseDeps: PhaseDeps = { storage, git, gh, log, mergeNoVerify: config.work.mergeNoVerify, projectRoot }
		const prep = role === 'implement'
			? await prepareImplement(phaseDeps, slice, ctx)
			: role === 'review'
				? await prepareReview(phaseDeps, slice, ctx)
				: await prepareAddress(phaseDeps, slice, ctx)
		const verdict: TurnOut = await makeSpawnTurnFor(prdId)({ role, slice, branch: prep.branch, turnIn: prep.turnIn })
		if (role === 'implement') await landImplement(phaseDeps, slice, verdict, ctx)
		else if (role === 'review') await landReview(phaseDeps, slice, verdict, ctx)
		else await landAddress(phaseDeps, slice, verdict, ctx)
	}

	const runLoopFor = async (prdId: string, branch: string): Promise<void> => {
		await sweepOrphanWorktrees({
			projectRoot,
			git,
			cleanupAge: config.work.worktreeCleanupAge,
			orphanCheck: async (sweptPrdId, sweptBranch) => {
				if (sweptPrdId !== prdId) return false
				return !(await git.branchExists(sweptBranch))
			},
		}).catch((e: Error) => log(`sweepOrphanWorktrees failed: ${e.message}`))

		await runLoop(prdId, {
			storage,
			git,
			gh,
			integrationBranch: branch,
			spawnTurn: makeSpawnTurnFor(prdId),
			log,
			config: {
				usePrs: config.work.usePrs,
				review: config.work.review,
				perSliceBranches: config.work.perSliceBranches,
				sliceStepCap: config.work.sliceStepCap,
				maxConcurrent: config.turn.maxConcurrent,
				mergeNoVerify: config.work.mergeNoVerify,
			},
			projectRoot,
		})
	}

	return { config, projectRoot, storage, integrationBranch, runOnePhase, runLoopFor }
}
