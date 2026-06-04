import type { StartRuntime } from './start.ts'
import type { Slice, ChangeSpec, SliceSpec, SlicePatch } from '../storages/types.ts'
import { noopGitOps } from '../test-utils/git-ops-fixtures.ts'
import { fakeSliceStorage } from '../test-utils/storage-fixtures.ts'

export type FakeCalls = {
	createChange: ChangeSpec[]
	createSlice: Array<{ changeId: string; spec: SliceSpec }>
	updateSlice: Array<{ changeId: string; sliceId: string; patch: SlicePatch }>
	stdout: string[]
	git: string[]
}

export type FakeGitState = {
	current: string
	clean: boolean
	stashStack: number
}

export type MakeFakesOpts = {
	startOut: string | null
	createChangeResult?: { id: string; changeBranch: string }
	createSliceIds?: string[]
	currentBranch?: string
	cleanTree?: boolean
	preflightFailures?: string[]
	createChangeThrows?: Error
	stashPopThrows?: Error
}

function fakeStartSlice(id: string, spec: SliceSpec): Slice {
	return {
		id,
		title: spec.title,
		body: spec.body,
		state: 'draft',
		closedAt: null,
		readyForAgent: false,
		needsRevision: false,
		blockedBy: [],
		sliceBranch: `change-pid/slice-${id}-${spec.title.toLowerCase().replace(/\s+/g, '-')}`,
		prState: null,
	}
}

export function makeFakes(opts: MakeFakesOpts): { rt: StartRuntime; calls: FakeCalls; gitState: FakeGitState } {
	const calls: FakeCalls = { createChange: [], createSlice: [], updateSlice: [], stdout: [], git: [] }
	const gitState: FakeGitState = {
		current: opts.currentBranch ?? 'main',
		clean: opts.cleanTree ?? true,
		stashStack: 0,
	}
	let sliceCursor = 0
	const createSliceIds = opts.createSliceIds ?? []

	const storage = fakeSliceStorage([], null, {
		createChange: async (spec) => {
			calls.createChange.push(spec)
			if (opts.createChangeThrows) throw opts.createChangeThrows
			return opts.createChangeResult ?? { id: 'pid', changeBranch: 'pid-branch' }
		},
		createSlice: async (changeId, spec) => {
			calls.createSlice.push({ changeId, spec })
			const id = createSliceIds[sliceCursor++] ?? `s${sliceCursor}`
			return fakeStartSlice(id, spec)
		},
		updateSlice: async (changeId, sliceId, patch) => {
			calls.updateSlice.push({ changeId, sliceId, patch })
		},
	})

	const git = noopGitOps({
		currentBranch: async () => gitState.current,
		checkout: async (b) => {
			calls.git.push(`checkout(${b})`)
			gitState.current = b
		},
		isWorkingTreeClean: async () => gitState.clean,
		stashPush: async () => {
			calls.git.push('stashPush')
			gitState.stashStack += 1
			gitState.clean = true
		},
		stashPop: async () => {
			calls.git.push('stashPop')
			if (opts.stashPopThrows) throw opts.stashPopThrows
			gitState.stashStack -= 1
		},
	})

	const rt: StartRuntime = {
		projectRoot: '/fake/proj',
		storage,
		git,
		startPromptText: '<prompt>',
		runInteractive: async () => {},
		readStartOut: async () => opts.startOut,
		preflight: async () => {
			if ((opts.preflightFailures ?? []).length > 0) throw new Error(`preflight failed:\n${opts.preflightFailures!.map((f) => `  · ${f}`).join('\n')}`)
		},
		stdout: (s) => calls.stdout.push(s),
		confirm: async () => false,
	}

	return { rt, calls, gitState }
}
