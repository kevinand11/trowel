import path from 'node:path'

import { confirm as inqConfirm } from '@inquirer/prompts'

import { getBackend } from '../backends/registry.ts'
import type { Backend, BackendDeps, DeleteBranchPolicy } from '../backends/types.ts'
import { loadConfig } from '../config.ts'
import { realGhRunner } from '../utils/gh-runner.ts'
import { tryExec } from '../utils/shell.ts'

export type OpenPr = { number: number; url: string }

export type GitOps = {
	currentBranch: () => Promise<string>
	branchExists: (branch: string) => Promise<boolean>
	isMerged: (branch: string, base: string) => Promise<boolean>
	checkout: (branch: string) => Promise<void>
	deleteBranch: (branch: string) => Promise<void>
}

export type CloseRuntime = {
	backend: Backend
	baseBranch: string
	deleteBranchPolicy: DeleteBranchPolicy
	confirm: (msg: string) => Promise<boolean>
	stdout: (s: string) => void
	git: GitOps
	listOpenPrs: (baseBranch: string) => Promise<OpenPr[]>
}

export async function runClose(prdId: string, rt: CloseRuntime): Promise<void> {
	const back = await rt.git.currentBranch()

	const prd = await rt.backend.findPrd(prdId)
	if (!prd) throw new Error(`PRD '${prdId}' not found`)

	const slices = await rt.backend.findSlices(prdId)
	const openSlices = slices.filter((s) => s.state === 'OPEN')
	if (openSlices.length > 0) {
		const ids = openSlices.map((s) => s.id).join(', ')
		const ok = await rt.confirm(`PRD has ${openSlices.length} open slices: ${ids}. Auto-close all? [y/N]`)
		if (!ok) {
			rt.stdout('Aborted; nothing changed.\n')
			return
		}
		for (const s of openSlices) {
			await rt.backend.updateSlice(prdId, s.id, { state: 'CLOSED' })
		}
	}

	if (prd.state === 'OPEN') {
		await rt.backend.close(prdId)
	} else {
		rt.stdout(`PRD '${prdId}' already closed in store.\n`)
	}

	if (await rt.git.branchExists(prd.branch)) {
		await maybeDeleteBranch(prd.branch, back, rt)
	}

	const current = await rt.git.currentBranch()
	if (current !== back) {
		if (await rt.git.branchExists(back)) {
			await rt.git.checkout(back)
		} else {
			rt.stdout(`Switched to '${rt.baseBranch}' (was on deleted branch '${back}')\n`)
		}
	}
}

async function maybeDeleteBranch(branch: string, backTo: string, rt: CloseRuntime): Promise<void> {
	if (rt.deleteBranchPolicy === 'never') return
	if (rt.deleteBranchPolicy === 'prompt') {
		const ok = await rt.confirm(`Delete integration branch '${branch}' (local + origin)? [y/N]`)
		if (!ok) return
	}

	const prs = await rt.listOpenPrs(branch)
	if (prs.length > 0) {
		rt.stdout(`Open PRs targeting '${branch}':\n`)
		for (const pr of prs) rt.stdout(`  #${pr.number}  ${pr.url}\n`)
		const ok = await rt.confirm('Deleting the branch will close these PRs. Continue? [y/N]')
		if (!ok) return
	}

	const merged = await rt.git.isMerged(branch, rt.baseBranch)
	if (!merged) {
		const ok = await rt.confirm(`Branch '${branch}' contains commits not on '${rt.baseBranch}' — delete anyway? [y/N]`)
		if (!ok) return
	}

	const current = await rt.git.currentBranch()
	if (current === branch) {
		await rt.git.checkout(rt.baseBranch)
	}

	await rt.git.deleteBranch(branch)
	if (backTo === branch) {
		// Caller's BACK_TO has been destroyed; the post-loop will detect and message.
	}
}

