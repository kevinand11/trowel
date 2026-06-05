import { runManualSliceCommand } from './manual-slice-command.ts'
import type { HarnessKind } from '../harnesses/registry.ts'

export async function audit(changeId: string, sliceId: string, opts: { storage?: string; harness?: HarnessKind }): Promise<void> {
	await runManualSliceCommand({
		commandName: 'audit',
		changeId,
		sliceId,
		storage: opts.storage,
		harness: opts.harness,
		role: 'audit',
		requiredState: 'implemented',
		reason: (changeId) => `Run \`trowel work ${changeId}\` to drive it through the loop, or audit it manually after implementation.`,
	})
}
