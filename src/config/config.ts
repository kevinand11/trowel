import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'

import { differ } from 'valleyed'

import { defaultConfig, partialConfigPipe, type Config, type PartialConfig } from './schema.ts'
import { validateJson } from '../utils/parse-json.ts'
import { resolveProjectRoot } from '../utils/project.ts'

const CONFIG_LAYER_ORDER = ['global', 'project'] as const

export type InitableLayer = (typeof CONFIG_LAYER_ORDER)[number]
type ConfigLayer = 'default' | InitableLayer

type LoadedLayer = {
	layer: Exclude<ConfigLayer, 'default'>
	path: string
	content: PartialConfig
}

export type ConfigResolution = {
	config: Config
	projectRoot: string | null
	loaded: LoadedLayer[]
}

export async function loadPartialConfig(filePath: string): Promise<PartialConfig | null> {
	const raw = await readFile(filePath, 'utf8').catch((error) => {
		const code = (error as any).code
		if (code === 'ENOENT') return null
		throw new Error(`Failed to read or parse ${filePath}: ${(error as Error).message}`)
	})
	if (raw === null) return null
	return validateJson(partialConfigPipe, raw, `Invalid config at ${filePath}`)
}

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
	const content = await loadPartialConfig(layerPath)
	if (!content) return
	state.config = differ.merge(state.config, content)
	state.loaded.push({ layer, path: layerPath, content })
}

function validateCapabilities(_config: Config): void {}

const PATH_FOR_LAYER: Record<InitableLayer, (projectRoot: string | null, home: string) => string | null> = {
	global: (_projectRoot, home) => path.join(home, '.trowel', 'config.json'),
	project: (projectRoot) => (projectRoot ? path.join(projectRoot, '.trowel', 'config.json') : null),
}

export function pathForLayer(layer: InitableLayer, projectRoot: string | null, home: string = homedir()): string | null {
	return PATH_FOR_LAYER[layer](projectRoot, home)
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

		test('project layer has highest precedence over global', async () => {
			await writeLayer(path.join(home, '.trowel', 'config.json'), { agent: { model: 'global-model' } })
			await writeLayer(path.join(project, '.trowel', 'config.json'), { agent: { model: 'project-model' } })
			const resolved = await loadConfig(project, home)
			expect(resolved.config.agent.model).toBe('project-model')
			expect(resolved.loaded.map((l) => l.layer)).toEqual(['global', 'project'])
		})

		test('ignores legacy private project config files', async () => {
			await writeLayer(path.join(home, '.trowel', 'config.json'), { agent: { model: 'global-model' } })
			await writeLayer(path.join(home, '.trowel', 'projects', project.replace(/^\//, ''), 'config.json'), {
				agent: { model: 'private-model' },
			})
			const resolved = await loadConfig(project, home)
			expect(resolved.config.agent.model).toBe('global-model')
			expect(resolved.loaded.map((l) => l.layer)).toEqual(['global'])
		})

		test('rejects an invalid storage in a layer file', async () => {
			await writeLayer(path.join(project, '.trowel', 'config.json'), { storage: 'mongo' })
			await expect(loadConfig(project, home)).rejects.toThrow(/Invalid config at/)
		})
	})
}
