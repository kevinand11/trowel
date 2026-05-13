import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

import type { Role } from './prompts.ts'
import { parseVerdict, type SandboxIn, type SandboxOut } from './verdict.ts'
import type { Slice } from '../storages/types.ts'

export type SpawnSandboxArgs = {
	role: Role
	slice: Slice
	branch: string
	sandboxIn: SandboxIn
}

export type Worktree = {
	readonly worktreePath: string
	close: () => Promise<unknown>
}

export type SpawnSandboxDeps = {
	prdId: string
	repoRoot: string
	createWorktree: (args: { branch: string }) => Promise<Worktree>
	runAgent: (args: { worktree: Worktree; logPath: string; role: Role; branch: string }) => Promise<{ commits: number }>
	randId: () => string
}

export async function spawnSandbox(args: SpawnSandboxArgs, deps: SpawnSandboxDeps): Promise<SandboxOut> {
	const runId = deps.randId()
	const logPath = path.join(deps.repoRoot, '.trowel', 'logs', deps.prdId, `${args.slice.id}-${args.role}-${runId}.log`)
	const worktree = await deps.createWorktree({ branch: args.branch })
	try {
		const trowelDir = path.join(worktree.worktreePath, '.trowel')
		await mkdir(trowelDir, { recursive: true })
		await writeFile(path.join(trowelDir, 'sandbox-in.json'), JSON.stringify(args.sandboxIn))
		const agentResult = await deps.runAgent({ worktree, logPath, role: args.role, branch: args.branch })
		let rawOut: string | null = null
		try {
			rawOut = await readFile(path.join(trowelDir, 'sandbox-out.json'), 'utf8')
		} catch {
			rawOut = null
		}
		return parseVerdict(rawOut, args.role, agentResult.commits)
	} finally {
		await worktree.close()
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
		beforeEach(async () => {
			tmp = await mkdtemp(path.join(tmpdir(), 'trowel-sandbox-'))
		})
		afterEach(async () => {
			await rm(tmp, { recursive: true, force: true })
		})

		function makeFakeWorktree(wtPath: string, closeRecord?: string[]): Worktree {
			return {
				worktreePath: wtPath,
				close: async () => {
					closeRecord?.push(wtPath)
				},
			}
		}

		test('closes the worktree even when runAgent throws', async () => {
			const args = makeArgs()
			const closedPaths: string[] = []
			const wtPath = path.join(tmp, 'sandbox-wt')
			const deps: SpawnSandboxDeps = {
				prdId: '142',
				repoRoot: tmp,
				createWorktree: async () => {
					await mkdir(wtPath, { recursive: true })
					return makeFakeWorktree(wtPath, closedPaths)
				},
				runAgent: async () => {
					throw new Error('Docker died')
				},
				randId: () => 'r1',
			}
			await expect(spawnSandbox(args, deps)).rejects.toThrow(/Docker died/)
			expect(closedPaths).toEqual([wtPath])
		})

		test('missing sandbox-out.json coerces to partial verdict (via parseVerdict)', async () => {
			const args = makeArgs()
			const wtPath = path.join(tmp, 'sandbox-wt')
			const deps: SpawnSandboxDeps = {
				prdId: '142',
				repoRoot: tmp,
				createWorktree: async () => {
					await mkdir(wtPath, { recursive: true })
					return makeFakeWorktree(wtPath)
				},
				runAgent: async () => 
					// Agent exits without writing sandbox-out.json
					 ({ commits: 0 })
				,
				randId: () => 'r1',
			}
			const out = await spawnSandbox(args, deps)
			expect(out.verdict).toBe('partial')
			expect(out.notes).toMatch(/missing/i)
		})

		test('passes runAgent the Worktree handle returned by createWorktree', async () => {
			const args = makeArgs({ role: 'review' })
			const wtPath = path.join(tmp, 'sandcastle-managed-wt')
			let observedWorktreePath: string | null = null
			const deps: SpawnSandboxDeps = {
				prdId: '142',
				repoRoot: tmp,
				createWorktree: async () => {
					await mkdir(wtPath, { recursive: true })
					return makeFakeWorktree(wtPath)
				},
				runAgent: async ({ worktree }) => {
					observedWorktreePath = worktree.worktreePath
					await writeFile(path.join(worktree.worktreePath, '.trowel', 'sandbox-out.json'), JSON.stringify({ verdict: 'partial', notes: 'stop' }))
					return { commits: 0 }
				},
				randId: () => 'abc',
			}
			await spawnSandbox(args, deps)
			expect(observedWorktreePath).toBe(wtPath)
		})

		test('passes runAgent a logPath under <repoRoot>/.trowel/logs/<prdId>/ containing the slice id, role and runId', async () => {
			const args = makeArgs({ role: 'review' })
			const wtPath = path.join(tmp, 'sandbox-wt')
			let observedLogPath: string | null = null
			const deps: SpawnSandboxDeps = {
				prdId: '142',
				repoRoot: tmp,
				createWorktree: async () => {
					await mkdir(wtPath, { recursive: true })
					return makeFakeWorktree(wtPath)
				},
				runAgent: async ({ logPath, worktree }) => {
					observedLogPath = logPath
					await writeFile(path.join(worktree.worktreePath, '.trowel', 'sandbox-out.json'), JSON.stringify({ verdict: 'partial', notes: 'stop' }))
					return { commits: 0 }
				},
				randId: () => 'abc',
			}
			await spawnSandbox(args, deps)
			expect(observedLogPath).toBe(path.join(tmp, '.trowel', 'logs', '142', '145-review-abc.log'))
		})

		test('surfaces the commits count returned by runAgent on the parsed SandboxOut', async () => {
			const args = makeArgs()
			const wtPath = path.join(tmp, 'sandbox-wt')
			const deps: SpawnSandboxDeps = {
				prdId: '142',
				repoRoot: tmp,
				createWorktree: async () => {
					await mkdir(wtPath, { recursive: true })
					return makeFakeWorktree(wtPath)
				},
				runAgent: async ({ worktree }) => {
					await writeFile(path.join(worktree.worktreePath, '.trowel', 'sandbox-out.json'), JSON.stringify({ verdict: 'ready' }))
					return { commits: 5 }
				},
				randId: () => 'r1',
			}
			const out = await spawnSandbox(args, deps)
			expect(out.commits).toBe(5)
		})

		test('writes sandbox-in.json into the worktree, runs the agent, reads sandbox-out.json, returns parsed verdict', async () => {
			const args = makeArgs()
			let runAgentCalled = false
			let observedSandboxIn: SandboxIn | null = null
			const wtPath = path.join(tmp, 'sandbox-wt')
			const deps: SpawnSandboxDeps = {
				prdId: '142',
				repoRoot: tmp,
				createWorktree: async () => {
					await mkdir(wtPath, { recursive: true })
					return makeFakeWorktree(wtPath)
				},
				runAgent: async ({ worktree }) => {
					runAgentCalled = true
					// Read what the host wrote to sandbox-in.json
					const inRaw = await readFile(path.join(worktree.worktreePath, '.trowel', 'sandbox-in.json'), 'utf8')
					observedSandboxIn = JSON.parse(inRaw) as SandboxIn
					// Simulate the agent writing its verdict
					await writeFile(path.join(worktree.worktreePath, '.trowel', 'sandbox-out.json'), JSON.stringify({ verdict: 'ready' }))
					return { commits: 2 }
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
