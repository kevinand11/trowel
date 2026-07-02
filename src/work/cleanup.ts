import { rm } from 'node:fs/promises'
import path from 'node:path'

import type { Change, DeleteBranchPolicy, Slice } from '../storages/types.ts'
import type { GitOps } from '../utils/git-ops.ts'

export type CleanupRuntime = {
	projectRoot: string
	git: GitOps
	deleteBranchPolicy: DeleteBranchPolicy
	interactive: boolean
	confirm: (msg: string) => Promise<boolean>
	stdout: (s: string) => void
}

export type CleanupChangeArgs = {
	change: Pick<Change, 'id' | 'changeBranch'>
	slices: Pick<Slice, 'id' | 'sliceBranch'>[]
	targetBranch: string
	rt: CleanupRuntime
}

export type CleanupPreflightArgs = Pick<CleanupChangeArgs, 'change' | 'slices' | 'targetBranch'> & {
	rt: Pick<CleanupRuntime, 'git' | 'deleteBranchPolicy'>
}

export async function cleanupChange(args: CleanupChangeArgs): Promise<void> {
	await refuseCurrentCleanupBranch(args)
	await cleanupChangeWorktrees(args.change.id, args.rt)
	await cleanupLocalBranches(args)
}

export async function refuseCurrentCleanupBranch(args: CleanupPreflightArgs): Promise<void> {
	if (args.rt.deleteBranchPolicy === 'never') return
	const candidates = await cleanupLocalBranchCandidates(args.change, args.slices, args.targetBranch, args.rt.git)
	const current = await args.rt.git.currentBranch()
	if (!candidates.includes(current)) return
	throw new Error(`Change ${args.change.id} cleanup may delete current branch '${current}'. Switch branches first, then retry.`)
}

async function cleanupChangeWorktrees(changeId: string, rt: CleanupRuntime): Promise<void> {
	const root = changeWorktreeRoot(rt.projectRoot, changeId)
	for (const wt of await rt.git.worktreeList()) {
		if (isInside(root, wt.path)) await removeRegisteredWorktree(wt.path, rt)
	}
	await rm(root, { recursive: true, force: true })
}

function changeWorktreeRoot(projectRoot: string, changeId: string): string {
	return path.resolve(projectRoot, '.trowel', 'worktrees', 'changes', changeId)
}

function isInside(root: string, candidate: string): boolean {
	const rel = path.relative(root, path.resolve(candidate))
	return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
}

async function removeRegisteredWorktree(worktreePath: string, rt: CleanupRuntime): Promise<void> {
	try {
		await rt.git.worktreeRemove(worktreePath, { force: true })
	} catch {
		// Fall through to filesystem cleanup; stale or dirty worktrees should not block Cleanup.
	}
	await rm(worktreePath, { recursive: true, force: true })
}

async function cleanupLocalBranches(args: CleanupChangeArgs): Promise<void> {
	const localBranchSet = await cleanupLocalBranchCandidates(args.change, args.slices, args.targetBranch, args.rt.git)
	if (localBranchSet.length === 0) return
	if (!(await branchDeletionAllowedByPolicy(args.change.id, localBranchSet, args.rt))) return
	const deletable = await branchesPassingRemoteSafety(localBranchSet, args.rt)
	if (deletable.length === 0) return
	for (const branch of deletable) await args.rt.git.deleteBranch(branch)
}

async function cleanupLocalBranchCandidates(change: Pick<Change, 'id' | 'changeBranch'>, slices: Pick<Slice, 'id' | 'sliceBranch'>[], targetBranch: string, git: GitOps): Promise<string[]> {
	const local = new Set(await git.listLocalBranches())
	const candidates = new Set<string>([change.changeBranch])
	for (const slice of slices) if (slice.sliceBranch !== null) candidates.add(slice.sliceBranch)
	return [...candidates].filter((branch) => branch !== targetBranch && local.has(branch))
}

async function branchDeletionAllowedByPolicy(changeId: string, branches: string[], rt: CleanupRuntime): Promise<boolean> {
	if (rt.deleteBranchPolicy === 'never') return false
	if (rt.deleteBranchPolicy === 'always') return true
	if (!rt.interactive) {
		rt.stdout(`Skipping local branch deletion for Change ${changeId}; prompt policy requires an interactive terminal.\n`)
		return false
	}
	return rt.confirm(promptForLocalBranchSet(changeId, branches))
}

