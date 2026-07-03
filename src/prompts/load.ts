import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export type Role = 'implement' | 'audit' | 'review'
export type PromptName = Role | 'start' | 'lane'

const PROMPTS_DIR = path.dirname(fileURLToPath(import.meta.url))

export async function loadPrompt(name: PromptName): Promise<string> {
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

		test('audit and review prompts load verbatim', async () => {
			const audit = await loadPrompt('audit')
			expect(audit.length).toBeGreaterThan(0)
			expect(audit).not.toMatch(/\{\{.+?\}\}/)

			const review = await loadPrompt('review')
			expect(review.length).toBeGreaterThan(0)
			expect(review).not.toMatch(/\{\{.+?\}\}/)
		})

		test('start prompt loads', async () => {
			const start = await loadPrompt('start')
			expect(start.length).toBeGreaterThan(0)
		})

		test('lane prompt loads and contains the confirmation gates', async () => {
			const lane = await loadPrompt('lane')
			expect(lane).toContain('Trowel Lane')
			expect(lane).toContain('Proceed with inline implementation in this lane?')
			expect(lane).toContain('human in the loop')
			expect(lane).toContain('Never commit automatically')
			expect(lane).toContain('propose a commit message')
			expect(lane).toContain('Default to no')
			expect(lane).toContain('will refuse while the Lane worktree is dirty')
		})

		test('throws with a useful message when the template is missing', async () => {
			await expect(loadPrompt('missing' as PromptName)).rejects.toThrow(/Prompt template not found/)
		})
	})
}
