import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export type Role = 'implement' | 'review' | 'address'

const promptsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'prompts')

export async function loadPrompt(role: Role, _placeholders: Record<string, never> = {}): Promise<string> {
	return await readFile(path.join(promptsDir, `${role}.md`), 'utf8')
}

if (import.meta.vitest) {
	const { describe, test, expect } = import.meta.vitest

	describe('loadPrompt', () => {
		test('returns the prompt file verbatim with no placeholder substitution', async () => {
			const out = await loadPrompt('implement')
			expect(out).toContain('You are running inside a trowel sandbox as the **Implementer**')
			expect(out).not.toMatch(/\{\{.+?\}\}/)
		})

		test('review and address prompts load verbatim regardless of storage', async () => {
			const review = await loadPrompt('review')
			expect(review.length).toBeGreaterThan(0)
			expect(review).not.toMatch(/\{\{.+?\}\}/)

			const address = await loadPrompt('address')
			expect(address.length).toBeGreaterThan(0)
			expect(address).not.toMatch(/\{\{.+?\}\}/)
		})
	})
}
