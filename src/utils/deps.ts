/**
 * Parse slice dependency declarations from a slice body.
 *
 * Convention: a slice's body MAY end with a git-style trailer block:
 *
 *   ... body text ...
 *
 *   Depends-on: 57
 *   Depends-on: 99, ab12cd
 *
 * Returns the list of referenced slice ids in declaration order, duplicates removed,
 * leading `#` stripped. Returns [] if the body has no `Depends-on:` trailers.
 */
export function parseDeps(body: string): string[] {
	const trailers = extractTrailerBlock(body)
	const ids: string[] = []
	for (const { key, value } of trailers) {
		if (key.toLowerCase() !== 'depends-on') continue
		for (const part of value.split(',')) {
			const id = part.trim().replace(/^#/, '')
			if (id && !ids.includes(id)) ids.push(id)
		}
	}
	return ids
}

type Trailer = { key: string; value: string }

function extractTrailerBlock(body: string): Trailer[] {
	// Take the final non-empty paragraph of the body and try to parse each line as a trailer.
	// If any line in that paragraph doesn't match the trailer shape, treat the paragraph
	// as prose and return no trailers (matches git's interpretation: trailers must be a
	// pure trailer block).
	const lines = body.replace(/\r\n/g, '\n').split('\n')
	// Walk backwards skipping trailing blank lines.
	let end = lines.length - 1
	while (end >= 0 && lines[end]!.trim() === '') end--
	if (end < 0) return []
	let start = end
	while (start > 0 && lines[start - 1]!.trim() !== '') start--
	const block = lines.slice(start, end + 1)
	const trailerRe = /^([A-Za-z][A-Za-z0-9-]*):\s*(.+)$/
	const out: Trailer[] = []
	for (const line of block) {
		const m = line.match(trailerRe)
		if (!m) return []
		out.push({ key: m[1]!, value: m[2]!.trim() })
	}
	return out
}

if (import.meta.vitest) {
	const { describe, test, expect } = import.meta.vitest

	describe('parseDeps', () => {
		test('extracts a single Depends-on trailer', () => {
			expect(parseDeps('spec body\n\nDepends-on: 57')).toEqual(['57'])
		})

		test('extracts multiple Depends-on trailers in declaration order', () => {
			expect(parseDeps('body\n\nDepends-on: 57\nDepends-on: 99')).toEqual(['57', '99'])
		})

		test('handles comma-separated values on one trailer', () => {
			expect(parseDeps('body\n\nDepends-on: 57, 99, ab12cd')).toEqual(['57', '99', 'ab12cd'])
		})

		test('strips leading # from ids', () => {
			expect(parseDeps('body\n\nDepends-on: #57, #99')).toEqual(['57', '99'])
		})

		test('deduplicates ids across multiple trailers', () => {
			expect(parseDeps('body\n\nDepends-on: 57\nDepends-on: 57, 99')).toEqual(['57', '99'])
		})

		test('is case-insensitive on the trailer key', () => {
			expect(parseDeps('body\n\ndepends-on: 57')).toEqual(['57'])
		})

		test('returns [] when body has no trailers', () => {
			expect(parseDeps('just prose, no trailers here')).toEqual([])
		})

		test('returns [] when the final paragraph mixes prose with trailers', () => {
			// Per git convention: trailer block must be pure trailers.
			expect(parseDeps('body\n\nthis is prose\nDepends-on: 57')).toEqual([])
		})

		test('returns [] for empty body', () => {
			expect(parseDeps('')).toEqual([])
		})

		test('ignores trailers that are not Depends-on', () => {
			expect(parseDeps('body\n\nSigned-off-by: Foo\nDepends-on: 57')).toEqual(['57'])
		})

		test('handles trailing blank lines after the trailer block', () => {
			expect(parseDeps('body\n\nDepends-on: 57\n\n\n')).toEqual(['57'])
		})
	})
}
