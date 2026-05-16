import { spawn } from 'node:child_process'
import { unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'

import type {
	HarnessAdapter,
	HarnessSpawnHandle,
	HarnessSpawnInteractiveArgs,
	HarnessSpawnPrintArgs,
	HarnessVersionInfo,
} from './types.ts'
import { tryExec } from '../utils/shell.ts'

export const codexHarness: HarnessAdapter = {
	kind: 'codex',
	// Placeholder — verify against `codex --list-models` at adapter-implementation time.
	defaultModel: 'gpt-5.1-codex',

	async spawnPrint(args: HarnessSpawnPrintArgs): Promise<HarnessSpawnHandle> {
		const child = spawn(
			'codex',
			['exec', '--model', args.model, '--dangerously-bypass-approvals-and-sandbox', '--cd', args.cwd, '-'],
			{ cwd: args.cwd, env: process.env, stdio: ['pipe', 'pipe', 'pipe'] },
		)
		child.stdout?.pipe(args.logStream, { end: false })
		child.stderr?.pipe(args.logStream, { end: false })
		child.stdin?.write(args.prompt)
		child.stdin?.end()

		const waitForExit = new Promise<number>((resolve, reject) => {
			child.on('error', reject)
			child.on('exit', (code) => resolve(code ?? -1))
		})
		return { child, waitForExit }
	},

	// Codex has no --append-system-prompt; codex auto-discovers AGENTS.md in cwd.
	// Write the system prompt there before spawning, remove on exit.
	async spawnInteractive(args: HarnessSpawnInteractiveArgs): Promise<HarnessSpawnHandle> {
		const agentsPath = path.join(args.cwd, 'AGENTS.md')
		await writeFile(agentsPath, args.systemPrompt, 'utf8')

		const child = spawn('codex', ['--model', args.model, '--cd', args.cwd], {
			cwd: args.cwd,
			env: process.env,
			stdio: 'inherit',
		})
		const waitForExit = new Promise<number>((resolve, reject) => {
			child.on('error', reject)
			child.on('exit', async (code) => {
				try {
					await unlink(agentsPath)
				} catch (e) {
					if ((e as { code?: string }).code !== 'ENOENT') {
						// Best-effort cleanup; surface but don't fail the spawn promise.
					}
				}
				resolve(code ?? -1)
			})
		})
		return { child, waitForExit }
	},

	async detectVersion(): Promise<HarnessVersionInfo> {
		for (const flag of ['--version', '-V']) {
			const r = await tryExec('codex', [flag])
			if (r.ok) {
				const m = `${r.stdout}\n${r.stderr}`.match(/(\d+\.\d+\.\d+)/)
				return { installed: true, version: m?.[1] }
			}
		}
		return { installed: false }
	},
}

if (import.meta.vitest) {
	const { describe, test, expect } = import.meta.vitest

	describe('codexHarness', () => {
		test('kind is codex', () => {
			expect(codexHarness.kind).toBe('codex')
		})
	})
}
