import { exec, tryExec } from './shell.ts'

export async function isCleanWorkingTree(cwd: string): Promise<boolean> {
	const unstaged = await tryExec('git', ['-C', cwd, 'diff', '--quiet'])
	const staged = await tryExec('git', ['-C', cwd, 'diff', '--cached', '--quiet'])
	return unstaged.ok && staged.ok
}

export async function currentBranch(cwd: string): Promise<string | null> {
	const result = await tryExec('git', ['-C', cwd, 'symbolic-ref', '--short', 'HEAD'])
	if (!result.ok) return null
	return result.stdout.trim()
}

export async function findGitRoot(cwd: string): Promise<string | null> {
	const result = await tryExec('git', ['-C', cwd, 'rev-parse', '--show-toplevel'])
	if (!result.ok) return null
	return result.stdout.trim()
}

export async function gitRemoteUrl(cwd: string, remote = 'origin'): Promise<string | null> {
	const result = await tryExec('git', ['-C', cwd, 'remote', 'get-url', remote])
	if (!result.ok) return null
	return result.stdout.trim()
}

export async function fetch(cwd: string, remote: string, ref: string): Promise<void> {
	await exec('git', ['-C', cwd, 'fetch', remote, ref])
}

export async function listOpenBranchesMatching(cwd: string, pattern: string): Promise<string[]> {
	const result = await tryExec('git', ['-C', cwd, 'ls-remote', '--heads', 'origin', pattern])
	if (!result.ok) return []
	return result.stdout
		.split('\n')
		.map((line) => line.trim())
		.filter(Boolean)
		.map((line) => line.split('refs/heads/')[1] ?? '')
		.filter(Boolean)
}

export async function branchTouchedFiles(cwd: string, branch: string, base: string): Promise<string[]> {
	const result = await tryExec('git', ['-C', cwd, 'diff', '--name-only', `${base}...${branch}`])
	if (!result.ok) return []
	return result.stdout.split('\n').map((s) => s.trim()).filter(Boolean)
}
