import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

import { loadConfig } from '../config.ts'
import { loadPrompt } from '../prompts/load.ts'
import { getStorage, type StorageKind } from '../storages/registry.ts'
import type { Storage, StorageDeps } from '../storages/types.ts'
import { createGh } from '../utils/gh-ops.ts'
import { createRepoGit, type GitOps } from '../utils/git-ops.ts'
import { tryExec } from '../utils/shell.ts'
import { parseStartOut } from '../work/start-out.ts'

export type StartRuntime = {
	projectRoot: string
	storage: Storage
	git: GitOps
	startPromptText: string
	runInteractive: (opts: { promptText: string; cwd: string }) => Promise<void>
	readStartOut: () => Promise<string | null>
	preflight: () => Promise<string[]>
	stdout: (s: string) => void
}

export async function runStart(rt: StartRuntime): Promise<void> {
	const failures = await rt.preflight()
	if (failures.length > 0) {
		throw new Error(`preflight failed:\n${failures.map((f) => `  · ${f}`).join('\n')}`)
	}

	const backTo = await rt.git.currentBranch()
	let stashed = false
	let materialised = false

	try {
		await rt.runInteractive({ promptText: rt.startPromptText, cwd: rt.projectRoot })

		const raw = await rt.readStartOut()
		if (raw === null) {
			rt.stdout('PRD not created. Working tree has grill changes; review with `git status`, then `git checkout .` to discard or stash/commit to keep.\n')
			throw new Error('start-out.json missing — grill aborted')
		}

		const spec = parseStartOut(raw)

		if (!(await rt.git.isWorkingTreeClean())) {
			await rt.git.stashPush({ includeUntracked: true })
			stashed = true
		}

		const { id: prdId, branch } = await rt.storage.createPrd(spec.prd)
		materialised = true
		await rt.git.checkout(branch)
		if (stashed) {
			await rt.git.stashPop()
			stashed = false
		}

		const realIds: string[] = []
		for (const slice of spec.slices) {
			const created = await rt.storage.createSlice(prdId, { title: slice.title, body: slice.body, blockedBy: [] })
			realIds.push(created.id)
		}
		for (const [i, slice] of spec.slices.entries()) {
			await rt.storage.updateSlice(prdId, realIds[i]!, {
				blockedBy: slice.blockedBy.map((idx) => realIds[idx]!),
				readyForAgent: slice.readyForAgent,
			})
		}

		rt.stdout(`\nCreated PRD ${prdId}\n`)
		rt.stdout(`Branch: ${branch} (you are now on it)\n`)
		if (realIds.length > 0) {
			rt.stdout('Slices:\n')
			for (const [i, slice] of spec.slices.entries()) {
				rt.stdout(`  - ${realIds[i]} ${slice.title}\n`)
			}
		}
		rt.stdout('\nReview `git status` for uncommitted files (CONTEXT/ADR edits from the grill, and on file storage, the PRD/slice artifacts). Commit at your discretion.\n')
		rt.stdout(`\nNext: trowel work ${prdId}\n`)
	} catch (e) {
		if (!materialised) {
			if (backTo && (await rt.git.currentBranch()) !== backTo) await rt.git.checkout(backTo)
			if (stashed) await rt.git.stashPop()
		}
		throw e
	}
}

export async function start(opts: { storage?: string }): Promise<void> {
	const { config, projectRoot } = await loadConfig()
	if (!projectRoot) {
		process.stderr.write('trowel start: no project root found\n')
		process.exit(1)
	}

	const storageKind = (opts.storage as StorageKind | undefined) ?? config.storage
	const git = createRepoGit(projectRoot)
	const gh = createGh()
	const storageDeps: StorageDeps = {
		gh,
		repoRoot: projectRoot,
		projectRoot,
		prdsDir: path.resolve(projectRoot, config.docs.prdsDir),
		labels: config.labels,
		closeOptions: config.close,
		git,
	}
	const storage = getStorage(storageKind, storageDeps)
	const startOutPath = path.resolve(projectRoot, '.trowel', 'start-out.json')

	const rt: StartRuntime = {
		projectRoot,
		storage,
		git,
		startPromptText: await loadPrompt('start', {}),
		runInteractive: async ({ promptText, cwd }) => {
			const child = spawn('claude', ['--append-system-prompt', promptText], {
				cwd,
				env: process.env,
				stdio: 'inherit',
			})
			const code: number = await new Promise((resolve, reject) => {
				child.on('error', reject)
				child.on('exit', (c) => resolve(c ?? -1))
			})
			if (code !== 0) throw new Error(`claude exited with code ${code}`)
		},
		readStartOut: async () => {
			try {
				return await readFile(startOutPath, 'utf8')
			} catch (e) {
				if ((e as { code?: string }).code === 'ENOENT') return null
				throw e
			}
		},
		preflight: async () => {
			const failures: string[] = []
			if (!(await git.isWorkingTreeClean())) failures.push('working tree is not clean — commit or stash before running trowel start')
			const claudeR = await tryExec('claude', ['--version'])
			if (!claudeR.ok) failures.push('claude CLI not found on PATH (required for trowel start)')
			const ghR = await tryExec('gh', ['auth', 'status'])
			if (!ghR.ok) failures.push('gh not authenticated or not on PATH (run `gh auth login`)')
			return failures
		},
		stdout: (s) => process.stdout.write(s),
	}

	try {
		await runStart(rt)
	} catch (error) {
		process.stderr.write(`trowel start: ${(error as Error).message}\n`)
		process.exit(1)
	}
}