export async function close(prdId: string, opts: { backend?: string }): Promise<void> {
	const { config, projectRoot } = await loadConfig()
	if (!projectRoot) {
		process.stderr.write('trowel close: no project root found\n')
		process.exit(1)
	}

	const backendKind = opts.backend ?? config.backend
	const promptConfirm = (msg: string) => inqConfirm({ message: msg, default: false })

	const backendDeps: BackendDeps = {
		gh: realGhRunner,
		repoRoot: projectRoot,
		projectRoot,
		baseBranch: config.baseBranch,
		branchPrefix: config.branchPrefix,
		prdsDir: path.resolve(projectRoot, config.docs.prdsDir),
		docMsg: config.commit.docMsg,
		labels: config.labels,
		closeOptions: config.close,
		confirm: promptConfirm,
	}
	const backend = getBackend(backendKind, backendDeps)

	const git: GitOps = {
		currentBranch: async () => {
			const r = await tryExec('git', ['-C', projectRoot, 'rev-parse', '--abbrev-ref', 'HEAD'])
			return r.ok ? r.stdout.trim() : ''
		},
		branchExists: async (b) => {
			const local = await tryExec('git', ['-C', projectRoot, 'branch', '--list', b])
			if (local.ok && local.stdout.trim() !== '') return true
			const remote = await tryExec('git', ['-C', projectRoot, 'ls-remote', '--heads', 'origin', b])
			return remote.ok && remote.stdout.trim() !== ''
		},
		isMerged: async (b, base) => {
			const r = await tryExec('git', ['-C', projectRoot, 'merge-base', '--is-ancestor', b, `origin/${base}`])
			return r.ok
		},
		checkout: async (b) => {
			const r = await tryExec('git', ['-C', projectRoot, 'checkout', '-q', b])
			if (!r.ok) throw r.error
		},
		deleteBranch: async (b) => {
			await tryExec('git', ['-C', projectRoot, 'branch', '-q', '-D', b])
			await tryExec('git', ['-C', projectRoot, 'push', '-q', 'origin', `:${b}`])
		},
	}

	const listOpenPrs = async (baseBranch: string): Promise<OpenPr[]> => {
		const r = await realGhRunner(['pr', 'list', '--base', baseBranch, '--state', 'open', '--json', 'number,url'])
		if (!r.ok) return []
		return JSON.parse(r.stdout) as OpenPr[]
	}

	try {
		await runClose(prdId, {
			backend,
			baseBranch: config.baseBranch,
			deleteBranchPolicy: config.close.deleteBranch,
			confirm: promptConfirm,
			stdout: (s) => process.stdout.write(s),
			git,
			listOpenPrs,
		})
	} catch (error) {
		process.stderr.write(`trowel close: ${(error as Error).message}\n`)
		process.exit(1)
	}
}

