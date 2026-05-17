import { loadConfig } from '../config.ts'
import { harnessFactories } from '../harnesses/registry.ts'
import { createGh } from '../utils/gh-ops.ts'
import { createRepoGit } from '../utils/git-ops.ts'

type Tag = 'ok' | 'X' | 'i'
type Check = { tag: Tag; label: string; detail: string; failsDoctor: boolean }

function fmtVersion(v: { installed: boolean; version?: string }, notFoundHint: string): { tag: Tag; detail: string } {
	if (!v.installed) return { tag: 'X', detail: notFoundHint }
	return { tag: 'ok', detail: v.version ? `v${v.version}` : 'found' }
}

export async function doctor(): Promise<void> {
	const checks: Check[] = []
	const git = createRepoGit(process.cwd())
	const gh = createGh()

	const gitV = await git.detectVersion()
	const gitFmt = fmtVersion(gitV, 'install git (every storage uses git for branches/worktrees)')
	checks.push({ tag: gitFmt.tag, label: 'git', detail: gitFmt.detail, failsDoctor: gitFmt.tag === 'X' })

	// Resolve config early so we know which harness is "configured".
	let projectRoot: string | null = null
	let configuredHarness: string | null = null
	let configError: Error | null = null
	try {
		const resolved = await loadConfig()
		projectRoot = resolved.projectRoot
		configuredHarness = resolved.config.agent.harness
	} catch (error) {
		configError = error as Error
	}

	// Per-harness block.
	for (const [kind, adapter] of Object.entries(harnessFactories)) {
		const v = await adapter.detectVersion()
		const isConfigured = kind === configuredHarness
		const annot = isConfigured ? '  ← configured' : ''
		if (v.installed) {
			checks.push({
				tag: 'i',
				label: `${kind} harness`,
				detail: `${v.version ? `v${v.version}` : 'found'}${annot}`,
				failsDoctor: false,
			})
		} else {
			checks.push({
				tag: isConfigured ? 'X' : 'i',
				label: `${kind} harness`,
				detail: `not installed${annot}`,
				failsDoctor: isConfigured,
			})
		}
	}

	const ghV = await gh.detectVersion()
	if (!ghV.installed) {
		checks.push({
			tag: 'X',
			label: 'gh',
			detail: 'not installed (install from https://cli.github.com/)',
			failsDoctor: true,
		})
	} else {
		const ghAuthed = await gh.isAuthenticated()
		const versionStr = ghV.version ? `v${ghV.version}` : 'found'
		checks.push({
			tag: ghAuthed ? 'ok' : 'X',
			label: 'gh',
			detail: ghAuthed ? `${versionStr}  authenticated` : `${versionStr}  not authenticated (run \`gh auth login\`)`,
			failsDoctor: !ghAuthed,
		})
	}

	if (configError) {
		checks.push({ tag: 'X', label: 'config', detail: configError.message, failsDoctor: true })
	} else {
		checks.push({
			tag: projectRoot ? 'ok' : 'X',
			label: 'project root',
			detail: projectRoot ?? 'no `.trowel/` or `.git/` found walking up from cwd',
			failsDoctor: !projectRoot,
		})
		try {
			const resolved = await loadConfig()
			checks.push({
				tag: 'ok',
				label: 'config layers loaded',
				detail:
					resolved.loaded.length === 0
						? 'none (hard-coded defaults only)'
						: resolved.loaded.map((l) => `${l.layer}@${l.path}`).join(', '),
				failsDoctor: false,
			})
		} catch {
			// Already reported above.
		}
	}

	let allOk = true
	for (const c of checks) {
		const tag = c.tag === 'ok' ? 'ok ' : c.tag === 'X' ? 'X  ' : 'i  '
		if (c.failsDoctor) allOk = false
		process.stdout.write(`${tag} ${c.label.padEnd(24)}  ${c.detail}\n`)
	}

	process.exit(allOk ? 0 : 1)
}
