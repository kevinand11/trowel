import type { DeleteBranchPolicy } from '../../storages/types.ts'
import type { GitOps } from '../../utils/git-ops.ts'

export type OpenPr = { number: number; url: string }

export type CloseBranchRuntime = {
	deleteBranchPolicy: DeleteBranchPolicy
	confirm: (msg: string) => Promise<boolean>
	stdout: (s: string) => void
	git: GitOps
	listOpenPrs: (baseBranch: string) => Promise<OpenPr[]>
}

export async function deleteBranchIfPresent(branch: string, targetBranch: string, rt: CloseBranchRuntime): Promise<void> {
	if ((await rt.git.listLocalBranches()).includes(branch)) await maybeDeleteBranch(branch, targetBranch, rt)
}

export async function restoreStartingBranch(back: string, fallbackBranch: string, rt: CloseBranchRuntime): Promise<void> {
	const current = await rt.git.currentBranch()
	if (current === back) return
	if ((await rt.git.listLocalBranches()).includes(back)) {
		await rt.git.checkout(back)
	} else {
		rt.stdout(`Switched to '${fallbackBranch}' (was on deleted branch '${back}')\n`)
	}
}

async function maybeDeleteBranch(branch: string, baseBranch: string, rt: CloseBranchRuntime): Promise<void> {
	if (!(await confirmBranchDeletePolicy(branch, rt))) return
	if (!(await confirmNoBlockingOpenPrs(branch, rt))) return
	if (!(await confirmMergedOrDeletionAccepted(branch, baseBranch, rt))) return
	await checkoutAwayFromDeletedBranch(branch, baseBranch, rt)
	await rt.git.deleteBranch(branch)
}

async function confirmBranchDeletePolicy(branch: string, rt: CloseBranchRuntime): Promise<boolean> {
	if (rt.deleteBranchPolicy === 'never') return false
	if (rt.deleteBranchPolicy === 'always') return true
	return rt.confirm(`Delete local branch '${branch}'? [y/N]`)
}

async function confirmNoBlockingOpenPrs(branch: string, rt: CloseBranchRuntime): Promise<boolean> {
	const prs = await rt.listOpenPrs(branch)
	if (prs.length === 0) return true
	rt.stdout(`Open PRs targeting '${branch}':\n`)
	for (const pr of prs) rt.stdout(`  #${pr.number}  ${pr.url}\n`)
	return rt.confirm('Deleting the branch will close these PRs. Continue? [y/N]')
}

async function confirmMergedOrDeletionAccepted(branch: string, baseBranch: string, rt: CloseBranchRuntime): Promise<boolean> {
	if (await rt.git.isMerged(branch, baseBranch)) return true
	return rt.confirm(`Branch '${branch}' contains commits not on '${baseBranch}' — delete anyway? [y/N]`)
}

async function checkoutAwayFromDeletedBranch(branch: string, baseBranch: string, rt: CloseBranchRuntime): Promise<void> {
	const current = await rt.git.currentBranch()
	if (current === branch) await rt.git.checkout(baseBranch)
}
