import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'

import type { Role } from './prompts.ts'
import { parseVerdict, type TurnIn, type TurnOut } from './verdict.ts'
import { ensureWorktree, resetWorktree, type TurnWorktree } from './worktrees.ts'
import type { Slice } from '../storages/types.ts'
import type { GitOps } from '../utils/git-ops.ts'

export type SpawnTurnArgs = {
	role: Role
	slice: Slice
	branch: string
	turnIn: TurnIn
}

export type SpawnTurnDeps = {
	prdId: string
	projectRoot: string
	copyToWorktree: string[]
	git: GitOps
	runAgent: (args: { worktree: TurnWorktree; logPath: string; role: Role; branch: string }) => Promise<{ commits: number }>
	randId: () => string
	log?: (m: string) => void
}

export async function spawnTurn(args: SpawnTurnArgs, deps: SpawnTurnDeps): Promise<TurnOut> {
	const runId = deps.randId()
	const logPath = path.join(deps.projectRoot, '.trowel', 'logs', deps.prdId, `${args.slice.id}-${args.role}-${runId}.log`)

	const worktree = await ensureWorktree({
		prdId: deps.prdId,
		branch: args.branch,
		projectRoot: deps.projectRoot,
		copyToWorktree: deps.copyToWorktree,
		git: deps.git,
		log: deps.log,
	})
	await resetWorktree(worktree, deps.git)

	const trowelDir = path.join(worktree.worktreePath, '.trowel')
	await mkdir(trowelDir, { recursive: true })
	// Wipe any stale turn-out.json from a prior Turn on this same worktree.
	// `resetWorktree` does `git clean -fd` which preserves gitignored files; if the user has
	// `.trowel/` in their project's .gitignore (common), a stale verdict would be read here.
	try {
		await unlink(path.join(trowelDir, 'turn-out.json'))
	} catch (e) {
		if ((e as { code?: string }).code !== 'ENOENT') throw e
	}
	await writeFile(path.join(trowelDir, 'turn-in.json'), JSON.stringify(args.turnIn))

	const agentResult = await deps.runAgent({ worktree, logPath, role: args.role, branch: args.branch })

	let rawOut: string | null = null
	try {
		rawOut = await readFile(path.join(trowelDir, 'turn-out.json'), 'utf8')
	} catch {
		rawOut = null
	}
	return parseVerdict(rawOut, args.role, agentResult.commits)
}

