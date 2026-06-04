import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'

import { v } from 'valleyed'

import { resolveProjectRoot } from './project.ts'
import { defaultConfig, mergePartial, partialConfigPipe, type Config, type ConfigLayer, type InitableLayer, type PartialConfig } from './schema.ts'

export type LoadedLayer = {
	layer: Exclude<ConfigLayer, 'default'>
	path: string
	content: PartialConfig
}

export type ConfigResolution = {
	config: Config
	projectRoot: string | null
	loaded: LoadedLayer[]
}

async function tryLoadJson(filePath: string): Promise<unknown | null> {
	try {
		const raw = await readFile(filePath, 'utf8')
		return JSON.parse(raw)
	} catch (error) {
		const code = (error as any).code
		if (code === 'ENOENT') return null
		throw new Error(`Failed to read or parse ${filePath}: ${(error as Error).message}`)
	}
}

export function validatePartialConfig(filePath: string, raw: unknown, label = 'Invalid config'): PartialConfig {
	const result = v.validate(partialConfigPipe(), raw)
	if (!result.valid) {
		const messages = result.error.messages.map((m) => `  · ${m.message ?? JSON.stringify(m)}`).join('\n')
		throw new Error(`${label} at ${filePath}:\n${messages}`)
	}
	return result.value as PartialConfig
}

async function loadAndValidate(filePath: string): Promise<PartialConfig | null> {
	const raw = await tryLoadJson(filePath)
	return raw === null ? null : validatePartialConfig(filePath, raw)
}

const CONFIG_LAYER_ORDER: InitableLayer[] = ['global', 'private', 'project']

type ConfigLoadState = { config: Config; loaded: LoadedLayer[] }

export async function loadConfig(cwd: string = process.cwd(), home: string = homedir()): Promise<ConfigResolution> {
	const projectRoot = await resolveProjectRoot(cwd)
	const state: ConfigLoadState = { config: defaultConfig, loaded: [] }
	for (const layer of CONFIG_LAYER_ORDER) await applyConfigLayer(state, layer, projectRoot, home)
	validateCapabilities(state.config)
	return { config: state.config, projectRoot, loaded: state.loaded }
}

async function applyConfigLayer(state: ConfigLoadState, layer: InitableLayer, projectRoot: string | null, home: string): Promise<void> {
	const layerPath = pathForLayer(layer, projectRoot, home)
	if (!layerPath) return
	const content = await loadAndValidate(layerPath)
	if (!content) return
	state.config = mergePartial(state.config, content)
	state.loaded.push({ layer, path: layerPath, content })
}

/**
 * Cross-field flag validation. See ADRs `storage-behavior-separation` and
 * `decouple-pr-flow-from-storage`: flag combinations are validated storage-independently.
 */
type ConfigValidationRule = { invalid: (config: Config) => boolean; message: string }

const CONFIG_VALIDATION_RULES: ConfigValidationRule[] = [
	{
		invalid: (config) => config.work.review && !config.work.usePrs,
		message: 'config.work.review requires config.work.usePrs: true (there is no PR for the reviewer to operate on otherwise)',
	},
	{
		invalid: (config) => config.work.usePrs && !config.work.perSliceBranches,
		message: 'config.work.usePrs requires config.work.perSliceBranches: true (there is no slice branch to open a PR against otherwise)',
	},
]

function validateCapabilities(config: Config): void {
	const violation = CONFIG_VALIDATION_RULES.find((rule) => rule.invalid(config))
	if (violation) throw new Error(violation.message)
}

const PATH_FOR_LAYER: Record<InitableLayer, (projectRoot: string | null, home: string) => string | null> = {
	global: (_projectRoot, home) => path.join(home, '.trowel', 'config.json'),
	project: (projectRoot) => projectRootPath(projectRoot),
	private: (projectRoot, home) => privateProjectPath(projectRoot, home),
}

export function pathForLayer(layer: InitableLayer, projectRoot: string | null, home: string = homedir()): string | null {
	return PATH_FOR_LAYER[layer](projectRoot, home)
}

function projectRootPath(projectRoot: string | null): string | null {
	return projectRoot ? path.join(projectRoot, '.trowel', 'config.json') : null
}

