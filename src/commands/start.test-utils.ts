import type { StartRuntime } from './start.ts'
import type { Slice, PrdSpec, SliceSpec, SlicePatch, Storage } from '../storages/types.ts'
import type { GitOps } from '../utils/git-ops.ts'

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

export function makeFakes(opts: MakeFakesOpts): { rt: StartRuntime; calls: FakeCalls; gitState: FakeGitState } {
	const calls: FakeCalls = { createPrd: [], createSlice: [], updateSlice: [], stdout: [], git: [] }
	const gitState: FakeGitState = {
		current: opts.currentBranch ?? 'main',
		clean: opts.cleanTree ?? true,
		stashStack: 0,
	}
	let sliceCursor = 0
	const createSliceIds = opts.createSliceIds ?? []

	const storage: Storage = {
		createPrd: async (spec) => {
			calls.createPrd.push(spec)
			if (opts.createPrdThrows) throw opts.createPrdThrows
			return opts.createPrdResult ?? { id: 'pid', branch: 'pid-branch' }
		},
		findPrd: async () => null,
		listPrds: async () => [],
		closePrd: async () => {},
		createSlice: async (prdId, spec) => {
			calls.createSlice.push({ prdId, spec })
			const id = createSliceIds[sliceCursor++] ?? `s${sliceCursor}`
			const slice: Slice = {
				id, title: spec.title, body: spec.body, state: 'OPEN',
				readyForAgent: false, needsRevision: false,
				blockedBy: [], prState: null,
			}
			return slice
		},
		findSlices: async () => [],
		findSlice: async () => null,
		updateSlice: async (prdId, sliceId, patch) => {
			calls.updateSlice.push({ prdId, sliceId, patch })
		},
	}

	const git: GitOps = {
		currentBranch: async () => gitState.current,
		baseBranch: async () => 'main',
		branchExists: async () => true,
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
		fetch: async () => {}, push: async () => {}, mergeNoFf: async () => {}, mergeAbort: async () => {},
		deleteRemoteBranch: async () => {}, createRemoteBranch: async () => {},
		createLocalBranch: async () => {}, pushSetUpstream: async () => {},
		isMerged: async () => false, deleteBranch: async () => {}, commitsAhead: async () => 0,
		worktreeAdd: async () => {}, worktreeRemove: async () => {},
		worktreeList: async () => [], restoreAll: async () => {}, cleanUntracked: async () => {},
		detectVersion: async () => ({ installed: true, version: '0.0.0' }),
	}

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
