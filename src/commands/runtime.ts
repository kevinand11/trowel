import path from 'node:path'

import { loadConfig, type Config } from '../config'
import { readOptionalFile } from './grill-flow.ts'
import { getHarness, type HarnessKind } from '../harnesses/registry.ts'
import { loadPrompt, type PromptName } from '../prompts/load.ts'
import { getStorage } from '../storages/registry.ts'
import type { Storage } from '../storages/types.ts'
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

export function buildStorage(base: CommandBase, storage: string): Storage {
	return getStorage(storage, {
		gh: base.gh,
		git: base.git,
		changesDir: path.resolve(base.projectRoot, base.config.docs.changesDir),
		labels: base.config.labels,
	})
}

export type GrillCommandRuntime = {
	config: Config
	projectRoot: string
	storage: Storage
	git: GitOps
	promptText: string
	runInteractive: (opts: { promptText: string; cwd: string; initialPrompt?: string }) => Promise<void>
	readOut: () => Promise<string | null>
	preflight: () => Promise<void>
	stdout: (s: string) => void
	confirm: (msg: string) => Promise<boolean>
}

export async function buildGrillCommandRuntime(
	commandName: string,
	promptName: PromptName,
	opts: { storage?: string; harness?: string },
	outFileName: string,
): Promise<GrillCommandRuntime> {
	const base = await loadCommandBase(commandName)
	const { config, projectRoot, git } = base
	const storage = opts.storage ?? config.storage
	const harnessKind = (opts.harness as HarnessKind | undefined) ?? config.agent.harness
	const harness = getHarness(harnessKind)
	const outPath = path.resolve(projectRoot, '.trowel', outFileName)
	return {
		config,
		projectRoot,
		storage: buildStorage(base, storage),
		git,
		promptText: await loadPrompt(promptName),
		runInteractive: async ({ promptText, cwd, initialPrompt }) => {
			const { waitForExit } = await harness.spawnInteractive({
				model: config.agent.model,
				systemPrompt: promptText,
				cwd,
				initialPrompt,
			})
			const code = await waitForExit
			if (code !== 0) throw new Error(`${harness.name} exited with code ${code}`)
		},
		readOut: () => readOptionalFile(outPath),
		preflight: () => changeStartPreflight({ git, harness, commandName }),
		stdout: (s) => process.stdout.write(s),
		confirm: async (msg) => {
			const { confirm } = await import('@inquirer/prompts')
			return confirm({ message: msg, default: false })
		},
	}
}

async function changeStartPreflight(args: { git: GitOps; harness: ReturnType<typeof getHarness>; commandName: string }): Promise<void> {
	const failures = await changeStartPreflightFailures(args)
	if (failures.length > 0) throw new Error(`preflight failed:\n${failures.map((f) => `  · ${f}`).join('\n')}`)
}

async function changeStartPreflightFailures(args: {
	git: GitOps
	harness: ReturnType<typeof getHarness>
	commandName: string
}): Promise<string[]> {
	return [await dirtyTreeFailure(args.git), await harnessFailure(args.harness, args.commandName), await ghAuthFailure()].filter(
		(f): f is string => f !== null,
	)
}

async function dirtyTreeFailure(git: GitOps): Promise<string | null> {
	if (await git.isWorkingTreeClean()) return null
	return (await confirmDirtyChangeStart(await git.statusShort())) ? null : 'working tree is dirty'
}

async function harnessFailure(harness: ReturnType<typeof getHarness>, commandName: string): Promise<string | null> {
	const harnessV = await harness.detectVersion()
	return harnessV.installed
		? null
		: `${harness.name} CLI not found on PATH (required for trowel ${commandName} with agent.harness=${harness.name})`
}

async function ghAuthFailure(): Promise<string | null> {
	const ghR = await import('../utils/shell.ts').then(({ tryExec }) => tryExec('gh', ['auth', 'status']))
	return ghR.ok ? null : 'gh not authenticated or not on PATH (run `gh auth login`)'
}

async function confirmDirtyChangeStart(statusShort: string): Promise<boolean> {
	const { confirm } = await import('@inquirer/prompts')
	if (statusShort.trim()) process.stdout.write(`\nDirty working tree:\n${statusShort.trimEnd()}\n\n`)
	return confirm({
		message:
			'Working tree is dirty. Commit/stash first for a clean change start, or continue and let the change-start grill account for your current changes. Continue with dirty tree?',
		default: false,
	})
}

export async function exitOnCommandError(commandName: string, fn: () => Promise<void>): Promise<void> {
	try {
		await fn()
	} catch (error) {
		process.stderr.write(`trowel ${commandName}: ${(error as Error).message}\n`)
		process.exit(1)
	}
}
