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

async function loadAndValidate(filePath: string): Promise<PartialConfig | null> {
	const raw = await tryLoadJson(filePath)
	if (raw === null) return null
	const result = v.validate(partialConfigPipe(), raw)
	if (!result.valid) {
		const messages = result.error.messages.map((m) => `  · ${m.message ?? JSON.stringify(m)}`).join('\n')
		throw new Error(`Invalid config at ${filePath}:\n${messages}`)
	}
	return result.value as PartialConfig
}

export async function loadConfig(cwd: string = process.cwd()): Promise<ConfigResolution> {
	const projectRoot = await resolveProjectRoot(cwd)

	const loaded: LoadedLayer[] = []
	let config = defaultConfig // 'default' layer

	// 'global'
	const globalPath = pathForLayer('global', projectRoot)
	if (globalPath) {
		const content = await loadAndValidate(globalPath)
		if (content) {
			config = mergePartial(config, content)
			loaded.push({ layer: 'global', path: globalPath, content })
		}
	}

	// 'private' (user per-project) — needs projectRoot
	const privatePath = pathForLayer('private', projectRoot)
	if (privatePath) {
		const content = await loadAndValidate(privatePath)
		if (content) {
			config = mergePartial(config, content)
			loaded.push({ layer: 'private', path: privatePath, content })
		}
	}

	// 'project' — wins outright under β precedence
	const projectPath = pathForLayer('project', projectRoot)
	if (projectPath) {
		const content = await loadAndValidate(projectPath)
		if (content) {
			config = mergePartial(config, content)
			loaded.push({ layer: 'project', path: projectPath, content })
		}
	}

	// Derive collision branchPattern if empty
	if (!config.collision.branchPattern) {
		config.collision.branchPattern = `${config.branchPrefix}*`
	}

	return { config, projectRoot, loaded }
}

export function pathForLayer(layer: InitableLayer, projectRoot: string | null): string | null {
	const home = homedir()
	if (layer === 'global') return path.join(home, '.trowel', 'config.json')
	if (layer === 'project') return projectRoot ? path.join(projectRoot, '.trowel', 'config.json') : null
	if (layer === 'private') return projectRoot ? path.join(home, '.trowel', 'projects', projectRoot.replace(/^\//, ''), 'config.json') : null
	return null
}
