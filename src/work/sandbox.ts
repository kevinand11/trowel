import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

import type { Role } from './prompts.ts'
import { parseVerdict, type SandboxIn, type SandboxOut } from './verdict.ts'
import type { Slice } from '../backends/types.ts'

export type SpawnSandboxArgs = {
	role: Role
	slice: Slice
	branch: string
	sandboxIn: SandboxIn
}

export type SpawnSandboxDeps = {
	prdId: string
	repoRoot: string
	worktreesDir: string
	addWorktree: (repoRoot: string, worktreePath: string, branch: string) => Promise<void>
	removeWorktree: (repoRoot: string, worktreePath: string) => Promise<void>
	runAgent: (args: { worktreePath: string; role: Role; branch: string }) => Promise<void>
	randId: () => string
}

export async function spawnSandbox(args: SpawnSandboxArgs, deps: SpawnSandboxDeps): Promise<SandboxOut> {
	const runId = deps.randId()
	const worktreePath = path.join(deps.worktreesDir, deps.prdId, `${args.slice.id}-${args.role}-${runId}`)
	await deps.addWorktree(deps.repoRoot, worktreePath, args.branch)
	try {
		const trowelDir = path.join(worktreePath, '.trowel')
		await mkdir(trowelDir, { recursive: true })
		await writeFile(path.join(trowelDir, 'sandbox-in.json'), JSON.stringify(args.sandboxIn))
		await deps.runAgent({ worktreePath, role: args.role, branch: args.branch })
		let rawOut: string | null = null
		try {
			rawOut = await readFile(path.join(trowelDir, 'sandbox-out.json'), 'utf8')
		} catch {
			rawOut = null
		}
		return parseVerdict(rawOut, args.role)
	} finally {
		await deps.removeWorktree(deps.repoRoot, worktreePath)
	}
}

if (import.meta.vitest) {
	const { describe, test, expect, beforeEach, afterEach } = import.meta.vitest
	const { mkdtemp, rm } = await import('node:fs/promises')
	const { tmpdir } = await import('node:os')

	function makeArgs(overrides: Partial<SpawnSandboxArgs> = {}): SpawnSandboxArgs {
		const slice: Slice = {
			id: '145',
			title: 'Session Middleware',
			body: 'wire JWT validation',
			state: 'OPEN',
			readyForAgent: true,
			needsRevision: false,
			bucket: 'ready',
			blockedBy: [],
			prState: null,
			branchAhead: false,
		}
		return {
			role: 'implement',
			slice,
			branch: 'prd-142/slice-145-session-middleware',
			sandboxIn: { slice: { id: slice.id, title: slice.title, body: slice.body } },
			...overrides,
		}
	}

	describe('spawnSandbox', () => {
		let tmp: string
		let worktreesDir: string
		beforeEach(async () => {
			tmp = await mkdtemp(path.join(tmpdir(), 'trowel-sandbox-'))
			worktreesDir = path.join(tmp, '.trowel', 'worktrees')
		})
		afterEach(async () => {
			await rm(tmp, { recursive: true, force: true })
		})

		test('worktree is removed even when runAgent throws', async () => {
			const args = makeArgs()
			const removedPaths: string[] = []
			const deps: SpawnSandboxDeps = {
				prdId: '142',
				repoRoot: tmp,
				worktreesDir,
				addWorktree: async (_root, wt) => {
					await mkdir(wt, { recursive: true })
				},
				removeWorktree: async (_root, wt) => {
					removedPaths.push(wt)
				},
				runAgent: async () => {
					throw new Error('Docker died')
				},
				randId: () => 'r1',
			}
			await expect(spawnSandbox(args, deps)).rejects.toThrow(/Docker died/)
			expect(removedPaths).toHaveLength(1)
		})

		test('missing sandbox-out.json coerces to partial verdict (via parseVerdict)', async () => {
			const args = makeArgs()
			const deps: SpawnSandboxDeps = {
				prdId: '142',
				repoRoot: tmp,
				worktreesDir,
				addWorktree: async (_root, wt) => {
					await mkdir(wt, { recursive: true })
				},
				removeWorktree: async () => {},
				runAgent: async () => {
					// Agent exits without writing sandbox-out.json
				},
				randId: () => 'r1',
			}
			const out = await spawnSandbox(args, deps)
			expect(out.verdict).toBe('partial')
			expect(out.notes).toMatch(/missing/i)
		})

		test('worktree path follows <worktreesDir>/<prdId>/<sliceId>-<role>-<runId>/', async () => {
			const args = makeArgs({ role: 'review' })
			let observedPath: string | null = null
			const deps: SpawnSandboxDeps = {
				prdId: '142',
				repoRoot: tmp,
				worktreesDir,
				addWorktree: async (_root, wt) => {
					observedPath = wt
					await mkdir(wt, { recursive: true })
				},
				removeWorktree: async () => {},
				runAgent: async ({ worktreePath }) => {
					await writeFile(path.join(worktreePath, '.trowel', 'sandbox-out.json'), JSON.stringify({ verdict: 'partial', notes: 'stop' }))
				},
				randId: () => 'abc',
			}
			await spawnSandbox(args, deps)
			expect(observedPath).toBe(path.join(worktreesDir, '142', '145-review-abc'))
		})

		test('writes sandbox-in.json into the worktree, runs the agent, reads sandbox-out.json, returns parsed verdict', async () => {
			const args = makeArgs()
			let runAgentCalled = false
			let observedSandboxIn: SandboxIn | null = null
			const deps: SpawnSandboxDeps = {
				prdId: '142',
				repoRoot: tmp,
				worktreesDir,
				addWorktree: async (_root, wt) => {
					await mkdir(wt, { recursive: true })
				},
				removeWorktree: async () => {},
				runAgent: async ({ worktreePath }) => {
					runAgentCalled = true
					// Read what the host wrote to sandbox-in.json
					const inRaw = await readFile(path.join(worktreePath, '.trowel', 'sandbox-in.json'), 'utf8')
					observedSandboxIn = JSON.parse(inRaw) as SandboxIn
					// Simulate the agent writing its verdict
					await writeFile(path.join(worktreePath, '.trowel', 'sandbox-out.json'), JSON.stringify({ verdict: 'ready' }))
				},
				randId: () => 'r1',
			}

			const out = await spawnSandbox(args, deps)

			expect(runAgentCalled).toBe(true)
			expect(observedSandboxIn).toEqual(args.sandboxIn)
			expect(out.verdict).toBe('ready')
		})
	})
}