function promptForLocalBranchSet(changeId: string, branches: string[]): string {
	return `Delete local branches for Change ${changeId}?\n${branches.map((branch) => `  ${branch}`).join('\n')}\n[y/N]`
}

async function branchesPassingRemoteSafety(branches: string[], rt: CleanupRuntime): Promise<string[]> {
	const deletable: string[] = []
	for (const branch of branches) {
		if (await hasCommitsNotOnRemote(branch, rt)) continue
		deletable.push(branch)
	}
	return deletable
}

async function hasCommitsNotOnRemote(branch: string, rt: CleanupRuntime): Promise<boolean> {
	if (!(await rt.git.remoteBranchExists(branch))) return false
	let ahead: number
	try {
		await rt.git.fetch(branch)
		ahead = await rt.git.commitsAhead(branch, `origin/${branch}`)
	} catch (error) {
		rt.stdout(`Skipped local branch '${branch}': could not verify commits against origin/${branch}: ${(error as Error).message}.\n`)
		return true
	}
	if (ahead <= 0) return false
	rt.stdout(`Skipped local branch '${branch}': ${ahead} commit(s) not present on origin/${branch}.\n`)
	return true
}

if (import.meta.vitest) {
	const { describe, test, expect, beforeEach, afterEach } = import.meta.vitest
	const { mkdir, mkdtemp, readFile, stat, writeFile } = await import('node:fs/promises')
	const { tmpdir } = await import('node:os')
	const { noopGitOps } = await import('../test-utils/git-ops-fixtures.ts')

	function fakeSlice(id: string, title: string): Pick<Slice, 'id' | 'sliceBranch'> {
		return { id, sliceBranch: `42/${id}-${title.toLowerCase()}` }
	}

	type CleanupGitState = {
		current: string
		localBranches: Set<string>
		remoteBranches: Set<string>
		ahead: Map<string, number>
		worktrees: Array<{ path: string; branch: string | null; head: string }>
	}

	function fakeCleanupGit(state: CleanupGitState): { git: GitOps; calls: string[] } {
		const calls: string[] = []
		const git = noopGitOps({
			listLocalBranches: async () => [...state.localBranches],
			remoteBranchExists: async (branch) => {
				calls.push(`remoteBranchExists(${branch})`)
				return state.remoteBranches.has(branch)
			},
			fetch: async (branch) => {
				calls.push(`fetch(${branch})`)
			},
			commitsAhead: async (branch, base) => {
				calls.push(`commitsAhead(${branch},${base})`)
				return state.ahead.get(branch) ?? 0
			},
			currentBranch: async () => state.current,
			checkout: async (branch) => {
				calls.push(`checkout(${branch})`)
				state.current = branch
			},
			deleteBranch: async (branch) => {
				calls.push(`deleteBranch(${branch})`)
				state.localBranches.delete(branch)
			},
			worktreeList: async () => state.worktrees,
			worktreeRemove: async (worktreePath) => {
				calls.push(`worktreeRemove(${worktreePath})`)
				state.worktrees = state.worktrees.filter((wt) => wt.path !== worktreePath)
			},
			deleteRemoteBranch: async (branch) => {
				calls.push(`deleteRemoteBranch(${branch})`)
			},
		})
		return { git, calls }
	}

	function cleanupRt(projectRoot: string, git: GitOps, overrides: Partial<CleanupRuntime> = {}): CleanupRuntime {
		return {
			projectRoot,
			git,
			deleteBranchPolicy: 'never',
			interactive: true,
			confirm: async () => false,
			stdout: () => {},
			...overrides,
		}
	}

	describe('cleanupChange', () => {
		let projectRoot: string

		beforeEach(async () => {
			projectRoot = await mkdtemp(path.join(tmpdir(), 'trowel-cleanup-'))
		})

		afterEach(async () => {
			await rm(projectRoot, { recursive: true, force: true })
		})

		test('removes all trowel-managed worktrees for a Change and keeps logs', async () => {
			const wtA = path.join(projectRoot, '.trowel', 'worktrees', 'changes', '42', 'a')
			const wtB = path.join(projectRoot, '.trowel', 'worktrees', 'changes', '42', 'b')
			const otherWt = path.join(projectRoot, '.trowel', 'worktrees', 'changes', '99', 'a')
			const logFile = path.join(projectRoot, '.trowel', 'logs', '42.log')
			await mkdir(wtA, { recursive: true })
			await mkdir(wtB, { recursive: true })
			await mkdir(otherWt, { recursive: true })
			await mkdir(path.dirname(logFile), { recursive: true })
			await writeFile(logFile, 'keep me\n')
			const { git, calls } = fakeCleanupGit({
				current: 'main',
				localBranches: new Set(),
				remoteBranches: new Set(),
				ahead: new Map(),
				worktrees: [
					{ path: projectRoot, branch: 'main', head: '0' },
					{ path: wtA, branch: 'change-42/slice-s1-a', head: '1' },
					{ path: wtB, branch: 'change-42/slice-s2-b', head: '2' },
					{ path: otherWt, branch: 'change-99/slice-s1-a', head: '3' },
				],
			})

			await cleanupChange({ change: { id: '42', changeBranch: 'change-42-x' }, slices: [], targetBranch: 'main', rt: cleanupRt(projectRoot, git) })

			await expect(stat(path.join(projectRoot, '.trowel', 'worktrees', 'changes', '42'))).rejects.toThrow()
			expect((await stat(otherWt)).isDirectory()).toBe(true)
			expect(await readFile(logFile, 'utf8')).toBe('keep me\n')
			expect(calls).toContain(`worktreeRemove(${wtA})`)
			expect(calls).toContain(`worktreeRemove(${wtB})`)
		})

		test('computes local Cleanup branch candidates from stored branch metadata only', async () => {
			const localBranches = new Set(['change-42-x', '42/s1-a', '42/s2-b', '42/stale-old-title', 'change-42/slice-stale-old-title', 'unrelated'])
			const { git } = fakeCleanupGit({ current: 'main', localBranches, remoteBranches: new Set(), ahead: new Map(), worktrees: [] })

			await expect(cleanupLocalBranchCandidates({ id: '42', changeBranch: 'change-42-x' }, [fakeSlice('s1', 'A'), fakeSlice('s2', 'B')], 'main', git))
				.resolves.toEqual(['change-42-x', '42/s1-a', '42/s2-b'])
		})

		test('filters the Target branch from Change and Slice branch deletion candidates', async () => {
			const localBranches = new Set(['main', 'change-42-x', '42/s2-b'])
			const { git } = fakeCleanupGit({ current: 'main', localBranches, remoteBranches: new Set(), ahead: new Map(), worktrees: [] })

			await expect(cleanupLocalBranchCandidates({ id: '42', changeBranch: 'main' }, [{ id: 's1', sliceBranch: 'main' }, fakeSlice('s2', 'B')], 'main', git))
				.resolves.toEqual(['42/s2-b'])
		})

		test('does not refuse the current Target branch when Target is the only matching Cleanup branch', async () => {
			const localBranches = new Set(['main'])
			const { git } = fakeCleanupGit({ current: 'main', localBranches, remoteBranches: new Set(), ahead: new Map(), worktrees: [] })

			await expect(refuseCurrentCleanupBranch({
				change: { id: '42', changeBranch: 'main' },
				slices: [{ id: 's1', sliceBranch: 'main' }],
				targetBranch: 'main',
				rt: { git, deleteBranchPolicy: 'always' },
			})).resolves.toBeUndefined()
		})

		test('refuses before prompting when the current branch is a Cleanup candidate', async () => {
			const wt = path.join(projectRoot, '.trowel', 'worktrees', 'changes', '42', 'a')
			await mkdir(wt, { recursive: true })
			const localBranches = new Set(['main', 'change-42-x'])
			const state = { current: 'change-42-x', localBranches, remoteBranches: new Set<string>(), ahead: new Map<string, number>(), worktrees: [{ path: wt, branch: 'change-42-x', head: '1' }] }
			const { git, calls } = fakeCleanupGit(state)
			const prompts: string[] = []

			await expect(cleanupChange({
				change: { id: '42', changeBranch: 'change-42-x' },
				slices: [],
				targetBranch: 'main',
				rt: cleanupRt(projectRoot, git, {
					deleteBranchPolicy: 'prompt',
					confirm: async (message) => {
						prompts.push(message)
						return true
					},
				}),
			})).rejects.toThrow(/Switch branches first/)
			expect(prompts).toEqual([])
			expect(state.current).toBe('change-42-x')
			expect(calls.find((call) => call.startsWith('worktreeRemove'))).toBeUndefined()
			expect(calls.find((call) => call.startsWith('checkout'))).toBeUndefined()
			expect(calls.find((call) => call.startsWith('deleteBranch'))).toBeUndefined()
		})

		test('deletes non-current branches without checking out the Target branch', async () => {
			const localBranches = new Set(['main', 'change-42-x'])
			const { git, calls } = fakeCleanupGit({ current: 'main', localBranches, remoteBranches: new Set(), ahead: new Map(), worktrees: [] })

			await cleanupChange({ change: { id: '42', changeBranch: 'change-42-x' }, slices: [], targetBranch: 'main', rt: cleanupRt(projectRoot, git, { deleteBranchPolicy: 'always' }) })

			expect(calls).toContain('deleteBranch(change-42-x)')
			expect(calls.find((call) => call.startsWith('checkout'))).toBeUndefined()
		})

		test('prompt policy asks once for the stored local branch set', async () => {
			const localBranches = new Set(['change-42-x', '42/s1-a', '42/s2-b', '42/stale-old-title', 'change-42/slice-stale-old-title', 'unrelated'])
			const { git, calls } = fakeCleanupGit({ current: 'main', localBranches, remoteBranches: new Set(), ahead: new Map(), worktrees: [] })
			const prompts: string[] = []

			await cleanupChange({
				change: { id: '42', changeBranch: 'change-42-x' },
				slices: [fakeSlice('s1', 'A'), fakeSlice('s2', 'B')],
				targetBranch: 'main',
				rt: cleanupRt(projectRoot, git, {
					deleteBranchPolicy: 'prompt',
					confirm: async (message) => {
						prompts.push(message)
						return false
					},
				}),
			})

			expect(prompts).toHaveLength(1)
			expect(prompts[0]).toContain('change-42-x')
			expect(prompts[0]).toContain('42/s1-a')
			expect(prompts[0]).toContain('42/s2-b')
			expect(prompts[0]).not.toContain('42/stale-old-title')
			expect(prompts[0]).not.toContain('change-42/slice-stale-old-title')
			expect(prompts[0]).not.toContain('unrelated')
			expect(calls.find((call) => call.startsWith('deleteBranch'))).toBeUndefined()
		})

		test('non-interactive prompt skips branch deletion but still removes worktrees', async () => {
			const wt = path.join(projectRoot, '.trowel', 'worktrees', 'changes', '42', 'a')
			await mkdir(wt, { recursive: true })
			const localBranches = new Set(['change-42-x'])
			const { git, calls } = fakeCleanupGit({ current: 'main', localBranches, remoteBranches: new Set(), ahead: new Map(), worktrees: [{ path: wt, branch: 'change-42-x', head: '1' }] })
			let out = ''

			await cleanupChange({
				change: { id: '42', changeBranch: 'change-42-x' },
				slices: [],
				targetBranch: 'main',
				rt: cleanupRt(projectRoot, git, {
					deleteBranchPolicy: 'prompt',
					interactive: false,
					confirm: async () => {
						throw new Error('should not prompt')
					},
					stdout: (s) => {
						out += s
					},
				}),
			})

			await expect(stat(wt)).rejects.toThrow()
			expect(localBranches.has('change-42-x')).toBe(true)
			expect(calls.find((call) => call.startsWith('deleteBranch'))).toBeUndefined()
			expect(out).toContain('prompt policy requires an interactive terminal')
		})

		test('skips and reports local branches with commits not present on their remote counterpart', async () => {
			const changeBranch = 'change-42-x'
			const sliceBranch = '42/s1-a'
			const localBranches = new Set([changeBranch, sliceBranch])
			const { git, calls } = fakeCleanupGit({
				current: 'main',
				localBranches,
				remoteBranches: new Set([changeBranch, sliceBranch]),
				ahead: new Map([[changeBranch, 2], [sliceBranch, 0]]),
				worktrees: [],
			})
			let out = ''

			await cleanupChange({
				change: { id: '42', changeBranch },
				slices: [fakeSlice('s1', 'A')],
				targetBranch: 'main',
				rt: cleanupRt(projectRoot, git, { deleteBranchPolicy: 'always', stdout: (s) => { out += s } }),
			})

			expect(localBranches.has(changeBranch)).toBe(true)
			expect(localBranches.has(sliceBranch)).toBe(false)
			expect(out).toContain(`Skipped local branch '${changeBranch}'`)
			expect(out).toContain(`not present on origin/${changeBranch}`)
			expect(calls).toContain(`deleteBranch(${sliceBranch})`)
			expect(calls.find((call) => call.startsWith('deleteRemoteBranch'))).toBeUndefined()
		})
	})
}
