import type { Slice } from '../storages/types.ts'

/**
 * The state of the slice's PR on the Change branch.
 *
 * - `'draft'`: an open draft PR exists; process milestones remain agent-processable.
 * - `'ready'`: an open non-draft PR exists, awaiting human review/merge.
 * - `'merged'`: the PR is merged; the computed Slice state is `landed` until Finalization sets `closedAt`.
 * - `null`: no PR exists.
 */
export type SlicePrState = 'draft' | 'ready' | 'merged' | null

export type SliceState =
	| 'draft'
	| 'open'
	| 'blocked'
	| 'in-flight'
	| 'implemented'
	| 'audited'
	| 'awaiting-review'
	| 'needs-revision'
	| 'landed'
	| 'done'

export type ClassifiedSlice = Slice
