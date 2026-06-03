import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'

import { confirm, input, select } from '@inquirer/prompts'

import { pathForLayer, validatePartialConfig } from '../config.ts'
import { harnessFactories } from '../harnesses/registry.ts'
import { resolveProjectRoot } from '../project.ts'
import { defaultConfig, emitJsonSchema, type InitableLayer, type PartialConfig } from '../schema.ts'
import { storageFactories } from '../storages/registry.ts'

type InitPrompts = {
	storage: (current: string) => Promise<string>
	prdsDir: (current: string) => Promise<string>
	agentHarness: (current: string) => Promise<string>
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
type InitRuntimeContext = { cwd: string; home: string; stdout: (s: string) => void; resolveRoot: (cwd: string) => Promise<string | null> }
type InitTarget = { projectRoot: string | null; filePath: string }

async function runInit(opts: RunInitOptions): Promise<RunInitResult> {
	const ctx = initRuntimeContext(opts)
	const target = await resolveInitTarget(opts, ctx)
	const existing = await readExisting(target.filePath)
	await emitSchemaFile(target.filePath, ctx.stdout)
	const merged = await buildInitConfig(opts, existing)
	const json = JSON.stringify(merged, null, 2) + '\n'
	return confirmAndWriteInitConfig(opts, target.filePath, json, ctx.stdout)
}

function initRuntimeContext(opts: RunInitOptions): InitRuntimeContext {
	return {
		cwd: valueOrDefault(opts.cwd, process.cwd()),
		home: valueOrDefault(opts.home, homedir()),
		stdout: valueOrDefault(opts.stdout, (s) => process.stdout.write(s)),
		resolveRoot: valueOrDefault(opts.resolveRoot, resolveProjectRoot),
	}
}

function valueOrDefault<T>(value: T | undefined, fallback: T): T {
	return value === undefined ? fallback : value
}

async function resolveInitTarget(opts: RunInitOptions, ctx: InitRuntimeContext): Promise<InitTarget> {
	const projectRoot = await ctx.resolveRoot(ctx.cwd)
	if (requiresProjectRoot(opts.layer) && projectRoot === null) {
		throw new Error(`no project root found (no .git/ or .trowel/ walking up from ${ctx.cwd}). Run 'git init' first, or cd into a git repo.`)
	}
	const filePath = pathForLayer(opts.layer, projectRoot, ctx.home)
	if (filePath === null) throw new Error(`cannot resolve config path for layer '${opts.layer}'`)
	return { projectRoot, filePath }
}

function requiresProjectRoot(layer: InitableLayer): boolean {
	return layer === 'project' || layer === 'private'
}

async function emitSchemaFile(filePath: string, stdout: (s: string) => void): Promise<void> {
	const schemaPath = path.join(path.dirname(filePath), 'schema.json')
	await mkdir(path.dirname(schemaPath), { recursive: true })
	await writeFile(schemaPath, JSON.stringify(emitJsonSchema(), null, 2) + '\n', 'utf8')
	stdout(`Wrote ${schemaPath}\n`)
}

async function buildInitConfig(opts: RunInitOptions, existing: PartialConfig | null): Promise<Record<string, unknown>> {
	const storageAnswer = await opts.prompts.storage(currentStorage(existing))
	const merged = baseInitConfig(existing, storageAnswer)
	if (storageAnswer === 'file') await addFileStorageConfig(opts, existing, merged)
	await addAgentConfig(opts, existing, merged)
	await addWorkConfig(opts, existing, merged)
	return merged
}

function baseInitConfig(existing: PartialConfig | null, storage: string): Record<string, unknown> {
	const { $schema: _existingSchema, ...rest } = existing ?? {}
	return { $schema: './schema.json', ...rest, storage }
}

function currentStorage(existing: PartialConfig | null): string {
	return valueOrDefault(existing?.storage, 'file')
}

async function addFileStorageConfig(opts: RunInitOptions, existing: PartialConfig | null, merged: Record<string, unknown>): Promise<void> {
	const prdsDirAnswer = await opts.prompts.prdsDir(currentPrdsDir(existing))
	merged.docs = { ...docsConfig(existing), prdsDir: prdsDirAnswer }
}

function docsConfig(existing: PartialConfig | null): Partial<NonNullable<PartialConfig['docs']>> {
	return existing?.docs ?? {}
}

function currentPrdsDir(existing: PartialConfig | null): string {
	return valueOrDefault(docsConfig(existing).prdsDir, defaultConfig.docs.prdsDir)
}

async function addAgentConfig(opts: RunInitOptions, existing: PartialConfig | null, merged: Record<string, unknown>): Promise<void> {
	const harnessAnswer = await opts.prompts.agentHarness(currentHarness(existing))
	const harness = harnessFactories[harnessAnswer as keyof typeof harnessFactories]
	if (!harness) throw new Error(`unknown harness '${harnessAnswer}'`)
	const modelAnswer = await opts.prompts.agentModel(modelDefaultForHarness(existing, harnessAnswer, harness.defaultModel))
	merged.agent = { ...agentConfig(existing), harness: harnessAnswer, model: modelAnswer }
}

function agentConfig(existing: PartialConfig | null): Partial<NonNullable<PartialConfig['agent']>> {
	return existing?.agent ?? {}
}

function currentHarness(existing: PartialConfig | null): string {
	return valueOrDefault(agentConfig(existing).harness, defaultConfig.agent.harness)
}

function modelDefaultForHarness(existing: PartialConfig | null, harnessAnswer: string, defaultModel: string): string {
	if (currentHarness(existing) !== harnessAnswer) return defaultModel
	return valueOrDefault(agentConfig(existing).model, defaultModel)
}

async function addWorkConfig(opts: RunInitOptions, existing: PartialConfig | null, merged: Record<string, unknown>): Promise<void> {
	const usePrsAnswer = await opts.prompts.usePrs(currentUsePrs(existing))
	const workOut: Record<string, unknown> = { ...workConfig(existing), usePrs: usePrsAnswer }
	if (usePrsAnswer) workOut.review = await opts.prompts.review(currentReview(existing))
	merged.work = workOut
}

function workConfig(existing: PartialConfig | null): Partial<NonNullable<PartialConfig['work']>> {
	return existing?.work ?? {}
}

function currentUsePrs(existing: PartialConfig | null): boolean {
	return valueOrDefault(workConfig(existing).usePrs, defaultConfig.work.usePrs)
}

function currentReview(existing: PartialConfig | null): boolean {
	return valueOrDefault(workConfig(existing).review, defaultConfig.work.review)
}

async function confirmAndWriteInitConfig(opts: RunInitOptions, filePath: string, json: string, stdout: (s: string) => void): Promise<RunInitResult> {
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
	const harnessChoices = Object.keys(harnessFactories).map((name) => ({ name, value: name }))
	const prompts: InitPrompts = {
		storage: (current) =>
			select({
				message: 'Storage',
				choices: storageChoices,
				default: current,
			}),
		prdsDir: (current) =>
			input({
				message: 'PRD docs directory (project-relative)',
				default: current,
				validate: validatePrdsDir,
			}),
		agentHarness: (current) =>
			select({
				message: 'Agent harness',
				choices: harnessChoices,
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

function validatePrdsDir(s: string): true | string {
	if (s.trim() === '') return 'cannot be empty'
	if (path.isAbsolute(s)) return 'must be project-relative (no leading /)'
	return true
}

async function readExisting(filePath: string): Promise<PartialConfig | null> {
	let raw: string
	try {
		raw = await readFile(filePath, 'utf8')
	} catch (error) {
		if ((error as any).code === 'ENOENT') return null
		throw error
	}
	return validatePartialConfig(filePath, JSON.parse(raw), 'Invalid existing config')
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

	function fixedPrompts(storage: string, confirm: boolean, overrides: Partial<InitPrompts> = {}): InitPrompts {
		return {
			storage: async () => storage,
			prdsDir: async (current) => current,
			agentHarness: async (current) => current,
			agentModel: async (current) => current,
			usePrs: async (current) => current,
			review: async (current) => current,
			confirm: async () => confirm,
			...overrides,
		}
	}

	function runProjectInit(f: Fixture, prompts: InitPrompts, stdout: (s: string) => void = () => {}) {
		return runInit({ layer: 'project', cwd: f.project, home: f.home, prompts, stdout })
	}

	function promptsForFile(overrides: Partial<InitPrompts> = {}): InitPrompts {
		return fixedPrompts('file', true, { usePrs: async () => false, review: async () => false, ...overrides })
	}

	function promptsForIssue(overrides: Partial<InitPrompts> = {}): InitPrompts {
		return fixedPrompts('issue', true, { usePrs: async () => false, review: async () => false, ...overrides })
	}

	async function modelDefaultForExistingAgent(f: Fixture, agent: Record<string, string>, harness = 'claude'): Promise<string | undefined> {
		const configPath = path.join(f.project, '.trowel', 'config.json')
		await mk(path.dirname(configPath), { recursive: true })
		await write(configPath, JSON.stringify({ agent }), 'utf8')
		let seenModelDefault: string | undefined
		await runProjectInit(
			f,
			promptsForFile({
				agentHarness: async () => harness,
				agentModel: async (current) => {
					seenModelDefault = current
					return current
				},
			}),
		)
		return seenModelDefault
	}

	describe('validatePrdsDir', () => {
		test('accepts a normal project-relative path', () => {
			expect(validatePrdsDir('docs/prds')).toBe(true)
			expect(validatePrdsDir('some/nested/dir')).toBe(true)
		})

		test('rejects empty string', () => {
			expect(validatePrdsDir('')).toMatch(/empty/i)
		})

		test('rejects whitespace-only string', () => {
			expect(validatePrdsDir('   ')).toMatch(/empty/i)
		})

		test('rejects an absolute path (leading slash)', () => {
			expect(validatePrdsDir('/etc/prds')).toMatch(/project-relative/i)
		})
	})

	describe('init: tracer (sparse write for fresh project)', () => {
		let f: Fixture
		beforeEach(async () => {
			f = await setup()
		})
		afterEach(async () => {
			await teardown(f)
		})

		test('writes a sparse file at <projectRoot>/.trowel/config.json with the keys the wizard asked about', async () => {
			const result = await runProjectInit(f, fixedPrompts('file', true))
			expect(result.wrote).toBe(true)
			expect(result.path).toBe(path.join(f.project, '.trowel', 'config.json'))
			const raw = await read(result.path, 'utf8')
			expect(JSON.parse(raw)).toEqual({
				$schema: './schema.json',
				storage: 'file',
				docs: { prdsDir: 'docs/prds' },
				agent: { harness: 'claude', model: 'claude-opus-4-6' },
				work: { usePrs: false },
			})
		})

		test('emits schema.json alongside the config file', async () => {
			await runProjectInit(f, fixedPrompts('file', true))
			const schemaPath = path.join(f.project, '.trowel', 'schema.json')
			const schema = JSON.parse(await read(schemaPath, 'utf8'))
			expect(schema.title).toBe('Trowel config')
			expect(schema.properties).toMatchObject({ storage: expect.any(Object) })
		})

		test('written config opens with $schema as the first key', async () => {
			await runProjectInit(f, fixedPrompts('file', true))
			const raw = await read(path.join(f.project, '.trowel', 'config.json'), 'utf8')
			expect(Object.keys(JSON.parse(raw))[0]).toBe('$schema')
		})

		test('global layer emits schema alongside the global config (not project)', async () => {
			await runInit({
				layer: 'global',
				cwd: f.project,
				home: f.home,
				prompts: promptsForFile(),
				stdout: () => {},
			})
			const schemaPath = path.join(f.home, '.trowel', 'schema.json')
			expect(JSON.parse(await read(schemaPath, 'utf8')).title).toBe('Trowel config')
		})
	})

	describe('init: docs.prdsDir prompt (file storage)', () => {
		let f: Fixture
		beforeEach(async () => {
			f = await setup()
		})
		afterEach(async () => {
			await teardown(f)
		})

		test('on file storage, prompts for prdsDir and writes the answer to docs.prdsDir', async () => {
			await runProjectInit(f, promptsForFile({ prdsDir: async () => 'custom/prds-here' }))
			const written = JSON.parse(await read(path.join(f.project, '.trowel', 'config.json'), 'utf8'))
			expect(written.docs).toEqual({ prdsDir: 'custom/prds-here' })
		})
	})

	describe('init: docs.prdsDir on issue storage', () => {
		let f: Fixture
		beforeEach(async () => {
			f = await setup()
		})
		afterEach(async () => {
			await teardown(f)
		})

		test('on issue storage, prdsDir prompt is NOT called', async () => {
			let prdsDirCalls = 0
			await runProjectInit(
				f,
				promptsForIssue({
					prdsDir: async (current) => {
						prdsDirCalls++
						return current
					},
				}),
			)
			expect(prdsDirCalls).toBe(0)
		})

		test('on issue storage, existing docs.prdsDir is preserved as-is in the merged output', async () => {
			const configPath = path.join(f.project, '.trowel', 'config.json')
			await mk(path.dirname(configPath), { recursive: true })
			await write(configPath, JSON.stringify({ storage: 'file', docs: { prdsDir: 'keep/me' } }), 'utf8')

			await runProjectInit(f, fixedPrompts('issue', true))
			const merged = JSON.parse(await read(configPath, 'utf8'))
			expect(merged.storage).toBe('issue')
			expect(merged.docs).toEqual({ prdsDir: 'keep/me' })
		})
	})

	describe('init: docs.prdsDir default resolution', () => {
		let f: Fixture
		beforeEach(async () => {
			f = await setup()
		})
		afterEach(async () => {
			await teardown(f)
		})

		test('fresh project (no existing config) → default is the hard-coded fallback "docs/prds"', async () => {
			let seenDefault: string | undefined
			await runProjectInit(
				f,
				promptsForFile({
					prdsDir: async (current) => {
						seenDefault = current
						return current
					},
				}),
			)
			expect(seenDefault).toBe('docs/prds')
		})

		test('existing config with custom docs.prdsDir → that value is the prompt default', async () => {
			const configPath = path.join(f.project, '.trowel', 'config.json')
			await mk(path.dirname(configPath), { recursive: true })
			await write(configPath, JSON.stringify({ storage: 'file', docs: { prdsDir: 'a/b/c' } }), 'utf8')

			let seenDefault: string | undefined
			await runProjectInit(
				f,
				promptsForFile({
					prdsDir: async (current) => {
						seenDefault = current
						return current
					},
				}),
			)
			expect(seenDefault).toBe('a/b/c')
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
			await runProjectInit(
				f,
				promptsForFile({
					agentModel: async (current) => {
						modelDefault = current
						return 'claude-sonnet-4-6'
					},
				}),
			)
			expect(modelDefault).toBe('claude-opus-4-6')
			const written = JSON.parse(await read(path.join(f.project, '.trowel', 'config.json'), 'utf8'))
			expect(written).toMatchObject({ agent: { model: 'claude-sonnet-4-6' } })
		})
	})

	describe('init: agent.harness prompt', () => {
		let f: Fixture
		beforeEach(async () => {
			f = await setup()
		})
		afterEach(async () => {
			await teardown(f)
		})

		test('fresh project → harness default is "claude" and gets written', async () => {
			let seenHarnessDefault: string | undefined
			await runProjectInit(
				f,
				promptsForFile({
					agentHarness: async (current) => {
						seenHarnessDefault = current
						return current
					},
				}),
			)
			expect(seenHarnessDefault).toBe('claude')
			const written = JSON.parse(await read(path.join(f.project, '.trowel', 'config.json'), 'utf8'))
			expect(written.agent.harness).toBe('claude')
		})

		test('switching harness resets the model default to the new harness\'s defaultModel', async () => {
			const configPath = path.join(f.project, '.trowel', 'config.json')
			await mk(path.dirname(configPath), { recursive: true })
			await write(configPath, JSON.stringify({ agent: { harness: 'claude', model: 'claude-opus-4-6' } }), 'utf8')

			let seenModelDefault: string | undefined
			await runProjectInit(
				f,
				promptsForFile({
					agentHarness: async () => 'pi',
					agentModel: async (current) => {
						seenModelDefault = current
						return current
					},
				}),
			)
			// pi's defaultModel is 'anthropic/claude-sonnet-4-5'; the old 'claude-opus-4-6' must not be reused.
			expect(seenModelDefault).not.toBe('claude-opus-4-6')
			expect(seenModelDefault?.startsWith('anthropic/')).toBe(true)
		})

		test('keeping the same harness preserves the existing model as the prompt default', async () => {
			const seenModelDefault = await modelDefaultForExistingAgent(f, { harness: 'claude', model: 'claude-sonnet-4-6' })
			expect(seenModelDefault).toBe('claude-sonnet-4-6')
		})

		test('legacy config with bare agent.model and no agent.harness → treated as claude (model preserved)', async () => {
			const seenModelDefault = await modelDefaultForExistingAgent(f, { model: 'claude-sonnet-4-6' })
			expect(seenModelDefault).toBe('claude-sonnet-4-6')
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
			await runProjectInit(f, promptsForFile({ usePrs: async () => true }))
			const written = JSON.parse(await read(path.join(f.project, '.trowel', 'config.json'), 'utf8'))
			expect(written.work.usePrs).toBe(true)
		})

		test('work.review prompt is NOT called when usePrs is false; no review key in output', async () => {
			let reviewCalls = 0
			await runProjectInit(
				f,
				promptsForFile({
					usePrs: async () => false,
					review: async () => {
						reviewCalls++
						return true
					},
				}),
			)
			expect(reviewCalls).toBe(0)
			const written = JSON.parse(await read(path.join(f.project, '.trowel', 'config.json'), 'utf8'))
			expect(written.work).not.toHaveProperty('review')
		})

		test('work.review prompt IS called when usePrs is true; value stored', async () => {
			let reviewCalls = 0
			await runProjectInit(
				f,
				promptsForFile({
					usePrs: async () => true,
					review: async () => {
						reviewCalls++
						return true
					},
				}),
			)
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
				prompts: promptsForFile(),
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

			await runProjectInit(f, fixedPrompts('issue', true))

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
			await runProjectInit(
				f,
				fixedPrompts('issue', true, {
					storage: async (current) => {
						promptDefault = current
						return 'issue'
					},
				}),
			)
			expect(promptDefault).toBe('issue')
		})

		test("refuses 'project' layer when no project root", async () => {
			await expect(
				runInit({
					layer: 'project',
					cwd: '/tmp/elsewhere',
					home: f.home,
					prompts: promptsForFile(),
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
					prompts: promptsForFile(),
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
				prompts: promptsForFile(),
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
			await runProjectInit(
				f,
				fixedPrompts('issue', true, {
					confirm: async (m) => {
						confirmMsg = m
						return false
					},
				}),
			)
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
					prompts: promptsForFile(),
					stdout: () => {},
				}),
			).rejects.toThrow(/Invalid existing config/)
		})
	})
}
