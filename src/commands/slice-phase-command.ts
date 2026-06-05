import type { Slice, SliceState, Storage } from '../storages/types.ts'
import type { GhOps } from '../utils/gh-ops.ts'
import { classifySlicesForChange } from '../work/slice-states.ts'

export type SlicePhaseRuntime = {
	storage: Storage
	gh: GhOps
	prs: boolean
	needsRevisionLabel?: string
	runOnePhase: (changeId: string, slice: Slice) => Promise<void>
}

export async function runSlicePhaseCommand(opts: {
	sliceId: string
	runtime: SlicePhaseRuntime
	requiredState: SliceState
	reason: (changeId: string) => string
}): Promise<void> {
	const hit = await opts.runtime.storage.findSlice(opts.sliceId)
	if (!hit) throw new Error(`slice '${opts.sliceId}' not found`)
	const { changeId } = hit
	const siblings = await classifySlicesForChange({
		storage: opts.runtime.storage,
		gh: opts.runtime.gh,
		changeId,
		pr: opts.runtime.prs,
		needsRevisionLabel: opts.runtime.needsRevisionLabel,
	})
	const slice = siblings.find((s) => s.id === opts.sliceId)
	if (!slice) throw new Error(`slice '${opts.sliceId}' disappeared between findSlice and findSlices`)
	if (slice.state !== opts.requiredState) {
		throw new Error(`slice '${opts.sliceId}' is in state '${slice.state}', not '${opts.requiredState}'. ${opts.reason(changeId)}`)
	}
	await opts.runtime.runOnePhase(changeId, slice)
}
