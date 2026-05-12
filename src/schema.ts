import { v, type DeepPartial, type PipeOutput } from 'valleyed'

import { backendFactories } from './backends/registry.ts'

export const partialConfigPipe = () =>
	v.object({
		backend: v.optional(v.in(Object.keys(backendFactories))),
		branchPrefix: v.optional(v.nullable(v.string())),
		baseBranch: v.optional(v.string()),
		docs: v.optional(
			v.object({
				dir: v.optional(v.string()),
				adrDir: v.optional(v.string()),
				contextMapPath: v.optional(v.string()),
				prdsDir: v.optional(v.string()),
			}),
		),
		commit: v.optional(
			v.object({
				convention: v.optional(v.in(['conventional', 'none'] as const)),
				docMsg: v.optional(v.string()),
				sign: v.optional(v.boolean()),
			}),
		),
		phases: v.optional(
			v.object({
				grill: v.optional(v.boolean()),
				createPrd: v.optional(v.boolean()),
				slice: v.optional(v.boolean()),
			}),
		),
		collision: v.optional(
			v.object({
				enabled: v.optional(v.boolean()),
				branchPattern: v.optional(v.string()),
			}),
		),
		agent: v.optional(
			v.object({
				model: v.optional(v.string()),
			}),
		),
		preconditions: v.optional(
			v.object({
				requireCleanTree: v.optional(v.boolean()),
				requireGitRoot: v.optional(v.boolean()),
				requireGhAuth: v.optional(v.boolean()),
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
		sandbox: v.optional(
			v.object({
				image: v.optional(v.string()),
				onReady: v.optional(v.array(v.string())),
				copyToWorktree: v.optional(v.array(v.string())),
				maxConcurrent: v.optional(v.nullable(v.number())),
				iterationCaps: v.optional(
					v.object({
						implementer: v.optional(v.number()),
						reviewer: v.optional(v.number()),
						addresser: v.optional(v.number()),
					}),
				),
			}),
		),
		work: v.optional(
			v.object({
				maxIterations: v.optional(v.number()),
				sliceStepCap: v.optional(v.number()),
				usePrs: v.optional(v.boolean()),
				worktreeCleanupAge: v.optional(v.string()),
			}),
		),
	})

export type PartialConfig = PipeOutput<ReturnType<typeof partialConfigPipe>>

export type Config = {
	backend: string
	branchPrefix: string | null
	baseBranch: string
	docs: {
		dir: string
		adrDir: string
		contextMapPath: string
		prdsDir: string
	}
	commit: {
		convention: 'conventional' | 'none'
		docMsg: string
		sign: boolean
	}
	phases: {
		grill: boolean
		createPrd: boolean
		slice: boolean
	}
	collision: {
		enabled: boolean
		branchPattern: string
	}
	agent: {
		model: string
	}
	preconditions: {
		requireCleanTree: boolean
		requireGitRoot: boolean
		requireGhAuth: boolean
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
	sandbox: {
		image: string
		onReady: string[]
		copyToWorktree: string[]
		maxConcurrent: number | null
		iterationCaps: {
			implementer: number
			reviewer: number
			addresser: number
		}
	}
	work: {
		maxIterations: number
		sliceStepCap: number
		usePrs: boolean
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
	backend: 'file',
	branchPrefix: null,
	baseBranch: 'main',
	docs: {
		dir: 'docs',
		adrDir: 'docs/adr',
		contextMapPath: 'docs/CONTEXT-MAP.md',
		prdsDir: 'docs/prds',
	},
	commit: {
		convention: 'conventional',
		docMsg: 'docs(prd-${id}): land context for ${title}',
		sign: false,
	},
	phases: {
		grill: true,
		createPrd: true,
		slice: true,
	},
	collision: {
		enabled: true,
		branchPattern: '',
	},
	agent: {
		model: 'claude-opus-4-6',
	},
	preconditions: {
		requireCleanTree: true,
		requireGitRoot: true,
		requireGhAuth: true,
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
	sandbox: {
		image: 'trowel:latest',
		onReady: [],
		copyToWorktree: [],
		maxConcurrent: 3,
		iterationCaps: {
			implementer: 100,
			reviewer: 1,
			addresser: 50,
		},
	},
	work: {
		maxIterations: 50,
		sliceStepCap: 5,
		usePrs: true,
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
		test('uses file as the default backend', () => {
			expect(defaultConfig.backend).toBe('file')
		})

		test('branchPrefix is null by default (backend supplies its own)', () => {
			expect(defaultConfig.branchPrefix).toBeNull()
		})

		test('labels.prd defaults to "prd"', () => {
			expect(defaultConfig.labels.prd).toBe('prd')
		})

		test('close defaults to prompt + "Closed via trowel"', () => {
			expect(defaultConfig.close.deleteBranch).toBe('prompt')
			expect(defaultConfig.close.comment).toBe('Closed via trowel')
		})

		test('sandbox defaults to trowel:latest image with concurrency cap of 3 and empty hook arrays', () => {
			expect(defaultConfig.sandbox.image).toBe('trowel:latest')
			expect(defaultConfig.sandbox.maxConcurrent).toBe(3)
			expect(defaultConfig.sandbox.onReady).toEqual([])
			expect(defaultConfig.sandbox.copyToWorktree).toEqual([])
		})

		test('sandbox.iterationCaps defaults match equipped (implementer 100, reviewer 1, addresser 50)', () => {
			expect(defaultConfig.sandbox.iterationCaps).toEqual({ implementer: 100, reviewer: 1, addresser: 50 })
		})

		test('agent defaults to claude-opus-4-6 (matches sandcastle DEFAULT_MODEL)', () => {
			expect(defaultConfig.agent.model).toBe('claude-opus-4-6')
		})

		test('work loop defaults: 50 outer iters, 5 inner step cap, PRs on, 24h worktree cleanup', () => {
			expect(defaultConfig.work.maxIterations).toBe(50)
			expect(defaultConfig.work.sliceStepCap).toBe(5)
			expect(defaultConfig.work.usePrs).toBe(true)
			expect(defaultConfig.work.worktreeCleanupAge).toBe('24h')
		})

		test('every preconditions check is on by default', () => {
			expect(defaultConfig.preconditions.requireCleanTree).toBe(true)
			expect(defaultConfig.preconditions.requireGitRoot).toBe(true)
			expect(defaultConfig.preconditions.requireGhAuth).toBe(true)
		})
	})

	describe('mergePartial', () => {
		test('returns the base unchanged when partial is undefined', () => {
			const result = mergePartial(defaultConfig, undefined)
			expect(result).toEqual(defaultConfig)
		})

		test('overrides a primitive value at the top level', () => {
			const result = mergePartial(defaultConfig, { backend: 'issue' })
			expect(result.backend).toBe('issue')
			expect(result.baseBranch).toBe(defaultConfig.baseBranch)
		})

		test('overrides branchPrefix from null to a string', () => {
			const result = mergePartial(defaultConfig, { branchPrefix: 'feat/' })
			expect(result.branchPrefix).toBe('feat/')
		})

		test('deep-merges nested objects per-key', () => {
			const result = mergePartial(defaultConfig, { sandbox: { image: 'custom:tag' } })
			expect(result.sandbox.image).toBe('custom:tag')
			expect(result.sandbox.maxConcurrent).toBe(defaultConfig.sandbox.maxConcurrent)
			expect(result.sandbox.iterationCaps).toEqual(defaultConfig.sandbox.iterationCaps)
		})

		test('replaces arrays whole (no element merging)', () => {
			const result = mergePartial(defaultConfig, { sandbox: { onReady: ['pnpm install --prefer-offline'] } })
			expect(result.sandbox.onReady).toEqual(['pnpm install --prefer-offline'])
		})

		test('ignores undefined values inside a partial', () => {
			const result = mergePartial(defaultConfig, { agent: { model: undefined } })
			expect(result.agent.model).toBe(defaultConfig.agent.model)
		})

		test('does not mutate the base', () => {
			const baseSnapshot = JSON.parse(JSON.stringify(defaultConfig))
			mergePartial(defaultConfig, { backend: 'issue', agent: { model: 'sonnet' } })
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

		test('accepts branchPrefix: null', () => {
			const result = v.validate(partialConfigPipe(), { branchPrefix: null })
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

		test('accepts sandbox.maxConcurrent as a number or null', () => {
			expect(v.validate(partialConfigPipe(), { sandbox: { maxConcurrent: 5 } }).valid).toBe(true)
			expect(v.validate(partialConfigPipe(), { sandbox: { maxConcurrent: null } }).valid).toBe(true)
		})

		test('accepts sandbox.onReady and copyToWorktree as string arrays', () => {
			const result = v.validate(partialConfigPipe(), {
				sandbox: { onReady: ['pnpm install --prefer-offline'], copyToWorktree: ['node_modules'] },
			})
			expect(result.valid).toBe(true)
		})

		test('accepts work.usePrs as a boolean', () => {
			expect(v.validate(partialConfigPipe(), { work: { usePrs: false } }).valid).toBe(true)
			expect(v.validate(partialConfigPipe(), { work: { usePrs: true } }).valid).toBe(true)
		})

		test('rejects work.maxIterations when non-numeric', () => {
			const result = v.validate(partialConfigPipe(), { work: { maxIterations: 'lots' } })
			expect(result.valid).toBe(false)
		})

		test('rejects an unknown backend value', () => {
			const result = v.validate(partialConfigPipe(), { backend: 'mongo' })
			expect(result.valid).toBe(false)
		})

		test('rejects a non-string branchPrefix', () => {
			const result = v.validate(partialConfigPipe(), { branchPrefix: 42 })
			expect(result.valid).toBe(false)
		})
	})
}
