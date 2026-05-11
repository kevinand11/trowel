import { tryExec } from './shell.ts'

export async function ghIsAuthenticated(): Promise<boolean> {
	const result = await tryExec('gh', ['auth', 'status'])
	return result.ok
}

export async function ghInstalled(): Promise<boolean> {
	const result = await tryExec('gh', ['--version'])
	return result.ok
}

export async function nodeVersion(): Promise<string | null> {
	const result = await tryExec('node', ['--version'])
	if (!result.ok) return null
	return result.stdout.trim()
}
