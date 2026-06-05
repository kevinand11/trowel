import { runManualSliceCommand } from './manual-slice-command.ts'
import type { HarnessKind } from '../harnesses/registry.ts'
import type { StorageKind } from '../storages/registry.ts'

export async function audit(sliceId: string, opts: { storage?: StorageKind; harness?: HarnessKind }): Promise<void> {
	await runManualSliceCommand({
		commandName: 'audit',
		sliceId,
		storage: opts.storage,
		harness: opts.harness,
		role: 'audit',
		requiredState: 'implemented',
		reason: (changeId) => `Run \`trowel work ${changeId}\` to drive it through the loop, or audit it manually after implementation.`,
	})
}
