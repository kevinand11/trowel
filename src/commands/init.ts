import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'

import { confirm, input, select } from '@inquirer/prompts'
import { v } from 'valleyed'

import { pathForLayer } from '../config.ts'
import { resolveProjectRoot } from '../project.ts'
import { defaultConfig, emitJsonSchema, partialConfigPipe, type InitableLayer, type PartialConfig } from '../schema.ts'
import { storageFactories } from '../storages/registry.ts'

type InitPrompts = {
	storage: (current: string) => Promise<string>
	agentModel: (current: string) => Promise<string>
	usePrs: (current: boolean) => Promise<boolean>
	review: (current: boolean) => Promise<boolean>
	confirm: (msg: string) => Promise<boolean>
}

type RunInitOptions = {
	layer: InitableLayer
	cwd?: string
	home?: string
	prompts: InitPrompts
	stdout?: (s: string) => void
	// Injectable for tests so flaky-ancestor-.git environments don't poison the project-root resolution.
	resolveRoot?: (cwd: string) => Promise<string | null>
}

type RunInitResult = { wrote: boolean; path: string }

async function runInit(opts: RunInitOptions): Promise<RunInitResult> {
	const cwd = opts.cwd ?? process.cwd()
	const home = opts.home ?? homedir()
	const stdout = opts.stdout ?? ((s) => process.stdout.write(s))
	const resolveRoot = opts.resolveRoot ?? resolveProjectRoot

	const projectRoot = await resolveRoot(cwd)
	if ((opts.layer === 'project' || opts.layer === 'private') && projectRoot === null) {
		throw new Error(
			`no project root found (no .git/ or .trowel/ walking up from ${cwd}). Run 'git init' first, or cd into a git repo.`,
		)
	}

	const filePath = pathForLayer(opts.layer, projectRoot, home)
	if (filePath === null) {
		// Shouldn't reach here given the guard above, but be explicit.
		throw new Error(`cannot resolve config path for layer '${opts.layer}'`)
	}

	const existing = await readExisting(filePath)

	// Always (re)emit the JSON Schema next to the config file so editors can
	// drive autocomplete via the `$schema` key we write below. Idempotent — a
	// re-run after a trowel upgrade refreshes the schema in place.
	const schemaPath = path.join(path.dirname(filePath), 'schema.json')
	await mkdir(path.dirname(schemaPath), { recursive: true })
	await writeFile(schemaPath, JSON.stringify(emitJsonSchema(), null, 2) + '\n', 'utf8')
	stdout(`Wrote ${schemaPath}\n`)

	const currentStorage = existing?.storage ?? 'file'
	const storageAnswer = await opts.prompts.storage(currentStorage)

	// Drop the existing `$schema` so we can re-insert it as the first key
	// pointing at the freshly-emitted file. JSON property order isn't speced
	// but Node + every editor preserves insertion order — keeping $schema
	// first matches how npm/gh/Renovate scaffold their own configs.
	const { $schema: _existingSchema, ...rest } = existing ?? {}
	const merged: Record<string, unknown> = { $schema: './schema.json', ...rest, storage: storageAnswer }

	const currentModel = existing?.agent?.model ?? defaultConfig.agent.model
	const modelAnswer = await opts.prompts.agentModel(currentModel)
	merged.agent = { ...(existing?.agent ?? {}), model: modelAnswer }

	const currentUsePrs = existing?.work?.usePrs ?? defaultConfig.work.usePrs
	const usePrsAnswer = await opts.prompts.usePrs(currentUsePrs)
	const workOut: Record<string, unknown> = { ...(existing?.work ?? {}), usePrs: usePrsAnswer }

	if (usePrsAnswer) {
		const currentReview = existing?.work?.review ?? defaultConfig.work.review
		const reviewAnswer = await opts.prompts.review(currentReview)
		workOut.review = reviewAnswer
	}
	merged.work = workOut

	const json = JSON.stringify(merged, null, 2) + '\n'
	const ok = await opts.prompts.confirm(`About to write to ${filePath}:\n\n${json}\nWrite?`)
	if (!ok) {
		stdout(`Aborted; nothing written.\n`)
		return { wrote: false, path: filePath }
	}

	await mkdir(path.dirname(filePath), { recursive: true })
	await writeFile(filePath, json, 'utf8')
	stdout(`Wrote ${filePath}\n`)
	return { wrote: true, path: filePath }
}

