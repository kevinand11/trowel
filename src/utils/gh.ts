import { realShellRunner, type ShellRunner } from './shell.ts'

export async function ghIsAuthenticated(runner: ShellRunner = realShellRunner): Promise<boolean> {
	const result = await runner('gh', ['auth', 'status'])
	return result.ok
}

export async function ghInstalled(runner: ShellRunner = realShellRunner): Promise<boolean> {
	const result = await runner('gh', ['--version'])
	return result.ok
}

export async function nodeVersion(runner: ShellRunner = realShellRunner): Promise<string | null> {
	const result = await runner('node', ['--version'])
	if (!result.ok) return null
	return result.stdout.trim()
}

if (import.meta.vitest) {
	const { describe, test, expect } = import.meta.vitest

	function mockRunner(impl: Record<string, ShellRunner>): { runner: ShellRunner; calls: Array<{ cmd: string; args: string[] }> } {
		const calls: Array<{ cmd: string; args: string[] }> = []
		const runner: ShellRunner = async (cmd, args) => {
			calls.push({ cmd, args })
			const handler = impl[cmd]
			if (!handler) return { ok: false, error: new Error(`unmocked command: ${cmd}`) }
			return handler(cmd, args)
		}
		return { runner, calls }
	}

	describe('nodeVersion', () => {
		test('returns the trimmed stdout when node exits cleanly', async () => {
			const { runner, calls } = mockRunner({
				node: async () => ({ ok: true, stdout: 'v22.4.0\n', stderr: '' }),
			})
			expect(await nodeVersion(runner)).toBe('v22.4.0')
			expect(calls).toEqual([{ cmd: 'node', args: ['--version'] }])
		})

		test('returns null when node is unavailable or fails', async () => {
			const { runner } = mockRunner({
				node: async () => ({ ok: false, error: new Error('ENOENT') }),
			})
			expect(await nodeVersion(runner)).toBeNull()
		})
	})

	describe('ghInstalled', () => {
		test('returns true when gh --version succeeds', async () => {
			const { runner, calls } = mockRunner({
				gh: async () => ({ ok: true, stdout: 'gh version 2.50.0\n', stderr: '' }),
			})
			expect(await ghInstalled(runner)).toBe(true)
			expect(calls).toEqual([{ cmd: 'gh', args: ['--version'] }])
		})

		test('returns false when gh is not installed', async () => {
			const { runner } = mockRunner({
				gh: async () => ({ ok: false, error: new Error('ENOENT') }),
			})
			expect(await ghInstalled(runner)).toBe(false)
		})
	})

	describe('ghIsAuthenticated', () => {
		test('returns true when gh auth status succeeds', async () => {
			const { runner, calls } = mockRunner({
				gh: async () => ({ ok: true, stdout: 'Logged in to github.com as user', stderr: '' }),
			})
			expect(await ghIsAuthenticated(runner)).toBe(true)
			expect(calls).toEqual([{ cmd: 'gh', args: ['auth', 'status'] }])
		})

		test('returns false when gh auth status fails (not authenticated or no token)', async () => {
			const { runner } = mockRunner({
				gh: async () => ({ ok: false, error: new Error('not logged in') }),
			})
			expect(await ghIsAuthenticated(runner)).toBe(false)
		})
	})
}
