import { randomBytes } from 'node:crypto'
import path from 'node:path'

import { getBackend } from '../backends/registry.ts'
import type { Backend, BackendDeps, Slice } from '../backends/types.ts'
import { loadConfig } from '../config.ts'
import type { Config } from '../schema.ts'
import { realGhRunner } from '../utils/gh-runner.ts'
import { tryExec } from '../utils/shell.ts'
import { slug as slugify } from '../utils/slug.ts'
import { processFileSlice, runFileLoop } from '../work/loops/file.ts'
import { type IssueLoopDeps, processIssueSlice, runIssueLoop } from '../work/loops/issue.ts'
import type { Role } from '../work/prompts.ts'
import { spawnSandbox } from '../work/sandbox.ts'
import type { SandboxIn } from '../work/verdict.ts'
import { addWorktree, ensureTrowelDir, removeWorktree } from '../work/worktrees.ts'

export type LoopWiring = {
	config: Config
	projectRoot: string
	backend: Backend
	integrationBranch: (prdId: string) => Promise<string>
	runOnePhase: (prdId: string, slice: Slice) => Promise<void>
	runFileLoopFor: (prdId: string, integrationBranch: string) => Promise<void>
	runIssueLoopFor: (prdId: string, integrationBranch: string) => Promise<void>
}

/**
 * Builds the gh/git/sandbox callbacks shared by `work`, `implement`, `review`, `address`.
 * The `runAgent` callback inside spawnSandbox is intentionally unimplemented; production
 * wiring needs `@ai-hero/sandcastle` integration (see TODO Section 1, Phase E).
 */
export async function buildLoopWiring(opts: { backend?: string }): Promise<LoopWiring> {
	const { config, projectRoot } = await loadConfig()
	if (!projectRoot) throw new Error('no project root found')

	const backendKind = opts.backend ?? config.backend
	const backendDeps: BackendDeps = {
		gh: realGhRunner,
		repoRoot: projectRoot,
		projectRoot,
		baseBranch: config.baseBranch,
		branchPrefix: config.branchPrefix,
		prdsDir: path.resolve(projectRoot, config.docs.prdsDir),
		docMsg: config.commit.docMsg,
		labels: config.labels,
		closeOptions: config.close,
		confirm: async () => false,
	}
	const backend = getBackend(backendKind, backendDeps)

	await ensureTrowelDir(projectRoot)
	const worktreesDir = path.join(projectRoot, '.trowel', 'worktrees')

	const gitFetch = async (b: string) => {
		const r = await tryExec('git', ['-C', projectRoot, 'fetch', '-q', 'origin', b])
		if (!r.ok) throw r.error
	}
	const gitPush = async (b: string) => {
		const r = await tryExec('git', ['-C', projectRoot, 'push', '-q', 'origin', b])
		if (!r.ok) throw r.error
	}
	const gitCheckout = async (b: string) => {
		const r = await tryExec('git', ['-C', projectRoot, 'checkout', '-q', b])
		if (!r.ok) throw r.error
	}
	const gitMergeNoFf = async (b: string) => {
		const r = await tryExec('git', ['-C', projectRoot, 'merge', '--no-ff', '-q', b])
		if (!r.ok) throw r.error
	}
	const gitDeleteRemoteBranch = async (b: string) => {
		const r = await tryExec('git', ['-C', projectRoot, 'push', '-q', 'origin', `:${b}`])
		if (!r.ok) throw r.error
	}
	const findPrNumber = async (sliceBranch: string): Promise<number> => {
		const r = await realGhRunner(['pr', 'list', '--head', sliceBranch, '--json', 'number', '--jq', '.[0].number'])
		if (!r.ok || !r.stdout.trim()) throw new Error(`no PR found for head '${sliceBranch}'`)
		return Number.parseInt(r.stdout.trim(), 10)
	}

	const runAgent = async (_args: { worktreePath: string; role: Role; branch: string }): Promise<void> => {
		throw new Error('runAgent not configured — wire `@ai-hero/sandcastle` integration (see TODO Section 1, Phase E)')
	}

	const makeSpawnSandboxFor = (prdId: string) => async (args: { role: Role; slice: Slice; branch: string; sandboxIn: SandboxIn }) =>
		spawnSandbox(args, {
			prdId,
			repoRoot: projectRoot,
			worktreesDir,
			addWorktree,
			removeWorktree,
			runAgent,
			randId: () => randomBytes(3).toString('hex'),
		})

	const log = (m: string) => process.stdout.write(`${m}\n`)

	const integrationBranch = async (prdId: string): Promise<string> => {
		const prd = await backend.findPrd(prdId)
		if (!prd) throw new Error(`PRD '${prdId}' not found`)
		return prd.branch
	}

	const runOnePhase = async (prdId: string, slice: Slice): Promise<void> => {
		const branch = await integrationBranch(prdId)
		if (backend.name === 'file') {
			await processFileSlice(prdId, slice, {
				backend,
				integrationBranch: branch,
				spawnSandbox: async ({ role, slice: s, sandboxIn }) => makeSpawnSandboxFor(prdId)({ role, slice: s, branch, sandboxIn }),
				gitPush,
				log,
			})
		} else if (backend.name === 'issue') {
			const loopDeps: IssueLoopDeps = {
				backend,
				prdId,
				integrationBranch: branch,
				gh: realGhRunner,
				gitFetch,
				gitPush,
				gitCheckout,
				gitMergeNoFf,
				gitDeleteRemoteBranch,
				findPrNumber,
				spawnSandbox: makeSpawnSandboxFor(prdId),
				log,
				slugify,
				config: { usePrs: config.work.usePrs, sliceStepCap: 1, maxIterations: 1, maxConcurrent: 1 },
			}
			await processIssueSlice(slice, loopDeps)
		} else {
			throw new Error(`unknown backend: ${backend.name}`)
		}
	}

	const runFileLoopFor = async (prdId: string, branch: string): Promise<void> => {
		await runFileLoop(prdId, {
			backend,
			integrationBranch: branch,
			spawnSandbox: async ({ role, slice: s, sandboxIn }) => makeSpawnSandboxFor(prdId)({ role, slice: s, branch, sandboxIn }),
			gitPush,
			log,
			config: { maxIterations: config.work.maxIterations, sliceStepCap: config.work.sliceStepCap },
		})
	}

	const runIssueLoopFor = async (prdId: string, branch: string): Promise<void> => {
		const loopDeps: IssueLoopDeps = {
			backend,
			prdId,
			integrationBranch: branch,
			gh: realGhRunner,
			gitFetch,
			gitPush,
			gitCheckout,
			gitMergeNoFf,
			gitDeleteRemoteBranch,
			findPrNumber,
			spawnSandbox: makeSpawnSandboxFor(prdId),
			log,
			slugify,
			config: {
				usePrs: config.work.usePrs,
				sliceStepCap: config.work.sliceStepCap,
				maxIterations: config.work.maxIterations,
				maxConcurrent: config.sandbox.maxConcurrent,
			},
		}
		await runIssueLoop(prdId, loopDeps)
	}

	return { config, projectRoot, backend, integrationBranch, runOnePhase, runFileLoopFor, runIssueLoopFor }
}
