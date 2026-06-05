import { buildLoopWiring } from './_loop-wiring.ts'
import { runSlicePhaseCommand } from './slice-phase-command.ts'
import type { HarnessKind } from '../harnesses/registry.ts'
import type { Role } from '../prompts/load.ts'
import type { SliceState } from '../work/slice-types.ts'

export async function runManualSliceCommand(opts: {
	commandName: string
	changeId: string
	sliceId: string
	storage?: string
	harness?: HarnessKind
	role: Role
	requiredState: SliceState
	reason: (changeId: string) => string
}): Promise<void> {
	try {
		const wiring = await buildLoopWiring({ storage: opts.storage, harness: opts.harness })
		await runSlicePhaseCommand({
			changeId: opts.changeId,
			sliceId: opts.sliceId,
			runtime: {
				storage: wiring.storage,
				gh: wiring.gh,
				prs: wiring.config.ship.pr,
				needsRevisionLabel: wiring.config.labels.needsRevision,
				runOnePhase: (changeId, slice) => wiring.runOnePhase(changeId, slice, opts.role),
			},
			requiredState: opts.requiredState,
			reason: opts.reason,
		})
	} catch (e) {
		process.stderr.write(`trowel ${opts.commandName}: ${(e as Error).message}\n`)
		process.exit(1)
	}
}
