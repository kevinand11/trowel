import path from 'node:path'

import { loadConfig } from '../config.ts'
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

export async function exitOnCommandError(commandName: string, fn: () => Promise<void>): Promise<void> {
	try {
		await fn()
	} catch (error) {
		process.stderr.write(`trowel ${commandName}: ${(error as Error).message}\n`)
		process.exit(1)
	}
}
