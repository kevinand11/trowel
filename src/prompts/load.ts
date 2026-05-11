import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PROMPTS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)))

/**
 * Load a prompt template and substitute {{PLACEHOLDER}} tokens.
 * Matches the substitution pattern used by equipped's .sandcastle prompts.
 *
 * `dir` defaults to this module's own directory; tests pass a fixture dir.
 */
export async function loadPrompt(name: string, args: Record<string, string>, dir: string = PROMPTS_DIR): Promise<string> {
	const filePath = path.join(dir, `${name}.md`)
	let template: string
	try {
		template = await readFile(filePath, 'utf8')
	} catch (error) {
		throw new Error(`Prompt template not found: ${filePath}: ${(error as Error).message}`)
	}
	let out = template
	for (const [key, value] of Object.entries(args)) {
		out = out.replaceAll(`{{${key}}}`, value)
	}
	return out
}

if (import.meta.vitest) {
	const { describe, test, expect, beforeEach, afterEach } = import.meta.vitest
	const { mkdtemp, rm, writeFile } = await import('node:fs/promises')
	const { tmpdir } = await import('node:os')

	describe('loadPrompt', () => {
		let dir: string

		beforeEach(async () => {
			dir = await mkdtemp(path.join(tmpdir(), 'trowel-prompt-'))
		})
		afterEach(async () => {
			await rm(dir, { recursive: true, force: true })
		})

		test('returns the template verbatim when there are no placeholders', async () => {
			await writeFile(path.join(dir, 'hi.md'), 'hello world', 'utf8')
			expect(await loadPrompt('hi', {}, dir)).toBe('hello world')
		})

		test('substitutes a {{TOKEN}} with its value', async () => {
			await writeFile(path.join(dir, 'tpl.md'), 'branch={{BRANCH}}', 'utf8')
			expect(await loadPrompt('tpl', { BRANCH: 'prd/foo' }, dir)).toBe('branch=prd/foo')
		})

		test('substitutes every occurrence of the same token', async () => {
			await writeFile(path.join(dir, 'tpl.md'), '{{X}} and {{X}}', 'utf8')
			expect(await loadPrompt('tpl', { X: 'Y' }, dir)).toBe('Y and Y')
		})

		test('leaves unknown tokens untouched', async () => {
			await writeFile(path.join(dir, 'tpl.md'), '{{KNOWN}} {{UNKNOWN}}', 'utf8')
			expect(await loadPrompt('tpl', { KNOWN: 'k' }, dir)).toBe('k {{UNKNOWN}}')
		})

		test('throws with a useful message when the template is missing', async () => {
			await expect(loadPrompt('missing', {}, dir)).rejects.toThrow(/Prompt template not found/)
		})
	})
}
