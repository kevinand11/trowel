import { v, type PipeOutput } from 'valleyed'

import { harnessFactories } from '../harnesses/registry.ts'
import { storageFactories } from '../storages/registry.ts'

export const partialConfigPipe = v.object({
	// File-only annotation. Editors use it to fetch a JSON Schema for
	// autocomplete; runtime code never reads it. `trowel init` writes it
	// pointing at ~/.trowel/schema.json.
	$schema: v.optional(v.string()),
	storage: v.optional(v.in(Object.keys(storageFactories))),
	docs: v.optional(
		v.object({
			changesDir: v.optional(v.string()),
		}),
	),
	agent: v.optional(
		v.object({
			harness: v.optional(v.in(Object.keys(harnessFactories))),
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

export type PartialConfig = PipeOutput<typeof partialConfigPipe>

type Builtin = string | number | boolean | bigint | symbol | null | undefined | Date | RegExp | Error | Function
type Defined<T> = Exclude<T, undefined>
type DeepRequired<T> = T extends Builtin
	? Defined<T>
	: T extends readonly [unknown, ...unknown[]]
		? { [K in keyof T]-?: DeepRequired<Defined<T[K]>> }
		: T extends (infer U)[]
			? DeepRequired<Defined<U>>[]
			: T extends object
				? { [K in keyof T]-?: DeepRequired<Defined<T[K]>> }
				: Defined<T>

export type Config = DeepRequired<Omit<PartialConfig, '$schema'>>

// Hard-coded defaults — the 'default' layer. Every field present.
export const defaultConfig: Config = {
	storage: 'file',
	docs: {
		changesDir: 'docs/changes',
	},
	agent: {
		harness: harnessFactories.claude.name,
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

export function emitConfigJsonSchema(): Record<string, unknown> {
	return {
		$schema: 'http://json-schema.org/draft-07/schema#',
		...v.schema(partialConfigPipe, { title: 'Trowel config' }),
	}
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

	describe('partialConfigPipe', () => {
		test('accepts an empty object (every field optional)', () => {
			const result = v.validate(partialConfigPipe, {})
			expect(result.valid).toBe(true)
		})

		test('accepts a partial with only one nested key set', () => {
			const result = v.validate(partialConfigPipe, { agent: { model: 'sonnet' } })
			expect(result.valid).toBe(true)
		})

		test('accepts labels.change as a string', () => {
			const result = v.validate(partialConfigPipe, { labels: { change: 'feature' } })
			expect(result.valid).toBe(true)
		})

		test('accepts close.deleteBranch with valid policy', () => {
			const result = v.validate(partialConfigPipe, { abort: { deleteBranch: 'always' } })
			expect(result.valid).toBe(true)
		})

		test('rejects close.deleteBranch with invalid policy', () => {
			const result = v.validate(partialConfigPipe, { abort: { deleteBranch: 'maybe' } })
			expect(result.valid).toBe(false)
		})

		test('accepts ship config values', () => {
			expect(v.validate(partialConfigPipe, { ship: { pr: false, mergeMethod: 'squash', deleteBranch: 'always' } }).valid).toBe(true)
		})

		test('rejects invalid ship config values', () => {
			expect(v.validate(partialConfigPipe, { ship: { mergeMethod: 'fast-forward' } }).valid).toBe(false)
			expect(v.validate(partialConfigPipe, { ship: { deleteBranch: 'maybe' } }).valid).toBe(false)
		})

		test('accepts turn.maxConcurrent as a number or null', () => {
			expect(v.validate(partialConfigPipe, { turn: { maxConcurrent: 5 } }).valid).toBe(true)
			expect(v.validate(partialConfigPipe, { turn: { maxConcurrent: null } }).valid).toBe(true)
		})

		test('accepts turn.copyToWorktree as a string array', () => {
			const result = v.validate(partialConfigPipe, { turn: { copyToWorktree: ['node_modules'] } })
			expect(result.valid).toBe(true)
		})

		test('accepts ship.pr as a boolean', () => {
			expect(v.validate(partialConfigPipe, { ship: { pr: false } }).valid).toBe(true)
			expect(v.validate(partialConfigPipe, { ship: { pr: true } }).valid).toBe(true)
		})

		test('accepts work.audit as a boolean', () => {
			expect(v.validate(partialConfigPipe, { work: { audit: false } }).valid).toBe(true)
			expect(v.validate(partialConfigPipe, { work: { audit: true } }).valid).toBe(true)
		})

		test('accepts work.perSliceBranches as a boolean', () => {
			expect(v.validate(partialConfigPipe, { work: { perSliceBranches: true } }).valid).toBe(true)
			expect(v.validate(partialConfigPipe, { work: { perSliceBranches: false } }).valid).toBe(true)
		})

		test('rejects work.audit when non-boolean', () => {
			expect(v.validate(partialConfigPipe, { work: { audit: 'sometimes' } }).valid).toBe(false)
		})

		test('rejects an unknown storage value', () => {
			const result = v.validate(partialConfigPipe, { storage: 'mongo' })
			expect(result.valid).toBe(false)
		})

		test('accepts $schema as a string (file annotation passes validation)', () => {
			const result = v.validate(partialConfigPipe, { $schema: '/home/me/.trowel/schema.json' })
			expect(result.valid).toBe(true)
		})
	})

	describe('emitJsonSchema', () => {
		test('declares the draft-07 meta-schema and a title', () => {
			const schema = emitConfigJsonSchema()
			expect(schema.$schema).toBe('http://json-schema.org/draft-07/schema#')
			expect(schema.title).toBe('Trowel config')
		})

		test('emits properties for every top-level config key', () => {
			const schema = emitConfigJsonSchema() as { properties: Record<string, unknown> }
			expect(Object.keys(schema.properties)).toEqual(
				expect.arrayContaining(['$schema', 'storage', 'docs', 'agent', 'labels', 'abort', 'ship', 'turn', 'work']),
			)
		})

		test('storage property emits the storage enum', () => {
			const schema = emitConfigJsonSchema() as { properties: { storage: { enum: string[] } } }
			expect(schema.properties.storage.enum).toEqual(expect.arrayContaining(['file', 'issue']))
		})

		test('close.deleteBranch property emits the policy enum', () => {
			const schema = emitConfigJsonSchema() as {
				properties: { abort: { properties: { deleteBranch: { enum: string[] } } } }
			}
			expect(schema.properties.abort.properties.deleteBranch.enum).toEqual(['always', 'never', 'prompt'])
		})

		test('ship properties emit pr plus enums', () => {
			const schema = emitConfigJsonSchema() as {
				properties: {
					ship: { properties: { pr: { type: string }; mergeMethod: { enum: string[] }; deleteBranch: { enum: string[] } } }
				}
			}
			expect(schema.properties.ship.properties.pr.type).toBe('boolean')
			expect(schema.properties.ship.properties.mergeMethod.enum).toEqual(['merge', 'squash', 'rebase'])
			expect(schema.properties.ship.properties.deleteBranch.enum).toEqual(['always', 'never', 'prompt'])
		})

		test('turn.maxConcurrent accepts number or null', () => {
			const schema = emitConfigJsonSchema() as {
				properties: { turn: { properties: { maxConcurrent: { oneOf: Array<{ type: string }> } } } }
			}
			const types = schema.properties.turn.properties.maxConcurrent.oneOf.map((b) => b.type)
			expect(types).toEqual(expect.arrayContaining(['number', 'null']))
		})

		test('top-level forbids additional properties (catches typos in editors)', () => {
			const schema = emitConfigJsonSchema() as { additionalProperties: boolean }
			expect(schema.additionalProperties).toBe(false)
		})
	})
}
