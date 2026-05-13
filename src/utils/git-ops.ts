import { tryExec } from './shell.ts'

/**
 * Single canonical surface for every git operation trowel performs against
 * a project's repo. See ADR `2026-05-13-unified-gitops-via-module-factory`.
 */
export type GitOps = {
	// phase-method ops (consumed by Storage implementations)
	fetch(branch: string): Promise<void>
	push(branch: string): Promise<void>
	checkout(branch: string): Promise<void>
	mergeNoFf(branch: string): Promise<void>
	deleteRemoteBranch(branch: string): Promise<void>
	createRemoteBranch(newBranch: string, baseBranch: string): Promise<void>
	// file storage's createPrd uses these for integration-branch creation
	createLocalBranch(name: string, baseBranch: string): Promise<void>
	pushSetUpstream(branch: string): Promise<void>
	// host-side close cleanup (consumed by `runClose` in `src/commands/close.ts`)
	currentBranch(): Promise<string>
	branchExists(branch: string): Promise<boolean>
	isMerged(branch: string, baseBranch: string): Promise<boolean>
	deleteBranch(branch: string): Promise<void>
}

export function createRepoGit(projectRoot: string): GitOps {
	const gitOrThrow = async (args: string[]): Promise<string> => {
		const r = await tryExec('git', ['-C', projectRoot, ...args])
		if (!r.ok) throw r.error
		return r.stdout
	}

	return {
		fetch: async (b) => { await gitOrThrow(['fetch', '-q', 'origin', b]) },
		push: async (b) => { await gitOrThrow(['push', '-q', 'origin', b]) },
		checkout: async (b) => { await gitOrThrow(['checkout', '-q', b]) },
		mergeNoFf: async (b) => { await gitOrThrow(['merge', '--no-ff', '-q', b]) },
		deleteRemoteBranch: async (b) => { await gitOrThrow(['push', '-q', 'origin', `:${b}`]) },
		createRemoteBranch: async (newBranch, baseBranch) => {
			await gitOrThrow(['fetch', '-q', 'origin', baseBranch])
			await gitOrThrow(['push', '-q', 'origin', `refs/remotes/origin/${baseBranch}:refs/heads/${newBranch}`])
		},
		createLocalBranch: async (name, baseBranch) => {
			await gitOrThrow(['checkout', '-q', '-b', name, baseBranch])
		},
		pushSetUpstream: async (b) => {
			await gitOrThrow(['push', '-q', '-u', 'origin', b])
		},
		currentBranch: async () => {
			const r = await tryExec('git', ['-C', projectRoot, 'rev-parse', '--abbrev-ref', 'HEAD'])
			return r.ok ? r.stdout.trim() : ''
		},
		branchExists: async (b) => {
			const local = await tryExec('git', ['-C', projectRoot, 'branch', '--list', b])
			if (local.ok && local.stdout.trim() !== '') return true
			const remote = await tryExec('git', ['-C', projectRoot, 'ls-remote', '--heads', 'origin', b])
			return remote.ok && remote.stdout.trim() !== ''
		},
		isMerged: async (b, base) => {
			const r = await tryExec('git', ['-C', projectRoot, 'merge-base', '--is-ancestor', b, `origin/${base}`])
			return r.ok
		},
		deleteBranch: async (b) => {
			await tryExec('git', ['-C', projectRoot, 'branch', '-q', '-D', b])
			await tryExec('git', ['-C', projectRoot, 'push', '-q', 'origin', `:${b}`])
		},
	}
}
