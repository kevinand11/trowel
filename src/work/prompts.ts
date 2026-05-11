import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export type Role = 'implement' | 'review' | 'address'
export type BackendKind = 'issue' | 'file'

export type PromptPlaceholders = {
	INTEGRATION_BRANCH: string
}

const promptsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'prompts')

export async function loadPrompt(role: Role, backend: BackendKind, placeholders: PromptPlaceholders): Promise<string> {
	if (backend === 'file' && role !== 'implement') {
		throw new Error(`prompt '${role}' is not available on the file backend (issue-only role)`)
	}
	const raw = await readFile(path.join(promptsDir, `${role}.md`), 'utf8')
	return applyConditionals(raw, backend)
		.replaceAll('{{INTEGRATION_BRANCH}}', placeholders.INTEGRATION_BRANCH)
		.replaceAll('{{BACKEND}}', backend)
}

function applyConditionals(raw: string, backend: BackendKind): string {
	const kinds: BackendKind[] = ['issue', 'file']
	let out = raw
	for (const kind of kinds) {
		const block = new RegExp(`\\{\\{#${kind}\\}\\}\\n?([\\s\\S]*?)\\n?\\{\\{/${kind}\\}\\}\\n?`, 'g')
		out = out.replace(block, kind === backend ? '$1' : '')
	}
	return out
}

if (import.meta.vitest) {
	const { describe, test, expect } = import.meta.vitest

	describe('loadPrompt', () => {
		test('substitutes {{INTEGRATION_BRANCH}} placeholder in the loaded prompt', async () => {
			const out = await loadPrompt('implement', 'issue', { INTEGRATION_BRANCH: 'prds-issue-142' })
			expect(out).toContain('prds-issue-142')
			expect(out).not.toContain('{{INTEGRATION_BRANCH}}')
		})

		test('substitutes {{BACKEND}} placeholder with the backend kind', async () => {
			const issueOut = await loadPrompt('implement', 'issue', { INTEGRATION_BRANCH: 'x' })
			expect(issueOut).toContain('against the `issue` backend')
			expect(issueOut).not.toContain('{{BACKEND}}')

			const fileOut = await loadPrompt('implement', 'file', { INTEGRATION_BRANCH: 'x' })
			expect(fileOut).toContain('against the `file` backend')
		})

		test('keeps {{#issue}}…{{/issue}} sections and drops {{#file}}…{{/file}} sections when backend is issue', async () => {
			const out = await loadPrompt('implement', 'issue', { INTEGRATION_BRANCH: 'x' })
			expect(out).toContain('Issue-backend specifics')
			expect(out).not.toContain('File-backend specifics')
			expect(out).not.toMatch(/\{\{#(issue|file)\}\}/)
			expect(out).not.toMatch(/\{\{\/(issue|file)\}\}/)
		})

		test('keeps {{#file}}…{{/file}} sections and drops {{#issue}}…{{/issue}} sections when backend is file', async () => {
			const out = await loadPrompt('implement', 'file', { INTEGRATION_BRANCH: 'x' })
			expect(out).toContain('File-backend specifics')
			expect(out).not.toContain('Issue-backend specifics')
			expect(out).not.toMatch(/\{\{#(issue|file)\}\}/)
			expect(out).not.toMatch(/\{\{\/(issue|file)\}\}/)
		})

		test('throws for review/address on the file backend (issue-only roles)', async () => {
			await expect(loadPrompt('review', 'file', { INTEGRATION_BRANCH: 'x' })).rejects.toThrow(/review/)
			await expect(loadPrompt('review', 'file', { INTEGRATION_BRANCH: 'x' })).rejects.toThrow(/file backend/)
			await expect(loadPrompt('address', 'file', { INTEGRATION_BRANCH: 'x' })).rejects.toThrow(/address/)
			await expect(loadPrompt('address', 'file', { INTEGRATION_BRANCH: 'x' })).rejects.toThrow(/file backend/)
		})

		test('review and address prompts exist and load on the issue backend', async () => {
			const review = await loadPrompt('review', 'issue', { INTEGRATION_BRANCH: 'x' })
			expect(review.length).toBeGreaterThan(0)
			expect(review).not.toMatch(/\{\{(BACKEND|INTEGRATION_BRANCH)\}\}/)

			const address = await loadPrompt('address', 'issue', { INTEGRATION_BRANCH: 'x' })
			expect(address.length).toBeGreaterThan(0)
			expect(address).not.toMatch(/\{\{(BACKEND|INTEGRATION_BRANCH)\}\}/)
		})
	})
}
