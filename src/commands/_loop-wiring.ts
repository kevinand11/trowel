import { randomBytes } from 'node:crypto'
import { copyFile, mkdir, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { claudeCode, createWorktree as sandcastleCreateWorktree, type Worktree as SandcastleWorktree } from '@ai-hero/sandcastle'
import { docker } from '@ai-hero/sandcastle/sandboxes/docker'

import { getBackend } from '../backends/registry.ts'
import type { Backend, BackendDeps, Slice } from '../backends/types.ts'
import { loadConfig } from '../config.ts'
import type { Config } from '../schema.ts'
import { realGhRunner } from '../utils/gh-runner.ts'
import { exec, tryExec } from '../utils/shell.ts'
import { slug as slugify } from '../utils/slug.ts'
import { ensureSandboxImage } from '../work/image.ts'
import { processFileSlice, runFileLoop } from '../work/loops/file.ts'
import { type IssueLoopDeps, processIssueSlice, runIssueLoop } from '../work/loops/issue.ts'
import { loadPrompt, type BackendKind, type Role } from '../work/prompts.ts'
import { spawnSandbox, type Worktree } from '../work/sandbox.ts'
import type { SandboxIn } from '../work/verdict.ts'
import { ensureTrowelDir } from '../work/worktrees.ts'

const TROWEL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const ASSETS_DOCKERFILE = path.join(TROWEL_ROOT, 'assets', 'Dockerfile')
const TROWEL_HOME = path.join(homedir(), '.trowel')
const TROWEL_HOME_DOCKERFILE = path.join(TROWEL_HOME, 'Dockerfile')

const realImageDeps = {
	dockerfileSrc: ASSETS_DOCKERFILE,
	dockerfileDst: TROWEL_HOME_DOCKERFILE,
	copyFile: async (src: string, dst: string) => {
		await mkdir(path.dirname(dst), { recursive: true })
		await copyFile(src, dst)
	},
	statFile: async (p: string) => {
		try {
			const s = await stat(p)
			return { mtime: s.mtime }
		} catch {
			return null
		}
	},
	inspectImageCreatedAt: async (imageName: string): Promise<Date | null> => {
		const r = await tryExec('docker', ['image', 'inspect', imageName, '--format', '{{.Created}}'])
		if (!r.ok) return null
		const created = r.stdout.trim()
		if (!created) return null
		const parsed = new Date(created)
		return Number.isNaN(parsed.getTime()) ? null : parsed
	},
	buildImage: async (imageName: string, dockerfilePath: string, buildContext: string) => {
		await exec('docker', ['build', '-t', imageName, '-f', dockerfilePath, buildContext])
	},
}

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

	const createWorktree = async ({ branch }: { branch: string }): Promise<Worktree> => sandcastleCreateWorktree({
			branchStrategy: { type: 'branch', branch },
			cwd: projectRoot,
			copyToWorktree: config.sandbox.copyToWorktree,
		})

	const ROLE_TO_CAP: Record<Role, keyof Config['sandbox']['iterationCaps']> = {
		implement: 'implementer',
		review: 'reviewer',
		address: 'addresser',
	}

	const makeRunAgent =
		(integrationBranchName: string) =>
		async ({ worktree, logPath, role }: { worktree: Worktree; logPath: string; role: Role; branch: string }): Promise<{ commits: number }> => {
			const rendered = await loadPrompt(role, backend.name as BackendKind, { INTEGRATION_BRANCH: integrationBranchName })
			const promptFile = path.join(worktree.worktreePath, '.trowel', `prompt-${role}.md`)
			await writeFile(promptFile, rendered)

			await ensureSandboxImage(config.sandbox.image, realImageDeps)

			await mkdir(path.dirname(logPath), { recursive: true })

			const sandcastleWt = worktree as SandcastleWorktree
			const sandbox = await sandcastleWt.createSandbox({
				sandbox: docker({
					imageName: config.sandbox.image,
					mounts: [{ hostPath: '~/.claude', sandboxPath: '/home/agent/.claude' }],
				}),
				hooks: {
					sandbox: {
						onSandboxReady: config.sandbox.onReady.map((c) => ({ command: c, timeoutMs: 600_000 })),
					},
				},
			})
			try {
				const result = await sandbox.run({
					maxIterations: config.sandbox.iterationCaps[ROLE_TO_CAP[role]],
					agent: claudeCode(config.agent.model),
					promptFile,
					logging: { type: 'file', path: logPath },
				})
				return { commits: result.commits.length }
			} finally {
				await sandbox.close()
			}
		}

	const makeSpawnSandboxFor = (prdId: string, integrationBranchName: string) => async (args: { role: Role; slice: Slice; branch: string; sandboxIn: SandboxIn }) =>
		spawnSandbox(args, {
			prdId,
			repoRoot: projectRoot,
			createWorktree,
			runAgent: makeRunAgent(integrationBranchName),
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
				spawnSandbox: async ({ role, slice: s, sandboxIn }) => makeSpawnSandboxFor(prdId, branch)({ role, slice: s, branch, sandboxIn }),
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
				spawnSandbox: makeSpawnSandboxFor(prdId, branch),
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
			spawnSandbox: async ({ role, slice: s, sandboxIn }) => makeSpawnSandboxFor(prdId, branch)({ role, slice: s, branch, sandboxIn }),
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
			spawnSandbox: makeSpawnSandboxFor(prdId, branch),
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
