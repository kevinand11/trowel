import { realShellRunner, type ShellRunner } from './shell.ts'

export type VersionProbe = { installed: boolean; version?: string }

function parseSemver(s: string): string | undefined {
	const m = s.trim().match(/(\d+\.\d+\.\d+)/)
	return m?.[1]
}

export async function ghIsAuthenticated(runner: ShellRunner = realShellRunner): Promise<boolean> {
	const result = await runner('gh', ['auth', 'status'])
	return result.ok
}

export async function ghVersion(runner: ShellRunner = realShellRunner): Promise<VersionProbe> {
	const result = await runner('gh', ['--version'])
	if (!result.ok) return { installed: false }
	return { installed: true, version: parseSemver(`${result.stdout}\n${result.stderr}`) }
}

export async function gitVersion(runner: ShellRunner = realShellRunner): Promise<VersionProbe> {
	const result = await runner('git', ['--version'])
	if (!result.ok) return { installed: false }
	return { installed: true, version: parseSemver(`${result.stdout}\n${result.stderr}`) }
}

export async function ghInstalled(runner: ShellRunner = realShellRunner): Promise<boolean> {
	return (await ghVersion(runner)).installed
}

export async function gitInstalled(runner: ShellRunner = realShellRunner): Promise<boolean> {
	return (await gitVersion(runner)).installed
}

export async function claudeInstalled(runner: ShellRunner = realShellRunner): Promise<boolean> {
	const result = await runner('claude', ['--version'])
	return result.ok
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

	describe('gitInstalled', () => {
		test('returns true when git --version succeeds', async () => {
			const { runner, calls } = mockRunner({
				git: async () => ({ ok: true, stdout: 'git version 2.43.0\n', stderr: '' }),
			})
			expect(await gitInstalled(runner)).toBe(true)
			expect(calls).toEqual([{ cmd: 'git', args: ['--version'] }])
		})

		test('returns false when git is not on PATH', async () => {
			const { runner } = mockRunner({
				git: async () => ({ ok: false, error: new Error('ENOENT') }),
			})
			expect(await gitInstalled(runner)).toBe(false)
		})
	})

	describe('claudeInstalled', () => {
		test('returns true when claude --version succeeds', async () => {
			const { runner, calls } = mockRunner({
				claude: async () => ({ ok: true, stdout: 'claude 1.2.3\n', stderr: '' }),
			})
			expect(await claudeInstalled(runner)).toBe(true)
			expect(calls).toEqual([{ cmd: 'claude', args: ['--version'] }])
		})

		test('returns false when claude is not on PATH', async () => {
			const { runner } = mockRunner({
				claude: async () => ({ ok: false, error: new Error('ENOENT') }),
			})
			expect(await claudeInstalled(runner)).toBe(false)
		})
	})
}
