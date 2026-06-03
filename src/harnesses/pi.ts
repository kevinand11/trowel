import { detectCliVersion, spawnHarness, spawnPrintCommand, waitForChildExit } from './process.ts'
import type {
	HarnessAdapter,
	HarnessSpawnHandle,
	HarnessSpawnInteractiveArgs,
	HarnessSpawnPrintArgs,
	HarnessVersionInfo,
} from './types.ts'

export const piHarness: HarnessAdapter = {
	kind: 'pi',
	// Provider-prefixed so we don't depend on pi's --provider default (which is `google`).
	defaultModel: 'anthropic/claude-sonnet-4-5',

	async spawnPrint(args: HarnessSpawnPrintArgs): Promise<HarnessSpawnHandle> {
		// `--mode json` emits NDJSON events per agent step instead of the final response text.
		return spawnPrintCommand('pi', ['-p', '--mode', 'json', '--model', args.model, '--no-session', args.prompt], { cwd: args.cwd, logStream: args.logStream })
	},

	async spawnInteractive(args: HarnessSpawnInteractiveArgs): Promise<HarnessSpawnHandle> {
		const child = spawnHarness('pi', ['--append-system-prompt', args.systemPrompt, '--model', args.model], { cwd: args.cwd, stdio: 'inherit' })
		return { child, waitForExit: waitForChildExit(child) }
	},

	async detectVersion(): Promise<HarnessVersionInfo> {
		// pi prints --version to stderr, not stdout — scan both streams.
		return detectCliVersion('pi', ['--version'])
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
