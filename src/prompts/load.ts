import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export type Role = 'implement' | 'review' | 'address'

const PROMPTS_DIR = path.dirname(fileURLToPath(import.meta.url))

export async function loadPrompt(name: Role | 'start'): Promise<string> {
	const filePath = path.join(PROMPTS_DIR, `${name}.md`)
	try {
		return await readFile(filePath, 'utf8')
	} catch (error) {
		throw new Error(`Prompt template not found: ${filePath}: ${(error as Error).message}`)
	}
}

if (import.meta.vitest) {
	const { describe, test, expect } = import.meta.vitest

	describe('loadPrompt', () => {
		test('returns the implement prompt verbatim', async () => {
			const out = await loadPrompt('implement')
			expect(out).toContain('You are running inside a trowel sandbox as the **Implementer**')
			expect(out).not.toMatch(/\{\{.+?\}\}/)
		})

		test('review and address prompts load verbatim', async () => {
			const review = await loadPrompt('review')
			expect(review.length).toBeGreaterThan(0)
			expect(review).not.toMatch(/\{\{.+?\}\}/)

			const address = await loadPrompt('address')
			expect(address.length).toBeGreaterThan(0)
			expect(address).not.toMatch(/\{\{.+?\}\}/)
		})

		test('start prompt loads', async () => {
			const start = await loadPrompt('start')
			expect(start.length).toBeGreaterThan(0)
		})

		test('throws with a useful message when the template is missing', async () => {
			await expect(loadPrompt('missing' as Role)).rejects.toThrow(/Prompt template not found/)
		})
	})
}
