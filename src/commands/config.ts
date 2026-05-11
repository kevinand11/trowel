import { loadConfig } from '../config.ts'

export async function showConfig(): Promise<void> {
	const resolved = await loadConfig()

	process.stdout.write(`# Resolved config\n\n`)
	process.stdout.write(`Project root: ${resolved.projectRoot ?? '(none — no .trowel/ or .git/ in any ancestor)'}\n\n`)
	process.stdout.write(`# Layers loaded (lowest precedence first; project wins outright)\n\n`)
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
	process.stdout.write(`\n`)
}
