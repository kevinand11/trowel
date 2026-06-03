import { buildLoopWiring } from './_loop-wiring.ts'
import { runSlicePhaseCommand } from './slice-phase-command.ts'
import type { HarnessKind } from '../harnesses/registry.ts'
import type { Role } from '../prompts/load.ts'
import type { StorageKind } from '../storages/registry.ts'
import type { Bucket } from '../utils/bucket.ts'

export async function runManualSliceCommand(opts: {
	commandName: string
	sliceId: string
	storage?: StorageKind
	harness?: HarnessKind
	role: Role
	requiredBucket: Bucket
	reason: (prdId: string) => string
}): Promise<void> {
	try {
		const wiring = await buildLoopWiring({ storage: opts.storage, harness: opts.harness })
		await runSlicePhaseCommand({
			sliceId: opts.sliceId,
			runtime: {
				storage: wiring.storage,
				gh: wiring.gh,
				usePrs: wiring.config.work.usePrs,
				runOnePhase: (prdId, slice) => wiring.runOnePhase(prdId, slice, opts.role),
			},
			requiredBucket: opts.requiredBucket,
			reason: opts.reason,
		})
	} catch (e) {
		process.stderr.write(`trowel ${opts.commandName}: ${(e as Error).message}\n`)
		process.exit(1)
	}
}
