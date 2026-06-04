import type { ClassifiedSlice, ChangeRecord } from '../../storages/types.ts'
import { BUCKET_ORDER, emptyBucketCounts, formatBucketCounts } from '../../utils/bucket-format.ts'
import type { Bucket } from '../../utils/bucket.ts'

export function renderStatus(change: ChangeRecord, slices: ClassifiedSlice[]): string {
	const counts = bucketCountsFor(slices)
	const summary = slices.length === 0 ? '(no slices)' : `(${formatBucketCounts(counts)})`
	const lines = [
		`Change ${change.id}  ${change.title}`,
		`Branch:  ${change.branch}`,
		`State:   ${change.state}          ${summary}`,
		'',
		...renderBucketSections(slices),
	]
	return lines.join('\n')
}

export function renderStatusSlice(change: ChangeRecord, slice: ClassifiedSlice, siblings: ClassifiedSlice[]): string {
	const lines: string[] = []
	lines.push(`Slice ${slice.id}  ${slice.title}`)
	lines.push(`Change:     ${change.id}  ${change.title}`)
	lines.push(`State:   ${slice.state}   bucket: ${slice.bucket}`)
	lines.push(`ready-for-agent: ${slice.readyForAgent}`)
	lines.push(`needs-revision:  ${slice.needsRevision}`)
	lines.push(...blockedByLines(slice, siblings))
	return lines.join('\n')
}

function bucketCountsFor(slices: ClassifiedSlice[]): Record<Bucket, number> {
	const counts: Record<Bucket, number> = emptyBucketCounts()
	for (const s of slices) counts[s.bucket]++
	return counts
}

function renderBucketSections(slices: ClassifiedSlice[]): string[] {
	const lines: string[] = []
	const sliceById = bySliceId(slices)
	for (const bucket of BUCKET_ORDER) appendBucketSection(lines, bucket, slices, sliceById)
	return lines
}

function appendBucketSection(lines: string[], bucket: Bucket, slices: ClassifiedSlice[], sliceById: Map<string, ClassifiedSlice>): void {
	const inBucket = slices.filter((s) => s.bucket === bucket)
	if (inBucket.length === 0) return
	lines.push(`  ${bucket}`)
	for (const s of inBucket) lines.push(renderSliceSummaryLine(s, sliceById))
	lines.push('')
}

function renderSliceSummaryLine(s: ClassifiedSlice, sliceById: Map<string, ClassifiedSlice>): string {
	const right = rightColumn(s, sliceById)
	const idCol = s.id.padEnd(8)
	return right ? `    ${idCol}  ${s.title.padEnd(48)}  ${right}` : `    ${idCol}  ${s.title}`
}

function bySliceId(slices: ClassifiedSlice[]): Map<string, ClassifiedSlice> {
	return new Map(slices.map((s) => [s.id, s]))
}

function rightColumn(s: ClassifiedSlice, byId: Map<string, ClassifiedSlice>): string {
	if (s.bucket !== 'blocked') return ''
	const unmet = unmetBlockers(s, byId)
	return unmet.length === 0 ? '' : `blockedBy: ${unmet.join(', ')}`
}

function unmetBlockers(s: ClassifiedSlice, byId: Map<string, ClassifiedSlice>): string[] {
	return s.blockedBy.filter((id) => {
		const dep = byId.get(id)
		return !dep || dep.bucket !== 'done'
	})
}

function blockedByLines(slice: ClassifiedSlice, siblings: ClassifiedSlice[]): string[] {
	if (slice.blockedBy.length === 0) return []
	const byId = bySliceId(siblings)
	return ['blockedBy:', ...slice.blockedBy.map((id) => blockedByLine(id, byId))]
}

function blockedByLine(id: string, byId: Map<string, ClassifiedSlice>): string {
	const dep = byId.get(id)
	return dep ? `  ${id.padEnd(6)}  ${dep.bucket.padEnd(14)}  ${dep.title}` : `  ${id.padEnd(6)}  (not found)`
}
