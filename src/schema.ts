import { v, type DeepPartial, type PipeOutput } from 'valleyed'

import { storageFactories } from './storages/registry.ts'

export const partialConfigPipe = () =>
	v.object({
		storage: v.optional(v.in(Object.keys(storageFactories))),
		docs: v.optional(
			v.object({
				prdsDir: v.optional(v.string()),
			}),
		),
		agent: v.optional(
			v.object({
				model: v.optional(v.string()),
			}),
		),
		labels: v.optional(
			v.object({
				readyForAgent: v.optional(v.string()),
				needsRevision: v.optional(v.string()),
				prd: v.optional(v.string()),
			}),
		),
		close: v.optional(
			v.object({
				comment: v.optional(v.nullable(v.string())),
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
				sliceStepCap: v.optional(v.number()),
				usePrs: v.optional(v.boolean()),
				review: v.optional(v.boolean()),
				perSliceBranches: v.optional(v.boolean()),
				worktreeCleanupAge: v.optional(v.string()),
			}),
		),
	})

export type PartialConfig = PipeOutput<ReturnType<typeof partialConfigPipe>>

export type Config = {
	storage: string
	docs: {
		prdsDir: string
	}
	agent: {
		model: string
	}
	labels: {
		readyForAgent: string
		needsRevision: string
		prd: string
	}
	close: {
		comment: string | null
		deleteBranch: 'always' | 'never' | 'prompt'
	}
	turn: {
		copyToWorktree: string[]
		maxConcurrent: number | null
	}
	work: {
		sliceStepCap: number
		usePrs: boolean
		review: boolean
		perSliceBranches: boolean
		worktreeCleanupAge: string
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
		prdsDir: 'docs/prds',
	},
	agent: {
		model: 'claude-opus-4-6',
	},
	labels: {
		readyForAgent: 'ready-for-agent',
		needsRevision: 'needs-revision',
		prd: 'prd',
	},
	close: {
		comment: 'Closed via trowel',
		deleteBranch: 'prompt',
	},
	turn: {
		copyToWorktree: [],
		maxConcurrent: 3,
	},
	work: {
		sliceStepCap: 5,
		// Default false: most projects start in host-merge mode regardless of storage.
		// Set true to open a draft PR per slice branch (requires a GitHub remote + gh auth).
		usePrs: false,
		review: false,
		// Default true: every workflow runs each slice on its own branch, then host-merges (no PRs)
		// or opens a draft PR (with `usePrs: true`). Set false to keep the old file-style
		// integration-direct behavior (one branch per PRD, implementers serialize).
		perSliceBranches: true,
		worktreeCleanupAge: '24h',
	},
}

// Deep-merge a partial layer onto an existing Config, producing a new Config.
// Per-key: present in partial → override; absent → keep existing.
export function mergePartial(base: Config, partial: DeepPartial<Config> | undefined): Config {
	if (!partial) return base
	return deepMerge(base, partial) as Config
}

function deepMerge<T extends Record<string, unknown>>(a: T, b: DeepPartial<T>): T {
	const out = { ...a } as Record<string, unknown>
	for (const [k, v] of Object.entries(b)) {
		if (v === undefined) continue
		const av = (a as Record<string, unknown>)[k]
		if (isPlainObject(av) && isPlainObject(v)) {
			out[k] = deepMerge(av as Record<string, unknown>, v as DeepPartial<Record<string, unknown>>)
		} else {
			out[k] = v
		}
	}
	return out as T
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

		test('labels.prd defaults to "prd"', () => {
			expect(defaultConfig.labels.prd).toBe('prd')
		})

		test('close defaults to prompt + "Closed via trowel"', () => {
			expect(defaultConfig.close.deleteBranch).toBe('prompt')
			expect(defaultConfig.close.comment).toBe('Closed via trowel')
		})

		test('turn defaults to maxConcurrent: 3 and empty copyToWorktree', () => {
			expect(defaultConfig.turn.maxConcurrent).toBe(3)
			expect(defaultConfig.turn.copyToWorktree).toEqual([])
		})

		test('agent defaults to claude-opus-4-6', () => {
			expect(defaultConfig.agent.model).toBe('claude-opus-4-6')
		})

		test('work loop defaults: 5 inner step cap, PRs off, 24h worktree cleanup', () => {
			expect(defaultConfig.work.sliceStepCap).toBe(5)
			expect(defaultConfig.work.usePrs).toBe(false)
			expect(defaultConfig.work.worktreeCleanupAge).toBe('24h')
		})

		test('work.review defaults to false (agent reviewer is opt-in)', () => {
			expect(defaultConfig.work.review).toBe(false)
		})

		test('work.perSliceBranches defaults to true (slice-branches by default; host-merges when usePrs is false)', () => {
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

		test('accepts labels.prd as a string', () => {
			const result = v.validate(partialConfigPipe(), { labels: { prd: 'feature' } })
			expect(result.valid).toBe(true)
		})

		test('accepts close.deleteBranch with valid policy', () => {
			const result = v.validate(partialConfigPipe(), { close: { deleteBranch: 'always' } })
			expect(result.valid).toBe(true)
		})

		test('rejects close.deleteBranch with invalid policy', () => {
			const result = v.validate(partialConfigPipe(), { close: { deleteBranch: 'maybe' } })
			expect(result.valid).toBe(false)
		})

		test('accepts turn.maxConcurrent as a number or null', () => {
			expect(v.validate(partialConfigPipe(), { turn: { maxConcurrent: 5 } }).valid).toBe(true)
			expect(v.validate(partialConfigPipe(), { turn: { maxConcurrent: null } }).valid).toBe(true)
		})

		test('accepts turn.copyToWorktree as a string array', () => {
			const result = v.validate(partialConfigPipe(), { turn: { copyToWorktree: ['node_modules'] } })
			expect(result.valid).toBe(true)
		})

		test('accepts work.usePrs as a boolean', () => {
			expect(v.validate(partialConfigPipe(), { work: { usePrs: false } }).valid).toBe(true)
			expect(v.validate(partialConfigPipe(), { work: { usePrs: true } }).valid).toBe(true)
		})

		test('accepts work.review as a boolean', () => {
			expect(v.validate(partialConfigPipe(), { work: { review: false } }).valid).toBe(true)
			expect(v.validate(partialConfigPipe(), { work: { review: true } }).valid).toBe(true)
		})

		test('accepts work.perSliceBranches as a boolean', () => {
			expect(v.validate(partialConfigPipe(), { work: { perSliceBranches: true } }).valid).toBe(true)
			expect(v.validate(partialConfigPipe(), { work: { perSliceBranches: false } }).valid).toBe(true)
		})

		test('rejects work.review when non-boolean', () => {
			expect(v.validate(partialConfigPipe(), { work: { review: 'sometimes' } }).valid).toBe(false)
		})

		test('rejects an unknown storage value', () => {
			const result = v.validate(partialConfigPipe(), { storage: 'mongo' })
			expect(result.valid).toBe(false)
		})

	})
}
