const MAX_LEN = 50

export function slug(title: string): string {
	const normalised = title
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-|-$/g, '')
	if (normalised.length <= MAX_LEN) return normalised
	return normalised.slice(0, MAX_LEN).replace(/-+[^-]*$/, '').replace(/-+$/, '')
}

if (import.meta.vitest) {
	const { describe, test, expect } = import.meta.vitest

	describe('slug', () => {
		test('lowercases and hyphenates a multi-word title', () => {
			expect(slug('Fix Tabs on macOS')).toBe('fix-tabs-on-macos')
		})

		test('replaces punctuation and non-alphanumeric runs with a single hyphen', () => {
			expect(slug("Add: user's avatar (v2)!")).toBe('add-user-s-avatar-v2')
		})

		test('returns empty string when the input has no alphanumeric chars', () => {
			expect(slug('!!! ???')).toBe('')
			expect(slug('')).toBe('')
		})

		test('truncates to 50 characters and never ends on a hyphen', () => {
			const long = 'this is a fairly long title with many many many words in it that exceeds fifty chars'
			const result = slug(long)
			expect(result.length).toBeLessThanOrEqual(50)
			expect(result.endsWith('-')).toBe(false)
			expect(result).toBe('this-is-a-fairly-long-title-with-many-many-many')
		})
	})
}