if (import.meta.vitest) {
	const { describe, test, expect, beforeEach, afterEach } = import.meta.vitest
	const { createRepoGit } = await import('../utils/git-ops.ts')
	const { setupTestRepo } = await import('../test-utils/git-repo.ts')
	const { stat } = await import('node:fs/promises')

	function makeArgs(overrides: Partial<SpawnTurnArgs> = {}): SpawnTurnArgs {
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
			branch: 'feature',
			turnIn: { slice: { id: slice.id, title: slice.title, body: slice.body } },
			...overrides,
		}
	}

	describe('spawnTurn (persistent worktree, host-mode)', () => {
		let projectRoot: string
		let git: GitOps
		let cleanupRepo: () => Promise<void>

		beforeEach(async () => {
			const r = await setupTestRepo({ prefix: 'trowel-spawnturn-', branches: ['feature'] })
			projectRoot = r.root
			cleanupRepo = r.cleanup
			git = createRepoGit(projectRoot)
		})
		afterEach(async () => {
			if (cleanupRepo) await cleanupRepo()
		})

		test('writes turn-in.json into the worktree and reads turn-out.json into the parsed verdict', async () => {
			let observedTurnIn: TurnIn | null = null
			const args = makeArgs()
			const deps: SpawnTurnDeps = {
				prdId: '142',
				projectRoot,
				copyToWorktree: [],
				git,
				runAgent: async ({ worktree }) => {
					const inRaw = await readFile(path.join(worktree.worktreePath, '.trowel', 'turn-in.json'), 'utf8')
					observedTurnIn = JSON.parse(inRaw) as TurnIn
					await writeFile(path.join(worktree.worktreePath, '.trowel', 'turn-out.json'), JSON.stringify({ verdict: 'ready' }))
					return { commits: 2 }
				},
				randId: () => 'r1',
			}

			const out = await spawnTurn(args, deps)
			expect(observedTurnIn).toEqual(args.turnIn)
			expect(out.verdict).toBe('ready')
			expect(out.commits).toBe(2)
		})

		test('wipes a stale turn-out.json from a prior Turn even when .trowel/ is gitignored (so git clean -fd preserves it)', async () => {
			// Simulate a user project where .trowel/ is gitignored — common, since trowel writes
			// ephemeral state there. This means git clean -fd in resetWorktree does NOT remove
			// stale turn-out.json between Turns; spawnTurn must explicitly unlink it.
			await writeFile(path.join(projectRoot, '.gitignore'), '.trowel/\n')
			const { exec } = await import('node:child_process')
			await new Promise<void>((res, rej) => exec('git add .gitignore && git commit -m "ignore trowel"', { cwd: projectRoot }, (err) => err ? rej(err) : res()))
			await new Promise<void>((res, rej) => exec('git checkout feature && git merge main --no-edit && git checkout main', { cwd: projectRoot }, (err) => err ? rej(err) : res()))

			// First turn: agent writes a valid ready verdict
			const firstDeps: SpawnTurnDeps = {
				prdId: '142',
				projectRoot,
				copyToWorktree: [],
				git,
				runAgent: async ({ worktree }) => {
					await writeFile(path.join(worktree.worktreePath, '.trowel', 'turn-out.json'), JSON.stringify({ verdict: 'ready' }))
					return { commits: 1 }
				},
				randId: () => 'first',
			}
			const first = await spawnTurn(makeArgs(), firstDeps)
			expect(first.verdict).toBe('ready')

			// Second turn against the SAME worktree: agent doesn't write a turn-out.json this time
			// (simulates a crash mid-Turn). Without the pre-Turn unlink, the stale 'ready' from
			// the prior Turn would be read and accepted as the current verdict — silent bug.
			const secondDeps: SpawnTurnDeps = {
				prdId: '142',
				projectRoot,
				copyToWorktree: [],
				git,
				runAgent: async () => ({ commits: 0 }),
				randId: () => 'second',
			}
			await expect(spawnTurn(makeArgs(), secondDeps)).rejects.toThrow(/verdict file missing/i)
		})

		test('lets parseVerdict throw bubble when turn-out.json is missing (no coercion to partial)', async () => {
			const deps: SpawnTurnDeps = {
				prdId: '142',
				projectRoot,
				copyToWorktree: [],
				git,
				runAgent: async () => ({ commits: 0 }),
				randId: () => 'r1',
			}
			await expect(spawnTurn(makeArgs(), deps)).rejects.toThrow(/verdict file missing/i)
		})

		test('logPath is under <projectRoot>/.trowel/logs/<prdId>/ containing slice id, role and runId', async () => {
			let observedLogPath: string | null = null
			const deps: SpawnTurnDeps = {
				prdId: '142',
				projectRoot,
				copyToWorktree: [],
				git,
				runAgent: async ({ logPath, worktree }) => {
					observedLogPath = logPath
					await writeFile(path.join(worktree.worktreePath, '.trowel', 'turn-out.json'), JSON.stringify({ verdict: 'partial', notes: 'stop' }))
					return { commits: 0 }
				},
				randId: () => 'abc',
			}
			await spawnTurn(makeArgs({ role: 'review' }), deps)
			expect(observedLogPath).toBe(path.join(projectRoot, '.trowel', 'logs', '142', '145-review-abc.log'))
		})

		test('passes runAgent a TurnWorktree handle pointing at the persistent worktree path', async () => {
			let observedWorktreePath: string | null = null
			const deps: SpawnTurnDeps = {
				prdId: '142',
				projectRoot,
				copyToWorktree: [],
				git,
				runAgent: async ({ worktree }) => {
					observedWorktreePath = worktree.worktreePath
					await writeFile(path.join(worktree.worktreePath, '.trowel', 'turn-out.json'), JSON.stringify({ verdict: 'partial', notes: 'stop' }))
					return { commits: 0 }
				},
				randId: () => 'r1',
			}
			await spawnTurn(makeArgs(), deps)
			expect(observedWorktreePath).toBe(path.join(projectRoot, '.trowel', 'worktrees', '142', 'feature'))
			const s = await stat(observedWorktreePath!)
			expect(s.isDirectory()).toBe(true)
		})

		test('resets the worktree between turns (uncommitted file from a prior turn is gone)', async () => {
			const deps: SpawnTurnDeps = {
				prdId: '142',
				projectRoot,
				copyToWorktree: [],
				git,
				runAgent: async ({ worktree }) => {
					await writeFile(path.join(worktree.worktreePath, 'leftover.txt'), 'from prior turn\n')
					await writeFile(path.join(worktree.worktreePath, '.trowel', 'turn-out.json'), JSON.stringify({ verdict: 'ready' }))
					return { commits: 1 }
				},
				randId: () => 'r1',
			}
			await spawnTurn(makeArgs(), deps)

			// Second turn: the prior turn's leftover.txt must be cleaned up before runAgent fires.
			let leftoverSeen = true
			const deps2: SpawnTurnDeps = {
				...deps,
				runAgent: async ({ worktree }) => {
					leftoverSeen = await stat(path.join(worktree.worktreePath, 'leftover.txt')).then(() => true, () => false)
					await writeFile(path.join(worktree.worktreePath, '.trowel', 'turn-out.json'), JSON.stringify({ verdict: 'ready' }))
					return { commits: 1 }
				},
			}
			await spawnTurn(makeArgs(), deps2)
			expect(leftoverSeen).toBe(false)
		})

		test('reuses the same worktree across turns (no second checkout)', async () => {
			const deps: SpawnTurnDeps = {
				prdId: '142',
				projectRoot,
				copyToWorktree: [],
				git,
				runAgent: async ({ worktree }) => {
					await writeFile(path.join(worktree.worktreePath, '.trowel', 'turn-out.json'), JSON.stringify({ verdict: 'ready' }))
					return { commits: 1 }
				},
				randId: () => 'r1',
			}
			await spawnTurn(makeArgs(), deps)
			await spawnTurn(makeArgs(), deps)
			const wts = (await git.worktreeList()).filter((w) => w.path.includes('worktrees'))
			expect(wts).toHaveLength(1)
		})
	})
}
