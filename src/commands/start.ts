import path from 'node:path'

import { resolveGrillSpec } from './grill-flow.ts'
import { buildGrillCommandRuntime, exitOnCommandError } from './runtime.ts'
import type { Storage } from '../storages/types.ts'
import type { GitOps } from '../utils/git-ops.ts'
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
	confirm: (msg: string) => Promise<boolean>
}

export async function runStart(rt: StartRuntime): Promise<void> {
	const result = await resolveGrillSpec({
		projectRoot: rt.projectRoot,
		git: rt.git,
		readOut: rt.readStartOut,
		preflight: rt.preflight,
		stdout: rt.stdout,
		confirm: rt.confirm,
		parseOut: parseStartOut,
		printResumePreview: (spec) => printResumePreview(rt, spec),
		runInteractive: () => rt.runInteractive({ promptText: rt.startPromptText, cwd: rt.projectRoot }),
		missingOutMessage: 'PRD not created. Working tree has grill changes; review with `git status`, then `git checkout .` to discard or stash/commit to keep.\n',
		missingOutError: 'start-out.json missing — grill aborted',
		resumePrompt: 'Continue with the spec above? (no → discard and start a fresh grill)',
		invalidPrompt: 'Discard the invalid file and start a fresh grill? (no → abort)',
		outFileName: 'start-out.json',
	})

	try {
		const { id: prdId, branch } = await rt.storage.createPrd({ ...result.spec.prd, targetBranch: result.targetBranch })
		result.markMaterialised()
		await rt.git.checkout(branch)
		if (result.stashed) await rt.git.stashPop()

		const realIds: string[] = []
		for (const slice of result.spec.slices) {
			const created = await rt.storage.createSlice(prdId, { title: slice.title, body: slice.body, blockedBy: [] })
			realIds.push(created.id)
		}
		for (const [i, slice] of result.spec.slices.entries()) {
			await rt.storage.updateSlice(prdId, realIds[i]!, {
				blockedBy: slice.blockedBy.map((idx) => realIds[idx]!),
				readyForAgent: slice.readyForAgent,
			})
		}

		rt.stdout(`\nCreated PRD ${prdId}\n`)
		rt.stdout(`Branch: ${branch} (you are now on it)\n`)
		if (realIds.length > 0) {
			rt.stdout('Slices:\n')
			for (const [i, slice] of result.spec.slices.entries()) {
				rt.stdout(`  - ${realIds[i]} ${slice.title}\n`)
			}
		}
		rt.stdout('\nReview `git status` for uncommitted files (CONTEXT/ADR edits from the grill, and on file storage, the PRD/slice artifacts). Commit at your discretion.\n')
		rt.stdout(`\nNext: trowel work ${prdId}\n`)

		await result.clearOut()
	} catch (e) {
		await result.recover()
		throw e
	}
}

function printResumePreview(rt: StartRuntime, spec: ReturnType<typeof parseStartOut>): void {
	rt.stdout('\nFound existing .trowel/start-out.json from a prior run:\n')
	rt.stdout(`\n# ${spec.prd.title}\n\n${spec.prd.body}\n`)
	if (spec.slices.length > 0) {
		rt.stdout('\nSlices:\n')
		for (const [i, slice] of spec.slices.entries()) {
			const ready = slice.readyForAgent ? 'AFK' : 'HITL'
			const blocks = slice.blockedBy.length > 0 ? ` blocked by [${slice.blockedBy.join(', ')}]` : ''
			rt.stdout(`  ${i}. ${slice.title}  (${ready}${blocks})\n`)
		}
	}
	rt.stdout('\n')
}

export async function start(opts: { storage?: string; harness?: string }): Promise<void> {
	const rtBase = await buildGrillCommandRuntime('start', opts, 'start-out.json')
	await exitOnCommandError('start', () => runStart({
		projectRoot: rtBase.projectRoot,
		storage: rtBase.storage,
		git: rtBase.git,
		startPromptText: rtBase.promptText,
		runInteractive: rtBase.runInteractive,
		readStartOut: rtBase.readOut,
		preflight: rtBase.preflight,
		stdout: rtBase.stdout,
		confirm: rtBase.confirm,
	}))
}

