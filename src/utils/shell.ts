import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

export const exec = promisify(execFile)

export async function tryExec(cmd: string, args: string[]): Promise<{ ok: true; stdout: string; stderr: string } | { ok: false; error: Error }> {
	try {
		const { stdout, stderr } = await exec(cmd, args)
		return { ok: true, stdout, stderr }
	} catch (error) {
		return { ok: false, error: error as Error }
	}
}

if (import.meta.vitest) {
	const { describe, test, expect } = import.meta.vitest

	describe('tryExec', () => {
		test('returns ok:true with stdout when the command succeeds', async () => {
			const result = await tryExec('node', ['-e', 'process.stdout.write("hello")'])
			expect(result.ok).toBe(true)
			if (result.ok) expect(result.stdout).toBe('hello')
		})

		test('returns ok:false with an Error when the command fails (no throw)', async () => {
			const result = await tryExec('node', ['-e', 'process.exit(1)'])
			expect(result.ok).toBe(false)
			if (!result.ok) expect(result.error).toBeInstanceOf(Error)
		})

		test('returns ok:false when the binary does not exist', async () => {
			const result = await tryExec('this-binary-does-not-exist-anywhere-9999', [])
			expect(result.ok).toBe(false)
		})
	})
}
