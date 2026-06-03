import type { Slice, Storage } from '../storages/types.ts'
import type { Bucket } from '../utils/bucket.ts'
import type { GhOps } from '../utils/gh-ops.ts'
import { classifySlicesForPrd } from '../work/slice-buckets.ts'

export type SlicePhaseRuntime = {
	storage: Storage
	gh: GhOps
	usePrs: boolean
	runOnePhase: (prdId: string, slice: Slice) => Promise<void>
}

export async function runSlicePhaseCommand(opts: {
	sliceId: string
	runtime: SlicePhaseRuntime
	requiredBucket: Bucket
	reason: (prdId: string) => string
}): Promise<void> {
	const hit = await opts.runtime.storage.findSlice(opts.sliceId)
	if (!hit) throw new Error(`slice '${opts.sliceId}' not found`)
	const { prdId } = hit
	const siblings = await classifySlicesForPrd({ storage: opts.runtime.storage, gh: opts.runtime.gh, prdId, usePrs: opts.runtime.usePrs })
	const slice = siblings.find((s) => s.id === opts.sliceId)
	if (!slice) throw new Error(`slice '${opts.sliceId}' disappeared between findSlice and findSlices`)
	if (slice.bucket !== opts.requiredBucket) {
		throw new Error(`slice '${opts.sliceId}' is in bucket '${slice.bucket}', not '${opts.requiredBucket}'. ${opts.reason(prdId)}`)
	}
	await opts.runtime.runOnePhase(prdId, slice)
}
