import { loadConfig } from '../config.ts'
import { ghInstalled, ghIsAuthenticated, nodeVersion } from '../utils/gh.ts'

type Check = { label: string; ok: boolean; detail: string }

export async function doctor(): Promise<void> {
	const checks: Check[] = []

	const node = await nodeVersion()
	checks.push({
		label: 'node',
		ok: node !== null,
		detail: node ?? 'not found on PATH',
	})

	const ghPresent = await ghInstalled()
	checks.push({
		label: 'gh CLI installed',
		ok: ghPresent,
		detail: ghPresent ? 'found' : 'install from https://cli.github.com/',
	})

	const ghAuthed = await ghIsAuthenticated()
	checks.push({
		label: 'gh authenticated',
		ok: ghAuthed,
		detail: ghAuthed ? 'ok' : 'run `gh auth login`',
	})

	let projectRoot: string | null = null
	try {
		const resolved = await loadConfig()
		projectRoot = resolved.projectRoot
		checks.push({
			label: 'project root',
			ok: projectRoot !== null,
			detail: projectRoot ?? 'no `.trowel/` or `.git/` found walking up from cwd',
		})
		checks.push({
			label: 'config layers loaded',
			ok: true,
			detail: resolved.loaded.length === 0 ? 'none (hard-coded defaults only)' : resolved.loaded.map((l) => `${l.layer}@${l.path}`).join(', '),
		})
	} catch (error) {
		checks.push({
			label: 'config',
			ok: false,
			detail: (error as Error).message,
		})
	}

	let allOk = true
	for (const c of checks) {
		const tag = c.ok ? 'ok ' : 'X  '
		if (!c.ok) allOk = false
		process.stdout.write(`${tag} ${c.label.padEnd(24)}  ${c.detail}\n`)
	}

	process.exit(allOk ? 0 : 1)
}
