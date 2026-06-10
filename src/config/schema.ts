import { v, type PipeOutput } from 'valleyed'

import { harnessFactories } from '../harnesses/registry.ts'
import { storageFactories } from '../storages/registry.ts'

export const partialConfigPipe = v.object({
	// File-only annotation. Editors use it to fetch a JSON Schema for
	// autocomplete; runtime code never reads it. `trowel init` writes it
	// pointing at ~/.trowel/schema.json.
	$schema: v.optional(v.meta(v.string(), {
		description: 'Path to the generated JSON Schema file used by editors for Trowel config completion.',
		examples: ['./schema.json'],
	})),
	storage: v.optional(v.meta(v.in(Object.keys(storageFactories)), {
		description: 'Storage strategy for Change and Slice records.',
		default: 'file',
		examples: ['file', 'issue'],
	})),
	docs: v.optional(
		v.meta(v.object({
			changesDir: v.optional(v.meta(v.string(), {
				description: 'Project-relative directory where file Storage writes Change and Slice artifacts.',
				default: 'docs/changes',
				examples: ['docs/changes'],
			})),
		}), { description: 'Documentation and file Storage paths.' }),
	),
	agent: v.optional(
		v.meta(v.object({
			harness: v.optional(v.meta(v.in(Object.keys(harnessFactories)), {
				description: 'Agent harness used to run Turns.',
				default: harnessFactories.claude.name,
				examples: Object.keys(harnessFactories),
			})),
			model: v.optional(v.meta(v.string(), {
				description: 'Model name passed to the selected Agent harness.',
				default: harnessFactories.claude.defaultModel,
				examples: [harnessFactories.claude.defaultModel],
			})),
		}), { description: 'Agent harness and model selection for Turns.' }),
	),
	labels: v.optional(
		v.meta(v.object({
			readyForAgent: v.optional(v.meta(v.string(), {
				description: 'Label used by issue Storage to identify Slices ready for agent work.',
				default: 'ready-for-agent',
				examples: ['ready-for-agent'],
			})),
			needsRevision: v.optional(v.meta(v.string(), {
				description: 'Label used on Slice PRs and Close-out PRs to mark requested revision work.',
				default: 'needs-revision',
				examples: ['needs-revision'],
			})),
			change: v.optional(v.meta(v.string(), {
				description: 'Label used by issue Storage to identify Change issues.',
				default: 'change',
				examples: ['change'],
			})),
		}), { description: 'Labels Trowel uses when issue Storage and PR review surfaces are backed by GitHub.' }),
	),
	abort: v.optional(
		v.meta(v.object({
			comment: v.optional(v.meta(v.nullable(v.string()), {
				description: 'Comment written when Abort closes GitHub issues or PRs; null closes silently.',
				default: 'Closed via trowel',
				examples: ['Closed via trowel', null],
			})),
			deleteBranch: v.optional(v.meta(v.in(['always', 'never', 'prompt'] as const), {
				description: 'Local branch deletion policy for Abort Cleanup.',
				default: 'prompt',
			})),
		}), { description: 'Abort behavior for abandoning a Change and running Cleanup.' }),
	),
	ship: v.optional(
		v.meta(v.object({
			pr: v.optional(v.meta(v.boolean(), {
				description: 'Ship a Change through a Close-out PR when true; host-merge the Change branch into the Target branch when false.',
				default: true,
			})),
			mergeMethod: v.optional(v.meta(v.in(['merge', 'squash', 'rebase'] as const), {
				description: 'GitHub merge method used when Ship merges Slice PRs or Close-out PRs.',
				default: 'merge',
			})),
			deleteBranch: v.optional(v.meta(v.in(['always', 'never', 'prompt'] as const), {
				description: 'Local branch deletion policy for Ship Cleanup after successful shipping.',
				default: 'prompt',
			})),
			mergeabilityPollSeconds: v.optional(v.meta(v.number().pipe(v.int()).pipe(v.gte(0)).pipe(v.lte(600)), {
				description: 'Seconds Ship waits for GitHub PR mergeability to become known; 0 disables polling.',
				default: 30,
			})),
		}), { description: 'Ship and Close-out behavior for completing a Change.' }),
	),
	turn: v.optional(
		v.meta(v.object({
			copyToWorktree: v.optional(v.meta(v.array(v.string()), {
				description: 'Project-relative files or directories copied into every Turn Worktree before the agent runs.',
				default: [],
				examples: [['.env.example']],
			})),
			maxConcurrent: v.optional(v.meta(v.nullable(v.number()), {
				description: 'Maximum concurrent Slice Turns within one Change; null removes the numeric cap while branch safety still applies.',
				default: 3,
			})),
		}), { description: 'Execution settings for agent Turns.' }),
	),
	work: v.optional(
		v.meta(v.object({
			audit: v.optional(v.meta(v.boolean(), {
				description: 'Run Auditing after implementation and before Slice integration or Slice PR readiness.',
				default: false,
			})),
			perSliceBranches: v.optional(v.meta(v.boolean(), {
				description: 'Create a dedicated Slice branch for each Slice when true; use the Change branch directly when false.',
				default: true,
			})),
			worktreeCleanupAge: v.optional(v.meta(v.string(), {
				description: 'Minimum age for orphaned trowel Worktrees before doctor can sweep them.',
				default: '24h',
				examples: ['24h', '7d'],
			})),
			mergeNoVerify: v.optional(v.meta(v.boolean(), {
				description: 'Bypass git hooks for host-owned local merges performed by Work or merge-mode Ship.',
				default: false,
			})),
			loopPollSeconds: v.optional(v.meta(v.number().pipe(v.int()).pipe(v.gte(1)).pipe(v.lte(3600)), {
				description: 'Seconds Polling work mode sleeps between no-actionable-work refetches for scoped Change work and Project work.',
				default: 30,
			})),
		}), { description: 'AFK loop behavior for scoped Change work and Project work.' }),
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
		mergeabilityPollSeconds: 30,
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
		loopPollSeconds: 30,
	},
}

export function emitConfigJsonSchema(): Record<string, unknown> {
	return {
		$schema: 'http://json-schema.org/draft-07/schema#',
		...v.schema(partialConfigPipe, { title: 'Trowel config' }),
	}
}

export type ConfigReferenceEntry = {
	path: string
	description: string
	default?: unknown
	examples?: unknown[]
}

type SchemaNode = {
	description?: string
	default?: unknown
	examples?: unknown[]
	properties?: Record<string, SchemaNode>
}

export function configReferenceEntries(schema: Record<string, unknown> = emitConfigJsonSchema()): ConfigReferenceEntry[] {
	return collectConfigReferenceEntries(schema as SchemaNode)
}

function collectConfigReferenceEntries(node: SchemaNode, prefix = ''): ConfigReferenceEntry[] {
	const properties = node.properties ?? {}
	return Object.entries(properties).flatMap(([key, child]) => {
		const path = prefix ? `${prefix}.${key}` : key
		const own = configReferenceEntry(path, child)
		return own ? [own, ...collectConfigReferenceEntries(child, path)] : collectConfigReferenceEntries(child, path)
	})
}

function configReferenceEntry(path: string, node: SchemaNode): ConfigReferenceEntry | null {
	if (node.description === undefined) return null
	const entry: ConfigReferenceEntry = { path, description: node.description }
	if ('default' in node) entry.default = node.default
	if (node.examples !== undefined) entry.examples = node.examples
	return entry
}

if (import.meta.vitest) {
	const { describe, test, expect } = import.meta.vitest

	function collectMissingDescriptions(node: SchemaNode, prefix: string, missing: string[]): void {
		for (const [key, child] of Object.entries(node.properties ?? {})) {
			const path = prefix ? `${prefix}.${key}` : key
			if (child.description === undefined) missing.push(path)
			collectMissingDescriptions(child, path, missing)
		}
	}

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

		test('ship defaults to PR mode, merge method, prompt branch deletion, and bounded mergeability polling', () => {
			expect(defaultConfig.ship.pr).toBe(true)
			expect(defaultConfig.ship.mergeMethod).toBe('merge')
			expect(defaultConfig.ship.deleteBranch).toBe('prompt')
			expect(defaultConfig.ship.mergeabilityPollSeconds).toBe(30)
		})

		test('turn defaults to maxConcurrent: 3 and empty copyToWorktree', () => {
			expect(defaultConfig.turn.maxConcurrent).toBe(3)
			expect(defaultConfig.turn.copyToWorktree).toEqual([])
		})

		test('agent defaults to claude-opus-4-6', () => {
			expect(defaultConfig.agent.model).toBe('claude-opus-4-6')
		})

		test('work loop defaults: Auditing off, 24h worktree cleanup, 30s loop polling', () => {
			expect(defaultConfig.work.audit).toBe(false)
			expect(defaultConfig.work.worktreeCleanupAge).toBe('24h')
			expect(defaultConfig.work.loopPollSeconds).toBe(30)
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
			expect(v.validate(partialConfigPipe, { ship: { pr: false, mergeMethod: 'squash', deleteBranch: 'always', mergeabilityPollSeconds: 30 } }).valid).toBe(true)
		})

		test('rejects invalid ship config values', () => {
			expect(v.validate(partialConfigPipe, { ship: { mergeMethod: 'fast-forward' } }).valid).toBe(false)
			expect(v.validate(partialConfigPipe, { ship: { deleteBranch: 'maybe' } }).valid).toBe(false)
			expect(v.validate(partialConfigPipe, { ship: { mergeabilityPollSeconds: -1 } }).valid).toBe(false)
			expect(v.validate(partialConfigPipe, { ship: { mergeabilityPollSeconds: 601 } }).valid).toBe(false)
			expect(v.validate(partialConfigPipe, { ship: { mergeabilityPollSeconds: 1.5 } }).valid).toBe(false)
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

		test('accepts bounded work.loopPollSeconds', () => {
			expect(v.validate(partialConfigPipe, { work: { loopPollSeconds: 1 } }).valid).toBe(true)
			expect(v.validate(partialConfigPipe, { work: { loopPollSeconds: 3600 } }).valid).toBe(true)
		})

		test('rejects invalid work.loopPollSeconds', () => {
			expect(v.validate(partialConfigPipe, { work: { loopPollSeconds: 0 } }).valid).toBe(false)
			expect(v.validate(partialConfigPipe, { work: { loopPollSeconds: 3601 } }).valid).toBe(false)
			expect(v.validate(partialConfigPipe, { work: { loopPollSeconds: 1.5 } }).valid).toBe(false)
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

		test('ship properties emit pr, enums, and mergeability polling bounds', () => {
			const schema = emitConfigJsonSchema() as {
				properties: {
					ship: {
						properties: {
							pr: { type: string }
							mergeMethod: { enum: string[] }
							deleteBranch: { enum: string[] }
							mergeabilityPollSeconds: { type: string; minimum: number; maximum: number }
						}
					}
				}
			}
			expect(schema.properties.ship.properties.pr.type).toBe('boolean')
			expect(schema.properties.ship.properties.mergeMethod.enum).toEqual(['merge', 'squash', 'rebase'])
			expect(schema.properties.ship.properties.deleteBranch.enum).toEqual(['always', 'never', 'prompt'])
			expect(schema.properties.ship.properties.mergeabilityPollSeconds).toMatchObject({ type: 'integer', minimum: 0, maximum: 600 })
		})

		test('turn.maxConcurrent accepts number or null', () => {
			const schema = emitConfigJsonSchema() as {
				properties: { turn: { properties: { maxConcurrent: { oneOf: Array<{ type: string }> } } } }
			}
			const types = schema.properties.turn.properties.maxConcurrent.oneOf.map((b) => b.type)
			expect(types).toEqual(expect.arrayContaining(['number', 'null']))
		})

		test('work.loopPollSeconds emits integer bounds', () => {
			const schema = emitConfigJsonSchema() as {
				properties: { work: { properties: { loopPollSeconds: { type: string; minimum: number; maximum: number } } } }
			}
			expect(schema.properties.work.properties.loopPollSeconds).toMatchObject({ type: 'integer', minimum: 1, maximum: 3600 })
		})

		test('emits descriptions for every config property', () => {
			const missing: string[] = []
			collectMissingDescriptions(emitConfigJsonSchema() as SchemaNode, '', missing)
			expect(missing).toEqual([])
		})

		test('emits descriptions and defaults for documented config keys', () => {
			const schema = emitConfigJsonSchema() as {
				properties: {
					ship: { description: string; properties: { pr: { description: string; default: boolean } } }
					work: { properties: { loopPollSeconds: { description: string; default: number } } }
				}
			}
			expect(schema.properties.ship.description).toMatch(/Ship/)
			expect(schema.properties.ship.properties.pr).toMatchObject({ default: true })
			expect(schema.properties.ship.properties.pr.description).toMatch(/Close-out PR/)
			expect(schema.properties.work.properties.loopPollSeconds).toMatchObject({ default: 30 })
		})

		test('emits examples where examples add value', () => {
			const schema = emitConfigJsonSchema() as {
				properties: { work: { properties: { worktreeCleanupAge: { examples: string[] } } } }
			}
			expect(schema.properties.work.properties.worktreeCleanupAge.examples).toEqual(['24h', '7d'])
		})

		test('top-level forbids additional properties (catches typos in editors)', () => {
			const schema = emitConfigJsonSchema() as { additionalProperties: boolean }
			expect(schema.additionalProperties).toBe(false)
		})
	})

	describe('configReferenceEntries', () => {
		test('lists config paths with descriptions, defaults, and examples from schema metadata', () => {
			const entries = configReferenceEntries()
			expect(entries).toContainEqual(expect.objectContaining({ path: 'ship.pr', default: true, description: expect.stringMatching(/Close-out PR/) }))
			expect(entries).toContainEqual(expect.objectContaining({ path: 'work.loopPollSeconds', default: 30, description: expect.stringMatching(/Polling work mode/) }))
			expect(entries).toContainEqual(expect.objectContaining({ path: 'work.worktreeCleanupAge', default: '24h', examples: ['24h', '7d'] }))
		})
	})
}
