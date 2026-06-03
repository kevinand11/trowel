import path from 'node:path'

import { readOptionalFile } from './grill-flow.ts'
import { loadConfig } from '../config.ts'
import { getHarness, type HarnessKind } from '../harnesses/registry.ts'
import { loadPrompt } from '../prompts/load.ts'
import type { Config } from '../schema.ts'
import { getStorage, type StorageKind } from '../storages/registry.ts'
import type { Storage, StorageDeps } from '../storages/types.ts'
import { createGh, type GhOps } from '../utils/gh-ops.ts'
import { createRepoGit, type GitOps } from '../utils/git-ops.ts'

export type CommandBase = {
	config: Config
	projectRoot: string
	git: GitOps
	gh: GhOps
}

export async function loadCommandBase(commandName: string): Promise<CommandBase> {
	const { config, projectRoot } = await loadConfig()
	if (!projectRoot) {
		process.stderr.write(`trowel ${commandName}: no project root found\n`)
		process.exit(1)
	}
	return { config, projectRoot, git: createRepoGit(projectRoot), gh: createGh() }
}

function buildStorageDeps(base: CommandBase, overrides: Partial<StorageDeps> = {}): StorageDeps {
	return {
		gh: base.gh,
		git: base.git,
		repoRoot: base.projectRoot,
		projectRoot: base.projectRoot,
		prdsDir: path.resolve(base.projectRoot, base.config.docs.prdsDir),
		fixesDir: path.resolve(base.projectRoot, base.config.docs.fixesDir),
		labels: base.config.labels,
		closeOptions: base.config.close,
		...overrides,
	}
}

export function buildStorage(base: CommandBase, storageKind: StorageKind, overrides: Partial<StorageDeps> = {}): Storage {
	return getStorage(storageKind, buildStorageDeps(base, overrides))
}

export type GrillCommandRuntime = {
	projectRoot: string
	storage: Storage
	git: GitOps
	promptText: string
	runInteractive: (opts: { promptText: string; cwd: string }) => Promise<void>
	readOut: () => Promise<string | null>
	preflight: () => Promise<string[]>
	stdout: (s: string) => void
	confirm: (msg: string) => Promise<boolean>
}

export async function buildGrillCommandRuntime(commandName: 'start' | 'fix', opts: { storage?: string; harness?: string }, outFileName: string): Promise<GrillCommandRuntime> {
	const base = await loadCommandBase(commandName)
	const { config, projectRoot, git } = base
	const storageKind = (opts.storage as StorageKind | undefined) ?? config.storage
	const harnessKind = (opts.harness as HarnessKind | undefined) ?? config.agent.harness
	const harness = getHarness(harnessKind)
	const outPath = path.resolve(projectRoot, '.trowel', outFileName)
	return {
		projectRoot,
		storage: buildStorage(base, storageKind),
		git,
		promptText: await loadPrompt(commandName),
		runInteractive: async ({ promptText, cwd }) => {
			const { waitForExit } = await harness.spawnInteractive({
				model: config.agent.model,
				systemPrompt: promptText,
				cwd,
			})
			const code = await waitForExit
			if (code !== 0) throw new Error(`${harness.kind} exited with code ${code}`)
		},
		readOut: () => readOptionalFile(outPath),
		preflight: async () => {
			const failures: string[] = []
			if (!(await git.isWorkingTreeClean())) failures.push(`working tree is not clean — commit or stash before running trowel ${commandName}`)
			const harnessV = await harness.detectVersion()
			if (!harnessV.installed) failures.push(`${harness.kind} CLI not found on PATH (required for trowel ${commandName} with agent.harness=${harness.kind})`)
			const ghR = await import('../utils/shell.ts').then(({ tryExec }) => tryExec('gh', ['auth', 'status']))
			if (!ghR.ok) failures.push('gh not authenticated or not on PATH (run `gh auth login`)')
			return failures
		},
		stdout: (s) => process.stdout.write(s),
		confirm: async (msg) => {
			const { confirm } = await import('@inquirer/prompts')
			return confirm({ message: msg, default: false })
		},
	}
}

export async function exitOnCommandError(commandName: string, fn: () => Promise<void>): Promise<void> {
	try {
		await fn()
	} catch (error) {
		process.stderr.write(`trowel ${commandName}: ${(error as Error).message}\n`)
		process.exit(1)
	}
}
