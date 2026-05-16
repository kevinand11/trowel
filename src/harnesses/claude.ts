import { spawn } from 'node:child_process'

import type {
	HarnessAdapter,
	HarnessSpawnHandle,
	HarnessSpawnInteractiveArgs,
	HarnessSpawnPrintArgs,
	HarnessVersionInfo,
} from './types.ts'
import { tryExec } from '../utils/shell.ts'

export const claudeHarness: HarnessAdapter = {
	kind: 'claude',
	defaultModel: 'claude-opus-4-6',

	async spawnPrint(args: HarnessSpawnPrintArgs): Promise<HarnessSpawnHandle> {
		const child = spawn(
			'claude',
			['--print', '--model', args.model, '--dangerously-skip-permissions', '--output-format', 'text'],
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

	async spawnInteractive(args: HarnessSpawnInteractiveArgs): Promise<HarnessSpawnHandle> {
		const child = spawn('claude', ['--append-system-prompt', args.systemPrompt, '--model', args.model], {
			cwd: args.cwd,
			env: process.env,
			stdio: 'inherit',
		})
		const waitForExit = new Promise<number>((resolve, reject) => {
			child.on('error', reject)
			child.on('exit', (code) => resolve(code ?? -1))
		})
		return { child, waitForExit }
	},

	async detectVersion(): Promise<HarnessVersionInfo> {
		const r = await tryExec('claude', ['--version'])
		if (!r.ok) return { installed: false }
		const m = `${r.stdout}\n${r.stderr}`.match(/(\d+\.\d+\.\d+)/)
		return { installed: true, version: m?.[1] }
	},
}

if (import.meta.vitest) {
	const { describe, test, expect } = import.meta.vitest

	describe('claudeHarness', () => {
		test('kind is claude', () => {
			expect(claudeHarness.kind).toBe('claude')
		})
		test('defaultModel is claude-opus-4-6', () => {
			expect(claudeHarness.defaultModel).toBe('claude-opus-4-6')
		})
	})
}