export async function init(layerArg: string): Promise<void> {
	const allowed: InitableLayer[] = ['global', 'private', 'project']
	if (!allowed.includes(layerArg as InitableLayer)) {
		process.stderr.write(`trowel init: layer must be one of ${allowed.join(' | ')} (got: ${layerArg})\n`)
		process.exit(1)
	}

	const storageChoices = Object.keys(storageFactories).map((name) => ({ name, value: name }))
	const prompts: InitPrompts = {
		storage: (current) =>
			select({
				message: 'Storage',
				choices: storageChoices,
				default: current,
			}),
		agentModel: (current) =>
			input({
				message: 'Agent model',
				default: current,
			}),
		usePrs: (current) =>
			confirm({
				message: 'Open a draft PR per slice branch (work.usePrs)?',
				default: current,
			}),
		review: (current) =>
			confirm({
				message: 'Run the agent reviewer/addresser against PRs (work.review)?',
				default: current,
			}),
		confirm: (message) => confirm({ message, default: true }),
	}

	try {
		await runInit({ layer: layerArg as InitableLayer, prompts })
	} catch (error) {
		process.stderr.write(`trowel init: ${(error as Error).message}\n`)
		process.exit(1)
	}
}

async function readExisting(filePath: string): Promise<PartialConfig | null> {
	let raw: string
	try {
		raw = await readFile(filePath, 'utf8')
	} catch (error) {
		if ((error as any).code === 'ENOENT') return null
		throw error
	}
	const parsed = JSON.parse(raw)
	const result = v.validate(partialConfigPipe(), parsed)
	if (!result.valid) {
		const messages = result.error.messages.map((m) => `  · ${m.message ?? JSON.stringify(m)}`).join('\n')
		throw new Error(`Invalid existing config at ${filePath}:\n${messages}`)
	}
	return result.value as PartialConfig
}

