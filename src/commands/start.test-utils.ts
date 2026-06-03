import type { StartRuntime } from './start.ts'
import type { Slice, PrdSpec, SliceSpec, SlicePatch } from '../storages/types.ts'
import { noopGitOps } from '../test-utils/git-ops-fixtures.ts'
import { fakeSliceStorage } from '../test-utils/storage-fixtures.ts'

export type FakeCalls = {
	createPrd: PrdSpec[]
	createSlice: Array<{ prdId: string; spec: SliceSpec }>
	updateSlice: Array<{ prdId: string; sliceId: string; patch: SlicePatch }>
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
	createPrdResult?: { id: string; branch: string }
	createSliceIds?: string[]
	currentBranch?: string
	cleanTree?: boolean
	preflightFailures?: string[]
	createPrdThrows?: Error
	stashPopThrows?: Error
}

function fakeStartSlice(id: string, spec: SliceSpec): Slice {
	return {
		id,
		title: spec.title,
		body: spec.body,
		state: 'OPEN',
		readyForAgent: false,
		needsRevision: false,
		blockedBy: [],
		prState: null,
	}
}

export function makeFakes(opts: MakeFakesOpts): { rt: StartRuntime; calls: FakeCalls; gitState: FakeGitState } {
	const calls: FakeCalls = { createPrd: [], createSlice: [], updateSlice: [], stdout: [], git: [] }
	const gitState: FakeGitState = {
		current: opts.currentBranch ?? 'main',
		clean: opts.cleanTree ?? true,
		stashStack: 0,
	}
	let sliceCursor = 0
	const createSliceIds = opts.createSliceIds ?? []

	const storage = fakeSliceStorage([], null, {
		createPrd: async (spec) => {
			calls.createPrd.push(spec)
			if (opts.createPrdThrows) throw opts.createPrdThrows
			return opts.createPrdResult ?? { id: 'pid', branch: 'pid-branch' }
		},
		createSlice: async (prdId, spec) => {
			calls.createSlice.push({ prdId, spec })
			const id = createSliceIds[sliceCursor++] ?? `s${sliceCursor}`
			return fakeStartSlice(id, spec)
		},
		updateSlice: async (prdId, sliceId, patch) => {
			calls.updateSlice.push({ prdId, sliceId, patch })
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
		preflight: async () => opts.preflightFailures ?? [],
		stdout: (s) => calls.stdout.push(s),
		confirm: async () => false,
	}

	return { rt, calls, gitState }
}
