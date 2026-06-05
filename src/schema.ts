import { v, type DeepPartial, type PipeOutput } from 'valleyed'

import { harnessFactories, type HarnessKind } from './harnesses/registry.ts'
import { storageFactories, type StorageKind } from './storages/registry.ts'

export const partialConfigPipe = () =>
	v.object({
		// File-only annotation. Editors use it to fetch a JSON Schema for
		// autocomplete; runtime code never reads it. `trowel init` writes it
		// pointing at ~/.trowel/schema.json.
		$schema: v.optional(v.string()),
		storage: v.optional(v.in(Object.keys(storageFactories) as StorageKind[])),
		docs: v.optional(
			v.object({
				changesDir: v.optional(v.string()),
			}),
		),
		agent: v.optional(
			v.object({
				harness: v.optional(v.in(Object.keys(harnessFactories) as HarnessKind[])),
				model: v.optional(v.string()),
			}),
		),
		labels: v.optional(
			v.object({
				readyForAgent: v.optional(v.string()),
				needsRevision: v.optional(v.string()),
				change: v.optional(v.string()),
			}),
		),
		abort: v.optional(
			v.object({
				comment: v.optional(v.nullable(v.string())),
				deleteBranch: v.optional(v.in(['always', 'never', 'prompt'] as const)),
			}),
		),
		ship: v.optional(
			v.object({
				pr: v.optional(v.boolean()),
				mergeMethod: v.optional(v.in(['merge', 'squash', 'rebase'] as const)),
				deleteBranch: v.optional(v.in(['always', 'never', 'prompt'] as const)),
			}),
		),
		turn: v.optional(
			v.object({
				copyToWorktree: v.optional(v.array(v.string())),
				maxConcurrent: v.optional(v.nullable(v.number())),
			}),
		),
		work: v.optional(
			v.object({
				audit: v.optional(v.boolean()),
				perSliceBranches: v.optional(v.boolean()),
				worktreeCleanupAge: v.optional(v.string()),
				mergeNoVerify: v.optional(v.boolean()),
			}),
		),
	})

export type PartialConfig = PipeOutput<ReturnType<typeof partialConfigPipe>>

export type Config = {
	storage: StorageKind
	docs: {
		changesDir: string
	}
	agent: {
		harness: HarnessKind
		model: string
	}
	labels: {
		readyForAgent: string
		needsRevision: string
		change: string
	}
	abort: {
		comment: string | null
		deleteBranch: 'always' | 'never' | 'prompt'
	}
	ship: {
		pr: boolean
		mergeMethod: 'merge' | 'squash' | 'rebase'
		deleteBranch: 'always' | 'never' | 'prompt'
	}
	turn: {
		copyToWorktree: string[]
		maxConcurrent: number | null
	}
	work: {
		audit: boolean
		perSliceBranches: boolean
		worktreeCleanupAge: string
		mergeNoVerify: boolean
	}
}

// The four config sources, named (not numbered). Precedence under β:
// default < global < private < project. The project file wins outright.
export type ConfigLayer = 'default' | 'global' | 'private' | 'project'

// The three init-able layers (every layer except the hard-coded 'default').
export type InitableLayer = Exclude<ConfigLayer, 'default'>

// Hard-coded defaults — the 'default' layer. Every field present.
export const defaultConfig: Config = {
	storage: 'file',
	docs: {
		changesDir: 'docs/changes',
	},
	agent: {
		harness: 'claude',
		model: harnessFactories.claude.defaultModel,
	},
	labels: {
		readyForAgent: 'ready-for-agent',
		needsRevision: 'needs-revision',
		change: 'change',
	},
	abort: {
		comment: 'Closed via trowel',
		deleteBranch: 'prompt',
	},
	ship: {
		pr: true,
		mergeMethod: 'merge',
		deleteBranch: 'prompt',
	},
	turn: {
		copyToWorktree: [],
		maxConcurrent: 3,
	},
	work: {
		audit: false,
		perSliceBranches: true,
		worktreeCleanupAge: '24h',
		mergeNoVerify: false,
	},
}

export function emitJsonSchema(): Record<string, unknown> {
	return {
		$schema: 'http://json-schema.org/draft-07/schema#',
		title: 'Trowel config',
		...partialConfigPipe().schema({}),
	}
}

// Deep-merge a partial layer onto an existing Config, producing a new Config.
// Per-key: present in partial → override; absent → keep existing.
export function mergePartial(base: Config, partial: DeepPartial<Config> | undefined): Config {
	if (!partial) return base
	return deepMerge(base, partial) as Config
}

function deepMerge<T extends Record<string, unknown>>(a: T, b: DeepPartial<T>): T {
	const out = { ...a } as Record<string, unknown>
	for (const [k, v] of Object.entries(b)) assignMergedValue(out, a, k, v)
	return out as T
}