if (import.meta.vitest) {
	const { describe, test, expect, beforeEach, afterEach } = import.meta.vitest
	const { mkdtemp, rm, readFile: read, writeFile: write, mkdir: mk } = await import('node:fs/promises')
	const { tmpdir } = await import('node:os')

	type Fixture = { home: string; project: string }

	async function setup(): Promise<Fixture> {
		const tmpRoot = await mkdtemp(path.join(tmpdir(), 'trowel-init-'))
		const home = path.join(tmpRoot, 'home')
		const project = path.join(tmpRoot, 'project')
		await mk(home, { recursive: true })
		await mk(project, { recursive: true })
		await mk(path.join(project, '.git'), { recursive: true })
		return { home, project }
	}

	async function teardown(f: Fixture | undefined) {
		if (!f) return
		await rm(path.dirname(f.home), { recursive: true, force: true })
	}

	function fixedPrompts(storage: string, confirm: boolean): InitPrompts {
		return {
			storage: async () => storage,
			agentModel: async (current) => current,
			usePrs: async (current) => current,
			review: async (current) => current,
			confirm: async () => confirm,
		}
	}

	describe('init: tracer (sparse write for fresh project)', () => {
		let f: Fixture
		beforeEach(async () => {
			f = await setup()
		})
		afterEach(async () => {
			await teardown(f)
		})

		test('writes a sparse file at <projectRoot>/.trowel/config.json with the keys the wizard asked about', async () => {
			const result = await runInit({
				layer: 'project',
				cwd: f.project,
				home: f.home,
				prompts: fixedPrompts('file', true),
				stdout: () => {},
			})
			expect(result.wrote).toBe(true)
			expect(result.path).toBe(path.join(f.project, '.trowel', 'config.json'))
			const raw = await read(result.path, 'utf8')
			expect(JSON.parse(raw)).toEqual({
				$schema: './schema.json',
				storage: 'file',
				agent: { model: 'claude-opus-4-6' },
				work: { usePrs: false },
			})
		})

		test('emits schema.json alongside the config file', async () => {
			await runInit({
				layer: 'project',
				cwd: f.project,
				home: f.home,
				prompts: fixedPrompts('file', true),
				stdout: () => {},
			})
			const schemaPath = path.join(f.project, '.trowel', 'schema.json')
			const schema = JSON.parse(await read(schemaPath, 'utf8'))
			expect(schema.title).toBe('Trowel config')
			expect(schema.properties).toMatchObject({ storage: expect.any(Object) })
		})

		test('written config opens with $schema as the first key', async () => {
			await runInit({
				layer: 'project',
				cwd: f.project,
				home: f.home,
				prompts: fixedPrompts('file', true),
				stdout: () => {},
			})
			const raw = await read(path.join(f.project, '.trowel', 'config.json'), 'utf8')
			expect(Object.keys(JSON.parse(raw))[0]).toBe('$schema')
		})

		test('global layer emits schema alongside the global config (not project)', async () => {
			await runInit({
				layer: 'global',
				cwd: f.project,
				home: f.home,
				prompts: fixedPrompts('file', true),
				stdout: () => {},
			})
			const schemaPath = path.join(f.home, '.trowel', 'schema.json')
			expect(JSON.parse(await read(schemaPath, 'utf8')).title).toBe('Trowel config')
		})
	})

	describe('init: agent.model prompt', () => {
		let f: Fixture
		beforeEach(async () => {
			f = await setup()
		})
		afterEach(async () => {
			await teardown(f)
		})

		test('prompts for agent.model and writes the answer into the sparse file', async () => {
			let modelDefault = ''
			await runInit({
				layer: 'project',
				cwd: f.project,
				home: f.home,
				prompts: {
					storage: async () => 'file',
					agentModel: async (current) => {
						modelDefault = current
						return 'claude-sonnet-4-6'
					},
					usePrs: async () => false,
					review: async () => false,
					confirm: async () => true,
				},
				stdout: () => {},
			})
			expect(modelDefault).toBe('claude-opus-4-6')
			const written = JSON.parse(await read(path.join(f.project, '.trowel', 'config.json'), 'utf8'))
			expect(written).toMatchObject({ agent: { model: 'claude-sonnet-4-6' } })
		})
	})

	describe('init: work.usePrs and work.review prompts', () => {
		let f: Fixture
		beforeEach(async () => {
			f = await setup()
		})
		afterEach(async () => {
			await teardown(f)
		})

		test('prompts for work.usePrs unconditionally; writes the answer', async () => {
			await runInit({
				layer: 'project',
				cwd: f.project,
				home: f.home,
				prompts: {
					storage: async () => 'file',
					agentModel: async (current) => current,
					usePrs: async () => true,
					review: async () => false,
					confirm: async () => true,
				},
				stdout: () => {},
			})
			const written = JSON.parse(await read(path.join(f.project, '.trowel', 'config.json'), 'utf8'))
			expect(written.work.usePrs).toBe(true)
		})

		test('work.review prompt is NOT called when usePrs is false; no review key in output', async () => {
			let reviewCalls = 0
			await runInit({
				layer: 'project',
				cwd: f.project,
				home: f.home,
				prompts: {
					storage: async () => 'file',
					agentModel: async (current) => current,
					usePrs: async () => false,
					review: async () => {
						reviewCalls++
						return true
					},
					confirm: async () => true,
				},
				stdout: () => {},
			})
			expect(reviewCalls).toBe(0)
			const written = JSON.parse(await read(path.join(f.project, '.trowel', 'config.json'), 'utf8'))
			expect(written.work).not.toHaveProperty('review')
		})

		test('work.review prompt IS called when usePrs is true; value stored', async () => {
			let reviewCalls = 0
			await runInit({
				layer: 'project',
				cwd: f.project,
				home: f.home,
				prompts: {
					storage: async () => 'file',
					agentModel: async (current) => current,
					usePrs: async () => true,
					review: async () => {
						reviewCalls++
						return true
					},
					confirm: async () => true,
				},
				stdout: () => {},
			})
			expect(reviewCalls).toBe(1)
			const written = JSON.parse(await read(path.join(f.project, '.trowel', 'config.json'), 'utf8'))
			expect(written.work).toMatchObject({ usePrs: true, review: true })
		})
	})

	describe('init: parent dir auto-creation', () => {
		let f: Fixture
		beforeEach(async () => {
			f = await setup()
		})
		afterEach(async () => {
			await teardown(f)
		})

		test("'private' layer creates the deep ~/.trowel/projects/<mirror>/ parent dir", async () => {
			const result = await runInit({
				layer: 'private',
				cwd: f.project,
				home: f.home,
				prompts: fixedPrompts('file', true),
				stdout: () => {},
			})
			expect(result.wrote).toBe(true)
			expect(result.path).toBe(path.join(f.home, '.trowel', 'projects', f.project.replace(/^\//, ''), 'config.json'))
			const raw = await read(result.path, 'utf8')
			expect(JSON.parse(raw)).toMatchObject({ storage: 'file' })
		})
	})

	describe('init: merge with existing file', () => {
		let f: Fixture
		beforeEach(async () => {
			f = await setup()
		})
		afterEach(async () => {
			await teardown(f)
		})

		test('preserves hand-edited keys not covered by the wizard', async () => {
			const configPath = path.join(f.project, '.trowel', 'config.json')
			await mk(path.dirname(configPath), { recursive: true })
			await write(configPath, JSON.stringify({ agent: { model: 'sonnet' } }), 'utf8')

			await runInit({
				layer: 'project',
				cwd: f.project,
				home: f.home,
				prompts: fixedPrompts('issue', true),
				stdout: () => {},
			})

			const merged = JSON.parse(await read(configPath, 'utf8'))
			expect(merged).toMatchObject({
				storage: 'issue',
				agent: { model: 'sonnet' },
			})
		})

		test('passes existing storage value to the storage prompt as default', async () => {
			const configPath = path.join(f.project, '.trowel', 'config.json')
			await mk(path.dirname(configPath), { recursive: true })
			await write(configPath, JSON.stringify({ storage: 'issue' }), 'utf8')

			let promptDefault: string | undefined
			await runInit({
				layer: 'project',
				cwd: f.project,
				home: f.home,
				prompts: {
					storage: async (current) => {
						promptDefault = current
						return 'issue'
					},
					agentModel: async (current) => current,
					usePrs: async (current) => current,
					review: async (current) => current,
					confirm: async () => true,
				},
				stdout: () => {},
			})
			expect(promptDefault).toBe('issue')
		})

		test("refuses 'project' layer when no project root", async () => {
			await expect(
				runInit({
					layer: 'project',
					cwd: '/tmp/elsewhere',
					home: f.home,
					prompts: fixedPrompts('file', true),
					stdout: () => {},
					resolveRoot: async () => null,
				}),
			).rejects.toThrow(/no project root found/i)
		})

		test("refuses 'private' layer when no project root", async () => {
			await expect(
				runInit({
					layer: 'private',
					cwd: '/tmp/elsewhere',
					home: f.home,
					prompts: fixedPrompts('file', true),
					stdout: () => {},
					resolveRoot: async () => null,
				}),
			).rejects.toThrow(/no project root found/i)
		})

		test("'global' layer works without a project root", async () => {
			const result = await runInit({
				layer: 'global',
				cwd: '/tmp/elsewhere',
				home: f.home,
				prompts: fixedPrompts('file', true),
				stdout: () => {},
				resolveRoot: async () => null,
			})
			expect(result.wrote).toBe(true)
			expect(result.path).toBe(path.join(f.home, '.trowel', 'config.json'))
			const raw = await read(result.path, 'utf8')
			expect(JSON.parse(raw)).toMatchObject({ storage: 'file' })
		})

		test('user declines confirm → file is not written, returns wrote=false', async () => {
			const result = await runInit({
				layer: 'project',
				cwd: f.project,
				home: f.home,
				prompts: fixedPrompts('issue', false),
				stdout: () => {},
			})
			expect(result.wrote).toBe(false)
			expect(result.path).toBe(path.join(f.project, '.trowel', 'config.json'))
			await expect(read(result.path, 'utf8')).rejects.toThrow(/ENOENT/)
		})

		test('confirm prompt receives the rendered JSON in its message', async () => {
			let confirmMsg = ''
			await runInit({
				layer: 'project',
				cwd: f.project,
				home: f.home,
				prompts: {
					storage: async () => 'issue',
					agentModel: async (current) => current,
					usePrs: async (current) => current,
					review: async (current) => current,
					confirm: async (m) => {
						confirmMsg = m
						return false
					},
				},
				stdout: () => {},
			})
			expect(confirmMsg).toContain('"storage": "issue"')
			expect(confirmMsg).toContain(path.join(f.project, '.trowel', 'config.json'))
		})

		test('rejects an existing file with an invalid config', async () => {
			const configPath = path.join(f.project, '.trowel', 'config.json')
			await mk(path.dirname(configPath), { recursive: true })
			await write(configPath, JSON.stringify({ storage: 'mongo' }), 'utf8')

			await expect(
				runInit({
					layer: 'project',
					cwd: f.project,
					home: f.home,
					prompts: fixedPrompts('file', true),
					stdout: () => {},
				}),
			).rejects.toThrow(/Invalid existing config/)
		})
	})
}
