import { configReferenceEntries, loadConfig, type ConfigReferenceEntry } from '../config'

export async function showConfig(): Promise<void> {
	const resolved = await loadConfig()

	process.stdout.write(`# Resolved config\n\n`)
	process.stdout.write(`Project root: ${resolved.projectRoot ?? '(none — no .trowel/ or .git/ in any ancestor)'}\n\n`)
	process.stdout.write(`# Layers loaded (lowest precedence first; project has highest precedence)\n\n`)
	if (resolved.loaded.length === 0) {
		process.stdout.write(`(none — 'default' (hard-coded) only)\n\n`)
	} else {
		for (const layer of resolved.loaded) {
			process.stdout.write(`${layer.layer.padEnd(8)}  ${layer.path}\n`)
		}
		process.stdout.write(`\n`)
	}

	process.stdout.write(`# Effective config\n\n`)
	process.stdout.write(JSON.stringify(resolved.config, null, 2))
	process.stdout.write(`\n\n`)
	process.stdout.write(`# Config reference\n\n`)
	for (const entry of configReferenceEntries()) process.stdout.write(formatConfigReferenceEntry(entry))
}

function formatConfigReferenceEntry(entry: ConfigReferenceEntry): string {
	const defaultText = 'default' in entry ? `  default=${JSON.stringify(entry.default)}` : ''
	const lines = [`${entry.path}${defaultText}`, `  ${entry.description}`]
	if (entry.examples !== undefined) lines.push(`  examples: ${entry.examples.map((example) => JSON.stringify(example)).join(', ')}`)
	return `${lines.join('\n')}\n`
}

if (import.meta.vitest) {
	const { describe, test, expect } = import.meta.vitest

	describe('formatConfigReferenceEntry', () => {
		test('renders compact path, default, description, and examples', () => {
			expect(formatConfigReferenceEntry({ path: 'work.worktreeCleanupAge', default: '24h', description: 'Age threshold.', examples: ['24h', '7d'] })).toBe(
				'work.worktreeCleanupAge  default="24h"\n  Age threshold.\n  examples: "24h", "7d"\n',
			)
		})
	})
}