function assignMergedValue(out: Record<string, unknown>, base: Record<string, unknown>, key: string, value: unknown): void {
	if (value === undefined) return
	out[key] = mergedValue(base[key], value)
}

function mergedValue(baseValue: unknown, nextValue: unknown): unknown {
	if (isPlainObject(baseValue) && isPlainObject(nextValue)) return deepMerge(baseValue, nextValue as DeepPartial<Record<string, unknown>>)
	return nextValue
}

function isPlainObject(x: unknown): x is Record<string, unknown> {
	return typeof x === 'object' && x !== null && !Array.isArray(x)
}

if (import.meta.vitest) {
	const { describe, test, expect } = import.meta.vitest

	describe('defaultConfig', () => {
		test('uses file as the default storage', () => {
			expect(defaultConfig.storage).toBe('file')
		})

		test('labels.change defaults to "change"', () => {
			expect(defaultConfig.labels.change).toBe('change')
		})

		test('close defaults to prompt + "Closed via trowel"', () => {
			expect(defaultConfig.abort.deleteBranch).toBe('prompt')
			expect(defaultConfig.abort.comment).toBe('Closed via trowel')
		})

		test('ship defaults to PR mode, merge method, and prompt branch deletion', () => {
			expect(defaultConfig.ship.pr).toBe(true)
			expect(defaultConfig.ship.mergeMethod).toBe('merge')
			expect(defaultConfig.ship.deleteBranch).toBe('prompt')
		})

		test('turn defaults to maxConcurrent: 3 and empty copyToWorktree', () => {
			expect(defaultConfig.turn.maxConcurrent).toBe(3)
			expect(defaultConfig.turn.copyToWorktree).toEqual([])
		})

		test('agent defaults to claude-opus-4-6', () => {
			expect(defaultConfig.agent.model).toBe('claude-opus-4-6')
		})

		test('work loop defaults: Auditing off, 24h worktree cleanup', () => {
			expect(defaultConfig.work.audit).toBe(false)
			expect(defaultConfig.work.worktreeCleanupAge).toBe('24h')
		})

		test('work.perSliceBranches defaults to true (slice-branches by default)', () => {
			expect(defaultConfig.work.perSliceBranches).toBe(true)
		})
	})

	describe('mergePartial', () => {
		test('returns the base unchanged when partial is undefined', () => {
			const result = mergePartial(defaultConfig, undefined)
			expect(result).toEqual(defaultConfig)
		})

		test('overrides a primitive value at the top level', () => {
			const result = mergePartial(defaultConfig, { storage: 'issue' })
			expect(result.storage).toBe('issue')
		})

		test('deep-merges nested objects per-key', () => {
			const result = mergePartial(defaultConfig, { turn: { maxConcurrent: 7 } })
			expect(result.turn.maxConcurrent).toBe(7)
			expect(result.turn.copyToWorktree).toEqual(defaultConfig.turn.copyToWorktree)
		})

		test('replaces arrays whole (no element merging)', () => {
			const result = mergePartial(defaultConfig, { turn: { copyToWorktree: ['node_modules'] } })
			expect(result.turn.copyToWorktree).toEqual(['node_modules'])
		})

		test('ignores undefined values inside a partial', () => {
			const result = mergePartial(defaultConfig, { agent: { model: undefined } })
			expect(result.agent.model).toBe(defaultConfig.agent.model)
		})

		test('does not mutate the base', () => {
			const baseSnapshot = JSON.parse(JSON.stringify(defaultConfig))
			mergePartial(defaultConfig, { storage: 'issue', agent: { model: 'sonnet' } })
			expect(defaultConfig).toEqual(baseSnapshot)
		})
	})

	describe('partialConfigPipe', () => {
		test('accepts an empty object (every field optional)', () => {
			const result = v.validate(partialConfigPipe(), {})
			expect(result.valid).toBe(true)
		})

		test('accepts a partial with only one nested key set', () => {
			const result = v.validate(partialConfigPipe(), { agent: { model: 'sonnet' } })
			expect(result.valid).toBe(true)
		})

		test('accepts labels.change as a string', () => {
			const result = v.validate(partialConfigPipe(), { labels: { change: 'feature' } })
			expect(result.valid).toBe(true)
		})

		test('accepts close.deleteBranch with valid policy', () => {
			const result = v.validate(partialConfigPipe(), { abort: { deleteBranch: 'always' } })
			expect(result.valid).toBe(true)
		})

		test('rejects close.deleteBranch with invalid policy', () => {
			const result = v.validate(partialConfigPipe(), { abort: { deleteBranch: 'maybe' } })
			expect(result.valid).toBe(false)
		})

		test('accepts ship config values', () => {
			expect(v.validate(partialConfigPipe(), { ship: { pr: false, mergeMethod: 'squash', deleteBranch: 'always' } }).valid).toBe(true)
		})

		test('rejects invalid ship config values', () => {
			expect(v.validate(partialConfigPipe(), { ship: { mergeMethod: 'fast-forward' } }).valid).toBe(false)
			expect(v.validate(partialConfigPipe(), { ship: { deleteBranch: 'maybe' } }).valid).toBe(false)
		})

		test('accepts turn.maxConcurrent as a number or null', () => {
			expect(v.validate(partialConfigPipe(), { turn: { maxConcurrent: 5 } }).valid).toBe(true)
			expect(v.validate(partialConfigPipe(), { turn: { maxConcurrent: null } }).valid).toBe(true)
		})

		test('accepts turn.copyToWorktree as a string array', () => {
			const result = v.validate(partialConfigPipe(), { turn: { copyToWorktree: ['node_modules'] } })
			expect(result.valid).toBe(true)
		})

		test('accepts ship.pr as a boolean', () => {
			expect(v.validate(partialConfigPipe(), { ship: { pr: false } }).valid).toBe(true)
			expect(v.validate(partialConfigPipe(), { ship: { pr: true } }).valid).toBe(true)
		})

		test('accepts work.audit as a boolean', () => {
			expect(v.validate(partialConfigPipe(), { work: { audit: false } }).valid).toBe(true)
			expect(v.validate(partialConfigPipe(), { work: { audit: true } }).valid).toBe(true)
		})

		test('accepts work.perSliceBranches as a boolean', () => {
			expect(v.validate(partialConfigPipe(), { work: { perSliceBranches: true } }).valid).toBe(true)
			expect(v.validate(partialConfigPipe(), { work: { perSliceBranches: false } }).valid).toBe(true)
		})

		test('rejects work.audit when non-boolean', () => {
			expect(v.validate(partialConfigPipe(), { work: { audit: 'sometimes' } }).valid).toBe(false)
		})

		test('rejects an unknown storage value', () => {
			const result = v.validate(partialConfigPipe(), { storage: 'mongo' })
			expect(result.valid).toBe(false)
		})

		test('accepts $schema as a string (file annotation passes validation)', () => {
			const result = v.validate(partialConfigPipe(), { $schema: '/home/me/.trowel/schema.json' })
			expect(result.valid).toBe(true)
		})
	})

	describe('emitJsonSchema', () => {
		test('declares the draft-07 meta-schema and a title', () => {
			const schema = emitJsonSchema()
			expect(schema.$schema).toBe('http://json-schema.org/draft-07/schema#')
			expect(schema.title).toBe('Trowel config')
		})

		test('emits properties for every top-level config key', () => {
			const schema = emitJsonSchema() as { properties: Record<string, unknown> }
			expect(Object.keys(schema.properties)).toEqual(
				expect.arrayContaining(['$schema', 'storage', 'docs', 'agent', 'labels', 'abort', 'ship', 'turn', 'work']),
			)
		})

		test('storage property emits the storage enum', () => {
			const schema = emitJsonSchema() as { properties: { storage: { enum: string[] } } }
			expect(schema.properties.storage.enum).toEqual(expect.arrayContaining(['file', 'issue']))
		})

		test('close.deleteBranch property emits the policy enum', () => {
			const schema = emitJsonSchema() as {
				properties: { abort: { properties: { deleteBranch: { enum: string[] } } } }
			}
			expect(schema.properties.abort.properties.deleteBranch.enum).toEqual(['always', 'never', 'prompt'])
		})

		test('ship properties emit pr plus enums', () => {
			const schema = emitJsonSchema() as {
				properties: { ship: { properties: { pr: { type: string }; mergeMethod: { enum: string[] }; deleteBranch: { enum: string[] } } } }
			}
			expect(schema.properties.ship.properties.pr.type).toBe('boolean')
			expect(schema.properties.ship.properties.mergeMethod.enum).toEqual(['merge', 'squash', 'rebase'])
			expect(schema.properties.ship.properties.deleteBranch.enum).toEqual(['always', 'never', 'prompt'])
		})

		test('turn.maxConcurrent accepts number or null', () => {
			const schema = emitJsonSchema() as {
				properties: { turn: { properties: { maxConcurrent: { oneOf: Array<{ type: string }> } } } }
			}
			const types = schema.properties.turn.properties.maxConcurrent.oneOf.map((b) => b.type)
			expect(types).toEqual(expect.arrayContaining(['number', 'null']))
		})

		test('top-level forbids additional properties (catches typos in editors)', () => {
			const schema = emitJsonSchema() as { additionalProperties: boolean }
			expect(schema.additionalProperties).toBe(false)
		})
	})
}