if (import.meta.vitest) {
	const { describe, test, expect } = import.meta.vitest
	const { runStart } = await import('./start.ts')
	const { makeFakes } = await import('./start.test-utils.ts')
	const { mkdtemp, mkdir, writeFile, readFile, rm, stat } = await import('node:fs/promises')
	const { tmpdir } = await import('node:os')

	async function setupTmp(): Promise<{ projectRoot: string; startOutPath: string; cleanup: () => Promise<void> }> {
		const projectRoot = await mkdtemp(path.join(tmpdir(), 'trowel-start-cleanup-'))
		await mkdir(path.join(projectRoot, '.trowel'), { recursive: true })
		const startOutPath = path.join(projectRoot, '.trowel', 'start-out.json')
		return { projectRoot, startOutPath, cleanup: () => rm(projectRoot, { recursive: true, force: true }) }
	}

	async function fileExists(p: string): Promise<boolean> {
		try {
			await stat(p)
			return true
		} catch {
			return false
		}
	}

	async function readStartOutFile(startOutPath: string): Promise<string | null> {
		try {
			return await readFile(startOutPath, 'utf8')
		} catch {
			return null
		}
	}

	function attachStartOutFile(rt: StartRuntime, tmp: { projectRoot: string; startOutPath: string }): void {
		rt.projectRoot = tmp.projectRoot
		rt.readStartOut = () => readStartOutFile(tmp.startOutPath)
	}

	function resumeSpec() {
		return {
			prd: { title: 'Resume Me', body: 'body from prior run' },
			slices: [{ title: 'A', body: 'a', blockedBy: [], readyForAgent: true }],
		}
	}

	function minimalStartOutJson(): string {
		return JSON.stringify({
			prd: { title: 't', body: 'b' },
			slices: [{ title: 'A', body: 'b', blockedBy: [], readyForAgent: true }],
		})
	}

	async function writeStartOut(tmp: { startOutPath: string }, spec = resumeSpec()): Promise<void> {
		await writeFile(tmp.startOutPath, JSON.stringify(spec))
	}

	function makeAttachedFakes(tmp: { projectRoot: string; startOutPath: string }, opts: Parameters<typeof makeFakes>[0]) {
		const fakes = makeFakes(opts)
		attachStartOutFile(fakes.rt, tmp)
		return fakes
	}

	async function expectRunStartRejectsWithoutCreate(startOut: string, error: RegExp): Promise<void> {
		const { rt, calls, gitState } = makeFakes({ startOut, currentBranch: 'main' })
		await expect(runStart(rt)).rejects.toThrow(error)
		expect(calls.createPrd).toEqual([])
		expect(gitState.current).toBe('main')
	}

	async function expectAttachedStartOutAbort(tmp: { projectRoot: string; startOutPath: string }, opts: Parameters<typeof makeFakes>[0], error: RegExp): Promise<void> {
		const { rt, calls } = makeAttachedFakes(tmp, opts)
		let interactiveCalled = false
		rt.runInteractive = async () => { interactiveCalled = true }
		rt.confirm = async () => false
		await expect(runStart(rt)).rejects.toThrow(error)
		expect(interactiveCalled).toBe(false)
		expect(calls.createPrd).toEqual([])
		expect(await fileExists(tmp.startOutPath)).toBe(true)
	}

	describe('runStart: existing start-out.json offers resume', () => {
		test('valid existing spec + user picks skip → stale file wiped, claude runs fresh grill, new spec materialised', async () => {
			const tmp = await setupTmp()
			try {
				const staleSpec = {
					prd: { title: 'STALE', body: 'old' },
					slices: [{ title: 'old-slice', body: 'x', blockedBy: [], readyForAgent: true }],
				}
				await writeFile(tmp.startOutPath, JSON.stringify(staleSpec))

				const freshSpec = {
					prd: { title: 'FRESH', body: 'new' },
					slices: [{ title: 'new-slice', body: 'y', blockedBy: [], readyForAgent: true }],
				}

				const { rt, calls } = makeFakes({
					startOut: null,
					createPrdResult: { id: 'pid', branch: 'pid-branch' },
					createSliceIds: ['s1'],
					currentBranch: 'main',
				})
				attachStartOutFile(rt, tmp)
				let stalePresentAtRunInteractive: boolean | null = null
				rt.runInteractive = async () => {
					stalePresentAtRunInteractive = await fileExists(tmp.startOutPath)
					await writeFile(tmp.startOutPath, JSON.stringify(freshSpec))
				}
				rt.confirm = async () => false // skip

				await runStart(rt)

				expect(stalePresentAtRunInteractive).toBe(false)
				expect(calls.createPrd).toEqual([{ title: 'FRESH', body: 'new', targetBranch: 'main' }])
			} finally {
				await tmp.cleanup()
			}
		})

		test('invalid existing spec + user confirms wipe → file wiped, claude runs fresh grill', async () => {
			const tmp = await setupTmp()
			try {
				await writeFile(tmp.startOutPath, JSON.stringify({ slices: [] })) // missing prd

				const freshSpec = {
					prd: { title: 'FRESH', body: 'new' },
					slices: [{ title: 'x', body: 'y', blockedBy: [], readyForAgent: true }],
				}

				const { rt, calls } = makeFakes({
					startOut: null,
					createPrdResult: { id: 'pid', branch: 'pid-branch' },
					createSliceIds: ['s1'],
					currentBranch: 'main',
				})
				attachStartOutFile(rt, tmp)
				let interactiveCalled = false
				rt.runInteractive = async () => {
					interactiveCalled = true
					await writeFile(tmp.startOutPath, JSON.stringify(freshSpec))
				}
				rt.confirm = async () => true // wipe and start fresh

				await runStart(rt)

				expect(interactiveCalled).toBe(true)
				expect(calls.createPrd).toEqual([{ title: 'FRESH', body: 'new', targetBranch: 'main' }])
				expect(calls.stdout.join('')).toMatch(/invalid/i)
			} finally {
				await tmp.cleanup()
			}
		})

		test('invalid existing spec + user declines wipe → runStart throws with validation error, file persists', async () => {
			const tmp = await setupTmp()
			try {
				await writeFile(tmp.startOutPath, JSON.stringify({ slices: [] })) // missing prd

				await expectAttachedStartOutAbort(tmp, { startOut: null, currentBranch: 'main' }, /Invalid start-out\.json/)
			} finally {
				await tmp.cleanup()
			}
		})

		test('preview prints PRD title, PRD body, and a slice row per slice before the confirm prompt', async () => {
			const tmp = await setupTmp()
			try {
				const spec = {
					prd: { title: 'Resume Me', body: 'long body content goes here' },
					slices: [
						{ title: 'first slice', body: 'a', blockedBy: [], readyForAgent: true },
						{ title: 'second slice', body: 'b', blockedBy: [0], readyForAgent: false },
					],
				}
				await writeFile(tmp.startOutPath, JSON.stringify(spec))

				const { rt, calls } = makeFakes({
					startOut: null,
					currentBranch: 'main',
				})
				attachStartOutFile(rt, tmp)
				let stdoutAtConfirm = ''
				rt.confirm = async () => {
					stdoutAtConfirm = calls.stdout.join('')
					return false // skip — short-circuits the rest of the flow
				}
				// Don't actually run claude on the skip path
				rt.runInteractive = async () => {}

				await expect(runStart(rt)).rejects.toThrow() // claude wrote nothing → missing start-out

				expect(stdoutAtConfirm).toContain('Resume Me')
				expect(stdoutAtConfirm).toContain('long body content goes here')
				expect(stdoutAtConfirm).toContain('first slice')
				expect(stdoutAtConfirm).toContain('second slice')
				expect(stdoutAtConfirm).toMatch(/AFK/)
				expect(stdoutAtConfirm).toMatch(/HITL/)
			} finally {
				await tmp.cleanup()
			}
		})

		test('valid existing spec + user confirms continue → claude is skipped, materialisation runs from in-memory spec, file is gone after', async () => {
			const tmp = await setupTmp()
			try {
				await writeStartOut(tmp)

				const { rt, calls } = makeAttachedFakes(tmp, {
					startOut: null, // not used — readStartOut overridden below
					createPrdResult: { id: 'pid', branch: 'pid-branch' },
					createSliceIds: ['s1'],
					currentBranch: 'main',
				})
				let interactiveCalls = 0
				rt.runInteractive = async () => { interactiveCalls++ }
				rt.confirm = async () => true // continue

				await runStart(rt)

				expect(interactiveCalls).toBe(0)
				expect(calls.createPrd).toEqual([{ title: 'Resume Me', body: 'body from prior run', targetBranch: 'main' }])
				expect(calls.createSlice).toHaveLength(1)
				expect(await fileExists(tmp.startOutPath)).toBe(false)
			} finally {
				await tmp.cleanup()
			}
		})

		test('valid existing spec + user confirms continue + preflight would fail → skips preflight and materialises', async () => {
			const tmp = await setupTmp()
			try {
				await writeStartOut(tmp)

				const { rt, calls } = makeAttachedFakes(tmp, {
					startOut: null,
					createPrdResult: { id: 'pid', branch: 'pid-branch' },
					createSliceIds: ['s1'],
					currentBranch: 'main',
					preflightFailures: ['working tree dirty'],
				})
				let interactiveCalled = false
				rt.runInteractive = async () => { interactiveCalled = true }
				rt.confirm = async () => true // continue

				await runStart(rt)

				expect(interactiveCalled).toBe(false)
				expect(calls.createPrd).toEqual([{ title: 'Resume Me', body: 'body from prior run', targetBranch: 'main' }])
				expect(await fileExists(tmp.startOutPath)).toBe(false)
			} finally {
				await tmp.cleanup()
			}
		})

		test('valid existing spec + user starts fresh + preflight fails → stale start-out.json is not cleaned up yet', async () => {
			const tmp = await setupTmp()
			try {
				const spec = {
					prd: { title: 'STALE', body: 'old' },
					slices: [{ title: 'old-slice', body: 'x', blockedBy: [], readyForAgent: true }],
				}
				await writeFile(tmp.startOutPath, JSON.stringify(spec))

				await expectAttachedStartOutAbort(tmp, { startOut: null, currentBranch: 'main', preflightFailures: ['working tree dirty'] }, /preflight failed/i)
			} finally {
				await tmp.cleanup()
			}
		})
	})

	describe('runStart: start-out.json lifecycle (real filesystem)', () => {
		test('pre-grill wipe — stale file from a prior run is gone before claude runs and is not re-read', async () => {
			const tmp = await setupTmp()
			try {
				// Stale file left behind by a prior aborted run
				await writeFile(tmp.startOutPath, JSON.stringify({
					prd: { title: 'STALE', body: 'should-not-be-read' },
					slices: [],
				}))

				const { rt, calls } = makeFakes({
					startOut: null,
					currentBranch: 'main',
				})
				attachStartOutFile(rt, tmp)
				let stalePresentAtRunInteractive: boolean | null = null
				rt.runInteractive = async () => {
					stalePresentAtRunInteractive = await fileExists(tmp.startOutPath)
					// Claude aborts: doesn't write a new file
				}

				await expect(runStart(rt)).rejects.toThrow(/start-out.json missing/i)
				expect(stalePresentAtRunInteractive).toBe(false)
				expect(calls.createPrd).toEqual([])
				expect(await fileExists(tmp.startOutPath)).toBe(false)
			} finally {
				await tmp.cleanup()
			}
		})

		test('failure path (invalid spec) leaves start-out.json on disk for inspection', async () => {
			const tmp = await setupTmp()
			try {
				const invalid = JSON.stringify({ slices: [] }) // missing prd
				const { rt } = makeFakes({ startOut: invalid, currentBranch: 'main' })
				attachStartOutFile(rt, tmp)
				rt.runInteractive = async () => {
					await writeFile(tmp.startOutPath, invalid)
				}
				await expect(runStart(rt)).rejects.toThrow(/Invalid start-out\.json/)
				expect(await fileExists(tmp.startOutPath)).toBe(true)
			} finally {
				await tmp.cleanup()
			}
		})

		test('success path deletes start-out.json after the summary print', async () => {
			const tmp = await setupTmp()
			try {
				const spec = {
					prd: { title: 'T', body: 'B' },
					slices: [{ title: 'S', body: 'B', blockedBy: [], readyForAgent: true }],
				}
				const { rt } = makeFakes({
					startOut: JSON.stringify(spec),
					createPrdResult: { id: 'pid', branch: 'pid-branch' },
					createSliceIds: ['s1'],
					currentBranch: 'main',
				})
				attachStartOutFile(rt, tmp)
				rt.runInteractive = async () => {
					await writeFile(tmp.startOutPath, JSON.stringify(spec))
				}
				await runStart(rt)
				expect(await fileExists(tmp.startOutPath)).toBe(false)
			} finally {
				await tmp.cleanup()
			}
		})
	})

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
			await expectRunStartRejectsWithoutCreate(JSON.stringify({ slices: [] }), /Invalid start-out\.json/)
		})

		test('blockedBy cycle → re-raises, no createPrd, BACK_TO restored', async () => {
			const cyclic = JSON.stringify({
				prd: { title: 't', body: 'b' },
				slices: [
					{ title: 'A', body: 'b', blockedBy: [1], readyForAgent: true },
					{ title: 'B', body: 'b', blockedBy: [0], readyForAgent: true },
				],
			})
			await expectRunStartRejectsWithoutCreate(cyclic, /cycle/i)
		})
	})

	describe('runStart: stash dance', () => {
		test('dirty tree → stashPush before createPrd, then checkout integration, then stashPop (in that order)', async () => {
			const startOut = minimalStartOutJson()
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
			const startOut = minimalStartOutJson()
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
			const startOut = minimalStartOutJson()
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
			const startOut = minimalStartOutJson()
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
		test('passes the invocation branch as the PRD target branch', async () => {
			const startOutJson = JSON.stringify({
				prd: { title: 'Target Develop', body: 'spec body' },
				slices: [],
			})
			const { rt, calls } = makeFakes({
				startOut: startOutJson,
				createPrdResult: { id: 'abc123', branch: 'abc123-target-develop' },
				currentBranch: 'develop',
			})

			await runStart(rt)

			expect(calls.createPrd).toEqual([{ title: 'Target Develop', body: 'spec body', targetBranch: 'develop' }])
		})

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

			expect(calls.createPrd).toEqual([{ title: 'Rename Foo', body: 'spec body', targetBranch: 'main' }])
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
