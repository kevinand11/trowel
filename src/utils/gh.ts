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

if (import.meta.vitest) {
	const { describe, test, expect } = import.meta.vitest

	describe('nodeVersion', () => {
		test("returns a string starting with 'v' on a Node-having machine", async () => {
			const v = await nodeVersion()
			expect(v).not.toBeNull()
			expect(v!.startsWith('v')).toBe(true)
		})
	})

	describe('ghInstalled / ghIsAuthenticated', () => {
		// These check the test machine's gh installation; they're env-dependent.
		// We assert the *return type contract*: always a boolean, never throws.
		test('ghInstalled returns a boolean', async () => {
			const result = await ghInstalled()
			expect(typeof result).toBe('boolean')
		})

		test('ghIsAuthenticated returns a boolean', async () => {
			const result = await ghIsAuthenticated()
			expect(typeof result).toBe('boolean')
		})
	})
}