if (import.meta.vitest) {
	const { describe, test, expect } = import.meta.vitest
	const { classify } = await import('../utils/bucket.ts')

	type FakeBackendState = {
		prd: { id: string; branch: string; title: string; state: 'OPEN' | 'CLOSED' } | null
		slices: Array<{ id: string; title: string; body: string; state: 'OPEN' | 'CLOSED'; readyForAgent: boolean; needsRevision: boolean }>
	}

	function fakeBackend(state: FakeBackendState): { backend: Backend; calls: string[] } {
		const calls: string[] = []
		const backend: Backend = {
			name: 'fake',
			defaultBranchPrefix: '',
			createPrd: async () => {
				throw new Error('not implemented')
			},
			branchForExisting: async (id) => {
				if (!state.prd || state.prd.id !== id) throw new Error('not found')
				return state.prd.branch
			},
			findPrd: async (id) => {
				calls.push(`findPrd(${id})`)
				if (!state.prd || state.prd.id !== id) return null
				return { ...state.prd }
			},
			listOpen: async () => (state.prd && state.prd.state === 'OPEN' ? [state.prd] : []),
			close: async (id) => {
				calls.push(`close(${id})`)
				if (state.prd && state.prd.id === id) state.prd.state = 'CLOSED'
			},
			createSlice: async () => {
				throw new Error('not implemented')
			},
			findSlices: async () => {
				calls.push('findSlices')
				return state.slices.map((s) => ({ ...s, blockedBy: [], bucket: classify(s, { hasOpenPr: false, unmetDepIds: [] }) }))
			},
			updateSlice: async (_pid, sliceId, patch) => {
				calls.push(`updateSlice(${sliceId},${JSON.stringify(patch)})`)
				const s = state.slices.find((x) => x.id === sliceId)
				if (s && patch.state === 'CLOSED') s.state = 'CLOSED'
				if (s && patch.readyForAgent !== undefined) s.readyForAgent = patch.readyForAgent
				if (s && patch.needsRevision !== undefined) s.needsRevision = patch.needsRevision
			},
		}
		return { backend, calls }
	}

	type GitState = {
		current: string
		branches: Set<string>
		mergedAncestors: Map<string, string[]> // branch → ancestors (i.e. base branches it's merged into)
	}

	function fakeGit(state: GitState): { git: GitOps; calls: string[] } {
		const calls: string[] = []
		const git: GitOps = {
			currentBranch: async () => state.current,
			branchExists: async (b) => state.branches.has(b),
			isMerged: async (b, base) => (state.mergedAncestors.get(b) ?? []).includes(base),
			checkout: async (b) => {
				calls.push(`checkout(${b})`)
				state.current = b
			},
			deleteBranch: async (b) => {
				calls.push(`deleteBranch(${b})`)
				state.branches.delete(b)
			},
		}
		return { git, calls }
	}

	describe('close: PRD not found', () => {
		test('throws when backend.findPrd returns null', async () => {
			const state: FakeBackendState = { prd: null, slices: [] }
			const gitState: GitState = { current: 'main', branches: new Set(['main']), mergedAncestors: new Map() }
			const { backend } = fakeBackend(state)
			const { git } = fakeGit(gitState)
			await expect(
				runClose('99', {
					backend,
					baseBranch: 'main',
					deleteBranchPolicy: 'never',
					confirm: async () => false,
					stdout: () => {},
					git,
					listOpenPrs: async () => [],
				}),
			).rejects.toThrow(/PRD '99' not found/)
		})
	})

	describe('close: idempotent on already-closed PRD', () => {
		test('does not call backend.close when prd state is CLOSED', async () => {
			const state: FakeBackendState = {
				prd: { id: '42', branch: '42-feature', title: 'F', state: 'CLOSED' },
				slices: [],
			}
			const gitState: GitState = {
				current: 'main',
				branches: new Set(['main', '42-feature']),
				mergedAncestors: new Map(),
			}
			const { backend, calls } = fakeBackend(state)
			const { git } = fakeGit(gitState)
			let stdoutBuf = ''
			await runClose('42', {
				backend,
				baseBranch: 'main',
				deleteBranchPolicy: 'never',
				confirm: async () => false,
				stdout: (s) => {
					stdoutBuf += s
				},
				git,
				listOpenPrs: async () => [],
			})
			expect(calls).not.toContain('close(42)')
			expect(stdoutBuf).toMatch(/already closed/i)
		})

		test('still attempts branch delete on a closed PRD when branch still exists', async () => {
			const state: FakeBackendState = {
				prd: { id: '42', branch: '42-feature', title: 'F', state: 'CLOSED' },
				slices: [],
			}
			const gitState: GitState = {
				current: 'main',
				branches: new Set(['main', '42-feature']),
				mergedAncestors: new Map([['42-feature', ['main']]]),
			}
			const { backend } = fakeBackend(state)
			const { git, calls: gCalls } = fakeGit(gitState)
			await runClose('42', {
				backend,
				baseBranch: 'main',
				deleteBranchPolicy: 'always',
				confirm: async () => false,
				stdout: () => {},
				git,
				listOpenPrs: async () => [],
			})
			expect(gCalls).toContain('deleteBranch(42-feature)')
		})
	})

	describe('close: open slices', () => {
		const baseSlice = { title: 'X', body: '', readyForAgent: false, needsRevision: false }

		test('warns with slice ids and confirms before auto-closing', async () => {
			const state: FakeBackendState = {
				prd: { id: '42', branch: '42-feature', title: 'F', state: 'OPEN' },
				slices: [
					{ id: 's1', ...baseSlice, state: 'OPEN' },
					{ id: 's2', ...baseSlice, state: 'CLOSED' },
					{ id: 's3', ...baseSlice, state: 'OPEN' },
				],
			}
			const gitState: GitState = { current: 'main', branches: new Set(['main', '42-feature']), mergedAncestors: new Map() }
			const { backend, calls } = fakeBackend(state)
			const { git } = fakeGit(gitState)
			let confirmMsg = ''
			await runClose('42', {
				backend,
				baseBranch: 'main',
				deleteBranchPolicy: 'never',
				confirm: async (m) => {
					confirmMsg = m
					return true
				},
				stdout: () => {},
				git,
				listOpenPrs: async () => [],
			})
			expect(confirmMsg).toMatch(/2 open slices/i)
			expect(confirmMsg).toContain('s1')
			expect(confirmMsg).toContain('s3')
			expect(confirmMsg).not.toContain('s2')
			expect(state.slices.every((s) => s.state === 'CLOSED')).toBe(true)
			expect(calls).toContain('close(42)')
		})

		test('declining the warn → no auto-close, no backend.close, no branch ops', async () => {
			const state: FakeBackendState = {
				prd: { id: '42', branch: '42-feature', title: 'F', state: 'OPEN' },
				slices: [{ id: 's1', ...baseSlice, state: 'OPEN' }],
			}
			const gitState: GitState = { current: 'main', branches: new Set(['main', '42-feature']), mergedAncestors: new Map() }
			const { backend, calls: bCalls } = fakeBackend(state)
			const { git, calls: gCalls } = fakeGit(gitState)
			let stdoutBuf = ''
			await runClose('42', {
				backend,
				baseBranch: 'main',
				deleteBranchPolicy: 'always',
				confirm: async () => false,
				stdout: (s) => {
					stdoutBuf += s
				},
				git,
				listOpenPrs: async () => [],
			})
			expect(state.slices[0]!.state).toBe('OPEN')
			expect(state.prd!.state).toBe('OPEN')
			expect(bCalls).not.toContain('close(42)')
			expect(gCalls.find((c) => c.startsWith('deleteBranch'))).toBeUndefined()
			expect(stdoutBuf).toMatch(/aborted/i)
		})

		test('no open slices → no prompt, proceeds straight to backend.close', async () => {
			const state: FakeBackendState = {
				prd: { id: '42', branch: '42-feature', title: 'F', state: 'OPEN' },
				slices: [{ id: 's1', ...baseSlice, state: 'CLOSED' }],
			}
			const gitState: GitState = { current: 'main', branches: new Set(['main', '42-feature']), mergedAncestors: new Map() }
			const { backend, calls } = fakeBackend(state)
			const { git } = fakeGit(gitState)
			let confirmCalled = 0
			await runClose('42', {
				backend,
				baseBranch: 'main',
				deleteBranchPolicy: 'never',
				confirm: async () => {
					confirmCalled++
					return false
				},
				stdout: () => {},
				git,
				listOpenPrs: async () => [],
			})
			expect(confirmCalled).toBe(0)
			expect(calls).toContain('close(42)')
		})
	})

	describe('close: tracer (PRD open, no slices, policy=never)', () => {
		test('calls backend.close, leaves branch intact, returns user to BACK_TO', async () => {
			const state: FakeBackendState = {
				prd: { id: '42', branch: '42-feature', title: 'Feature', state: 'OPEN' },
				slices: [],
			}
			const gitState: GitState = {
				current: 'main',
				branches: new Set(['main', '42-feature']),
				mergedAncestors: new Map(),
			}
			const { backend, calls: bCalls } = fakeBackend(state)
			const { git, calls: gCalls } = fakeGit(gitState)
			await runClose('42', {
				backend,
				baseBranch: 'main',
				deleteBranchPolicy: 'never',
				confirm: async () => false,
				stdout: () => {},
				git,
				listOpenPrs: async () => [],
			})
			expect(state.prd!.state).toBe('CLOSED')
			expect(bCalls).toContain('close(42)')
			expect(gCalls.find((c) => c.startsWith('deleteBranch'))).toBeUndefined()
			expect(gitState.branches.has('42-feature')).toBe(true)
			expect(gitState.current).toBe('main')
		})
	})

	describe('close: branch deletion policy', () => {
		function happyState(): { state: FakeBackendState; gitState: GitState } {
			return {
				state: { prd: { id: '42', branch: '42-feature', title: 'F', state: 'OPEN' }, slices: [] },
				gitState: {
					current: 'main',
					branches: new Set(['main', '42-feature']),
					mergedAncestors: new Map([['42-feature', ['main']]]),
				},
			}
		}

		test("policy='always' + merged + no open PRs → deletes without confirm", async () => {
			const { state, gitState } = happyState()
			const { backend } = fakeBackend(state)
			const { git, calls: gCalls } = fakeGit(gitState)
			let confirmCalls = 0
			await runClose('42', {
				backend,
				baseBranch: 'main',
				deleteBranchPolicy: 'always',
				confirm: async () => {
					confirmCalls++
					return true
				},
				stdout: () => {},
				git,
				listOpenPrs: async () => [],
			})
			expect(confirmCalls).toBe(0)
			expect(gCalls).toContain('deleteBranch(42-feature)')
			expect(gitState.branches.has('42-feature')).toBe(false)
		})

		test("policy='prompt' → asks once; user declines → no delete", async () => {
			const { state, gitState } = happyState()
			const { backend } = fakeBackend(state)
			const { git, calls: gCalls } = fakeGit(gitState)
			const msgs: string[] = []
			await runClose('42', {
				backend,
				baseBranch: 'main',
				deleteBranchPolicy: 'prompt',
				confirm: async (m) => {
					msgs.push(m)
					return false
				},
				stdout: () => {},
				git,
				listOpenPrs: async () => [],
			})
			expect(msgs).toHaveLength(1)
			expect(msgs[0]).toMatch(/delete integration branch '42-feature'/i)
			expect(gCalls.find((c) => c.startsWith('deleteBranch'))).toBeUndefined()
			expect(gitState.branches.has('42-feature')).toBe(true)
		})

		test("policy='prompt' + accept → deletes; merged so no extra warnings", async () => {
			const { state, gitState } = happyState()
			const { backend } = fakeBackend(state)
			const { git } = fakeGit(gitState)
			const msgs: string[] = []
			await runClose('42', {
				backend,
				baseBranch: 'main',
				deleteBranchPolicy: 'prompt',
				confirm: async (m) => {
					msgs.push(m)
					return true
				},
				stdout: () => {},
				git,
				listOpenPrs: async () => [],
			})
			expect(msgs).toHaveLength(1)
			expect(gitState.branches.has('42-feature')).toBe(false)
		})

		test("policy='never' → never prompts and never deletes", async () => {
			const { state, gitState } = happyState()
			const { backend } = fakeBackend(state)
			const { git, calls: gCalls } = fakeGit(gitState)
			let confirmCalls = 0
			await runClose('42', {
				backend,
				baseBranch: 'main',
				deleteBranchPolicy: 'never',
				confirm: async () => {
					confirmCalls++
					return true
				},
				stdout: () => {},
				git,
				listOpenPrs: async () => [],
			})
			expect(confirmCalls).toBe(0)
			expect(gCalls.find((c) => c.startsWith('deleteBranch'))).toBeUndefined()
		})

		test('open slice PRs → warn + confirm before delete; decline → keep branch', async () => {
			const { state, gitState } = happyState()
			const { backend } = fakeBackend(state)
			const { git } = fakeGit(gitState)
			const msgs: string[] = []
			let stdoutBuf = ''
			await runClose('42', {
				backend,
				baseBranch: 'main',
				deleteBranchPolicy: 'always',
				confirm: async (m) => {
					msgs.push(m)
					return false // decline
				},
				stdout: (s) => {
					stdoutBuf += s
				},
				git,
				listOpenPrs: async (b) => [{ number: 99, url: `https://github.com/o/r/pull/99 base=${b}` }],
			})
			expect(stdoutBuf).toContain('#99')
			expect(msgs.some((m) => /deleting the branch will close these PRs/i.test(m))).toBe(true)
			expect(gitState.branches.has('42-feature')).toBe(true)
		})

		test('unmerged branch → warn + confirm; decline → keep branch', async () => {
			const { state, gitState } = happyState()
			gitState.mergedAncestors = new Map() // branch not merged
			const { backend } = fakeBackend(state)
			const { git } = fakeGit(gitState)
			const msgs: string[] = []
			await runClose('42', {
				backend,
				baseBranch: 'main',
				deleteBranchPolicy: 'always',
				confirm: async (m) => {
					msgs.push(m)
					return false
				},
				stdout: () => {},
				git,
				listOpenPrs: async () => [],
			})
			expect(msgs.some((m) => /contains commits not on 'main'/i.test(m))).toBe(true)
			expect(gitState.branches.has('42-feature')).toBe(true)
		})

		test('unmerged + accept → deletes', async () => {
			const { state, gitState } = happyState()
			gitState.mergedAncestors = new Map()
			const { backend } = fakeBackend(state)
			const { git } = fakeGit(gitState)
			await runClose('42', {
				backend,
				baseBranch: 'main',
				deleteBranchPolicy: 'always',
				confirm: async () => true,
				stdout: () => {},
				git,
				listOpenPrs: async () => [],
			})
			expect(gitState.branches.has('42-feature')).toBe(false)
		})
	})

	describe('close: BACK_TO restoration', () => {
		test('currently on integration branch + delete → switches to baseBranch + stays there', async () => {
			const state: FakeBackendState = {
				prd: { id: '42', branch: '42-feature', title: 'F', state: 'OPEN' },
				slices: [],
			}
			const gitState: GitState = {
				current: '42-feature',
				branches: new Set(['main', '42-feature']),
				mergedAncestors: new Map([['42-feature', ['main']]]),
			}
			const { backend } = fakeBackend(state)
			const { git, calls: gCalls } = fakeGit(gitState)
			let stdoutBuf = ''
			await runClose('42', {
				backend,
				baseBranch: 'main',
				deleteBranchPolicy: 'always',
				confirm: async () => true,
				stdout: (s) => {
					stdoutBuf += s
				},
				git,
				listOpenPrs: async () => [],
			})
			expect(gCalls).toContain('checkout(main)')
			expect(gitState.current).toBe('main')
			expect(stdoutBuf).toMatch(/Switched to 'main' \(was on deleted branch '42-feature'\)/)
		})

		test('currently on baseBranch → no checkout calls', async () => {
			const state: FakeBackendState = {
				prd: { id: '42', branch: '42-feature', title: 'F', state: 'OPEN' },
				slices: [],
			}
			const gitState: GitState = {
				current: 'main',
				branches: new Set(['main', '42-feature']),
				mergedAncestors: new Map([['42-feature', ['main']]]),
			}
			const { backend } = fakeBackend(state)
			const { git, calls: gCalls } = fakeGit(gitState)
			await runClose('42', {
				backend,
				baseBranch: 'main',
				deleteBranchPolicy: 'always',
				confirm: async () => true,
				stdout: () => {},
				git,
				listOpenPrs: async () => [],
			})
			expect(gCalls.filter((c) => c.startsWith('checkout'))).toEqual([])
		})

		test('currently on unrelated branch + delete integration → restores user to BACK_TO branch', async () => {
			const state: FakeBackendState = {
				prd: { id: '42', branch: '42-feature', title: 'F', state: 'OPEN' },
				slices: [],
			}
			const gitState: GitState = {
				current: 'experiment',
				branches: new Set(['main', '42-feature', 'experiment']),
				mergedAncestors: new Map([['42-feature', ['main']]]),
			}
			const { backend } = fakeBackend(state)
			const { git } = fakeGit(gitState)
			await runClose('42', {
				backend,
				baseBranch: 'main',
				deleteBranchPolicy: 'always',
				confirm: async () => true,
				stdout: () => {},
				git,
				listOpenPrs: async () => [],
			})
			expect(gitState.current).toBe('experiment')
			expect(gitState.branches.has('42-feature')).toBe(false)
		})
	})
}
