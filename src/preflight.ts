import type { Config } from './schema.ts'
import { ghIsAuthenticated } from './utils/gh.ts'
import { currentBranch, fetch, isCleanWorkingTree } from './utils/git.ts'

export type PreflightFailure = {
	check: string
	message: string
}

export async function runPreflight(opts: { config: Config; projectRoot: string | null }): Promise<PreflightFailure[]> {
	const failures: PreflightFailure[] = []
	const { config, projectRoot } = opts

	if (config.preconditions.requireGitRoot && !projectRoot) {
		failures.push({ check: 'git-root', message: 'No `.trowel/` or `.git/` found in any ancestor; trowel requires a recognised project root.' })
	}

	if (config.preconditions.requireCleanTree && projectRoot) {
		const clean = await isCleanWorkingTree(projectRoot)
		if (!clean) {
			failures.push({ check: 'clean-tree', message: 'Working tree has uncommitted changes. Stash or commit first.' })
		}
	}

	if (config.preconditions.requireGhAuth) {
		const authed = await ghIsAuthenticated()
		if (!authed) {
			failures.push({ check: 'gh-auth', message: '`gh` is not authenticated. Run `gh auth login` first.' })
		}
	}

	return failures
}

export async function captureBranch(cwd: string): Promise<string | null> {
	return currentBranch(cwd)
}

export async function fetchBase(cwd: string, baseBranch: string): Promise<void> {
	await fetch(cwd, 'origin', baseBranch)
}

export type CollisionReport = {
	branch: string
	files: string[]
}

// Cross-PRD collision detection: stub for v0. Full implementation lands with backends,
// which know which branches to scan and how to identify "this PRD's branch".
export async function detectCollisions(_opts: { config: Config; projectRoot: string }): Promise<CollisionReport[]> {
	return []
}
