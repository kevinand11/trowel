import type { StartRuntime } from './start.ts'
import type { ChangeMetadataPatch, ChangeSpec, SliceMetadataPatch, SlicePatch, SliceSpec } from '../storages/types.ts'
import { noopGitOps } from '../test-utils/git-ops-fixtures.ts'
import { fakeSliceStorage } from '../test-utils/storage-fixtures.ts'

export type FakeCalls = {
	createChange: ChangeSpec[]
	createSlice: Array<{ changeId: string; spec: SliceSpec }>
	updateChangeMetadata: Array<{ changeId: string; patch: ChangeMetadataPatch }>
	updateSlice: Array<{ changeId: string; sliceId: string; patch: SlicePatch }>
	updateSliceMetadata: Array<{ changeId: string; sliceId: string; patch: SliceMetadataPatch }>
	stdout: string[]
	git: string[]
	order: string[]
}

export type FakeGitState = {
	current: string
	clean: boolean
	stashStack: number
}

export type MakeFakesOpts = {
	startOut: string | null
	createChangeResult?: { id: string; title?: string; changeBranch?: string }
	createSliceIds?: string[]
	currentBranch?: string
	cleanTree?: boolean
	preflightFailures?: string[]
	createChangeThrows?: Error
	stashPopThrows?: Error
	perSliceBranches?: boolean
	updateChangeMetadataThrows?: Error
	updateSliceMetadataThrows?: Error
}

export function makeFakes(opts: MakeFakesOpts): { rt: StartRuntime; calls: FakeCalls; gitState: FakeGitState } {
	const calls: FakeCalls = { createChange: [], createSlice: [], updateChangeMetadata: [], updateSlice: [], updateSliceMetadata: [], stdout: [], git: [], order: [] }
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
			calls.order.push(`createChange(${spec.title})`)
			if (opts.createChangeThrows) throw opts.createChangeThrows
			return { id: opts.createChangeResult?.id ?? 'pid', title: opts.createChangeResult?.title ?? spec.title }
		},
		updateChangeMetadata: async (changeId, patch) => {
			calls.updateChangeMetadata.push({ changeId, patch })
			calls.order.push(`updateChangeMetadata(${changeId},${patch.targetBranch ?? ''},${patch.changeBranch ?? ''})`)
			if (opts.updateChangeMetadataThrows) throw opts.updateChangeMetadataThrows
		},
		createSlice: async (changeId, spec) => {
			calls.createSlice.push({ changeId, spec })
			calls.order.push(`createSlice(${changeId},${spec.title})`)
			const id = createSliceIds[sliceCursor++] ?? `s${sliceCursor}`
			return { id, title: spec.title }
		},
		updateSlice: async (changeId, sliceId, patch) => {
			calls.updateSlice.push({ changeId, sliceId, patch })
			calls.order.push(`updateSlice(${changeId},${sliceId})`)
		},
		updateSliceMetadata: async (changeId, sliceId, patch) => {
			calls.updateSliceMetadata.push({ changeId, sliceId, patch })
			calls.order.push(`updateSliceMetadata(${changeId},${sliceId},${patch.sliceBranch ?? ''})`)
			if (opts.updateSliceMetadataThrows) throw opts.updateSliceMetadataThrows
		},
	})

	const git = noopGitOps({
		currentBranch: async () => gitState.current,
		fetch: async (b) => {
			calls.git.push(`fetch(${b})`)
			calls.order.push(`fetch(${b})`)
		},
		checkout: async (b) => {
			calls.git.push(`checkout(${b})`)
			calls.order.push(`checkout(${b})`)
			gitState.current = b
		},
		createRemoteBranch: async (b, base) => {
			calls.git.push(`createRemoteBranch(${b},${base})`)
			calls.order.push(`createRemoteBranch(${b},${base})`)
		},
		isWorkingTreeClean: async () => gitState.clean,
		stashPush: async () => {
			calls.git.push('stashPush')
			calls.order.push('stashPush')
			gitState.stashStack += 1
			gitState.clean = true
		},
		stashPop: async () => {
			calls.git.push('stashPop')
			calls.order.push('stashPop')
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
		perSliceBranches: opts.perSliceBranches ?? true,
	}

	return { rt, calls, gitState }
}
