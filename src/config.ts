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

export async function loadConfig(cwd: string = process.cwd(), home: string = homedir()): Promise<ConfigResolution> {
	const projectRoot = await resolveProjectRoot(cwd)

	const loaded: LoadedLayer[] = []
	let config = defaultConfig // 'default' layer

	// 'global'
	const globalPath = pathForLayer('global', projectRoot, home)
	if (globalPath) {
		const content = await loadAndValidate(globalPath)
		if (content) {
			config = mergePartial(config, content)
			loaded.push({ layer: 'global', path: globalPath, content })
		}
	}

	// 'private' (user per-project) — needs projectRoot
	const privatePath = pathForLayer('private', projectRoot, home)
	if (privatePath) {
		const content = await loadAndValidate(privatePath)
		if (content) {
			config = mergePartial(config, content)
			loaded.push({ layer: 'private', path: privatePath, content })
		}
	}

	// 'project' — wins outright under β precedence
	const projectPath = pathForLayer('project', projectRoot, home)
	if (projectPath) {
		const content = await loadAndValidate(projectPath)
		if (content) {
			config = mergePartial(config, content)
			loaded.push({ layer: 'project', path: projectPath, content })
		}
	}

	// Derive collision branchPattern if empty.
	// Build a fresh object instead of mutating — `config.collision` may share
	// a reference with `defaultConfig.collision` when no layer touched it.
	// branchPrefix may be null (means "use backend default"); we leave the
	// pattern empty in that case — callers resolve against the backend.
	if (!config.collision.branchPattern && config.branchPrefix !== null) {
		config = {
			...config,
			collision: { ...config.collision, branchPattern: `${config.branchPrefix}*` },
		}
	}

	return { config, projectRoot, loaded }
}

export function pathForLayer(layer: InitableLayer, projectRoot: string | null, home: string = homedir()): string | null {
	if (layer === 'global') return path.join(home, '.trowel', 'config.json')
	if (layer === 'project') return projectRoot ? path.join(projectRoot, '.trowel', 'config.json') : null
	if (layer === 'private') return projectRoot ? path.join(home, '.trowel', 'projects', projectRoot.replace(/^\//, ''), 'config.json') : null
	return null
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
			expect(resolved.config.backend).toBe('file')
			expect(resolved.loaded).toEqual([])
		})

		test('applies the global layer when present', async () => {
			await writeLayer(path.join(home, '.trowel', 'config.json'), { baseBranch: 'develop' })
			const resolved = await loadConfig(project, home)
			expect(resolved.config.baseBranch).toBe('develop')
			expect(resolved.loaded.map((l) => l.layer)).toEqual(['global'])
		})

		test('project layer wins outright over private and global (β precedence)', async () => {
			await writeLayer(path.join(home, '.trowel', 'config.json'), { baseBranch: 'global-branch' })
			await writeLayer(path.join(home, '.trowel', 'projects', project.replace(/^\//, ''), 'config.json'), { baseBranch: 'private-branch' })
			await writeLayer(path.join(project, '.trowel', 'config.json'), { baseBranch: 'project-branch' })
			const resolved = await loadConfig(project, home)
			expect(resolved.config.baseBranch).toBe('project-branch')
			expect(resolved.loaded.map((l) => l.layer)).toEqual(['global', 'private', 'project'])
		})

		test('private overrides global when project layer is absent', async () => {
			await writeLayer(path.join(home, '.trowel', 'config.json'), { baseBranch: 'global-branch' })
			await writeLayer(path.join(home, '.trowel', 'projects', project.replace(/^\//, ''), 'config.json'), { baseBranch: 'private-branch' })
			const resolved = await loadConfig(project, home)
			expect(resolved.config.baseBranch).toBe('private-branch')
		})

		test('rejects an invalid backend in a layer file', async () => {
			await writeLayer(path.join(project, '.trowel', 'config.json'), { backend: 'mongo' })
			await expect(loadConfig(project, home)).rejects.toThrow(/Invalid config at/)
		})

		test("derives collision.branchPattern from branchPrefix when not set explicitly", async () => {
			await writeLayer(path.join(project, '.trowel', 'config.json'), { branchPrefix: 'prds-issue-' })
			const resolved = await loadConfig(project, home)
			expect(resolved.config.collision.branchPattern).toBe('prds-issue-*')
		})
	})
}
