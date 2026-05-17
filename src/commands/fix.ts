import { readFile, unlink } from 'node:fs/promises'
import path from 'node:path'

import { loadConfig } from '../config.ts'
import { getHarness, type HarnessKind } from '../harnesses/registry.ts'
import { loadPrompt } from '../prompts/load.ts'
import { getStorage, type StorageKind } from '../storages/registry.ts'
import type { Storage, StorageDeps } from '../storages/types.ts'
import { createGh } from '../utils/gh-ops.ts'
import { createRepoGit, type GitOps } from '../utils/git-ops.ts'
import { tryExec } from '../utils/shell.ts'
import { parseFixOut } from '../work/fix-out.ts'

export type FixRuntime = {
	projectRoot: string
	storage: Storage
	git: GitOps
	fixPromptText: string
	runInteractive: (opts: { promptText: string; cwd: string }) => Promise<void>
	readFixOut: () => Promise<string | null>
	preflight: () => Promise<string[]>
	stdout: (s: string) => void
}

export async function runFix(rt: FixRuntime): Promise<void> {
	const fixOutPath = path.join(rt.projectRoot, '.trowel', 'fix-out.json')

	const failures = await rt.preflight()
	if (failures.length > 0) {
		throw new Error(`preflight failed:\n${failures.map((f) => `  · ${f}`).join('\n')}`)
	}

	// Wipe any stale fix-out.json from a prior aborted run so the read after the grill can only see
	// what the agent just wrote. Mirrors the start-flow's pre-grill discipline.
	await unlinkSwallowEnoent(fixOutPath)

	const backTo = await rt.git.currentBranch()

	try {
		await rt.runInteractive({ promptText: rt.fixPromptText, cwd: rt.projectRoot })

		const raw = await rt.readFixOut()
		if (raw === null) {
			rt.stdout('Fix not created. Working tree has grill changes; review with `git status`, then `git checkout .` to discard or stash/commit to keep.\n')
			throw new Error('fix-out.json missing — grill aborted')
		}
		const spec = parseFixOut(raw)

		const { id, branch } = await rt.storage.createFix({ title: spec.title, body: spec.body })

		rt.stdout(`\nCreated Fix ${id}\n`)
		rt.stdout(`Branch: ${branch}\n`)
		rt.stdout(`\nNext: trowel work fix ${id}\n`)

		await unlinkSwallowEnoent(fixOutPath)
	} finally {
		if (backTo && (await rt.git.currentBranch()) !== backTo) {
			if (await rt.git.branchExists(backTo)) await rt.git.checkout(backTo)
		}
	}
}

async function unlinkSwallowEnoent(p: string): Promise<void> {
	try {
		await unlink(p)
	} catch (e) {
		if ((e as { code?: string }).code !== 'ENOENT') throw e
	}
}

export async function fix(opts: { storage?: string; harness?: string }): Promise<void> {
	const { config, projectRoot } = await loadConfig()
	if (!projectRoot) {
		process.stderr.write('trowel fix: no project root found\n')
		process.exit(1)
	}

	const storageKind = (opts.storage as StorageKind | undefined) ?? config.storage
	const harnessKind = (opts.harness as HarnessKind | undefined) ?? config.agent.harness
	const harness = getHarness(harnessKind)
	const git = createRepoGit(projectRoot)
	const gh = createGh()
	const storageDeps: StorageDeps = {
		gh,
		repoRoot: projectRoot,
		projectRoot,
		prdsDir: path.resolve(projectRoot, config.docs.prdsDir),
		fixesDir: path.resolve(projectRoot, config.docs.fixesDir),
		labels: config.labels,
		closeOptions: config.close,
		git,
	}
	const storage = getStorage(storageKind, storageDeps)
	const fixOutPath = path.resolve(projectRoot, '.trowel', 'fix-out.json')

	const rt: FixRuntime = {
		projectRoot,
		storage,
		git,
		fixPromptText: await loadPrompt('fix'),
		runInteractive: async ({ promptText, cwd }) => {
			const { waitForExit } = await harness.spawnInteractive({
				model: config.agent.model,
				systemPrompt: promptText,
				cwd,
			})
			const code = await waitForExit
			if (code !== 0) throw new Error(`${harness.kind} exited with code ${code}`)
		},
		readFixOut: async () => {
			try {
				return await readFile(fixOutPath, 'utf8')
			} catch (e) {
				if ((e as { code?: string }).code === 'ENOENT') return null
				throw e
			}
		},
		preflight: async () => {
			const failures: string[] = []
			if (!(await git.isWorkingTreeClean())) failures.push('working tree is not clean — commit or stash before running trowel fix')
			const harnessV = await harness.detectVersion()
			if (!harnessV.installed) failures.push(`${harness.kind} CLI not found on PATH (required for trowel fix with agent.harness=${harness.kind})`)
			const ghR = await tryExec('gh', ['auth', 'status'])
			if (!ghR.ok) failures.push('gh not authenticated or not on PATH (run `gh auth login`)')
			return failures
		},
		stdout: (s) => process.stdout.write(s),
	}

	try {
		await runFix(rt)
	} catch (error) {
		process.stderr.write(`trowel fix: ${(error as Error).message}\n`)
		process.exit(1)
	}
}
