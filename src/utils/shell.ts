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
