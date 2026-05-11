import { v, type DeepPartial, type PipeOutput } from 'valleyed'

export type BackendKind = 'markdown' | 'draft-pr' | 'issue'

export const partialConfigPipe = () =>
	v.object({
		backend: v.optional(v.in(['markdown', 'draft-pr', 'issue'] as const)),
		branchPrefix: v.optional(v.string()),
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
				command: v.optional(v.string()),
				args: v.optional(v.array(v.string())),
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
				prd: v.optional(v.array(v.string())),
			}),
		),
		sandbox: v.optional(
			v.object({
				image: v.optional(v.string()),
				iterationCaps: v.optional(
					v.object({
						implementer: v.optional(v.number()),
						reviewer: v.optional(v.number()),
						addresser: v.optional(v.number()),
					}),
				),
			}),
		),
	})

export type PartialConfig = PipeOutput<ReturnType<typeof partialConfigPipe>>

export type Config = {
	backend: BackendKind
	branchPrefix: string
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
		command: string
		args: string[]
		model: string | null
	}
	preconditions: {
		requireCleanTree: boolean
		requireGitRoot: boolean
		requireGhAuth: boolean
	}
	labels: {
		readyForAgent: string
		needsRevision: string
		prd: string[]
	}
	sandbox: {
		image: string
		iterationCaps: {
			implementer: number
			reviewer: number
			addresser: number
		}
	}
}

// The four config sources, named (not numbered). Precedence under β:
// default < global < private < project. The project file wins outright.
export type ConfigLayer = 'default' | 'global' | 'private' | 'project'

// The three init-able layers (every layer except the hard-coded 'default').
export type InitableLayer = Exclude<ConfigLayer, 'default'>

// Hard-coded defaults — the 'default' layer. Every field present.
export const defaultConfig: Config = {
	backend: 'markdown',
	branchPrefix: 'prd/',
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
		command: 'claude',
		args: [],
		model: null,
	},
	preconditions: {
		requireCleanTree: true,
		requireGitRoot: true,
		requireGhAuth: true,
	},
	labels: {
		readyForAgent: 'ready-for-agent',
		needsRevision: 'needs-revision',
		prd: [],
	},
	sandbox: {
		image: 'node:22-bookworm',
		iterationCaps: {
			implementer: 100,
			reviewer: 1,
			addresser: 50,
		},
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