function privateProjectPath(projectRoot: string | null, home: string): string | null {
	return projectRoot ? path.join(home, '.trowel', 'projects', projectRoot.replace(/^\//, ''), 'config.json') : null
}

if (import.meta.vitest) {
	const { describe, test, expect, beforeEach, afterEach } = import.meta.vitest
	const { mkdtemp, mkdir, rm, writeFile } = await import('node:fs/promises')
	const { tmpdir } = await import('node:os')

	describe('pathForLayer', () => {
		test("'global' is always under home/.trowel/config.json", () => {
			expect(pathForLayer('global', null, '/h')).toBe('/h/.trowel/config.json')
			expect(pathForLayer('global', '/r', '/h')).toBe('/h/.trowel/config.json')
		})

		test("'project' returns project root joined with .trowel/config.json", () => {
			expect(pathForLayer('project', '/r', '/h')).toBe('/r/.trowel/config.json')
		})

		test("'project' returns null when no project root", () => {
			expect(pathForLayer('project', null, '/h')).toBeNull()
		})

		test("'private' mirrors the full path under home/.trowel/projects/", () => {
			expect(pathForLayer('private', '/Users/me/code/x', '/h')).toBe('/h/.trowel/projects/Users/me/code/x/config.json')
		})

		test("'private' returns null when no project root", () => {
			expect(pathForLayer('private', null, '/h')).toBeNull()
		})
	})

	describe('loadConfig', () => {
		let home: string
		let project: string

		beforeEach(async () => {
			const tmpRoot = await mkdtemp(path.join(tmpdir(), 'trowel-config-'))
			home = path.join(tmpRoot, 'home')
			project = path.join(tmpRoot, 'project')
			await mkdir(home)
			await mkdir(project)
			await mkdir(path.join(project, '.git'))
		})
		afterEach(async () => {
			await rm(path.dirname(home), { recursive: true, force: true })
		})

		const writeLayer = async (filePath: string, content: object) => {
			await mkdir(path.dirname(filePath), { recursive: true })
			await writeFile(filePath, JSON.stringify(content), 'utf8')
		}

		test('returns hard-coded defaults when no config files exist', async () => {
			const resolved = await loadConfig(project, home)
			expect(resolved.config.storage).toBe('file')
			expect(resolved.loaded).toEqual([])
		})

		test('applies the global layer when present', async () => {
			await writeLayer(path.join(home, '.trowel', 'config.json'), { agent: { model: 'sonnet' } })
			const resolved = await loadConfig(project, home)
			expect(resolved.config.agent.model).toBe('sonnet')
			expect(resolved.loaded.map((l) => l.layer)).toEqual(['global'])
		})

		test('project layer wins outright over private and global (β precedence)', async () => {
			await writeLayer(path.join(home, '.trowel', 'config.json'), { agent: { model: 'global-model' } })
			await writeLayer(path.join(home, '.trowel', 'projects', project.replace(/^\//, ''), 'config.json'), { agent: { model: 'private-model' } })
			await writeLayer(path.join(project, '.trowel', 'config.json'), { agent: { model: 'project-model' } })
			const resolved = await loadConfig(project, home)
			expect(resolved.config.agent.model).toBe('project-model')
			expect(resolved.loaded.map((l) => l.layer)).toEqual(['global', 'private', 'project'])
		})

		test('private overrides global when project layer is absent', async () => {
			await writeLayer(path.join(home, '.trowel', 'config.json'), { agent: { model: 'global-model' } })
			await writeLayer(path.join(home, '.trowel', 'projects', project.replace(/^\//, ''), 'config.json'), { agent: { model: 'private-model' } })
			const resolved = await loadConfig(project, home)
			expect(resolved.config.agent.model).toBe('private-model')
		})

		test('rejects an invalid storage in a layer file', async () => {
			await writeLayer(path.join(project, '.trowel', 'config.json'), { storage: 'mongo' })
			await expect(loadConfig(project, home)).rejects.toThrow(/Invalid config at/)
		})

		test('accepts usePrs: true against the file storage (capability gating retired)', async () => {
			await writeLayer(path.join(project, '.trowel', 'config.json'), { storage: 'file', work: { usePrs: true } })
			const resolved = await loadConfig(project, home)
			expect(resolved.config.work.usePrs).toBe(true)
		})

		test('accepts usePrs: true against the issue storage', async () => {
			await writeLayer(path.join(project, '.trowel', 'config.json'), { storage: 'issue', work: { usePrs: true } })
			const resolved = await loadConfig(project, home)
			expect(resolved.config.work.usePrs).toBe(true)
		})

		test('rejects review: true without usePrs: true (no PR for reviewer to operate on)', async () => {
			await writeLayer(path.join(project, '.trowel', 'config.json'), { storage: 'issue', work: { usePrs: false, review: true } })
			await expect(loadConfig(project, home)).rejects.toThrow(/config\.work\.review requires config\.work\.usePrs: true/)
		})

		test('accepts review: true when usePrs: true is also set', async () => {
			await writeLayer(path.join(project, '.trowel', 'config.json'), { storage: 'issue', work: { usePrs: true, review: true } })
			const resolved = await loadConfig(project, home)
			expect(resolved.config.work.review).toBe(true)
		})

		test('rejects usePrs: true with perSliceBranches: false (no slice branch to PR against)', async () => {
			await writeLayer(path.join(project, '.trowel', 'config.json'), {
				storage: 'issue',
				work: { usePrs: true, perSliceBranches: false },
			})
			await expect(loadConfig(project, home)).rejects.toThrow(
				/config\.work\.usePrs requires config\.work\.perSliceBranches: true/,
			)
		})
	})
}