if (import.meta.vitest) {
	const { describe, test, expect } = import.meta.vitest
	const { runStart } = await import('./start.ts')
	const { makeFakes } = await import('./start.test-utils.ts')

	describe('runStart: missing start-out.json (claude aborted)', () => {
		test('prints recovery message, restores BACK_TO, throws', async () => {
			const { rt, calls, gitState } = makeFakes({
				startOut: null,
				currentBranch: 'main',
			})
			await expect(runStart(rt)).rejects.toThrow(/start-out.json missing/i)
			expect(calls.stdout.join('')).toMatch(/git status/i)
			expect(calls.createPrd).toEqual([])
			expect(gitState.current).toBe('main')
		})

		test('restores BACK_TO even if claude left the user on a different branch', async () => {
			const { rt, gitState } = makeFakes({ startOut: null, currentBranch: 'main' })
			rt.runInteractive = async () => {
				gitState.current = 'somewhere-else'
			}
			await expect(runStart(rt)).rejects.toThrow()
			expect(gitState.current).toBe('main')
		})
	})

	describe('runStart: invalid start-out.json', () => {
		test('schema violation (missing prd) → re-raises validation error, BACK_TO restored, no createPrd', async () => {
			const bad = JSON.stringify({ slices: [] })
			const { rt, calls, gitState } = makeFakes({ startOut: bad, currentBranch: 'main' })
			await expect(runStart(rt)).rejects.toThrow(/Invalid start-out\.json/)
			expect(calls.createPrd).toEqual([])
			expect(gitState.current).toBe('main')
		})

		test('blockedBy cycle → re-raises, no createPrd, BACK_TO restored', async () => {
			const cyclic = JSON.stringify({
				prd: { title: 't', body: 'b' },
				slices: [
					{ title: 'A', body: 'b', blockedBy: [1], readyForAgent: true },
					{ title: 'B', body: 'b', blockedBy: [0], readyForAgent: true },
				],
			})
			const { rt, calls, gitState } = makeFakes({ startOut: cyclic, currentBranch: 'main' })
			await expect(runStart(rt)).rejects.toThrow(/cycle/i)
			expect(calls.createPrd).toEqual([])
			expect(gitState.current).toBe('main')
		})
	})

	describe('runStart: stash dance', () => {
		test('dirty tree → stashPush before createPrd, then checkout integration, then stashPop (in that order)', async () => {
			const startOut = JSON.stringify({
				prd: { title: 't', body: 'b' },
				slices: [{ title: 'A', body: 'b', blockedBy: [], readyForAgent: true }],
			})
			const { rt, calls } = makeFakes({
				startOut,
				createPrdResult: { id: 'pid', branch: 'pid-branch' },
				createSliceIds: ['s1'],
				currentBranch: 'main',
				cleanTree: false,
			})
			await runStart(rt)
			expect(calls.git).toEqual(['stashPush', 'checkout(pid-branch)', 'stashPop'])
		})

		test('clean tree → no stashPush/stashPop, just checkout', async () => {
			const startOut = JSON.stringify({
				prd: { title: 't', body: 'b' },
				slices: [{ title: 'A', body: 'b', blockedBy: [], readyForAgent: true }],
			})
			const { rt, calls } = makeFakes({
				startOut,
				createPrdResult: { id: 'pid', branch: 'pid-branch' },
				createSliceIds: ['s1'],
				currentBranch: 'main',
				cleanTree: true,
			})
			await runStart(rt)
			expect(calls.git).toEqual(['checkout(pid-branch)'])
		})
	})

	describe('runStart: stash-pop conflict', () => {
		test('stashPop throws → user stays on integration branch (no restore), error surfaces', async () => {
			const startOut = JSON.stringify({
				prd: { title: 't', body: 'b' },
				slices: [{ title: 'A', body: 'b', blockedBy: [], readyForAgent: true }],
			})
			const { rt, gitState } = makeFakes({
				startOut,
				createPrdResult: { id: 'pid', branch: 'pid-branch' },
				createSliceIds: ['s1'],
				currentBranch: 'main',
				cleanTree: false,
				stashPopThrows: new Error('CONFLICT (content): Merge conflict in CONTEXT.md'),
			})
			await expect(runStart(rt)).rejects.toThrow(/conflict/i)
			expect(gitState.current).toBe('pid-branch')
		})
	})

	describe('runStart: createPrd fails after stash', () => {
		test('storage.createPrd throws while stashed → stash popped on BACK_TO, BACK_TO restored, error re-raised', async () => {
			const startOut = JSON.stringify({
				prd: { title: 't', body: 'b' },
				slices: [{ title: 'A', body: 'b', blockedBy: [], readyForAgent: true }],
			})
			const { rt, calls, gitState } = makeFakes({
				startOut,
				currentBranch: 'main',
				cleanTree: false,
				createPrdThrows: new Error('GitHub API down'),
			})
			await expect(runStart(rt)).rejects.toThrow(/GitHub API down/)
			// stash was pushed; createPrd failed; stash must be popped back on the original branch
			expect(calls.git).toEqual(['stashPush', 'stashPop'])
			expect(gitState.current).toBe('main')
			expect(gitState.stashStack).toBe(0)
		})
	})

	describe('runStart: preflight short-circuit', () => {
		test('preflight failures → throws before claude is launched; no createPrd', async () => {
			const { rt, calls } = makeFakes({
				startOut: null,
				preflightFailures: ['working tree dirty', 'gh not authenticated'],
			})
			let claudeRan = false
			rt.runInteractive = async () => { claudeRan = true }
			await expect(runStart(rt)).rejects.toThrow(/working tree dirty[\s\S]*gh not authenticated/i)
			expect(claudeRan).toBe(false)
			expect(calls.createPrd).toEqual([])
		})
	})

	describe('runStart: summary', () => {
		test('prints PRD id, integration branch, slice ids, and a commit-reminder hint after success', async () => {
			const startOut = JSON.stringify({
				prd: { title: 'Rename Foo', body: 'b' },
				slices: [
					{ title: 'A', body: 'b', blockedBy: [], readyForAgent: true },
					{ title: 'B', body: 'b', blockedBy: [0], readyForAgent: true },
				],
			})
			const { rt, calls } = makeFakes({
				startOut,
				createPrdResult: { id: 'abc123', branch: 'abc123-rename-foo' },
				createSliceIds: ['s1', 's2'],
				currentBranch: 'main',
			})
			await runStart(rt)
			const out = calls.stdout.join('')
			expect(out).toMatch(/abc123/)
			expect(out).toMatch(/abc123-rename-foo/)
			expect(out).toMatch(/s1/)
			expect(out).toMatch(/s2/)
			expect(out).toMatch(/trowel work abc123/)
			expect(out).toMatch(/commit/i)
		})
	})

	describe('runStart: happy path', () => {
		test('claude writes valid 2-slice spec → createPrd + 2× createSlice + 2× updateSlice with resolved blockedBy and readyForAgent', async () => {
			const startOutJson = JSON.stringify({
				prd: { title: 'Rename Foo', body: 'spec body' },
				slices: [
					{ title: 'Rename type', body: 'a', blockedBy: [], readyForAgent: true },
					{ title: 'Update callsites', body: 'b', blockedBy: [0], readyForAgent: false },
				],
			})
			const { rt, calls, gitState } = makeFakes({
				startOut: startOutJson,
				createPrdResult: { id: 'abc123', branch: 'abc123-rename-foo' },
				createSliceIds: ['slice-a', 'slice-b'],
				currentBranch: 'main',
			})

			await runStart(rt)

			expect(calls.createPrd).toEqual([{ title: 'Rename Foo', body: 'spec body' }])
			expect(calls.createSlice).toEqual([
				{ prdId: 'abc123', spec: { title: 'Rename type', body: 'a', blockedBy: [] } },
				{ prdId: 'abc123', spec: { title: 'Update callsites', body: 'b', blockedBy: [] } },
			])
			expect(calls.updateSlice).toEqual([
				{ prdId: 'abc123', sliceId: 'slice-a', patch: { blockedBy: [], readyForAgent: true } },
				{ prdId: 'abc123', sliceId: 'slice-b', patch: { blockedBy: ['slice-a'], readyForAgent: false } },
			])
			expect(gitState.current).toBe('abc123-rename-foo')
		})
	})
}
