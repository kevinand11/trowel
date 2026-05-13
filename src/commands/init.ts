import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'

import { confirm, input, select } from '@inquirer/prompts'
import { v } from 'valleyed'

import { pathForLayer } from '../config.ts'
import { resolveProjectRoot } from '../project.ts'
import { partialConfigPipe, type InitableLayer, type PartialConfig } from '../schema.ts'
import { storageFactories } from '../storages/registry.ts'

type InitPrompts = {
	storage: (current: string) => Promise<string>
	branchPrefix: (current: string) => Promise<string>
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

	const currentStorage = existing?.storage ?? 'file'
	const storageAnswer = await opts.prompts.storage(currentStorage)

	const merged: Record<string, unknown> = { ...(existing ?? {}), storage: storageAnswer }

	if (storageAnswer === 'issue') {
		const currentPrefix = existing?.branchPrefix ?? 'prds-issue-'
		merged.branchPrefix = await opts.prompts.branchPrefix(currentPrefix)
	}

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
		branchPrefix: (current) =>
			input({
				message: 'Branch prefix',
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

	function fixedPrompts(storage: string, branchPrefix: string, confirm: boolean): InitPrompts {
		return {
			storage: async () => storage,
			branchPrefix: async () => branchPrefix,
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

		test('writes a sparse file with just the chosen storage at <projectRoot>/.trowel/config.json', async () => {
			const result = await runInit({
				layer: 'project',
				cwd: f.project,
				home: f.home,
				prompts: fixedPrompts('file', '', true),
				stdout: () => {},
			})
			expect(result.wrote).toBe(true)
			expect(result.path).toBe(path.join(f.project, '.trowel', 'config.json'))
			const raw = await read(result.path, 'utf8')
			expect(JSON.parse(raw)).toEqual({ storage: 'file' })
		})
	})

	describe('init: branchPrefix prompt is conditional on storage', () => {
		let f: Fixture
		beforeEach(async () => {
			f = await setup()
		})
		afterEach(async () => {
			await teardown(f)
		})

		test('storage=file → branchPrefix prompt is NOT called; no branchPrefix in output', async () => {
			let prefixCalled = 0
			await runInit({
				layer: 'project',
				cwd: f.project,
				home: f.home,
				prompts: {
					storage: async () => 'file',
					branchPrefix: async () => {
						prefixCalled++
						return 'should-not-be-stored'
					},
					confirm: async () => true,
				},
				stdout: () => {},
			})
			expect(prefixCalled).toBe(0)
			const written = JSON.parse(await read(path.join(f.project, '.trowel', 'config.json'), 'utf8'))
			expect(written).not.toHaveProperty('branchPrefix')
		})

		test("storage=issue → branchPrefix prompt is called with 'prds-issue-' as default; value stored", async () => {
			let prefixDefault = ''
			await runInit({
				layer: 'project',
				cwd: f.project,
				home: f.home,
				prompts: {
					storage: async () => 'issue',
					branchPrefix: async (current) => {
						prefixDefault = current
						return 'prds-issue-'
					},
					confirm: async () => true,
				},
				stdout: () => {},
			})
			expect(prefixDefault).toBe('prds-issue-')
			const written = JSON.parse(await read(path.join(f.project, '.trowel', 'config.json'), 'utf8'))
			expect(written).toEqual({ storage: 'issue', branchPrefix: 'prds-issue-' })
		})

		test('storage=issue + existing branchPrefix → prompt uses existing as default', async () => {
			const configPath = path.join(f.project, '.trowel', 'config.json')
			await mk(path.dirname(configPath), { recursive: true })
			await write(configPath, JSON.stringify({ storage: 'issue', branchPrefix: 'feat/' }), 'utf8')

			let prefixDefault = ''
			await runInit({
				layer: 'project',
				cwd: f.project,
				home: f.home,
				prompts: {
					storage: async () => 'issue',
					branchPrefix: async (current) => {
						prefixDefault = current
						return current
					},
					confirm: async () => true,
				},
				stdout: () => {},
			})
			expect(prefixDefault).toBe('feat/')
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
				prompts: fixedPrompts('file', '', true),
				stdout: () => {},
			})
			expect(result.wrote).toBe(true)
			expect(result.path).toBe(path.join(f.home, '.trowel', 'projects', f.project.replace(/^\//, ''), 'config.json'))
			const raw = await read(result.path, 'utf8')
			expect(JSON.parse(raw)).toEqual({ storage: 'file' })
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
				prompts: fixedPrompts('issue', '', true),
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
					branchPrefix: async () => '',
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
					prompts: fixedPrompts('file', '', true),
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
					prompts: fixedPrompts('file', '', true),
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
				prompts: fixedPrompts('file', '', true),
				stdout: () => {},
				resolveRoot: async () => null,
			})
			expect(result.wrote).toBe(true)
			expect(result.path).toBe(path.join(f.home, '.trowel', 'config.json'))
			const raw = await read(result.path, 'utf8')
			expect(JSON.parse(raw)).toEqual({ storage: 'file' })
		})

		test('user declines confirm → file is not written, returns wrote=false', async () => {
			const result = await runInit({
				layer: 'project',
				cwd: f.project,
				home: f.home,
				prompts: fixedPrompts('issue', '', false),
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
					branchPrefix: async () => '',
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
					prompts: fixedPrompts('file', '', true),
					stdout: () => {},
				}),
			).rejects.toThrow(/Invalid existing config/)
		})
	})
}
