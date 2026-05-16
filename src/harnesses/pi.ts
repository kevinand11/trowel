import { spawn } from 'node:child_process'

import type {
	HarnessAdapter,
	HarnessSpawnHandle,
	HarnessSpawnInteractiveArgs,
	HarnessSpawnPrintArgs,
	HarnessVersionInfo,
} from './types.ts'
import { tryExec } from '../utils/shell.ts'

export const piHarness: HarnessAdapter = {
	kind: 'pi',
	// Provider-prefixed so we don't depend on pi's --provider default (which is `google`).
	defaultModel: 'anthropic/claude-sonnet-4-5',

	async spawnPrint(args: HarnessSpawnPrintArgs): Promise<HarnessSpawnHandle> {
		const child = spawn('pi', ['-p', '--model', args.model, '--no-session', args.prompt], {
			cwd: args.cwd,
			env: process.env,
			stdio: ['pipe', 'pipe', 'pipe'],
		})
		child.stdout?.pipe(args.logStream, { end: false })
		child.stderr?.pipe(args.logStream, { end: false })
		child.stdin?.end()

		const waitForExit = new Promise<number>((resolve, reject) => {
			child.on('error', reject)
			child.on('exit', (code) => resolve(code ?? -1))
		})
		return { child, waitForExit }
	},

	async spawnInteractive(args: HarnessSpawnInteractiveArgs): Promise<HarnessSpawnHandle> {
		const child = spawn('pi', ['--append-system-prompt', args.systemPrompt, '--model', args.model], {
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
		// pi prints --version to stderr, not stdout — scan both streams.
		const r = await tryExec('pi', ['--version'])
		if (!r.ok) return { installed: false }
		const m = `${r.stdout}\n${r.stderr}`.match(/(\d+\.\d+\.\d+)/)
		return { installed: true, version: m?.[1] }
	},
}

if (import.meta.vitest) {
	const { describe, test, expect } = import.meta.vitest

	describe('piHarness', () => {
		test('kind is pi', () => {
			expect(piHarness.kind).toBe('pi')
		})
		test('defaultModel is provider-prefixed (anthropic/…)', () => {
			expect(piHarness.defaultModel.startsWith('anthropic/')).toBe(true)
		})
	})
}
