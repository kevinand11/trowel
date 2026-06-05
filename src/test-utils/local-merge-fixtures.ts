import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { setupTestRepoWithBare } from './git-repo.ts'
import type { ChangeRecord, Slice, SlicePatch, Storage } from '../storages/types.ts'
import { createRepoGit, type GitOps } from '../utils/git-ops.ts'
import { exec } from '../utils/shell.ts'

export type LocalSliceMergeFixture = {
	projectRoot: string
	git: GitOps
	storage: Storage
	state: { change: ChangeRecord; slice: Slice }
	commitOnBranch: (branch: string, file: string, content: string) => Promise<void>
	currentBranch: () => Promise<string>
	cleanup: () => Promise<void>
}

export async function setupLocalSliceMergeFixture(opts: {
	changeId?: string
	changeBranch?: string
	currentBranch?: string
	slice?: Partial<Slice>
} = {}): Promise<LocalSliceMergeFixture> {
	const fixture = await setupTestRepoWithBare({ prefix: 'trowel-local-slice-merge-' })
	const git = createRepoGit(fixture.work)
	const changeId = opts.changeId ?? 'p1'
	const changeBranch = opts.changeBranch ?? `${changeId}-feature`
	const currentBranch = opts.currentBranch ?? 'main'
	await createRemoteChangeBranch(fixture.work, changeBranch)
	if (currentBranch !== 'main') await exec('git', ['-C', fixture.work, 'checkout', '-q', '-b', currentBranch, 'origin/main'])

	const state = {
		change: { id: changeId, changeBranch, targetBranch: 'main', title: 'Feature', closedAt: null },
		slice: testSlice(changeId, opts.slice),
	}
	if (state.slice.sliceBranch !== null && state.slice.sliceBranch !== changeBranch) await createRemoteSliceBranch(fixture.work, state.slice.sliceBranch, changeBranch)

	return {
		projectRoot: fixture.work,
		git,
		storage: localSliceMergeStorage(state),
		state,
		commitOnBranch: (branch, file, content) => commitOnBranch(fixture.work, branch, file, content),
		currentBranch: () => currentBranchName(fixture.work),
		cleanup: () => fixture.cleanup(),
	}
}

async function createRemoteChangeBranch(repo: string, branch: string): Promise<void> {
	await exec('git', ['-C', repo, 'branch', branch, 'origin/main'])
	await exec('git', ['-C', repo, 'push', '-q', 'origin', `${branch}:${branch}`])
}

async function createRemoteSliceBranch(repo: string, branch: string, changeBranch: string): Promise<void> {
	await exec('git', ['-C', repo, 'branch', branch, changeBranch])
	await exec('git', ['-C', repo, 'push', '-q', 'origin', `${branch}:${branch}`])
}

function testSlice(changeId: string, overrides: Partial<Slice> = {}): Slice {
	const id = overrides.id ?? 's1'
	return {
		id,
		title: 'Implement A',
		body: 'spec',
		state: 'open',
		closedAt: null,
		implementedAt: null,
		auditedAt: null,
		readyForAgent: true,
		needsRevision: false,
		blockedBy: [],
		sliceBranch: `${changeId}/${id}-implement-a`,
		prState: null,
		...overrides,
	}
}

function localSliceMergeStorage(state: { change: ChangeRecord; slice: Slice }): Storage {
	return {
		createChange: async () => ({ id: state.change.id, title: state.change.title }),
		findChange: async (id) => id === state.change.id ? { ...state.change } : null,
		listChanges: async () => [],
		closeChange: async (id) => {
			if (id !== state.change.id) return
			state.change.closedAt = new Date().toISOString()
		},
		updateChangeMetadata: async (_changeId, patch) => {
			if (patch.changeBranch !== undefined) state.change.changeBranch = patch.changeBranch
			if (patch.targetBranch !== undefined) state.change.targetBranch = patch.targetBranch
		},
		createSlice: async () => { throw new Error('not used') },
		findSlices: async (changeId) => changeId === state.change.id ? [{ ...state.slice }] : [],
		updateSlice: async (changeId, sliceId, patch) => {
			if (changeId !== state.change.id || sliceId !== state.slice.id) return
			applySlicePatch(state.slice, patch)
		},
		updateSliceMetadata: async (_changeId, sliceId, patch) => {
			if (sliceId !== state.slice.id) return
			if (patch.sliceBranch !== undefined) state.slice.sliceBranch = patch.sliceBranch
		},
	}
}

function applySlicePatch(slice: Slice, patch: SlicePatch): void {
	if (patch.closedAt !== undefined) {
		slice.closedAt = patch.closedAt
		slice.state = patch.closedAt === null ? 'open' : 'done'
	}
	if (patch.implementedAt !== undefined) slice.implementedAt = patch.implementedAt
	if (patch.auditedAt !== undefined) slice.auditedAt = patch.auditedAt
	if (patch.readyForAgent !== undefined) slice.readyForAgent = patch.readyForAgent
	if (patch.blockedBy !== undefined) slice.blockedBy = patch.blockedBy
}

async function commitOnBranch(repo: string, branch: string, file: string, content: string): Promise<void> {
	const tempRoot = await mkdtemp(path.join(tmpdir(), 'trowel-turn-wt-'))
	const worktreePath = path.join(tempRoot, 'wt')
	try {
		await exec('git', ['-C', repo, 'worktree', 'add', '-q', worktreePath, branch])
		await writeFile(path.join(worktreePath, file), content)
		await exec('git', ['-C', worktreePath, 'add', file])
		await exec('git', ['-C', worktreePath, 'commit', '-q', '-m', `commit ${file}`])
		await exec('git', ['-C', repo, 'worktree', 'remove', '-f', worktreePath])
	} finally {
		await rm(tempRoot, { recursive: true, force: true })
	}
}

async function currentBranchName(repo: string): Promise<string> {
	return (await exec('git', ['-C', repo, 'rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim()
}
