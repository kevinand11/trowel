import type { Slice, Storage } from '../storages/types.ts'
import type { Bucket } from '../utils/bucket.ts'
import type { GhOps } from '../utils/gh-ops.ts'
import { classifySlicesForChange } from '../work/slice-buckets.ts'

export type SlicePhaseRuntime = {
	storage: Storage
	gh: GhOps
	usePrs: boolean
	runOnePhase: (changeId: string, slice: Slice) => Promise<void>
}

export async function runSlicePhaseCommand(opts: {
	sliceId: string
	runtime: SlicePhaseRuntime
	requiredBucket: Bucket
	reason: (changeId: string) => string
}): Promise<void> {
	const hit = await opts.runtime.storage.findSlice(opts.sliceId)
	if (!hit) throw new Error(`slice '${opts.sliceId}' not found`)
	const { changeId } = hit
	const siblings = await classifySlicesForChange({ storage: opts.runtime.storage, gh: opts.runtime.gh, changeId, usePrs: opts.runtime.usePrs })
	const slice = siblings.find((s) => s.id === opts.sliceId)
	if (!slice) throw new Error(`slice '${opts.sliceId}' disappeared between findSlice and findSlices`)
	if (slice.bucket !== opts.requiredBucket) {
		throw new Error(`slice '${opts.sliceId}' is in bucket '${slice.bucket}', not '${opts.requiredBucket}'. ${opts.reason(changeId)}`)
	}
	await opts.runtime.runOnePhase(changeId, slice)
}
