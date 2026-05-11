import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PROMPTS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)))

/**
 * Load a prompt template and substitute {{PLACEHOLDER}} tokens.
 * Matches the substitution pattern used by equipped's .sandcastle prompts.
 */
export async function loadPrompt(name: string, args: Record<string, string>): Promise<string> {
	const filePath = path.join(PROMPTS_DIR, `${name}.md`)
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
