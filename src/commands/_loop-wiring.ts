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
import { loadClaudeOauthToken, realLoadOauthTokenDeps } from '../utils/oauth-token.ts'
import { exec, tryExec } from '../utils/shell.ts'
import { ensureSandboxImage } from '../work/image.ts'
import { runLoop } from '../work/loop.ts'
import { loadPrompt, type BackendKind, type Role } from '../work/prompts.ts'
import { spawnSandbox, type Worktree } from '../work/sandbox.ts'
import type { SandboxIn, SandboxOut } from '../work/verdict.ts'
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
	runOnePhase: (prdId: string, slice: Slice, role: Role) => Promise<void>
	runLoopFor: (prdId: string, integrationBranch: string) => Promise<void>
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
	const gitCreateRemoteBranch = async (newBranch: string, baseBranch: string) => {
		const fetched = await tryExec('git', ['-C', projectRoot, 'fetch', '-q', 'origin', baseBranch])
		if (!fetched.ok) throw fetched.error
		const pushed = await tryExec('git', ['-C', projectRoot, 'push', '-q', 'origin', `refs/remotes/origin/${baseBranch}:refs/heads/${newBranch}`])
		if (!pushed.ok) throw pushed.error
	}

	const log = (m: string) => process.stdout.write(`${m}\n`)

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
		git: {
			fetch: gitFetch,
			push: gitPush,
			checkout: gitCheckout,
			mergeNoFf: gitMergeNoFf,
			deleteRemoteBranch: gitDeleteRemoteBranch,
			createRemoteBranch: gitCreateRemoteBranch,
		},
		log,
	}
	const backend = getBackend(backendKind, backendDeps)

	await ensureTrowelDir(projectRoot)

	const oauthToken = await loadClaudeOauthToken(projectRoot, realLoadOauthTokenDeps)
	const sandboxEnv: Record<string, string> = oauthToken !== null ? { CLAUDE_CODE_OAUTH_TOKEN: oauthToken } : {}

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
					env: sandboxEnv,
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

	const integrationBranch = async (prdId: string): Promise<string> => {
		const prd = await backend.findPrd(prdId)
		if (!prd) throw new Error(`PRD '${prdId}' not found`)
		return prd.branch
	}

	const runOnePhase = async (prdId: string, slice: Slice, role: Role): Promise<void> => {
		const branch = await integrationBranch(prdId)
		const ctx = { prdId, integrationBranch: branch, config: { usePrs: config.work.usePrs, review: config.work.review } }
		const prep = role === 'implement'
			? await backend.prepareImplement(slice, ctx)
			: role === 'review'
				? await backend.prepareReview(slice, ctx)
				: await backend.prepareAddress(slice, ctx)
		const verdict: SandboxOut = await makeSpawnSandboxFor(prdId, branch)({ role, slice, branch: prep.branch, sandboxIn: prep.sandboxIn })
		if (role === 'implement') await backend.landImplement(slice, verdict, ctx)
		else if (role === 'review') await backend.landReview(slice, verdict, ctx)
		else await backend.landAddress(slice, verdict, ctx)
	}

	const runLoopFor = async (prdId: string, branch: string): Promise<void> => {
		await runLoop(prdId, {
			backend,
			integrationBranch: branch,
			spawnSandbox: makeSpawnSandboxFor(prdId, branch),
			log,
			config: {
				usePrs: config.work.usePrs,
				review: config.work.review,
				maxIterations: config.work.maxIterations,
				sliceStepCap: config.work.sliceStepCap,
				maxConcurrent: config.sandbox.maxConcurrent,
			},
		})
	}

	return { config, projectRoot, backend, integrationBranch, runOnePhase, runLoopFor }
}
