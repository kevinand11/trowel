import { loadConfig, type ConfigResolution } from '../config.ts'
import { harnessFactories } from '../harnesses/registry.ts'
import { createGh } from '../utils/gh-ops.ts'
import { createRepoGit } from '../utils/git-ops.ts'

type Tag = 'ok' | 'X' | 'i'
type Check = { tag: Tag; label: string; detail: string; failsDoctor: boolean }

function fmtVersion(v: { installed: boolean; version?: string }, notFoundHint: string): { tag: Tag; detail: string } {
	if (!v.installed) return { tag: 'X', detail: notFoundHint }
	return { tag: 'ok', detail: v.version ? `v${v.version}` : 'found' }
}

type DoctorConfigState = { resolved: ConfigResolution | null; error: Error | null }

export async function doctor(): Promise<void> {
	const checks: Check[] = []
	const git = createRepoGit(process.cwd())
	const gh = createGh()
	await addGitCheck(checks, git)
	const configState = await loadDoctorConfig()
	await addHarnessChecks(checks, configState.resolved?.config.agent.harness ?? null)
	await addGhCheck(checks, gh)
	addConfigChecks(checks, configState)
	exitWithDoctorChecks(checks)
}

async function addGitCheck(checks: Check[], git: ReturnType<typeof createRepoGit>): Promise<void> {
	const gitFmt = fmtVersion(await git.detectVersion(), 'install git (every storage uses git for branches/worktrees)')
	checks.push({ tag: gitFmt.tag, label: 'git', detail: gitFmt.detail, failsDoctor: gitFmt.tag === 'X' })
}

async function loadDoctorConfig(): Promise<DoctorConfigState> {
	try {
		return { resolved: await loadConfig(), error: null }
	} catch (error) {
		return { resolved: null, error: error as Error }
	}
}

async function addHarnessChecks(checks: Check[], configuredHarness: string | null): Promise<void> {
	for (const [kind, adapter] of Object.entries(harnessFactories)) {
		const version = await adapter.detectVersion()
		checks.push(harnessCheck(kind, version, kind === configuredHarness))
	}
}

function harnessCheck(kind: string, version: { installed: boolean; version?: string }, isConfigured: boolean): Check {
	return version.installed ? installedHarnessCheck(kind, version, isConfigured) : missingHarnessCheck(kind, isConfigured)
}

function installedHarnessCheck(kind: string, version: { version?: string }, isConfigured: boolean): Check {
	return { tag: 'i', label: `${kind} harness`, detail: `${versionDetail(version)}${configuredAnnotation(isConfigured)}`, failsDoctor: false }
}

function missingHarnessCheck(kind: string, isConfigured: boolean): Check {
	return { tag: isConfigured ? 'X' : 'i', label: `${kind} harness`, detail: `not installed${configuredAnnotation(isConfigured)}`, failsDoctor: isConfigured }
}

function configuredAnnotation(isConfigured: boolean): string {
	return isConfigured ? '  ← configured' : ''
}

function versionDetail(version: { version?: string }): string {
	return version.version ? `v${version.version}` : 'found'
}

async function addGhCheck(checks: Check[], gh: ReturnType<typeof createGh>): Promise<void> {
	const ghV = await gh.detectVersion()
	if (!ghV.installed) {
		checks.push({ tag: 'X', label: 'gh', detail: 'not installed (install from https://cli.github.com/)', failsDoctor: true })
		return
	}
	checks.push(await authenticatedGhCheck(gh, ghV))
}

async function authenticatedGhCheck(gh: ReturnType<typeof createGh>, ghV: { version?: string }): Promise<Check> {
	const ghAuthed = await gh.isAuthenticated()
	return {
		tag: ghAuthed ? 'ok' : 'X',
		label: 'gh',
		detail: ghAuthed ? `${versionDetail(ghV)}  authenticated` : `${versionDetail(ghV)}  not authenticated (run \`gh auth login\`)`,
		failsDoctor: !ghAuthed,
	}
}

function addConfigChecks(checks: Check[], state: DoctorConfigState): void {
	if (state.error) {
		checks.push({ tag: 'X', label: 'config', detail: state.error.message, failsDoctor: true })
		return
	}
	const resolved = state.resolved!
	checks.push(projectRootCheck(resolved.projectRoot))
	checks.push({ tag: 'ok', label: 'config layers loaded', detail: configLayersDetail(resolved), failsDoctor: false })
}

function projectRootCheck(projectRoot: string | null): Check {
	return {
		tag: projectRoot ? 'ok' : 'X',
		label: 'project root',
		detail: projectRoot ?? 'no `.trowel/` or `.git/` found walking up from cwd',
		failsDoctor: !projectRoot,
	}
}

function configLayersDetail(resolved: ConfigResolution): string {
	return resolved.loaded.length === 0 ? 'none (hard-coded defaults only)' : resolved.loaded.map((l) => `${l.layer}@${l.path}`).join(', ')
}

function exitWithDoctorChecks(checks: Check[]): never {
	let allOk = true
	for (const c of checks) {
		if (c.failsDoctor) allOk = false
		process.stdout.write(`${tagText(c.tag)} ${c.label.padEnd(24)}  ${c.detail}\n`)
	}
	process.exit(allOk ? 0 : 1)
}

function tagText(tag: Tag): string {
	return tag === 'ok' ? 'ok ' : tag === 'X' ? 'X  ' : 'i  '
}
