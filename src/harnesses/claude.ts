import { detectCliVersion, spawnHarness, spawnPrintCommand, waitForChildExit } from './process.ts'
import type {
	HarnessAdapter,
	HarnessSpawnHandle,
	HarnessSpawnInteractiveArgs,
	HarnessSpawnPrintArgs,
	HarnessVersionInfo,
} from './types.ts'

export const claudeHarness: HarnessAdapter = {
	kind: 'claude',
	defaultModel: 'claude-opus-4-6',

	async spawnPrint(args: HarnessSpawnPrintArgs): Promise<HarnessSpawnHandle> {
		// `stream-json` emits one NDJSON event per agent step (message_start, content_block_*,
		// tool_use, tool_result, message_stop, …); `--verbose` is required for the stream to
		// include those events rather than just the final assistant text.
		return spawnPrintCommand('claude', ['--print', '--model', args.model, '--dangerously-skip-permissions', '--output-format', 'stream-json', '--verbose'], {
			cwd: args.cwd,
			prompt: args.prompt,
			logStream: args.logStream,
		})
	},

	async spawnInteractive(args: HarnessSpawnInteractiveArgs): Promise<HarnessSpawnHandle> {
		const child = spawnHarness('claude', ['--append-system-prompt', args.systemPrompt, '--model', args.model], { cwd: args.cwd, stdio: 'inherit' })
		return { child, waitForExit: waitForChildExit(child) }
	},

	async detectVersion(): Promise<HarnessVersionInfo> {
		return detectCliVersion('claude', ['--version'])
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
