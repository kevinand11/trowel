import type { Bucket } from './bucket.ts'

export const BUCKET_ORDER: Bucket[] = ['done', 'needs-revision', 'in-flight', 'blocked', 'ready', 'draft']

export function emptyBucketCounts(): Record<Bucket, number> {
	return {
		done: 0,
		'needs-revision': 0,
		'in-flight': 0,
		blocked: 0,
		ready: 0,
		draft: 0,
	}
}

export function formatBucketCounts(counts: Record<Bucket, number>): string {
	return BUCKET_ORDER.filter((b) => counts[b] > 0)
		.map((b) => `${counts[b]} ${b}`)
		.join(' · ')
}
