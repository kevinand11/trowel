import { recordingGhOps } from './gh-ops-recorder.ts'
import { fakeSliceStorage } from './storage-fixtures.ts'
import { runSlicePhaseCommand } from '../commands/slice-phase-command.ts'
import type { Slice } from '../storages/types.ts'


export { runSlicePhaseCommand } from '../commands/slice-phase-command.ts'
export { recordingGhOps } from './gh-ops-recorder.ts'
export { fakeClassifiedSlice, fakeSliceStorage } from './storage-fixtures.ts'

type SlicePhaseRuntime = Parameters<typeof runSlicePhaseCommand>[0]['runtime']
type RunSlicePhase = (sliceId: string, runtime: SlicePhaseRuntime) => Promise<void>

export async function collectRunOnePhaseSlices(run: RunSlicePhase, slice: Slice): Promise<Slice[]> {
	const storage = fakeSliceStorage([slice])
	const { gh } = recordingGhOps()
	const calls: Slice[] = []
	await run('s1', {
		storage,
		gh,
		usePrs: false,
		runOnePhase: async (_prdId, s) => {
			calls.push(s)
		},
	})
	return calls
}
