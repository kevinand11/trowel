import type { DeleteBranchPolicy } from './types.ts'
import { tryExec } from '../utils/shell.ts'

export type BranchPolicyDeps = {
	repoRoot: string
	baseBranch: string
	deleteBranch: DeleteBranchPolicy
	confirm: (msg: string) => Promise<boolean>
}

// Apply the configured branch-deletion policy to the given branch. Tolerant
// of missing local/origin branches — failures in any git step are absorbed,
// since the goal is best-effort cleanup, not a transactional commitment.
export async function applyBranchDeletePolicy(branch: string, deps: BranchPolicyDeps): Promise<void> {
	if (deps.deleteBranch === 'never') return
	if (deps.deleteBranch === 'prompt') {
		const ok = await deps.confirm(`Delete integration branch '${branch}' (local + origin)?`)
		if (!ok) return
	}
	await tryExec('git', ['-C', deps.repoRoot, 'checkout', '-q', deps.baseBranch])
	await tryExec('git', ['-C', deps.repoRoot, 'branch', '-q', '-D', branch])
	await tryExec('git', ['-C', deps.repoRoot, 'push', '-q', 'origin', `:${branch}`])
}
