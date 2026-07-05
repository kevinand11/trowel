import path from 'node:path'

import { resolveGrillSpec, type GrillSpecResult } from './grill-flow.ts'
import { buildGrillCommandRuntime, exitOnCommandError } from './runtime.ts'
import type { ChangeMetadataPatch, Storage } from '../storages/types.ts'
import type { GitOps } from '../utils/git-ops.ts'
import { withMutationLock } from '../utils/mutation-lock.ts'
import { slug as slugify } from '../utils/slug.ts'
import { parseStartChangeOut, type CreateChangeStartOut, type StartChangeOut } from '../work/start-change-out.ts'

export type ChangeStartRuntime = {
	projectRoot: string
	storage: Storage
	git: GitOps
	changeStartPromptText: string
	runInteractive: (opts: { promptText: string; cwd: string; initialPrompt?: string }) => Promise<void>
	initialPrompt?: string
	readStartChangeOut: () => Promise<string | null>
	preflight: () => Promise<void>
	stdout: (s: string) => void
	confirm: (msg: string) => Promise<boolean>
}

type ChangeStartSpec = CreateChangeStartOut
type ChangeStartGrillResult = GrillSpecResult<StartChangeOut>
type CreatedChangeStart = { changeId: string; changeBranch: string; realIds: string[]; spec: ChangeStartSpec }

export async function runChangeStart(rt: ChangeStartRuntime): Promise<void> {
	const result = await resolveChangeStartSpec(rt)
	try {
		await handleChangeStartOutcome(rt, result)
		await result.clearOut()
	} catch (e) {
		await result.recover()
		throw e
	}
}

function resolveChangeStartSpec(rt: ChangeStartRuntime): Promise<ChangeStartGrillResult> {
	return resolveGrillSpec({
		projectRoot: rt.projectRoot,
		git: rt.git,
		readOut: rt.readStartChangeOut,
		preflight: rt.preflight,
		stdout: rt.stdout,
		confirm: rt.confirm,
		parseOut: parseStartChangeOut,
		printResumePreview: (spec) => printResumePreview(rt, spec),
		runInteractive: () => rt.runInteractive({ promptText: rt.changeStartPromptText, cwd: rt.projectRoot, initialPrompt: rt.initialPrompt }),
		missingOutMessage: 'Change not created. Working tree has grill changes; review with `git status`, then `git checkout .` to discard or stash/commit to keep.\n',
		missingOutError: 'start-change-out.json missing — grill aborted',
		resumePrompt: 'Continue with the spec above? (no → discard and start a fresh grill)',
		invalidPrompt: 'Discard the invalid file and start a fresh grill? (no → abort)',
		outFileName: 'start-change-out.json',
	})
}

async function handleChangeStartOutcome(rt: ChangeStartRuntime, result: ChangeStartGrillResult): Promise<void> {
	if (result.spec.outcome === 'create-change') {
		const created = await materialiseChangeStart(rt, result, result.spec)
		printCreatedChangeStart(rt, created)
		return
	}
	if (result.spec.outcome === 'existing-change') {
		await printExistingChangeStart(rt, result.spec.changeId, result.spec.reason)
		return
	}
	printNoChangeStart(rt, result.spec.reason)
}

async function materialiseChangeStart(rt: ChangeStartRuntime, result: ChangeStartGrillResult, spec: ChangeStartSpec): Promise<CreatedChangeStart> {
	return withMutationLock(rt.projectRoot, async () => {
		const created = await rt.storage.createChange(spec.change)
		const changeId = created.id
		const changeBranch = changeBranchName(changeId, created.title)
		await rt.git.createRemoteBranch(changeBranch, result.targetBranch)
		await updateChangeMetadataOrThrow(rt, changeId, { targetBranch: result.targetBranch, changeBranch })
		result.markMaterialised()
		await rt.git.fetch(changeBranch)
		await rt.git.checkout(changeBranch)
		if (result.stashed) await rt.git.stashPop()
		const realIds = await createChangeStartSlices(rt, changeId, spec)
		await updateChangeStartSliceLinks(rt, changeId, spec, realIds)
		return { changeId, changeBranch, realIds, spec }
	})
}

function changeBranchName(changeId: string, title: string): string {
	return `change-${changeId}-${slugify(title)}`
}

async function updateChangeMetadataOrThrow(rt: ChangeStartRuntime, changeId: string, patch: ChangeMetadataPatch): Promise<void> {
	try {
		await rt.storage.updateChangeMetadata(changeId, patch)
	} catch (e) {
		throw new Error(`failed to update Change metadata for ${changeId}: ${(e as Error).message}`)
	}
}

async function createChangeStartSlices(rt: ChangeStartRuntime, changeId: string, spec: ChangeStartSpec): Promise<string[]> {
	const realIds: string[] = []
	for (const slice of spec.slices) {
		const created = await rt.storage.createSlice(changeId, { title: slice.title, body: slice.body })
		realIds.push(created.id)
	}
	return realIds
}

async function updateChangeStartSliceLinks(rt: ChangeStartRuntime, changeId: string, spec: ChangeStartSpec, realIds: string[]): Promise<void> {
	for (const [i, slice] of spec.slices.entries()) {
		const sliceId = realIds[i]!
		await rt.storage.setSliceBlockers(changeId, sliceId, slice.blockedBy.map((idx) => realIds[idx]!))
		await rt.storage.setSliceReadyForAgent(changeId, sliceId, slice.readyForAgent)
	}
}

function printCreatedChangeStart(rt: ChangeStartRuntime, created: CreatedChangeStart): void {
	rt.stdout(`\nCreated Change ${created.changeId}\n`)
	rt.stdout(`Change branch: ${created.changeBranch} (you are now on it)\n`)
	printCreatedChangeStartSlices(rt, created)
	rt.stdout('\nReview `git status` for uncommitted files (CONTEXT/ADR edits from the grill, and on file storage, the Change/slice artifacts). Commit at your discretion.\n')
	rt.stdout(`\nNext: trowel change work ${created.changeId}\n`)
}

async function printExistingChangeStart(rt: ChangeStartRuntime, changeId: string, reason: string): Promise<void> {
	const change = await rt.storage.findChange(changeId)
	if (!change) throw new Error(`start-change-out.json referenced missing Change '${changeId}'`)
	rt.stdout(`\nExisting Change ${changeId} appears to cover this:\n`)
	rt.stdout(`  ${change.title}\n`)
	if (reason.trim()) rt.stdout(`\nReason: ${reason}\n`)
	rt.stdout('\nNo new Change created.\n')
	rt.stdout(`Inspect it with: trowel change status ${changeId}\n`)
}

function printNoChangeStart(rt: ChangeStartRuntime, reason: string): void {
	rt.stdout('\nNo Change created.\n')
	if (reason.trim()) rt.stdout(`Reason: ${reason}\n`)
}

function printCreatedChangeStartSlices(rt: ChangeStartRuntime, created: CreatedChangeStart): void {
	if (created.realIds.length === 0) return
	rt.stdout('Slices:\n')
	for (const [i, slice] of created.spec.slices.entries()) rt.stdout(`  - ${created.realIds[i]} ${slice.title}\n`)
}

function printResumePreview(rt: ChangeStartRuntime, spec: ReturnType<typeof parseStartChangeOut>): void {
	rt.stdout('\nFound existing .trowel/start-change-out.json from a prior run:\n')
	if (spec.outcome === 'create-change') {
		rt.stdout(`\n# ${spec.change.title}\n\n${spec.change.body}\n`)
		printResumeSlices(rt, spec.slices)
	} else if (spec.outcome === 'existing-change') {
		rt.stdout(`\nExisting Change: ${spec.changeId}\nReason: ${spec.reason}\n`)
	} else {
		rt.stdout(`\nNo Change: ${spec.reason}\n`)
	}
	rt.stdout('\n')
}

function printResumeSlices(rt: ChangeStartRuntime, slices: ChangeStartSpec['slices']): void {
	if (slices.length === 0) return
	rt.stdout('\nSlices:\n')
	for (const [i, slice] of slices.entries()) rt.stdout(resumeSliceLine(i, slice))
}

function resumeSliceLine(i: number, slice: ChangeStartSpec['slices'][number]): string {
	const ready = slice.readyForAgent ? 'AFK' : 'HITL'
	return `  ${i}. ${slice.title}  (${ready}${blockedBySuffix(slice)})\n`
}

function blockedBySuffix(slice: ChangeStartSpec['slices'][number]): string {
	return slice.blockedBy.length > 0 ? ` blocked by [${slice.blockedBy.join(', ')}]` : ''
}

export async function changeStart(opts: { storage?: string; harness?: string; request?: string }): Promise<void> {
	const rtBase = await buildGrillCommandRuntime('change start', 'start-change', opts, 'start-change-out.json')
	await exitOnCommandError('change start', () => runChangeStart({
		projectRoot: rtBase.projectRoot,
		storage: rtBase.storage,
		git: rtBase.git,
		changeStartPromptText: rtBase.promptText,
		runInteractive: rtBase.runInteractive,
		initialPrompt: opts.request,
		readStartChangeOut: rtBase.readOut,
		preflight: rtBase.preflight,
		stdout: rtBase.stdout,
		confirm: rtBase.confirm,
	}))
}

if (import.meta.vitest) {
	const { describe, test, expect } = import.meta.vitest
	const { runChangeStart } = await import('./change-start.ts')
	const { makeFakes } = await import('./change-start.test-utils.ts')
	const { mkdtemp, mkdir, writeFile, readFile, rm, stat } = await import('node:fs/promises')
	const { tmpdir } = await import('node:os')

	async function setupTmp(): Promise<{ projectRoot: string; startChangeOutPath: string; cleanup: () => Promise<void> }> {
		const projectRoot = await mkdtemp(path.join(tmpdir(), 'trowel-change-start-cleanup-'))
		await mkdir(path.join(projectRoot, '.trowel'), { recursive: true })
		const startChangeOutPath = path.join(projectRoot, '.trowel', 'start-change-out.json')
		return { projectRoot, startChangeOutPath, cleanup: () => rm(projectRoot, { recursive: true, force: true }) }
	}

	async function fileExists(p: string): Promise<boolean> {
		try {
			await stat(p)
			return true
		} catch {
			return false
		}
	}

	async function readStartChangeOutFile(startChangeOutPath: string): Promise<string | null> {
		try {
			return await readFile(startChangeOutPath, 'utf8')
		} catch {
			return null
		}
	}

	function attachStartChangeOutFile(rt: ChangeStartRuntime, tmp: { projectRoot: string; startChangeOutPath: string }): void {
		rt.projectRoot = tmp.projectRoot
		rt.readStartChangeOut = () => readStartChangeOutFile(tmp.startChangeOutPath)
	}

	function resumeSpec() {
		return {
			outcome: 'create-change' as const,
			change: { title: 'Resume Me', body: 'body from prior run' },
			slices: [{ title: 'A', body: 'a', blockedBy: [], readyForAgent: true }],
		}
	}

	function minimalStartChangeOutJson(): string {
		return JSON.stringify({
			outcome: 'create-change',
			change: { title: 't', body: 'b' },
			slices: [{ title: 'A', body: 'b', blockedBy: [], readyForAgent: true }],
		})
	}

	async function writeStartChangeOut(tmp: { startChangeOutPath: string }, spec = resumeSpec()): Promise<void> {
		await writeFile(tmp.startChangeOutPath, JSON.stringify(spec))
	}

	function makeAttachedFakes(tmp: { projectRoot: string; startChangeOutPath: string }, opts: Parameters<typeof makeFakes>[0]) {
		const fakes = makeFakes(opts)
		attachStartChangeOutFile(fakes.rt, tmp)
		return fakes
	}

	async function expectRunChangeStartRejectsWithoutCreate(startChangeOut: string, error: RegExp): Promise<void> {
		const { rt, calls, gitState } = makeFakes({ startChangeOut, currentBranch: 'main' })
		await expect(runChangeStart(rt)).rejects.toThrow(error)
		expect(calls.createChange).toEqual([])
		expect(gitState.current).toBe('main')
	}

	async function expectAttachedStartChangeOutAbort(tmp: { projectRoot: string; startChangeOutPath: string }, opts: Parameters<typeof makeFakes>[0], error: RegExp): Promise<void> {
		const { rt, calls } = makeAttachedFakes(tmp, opts)
		let interactiveCalled = false
		rt.runInteractive = async () => { interactiveCalled = true }
		rt.confirm = async () => false
		await expect(runChangeStart(rt)).rejects.toThrow(error)
		expect(interactiveCalled).toBe(false)
		expect(calls.createChange).toEqual([])
		expect(await fileExists(tmp.startChangeOutPath)).toBe(true)
	}

	describe('runChangeStart: existing start-change-out.json offers resume', () => {
		test('valid existing spec + user picks skip → stale file wiped, claude runs fresh grill, new spec materialised', async () => {
			const tmp = await setupTmp()
			try {
				const staleSpec = {
					outcome: 'create-change' as const,
					change: { title: 'STALE', body: 'old' },
					slices: [{ title: 'old-slice', body: 'x', blockedBy: [], readyForAgent: true }],
				}
				await writeFile(tmp.startChangeOutPath, JSON.stringify(staleSpec))

				const freshSpec = {
					outcome: 'create-change' as const,
					change: { title: 'FRESH', body: 'new' },
					slices: [{ title: 'new-slice', body: 'y', blockedBy: [], readyForAgent: true }],
				}

				const { rt, calls } = makeFakes({
					startChangeOut: null,
					createChangeResult: { id: 'pid', changeBranch: 'pid-branch' },
					createSliceIds: ['s1'],
					currentBranch: 'main',
				})
				attachStartChangeOutFile(rt, tmp)
				let stalePresentAtRunInteractive: boolean | null = null
				rt.runInteractive = async () => {
					stalePresentAtRunInteractive = await fileExists(tmp.startChangeOutPath)
					await writeFile(tmp.startChangeOutPath, JSON.stringify(freshSpec))
				}
				rt.confirm = async () => false // skip

				await runChangeStart(rt)

				expect(stalePresentAtRunInteractive).toBe(false)
				expect(calls.createChange).toEqual([{ title: 'FRESH', body: 'new' }])
			} finally {
				await tmp.cleanup()
			}
		})

		test('legacy start-out.json is ignored; only start-change-out.json controls resume', async () => {
			const tmp = await setupTmp()
			try {
				await writeFile(path.join(tmp.projectRoot, '.trowel', 'start-out.json'), JSON.stringify({
					outcome: 'create-change',
					change: { title: 'LEGACY', body: 'old' },
					slices: [{ title: 'legacy-slice', body: 'x', blockedBy: [], readyForAgent: true }],
				}))
				const freshSpec = {
					outcome: 'create-change' as const,
					change: { title: 'FRESH', body: 'new' },
					slices: [{ title: 'new-slice', body: 'y', blockedBy: [], readyForAgent: true }],
				}

				const { rt, calls } = makeFakes({
					startChangeOut: null,
					createChangeResult: { id: 'pid', changeBranch: 'pid-branch' },
					createSliceIds: ['s1'],
					currentBranch: 'main',
				})
				attachStartChangeOutFile(rt, tmp)
				rt.runInteractive = async () => {
					await writeFile(tmp.startChangeOutPath, JSON.stringify(freshSpec))
				}

				await runChangeStart(rt)

				expect(calls.createChange).toEqual([{ title: 'FRESH', body: 'new' }])
			} finally {
				await tmp.cleanup()
			}
		})

		test('invalid existing spec + user confirms wipe → file wiped, claude runs fresh grill', async () => {
			const tmp = await setupTmp()
			try {
				await writeFile(tmp.startChangeOutPath, JSON.stringify({ slices: [] })) // missing change

				const freshSpec = {
					outcome: 'create-change' as const,
					change: { title: 'FRESH', body: 'new' },
					slices: [{ title: 'x', body: 'y', blockedBy: [], readyForAgent: true }],
				}

				const { rt, calls } = makeFakes({
					startChangeOut: null,
					createChangeResult: { id: 'pid', changeBranch: 'pid-branch' },
					createSliceIds: ['s1'],
					currentBranch: 'main',
				})
				attachStartChangeOutFile(rt, tmp)
				let interactiveCalled = false
				rt.runInteractive = async () => {
					interactiveCalled = true
					await writeFile(tmp.startChangeOutPath, JSON.stringify(freshSpec))
				}
				rt.confirm = async () => true // wipe and start fresh

				await runChangeStart(rt)

				expect(interactiveCalled).toBe(true)
				expect(calls.createChange).toEqual([{ title: 'FRESH', body: 'new' }])
				expect(calls.stdout.join('')).toMatch(/invalid/i)
			} finally {
				await tmp.cleanup()
			}
		})

		test('invalid existing spec + user declines wipe → runChangeStart throws with validation error, file persists', async () => {
			const tmp = await setupTmp()
			try {
				await writeFile(tmp.startChangeOutPath, JSON.stringify({ slices: [] })) // missing change

				await expectAttachedStartChangeOutAbort(tmp, { startChangeOut: null, currentBranch: 'main' }, /Invalid start-change-out\.json/)
			} finally {
				await tmp.cleanup()
			}
		})

		test('preview prints Change title, Change body, and a slice row per slice before the confirm prompt', async () => {
			const tmp = await setupTmp()
			try {
				const spec = {
					outcome: 'create-change' as const,
					change: { title: 'Resume Me', body: 'long body content goes here' },
					slices: [
						{ title: 'first slice', body: 'a', blockedBy: [], readyForAgent: true },
						{ title: 'second slice', body: 'b', blockedBy: [0], readyForAgent: false },
					],
				}
				await writeFile(tmp.startChangeOutPath, JSON.stringify(spec))

				const { rt, calls } = makeFakes({
					startChangeOut: null,
					currentBranch: 'main',
				})
				attachStartChangeOutFile(rt, tmp)
				let stdoutAtConfirm = ''
				rt.confirm = async () => {
					stdoutAtConfirm = calls.stdout.join('')
					return false // skip — short-circuits the rest of the flow
				}
				// Don't actually run claude on the skip path
				rt.runInteractive = async () => {}

				await expect(runChangeStart(rt)).rejects.toThrow() // claude wrote nothing → missing start-change-out

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
				await writeStartChangeOut(tmp)

				const { rt, calls } = makeAttachedFakes(tmp, {
					startChangeOut: null, // not used — readStartChangeOut overridden below
					createChangeResult: { id: 'pid', changeBranch: 'pid-branch' },
					createSliceIds: ['s1'],
					currentBranch: 'main',
				})
				let interactiveCalls = 0
				rt.runInteractive = async () => { interactiveCalls++ }
				rt.confirm = async () => true // continue

				await runChangeStart(rt)

				expect(interactiveCalls).toBe(0)
				expect(calls.createChange).toEqual([{ title: 'Resume Me', body: 'body from prior run' }])
				expect(calls.createSlice).toHaveLength(1)
				expect(await fileExists(tmp.startChangeOutPath)).toBe(false)
			} finally {
				await tmp.cleanup()
			}
		})

		test('valid existing spec + user confirms continue + preflight would fail → skips preflight and materialises', async () => {
			const tmp = await setupTmp()
			try {
				await writeStartChangeOut(tmp)

				const { rt, calls } = makeAttachedFakes(tmp, {
					startChangeOut: null,
					createChangeResult: { id: 'pid', changeBranch: 'pid-branch' },
					createSliceIds: ['s1'],
					currentBranch: 'main',
					preflightFailures: ['working tree dirty'],
				})
				let interactiveCalled = false
				rt.runInteractive = async () => { interactiveCalled = true }
				rt.confirm = async () => true // continue

				await runChangeStart(rt)

				expect(interactiveCalled).toBe(false)
				expect(calls.createChange).toEqual([{ title: 'Resume Me', body: 'body from prior run' }])
				expect(await fileExists(tmp.startChangeOutPath)).toBe(false)
			} finally {
				await tmp.cleanup()
			}
		})

		test('valid existing spec + user starts fresh + preflight fails → stale start-change-out.json is not cleaned up yet', async () => {
			const tmp = await setupTmp()
			try {
				const spec = {
					outcome: 'create-change' as const,
					change: { title: 'STALE', body: 'old' },
					slices: [{ title: 'old-slice', body: 'x', blockedBy: [], readyForAgent: true }],
				}
				await writeFile(tmp.startChangeOutPath, JSON.stringify(spec))

				await expectAttachedStartChangeOutAbort(tmp, { startChangeOut: null, currentBranch: 'main', preflightFailures: ['working tree dirty'] }, /preflight failed/i)
			} finally {
				await tmp.cleanup()
			}
		})
	})

	describe('runChangeStart: start-change-out.json lifecycle (real filesystem)', () => {
		test('pre-grill wipe — stale file from a prior run is gone before claude runs and is not re-read', async () => {
			const tmp = await setupTmp()
			try {
				// Stale file left behind by a prior aborted run
				await writeFile(tmp.startChangeOutPath, JSON.stringify({
					outcome: 'create-change' as const,
					change: { title: 'STALE', body: 'should-not-be-read' },
					slices: [],
				}))

				const { rt, calls } = makeFakes({
					startChangeOut: null,
					currentBranch: 'main',
				})
				attachStartChangeOutFile(rt, tmp)
				let stalePresentAtRunInteractive: boolean | null = null
				rt.runInteractive = async () => {
					stalePresentAtRunInteractive = await fileExists(tmp.startChangeOutPath)
					// Claude aborts: doesn't write a new file
				}

				await expect(runChangeStart(rt)).rejects.toThrow(/start-change-out.json missing/i)
				expect(stalePresentAtRunInteractive).toBe(false)
				expect(calls.createChange).toEqual([])
				expect(await fileExists(tmp.startChangeOutPath)).toBe(false)
			} finally {
				await tmp.cleanup()
			}
		})

		test('failure path (invalid spec) leaves start-change-out.json on disk for inspection', async () => {
			const tmp = await setupTmp()
			try {
				const invalid = JSON.stringify({ slices: [] }) // missing change
				const { rt } = makeFakes({ startChangeOut: invalid, currentBranch: 'main' })
				attachStartChangeOutFile(rt, tmp)
				rt.runInteractive = async () => {
					await writeFile(tmp.startChangeOutPath, invalid)
				}
				await expect(runChangeStart(rt)).rejects.toThrow(/Invalid start-change-out\.json/)
				expect(await fileExists(tmp.startChangeOutPath)).toBe(true)
			} finally {
				await tmp.cleanup()
			}
		})

		test('success path deletes start-change-out.json after the summary print', async () => {
			const tmp = await setupTmp()
			try {
				const spec = {
					outcome: 'create-change' as const,
					change: { title: 'T', body: 'B' },
					slices: [{ title: 'S', body: 'B', blockedBy: [], readyForAgent: true }],
				}
				const { rt } = makeFakes({
					startChangeOut: JSON.stringify(spec),
					createChangeResult: { id: 'pid', changeBranch: 'pid-branch' },
					createSliceIds: ['s1'],
					currentBranch: 'main',
				})
				attachStartChangeOutFile(rt, tmp)
				rt.runInteractive = async () => {
					await writeFile(tmp.startChangeOutPath, JSON.stringify(spec))
				}
				await runChangeStart(rt)
				expect(await fileExists(tmp.startChangeOutPath)).toBe(false)
			} finally {
				await tmp.cleanup()
			}
		})
	})

	describe('runChangeStart: missing start-change-out.json (claude aborted)', () => {
		test('prints recovery message, restores BACK_TO, throws', async () => {
			const { rt, calls, gitState } = makeFakes({
				startChangeOut: null,
				currentBranch: 'main',
			})
			await expect(runChangeStart(rt)).rejects.toThrow(/start-change-out.json missing/i)
			expect(calls.stdout.join('')).toMatch(/git status/i)
			expect(calls.createChange).toEqual([])
			expect(gitState.current).toBe('main')
		})

		test('restores BACK_TO even if claude left the user on a different branch', async () => {
			const { rt, gitState } = makeFakes({ startChangeOut: null, currentBranch: 'main' })
			rt.runInteractive = async () => {
				gitState.current = 'somewhere-else'
			}
			await expect(runChangeStart(rt)).rejects.toThrow()
			expect(gitState.current).toBe('main')
		})
	})

	describe('runChangeStart: invalid start-change-out.json', () => {
		test('schema violation (missing change) → re-raises validation error, BACK_TO restored, no createChange', async () => {
			await expectRunChangeStartRejectsWithoutCreate(JSON.stringify({ slices: [] }), /Invalid start-change-out\.json/)
		})

		test('blockedBy cycle → re-raises, no createChange, BACK_TO restored', async () => {
			const cyclic = JSON.stringify({
				outcome: 'create-change' as const,
				change: { title: 't', body: 'b' },
				slices: [
					{ title: 'A', body: 'b', blockedBy: [1], readyForAgent: true },
					{ title: 'B', body: 'b', blockedBy: [0], readyForAgent: true },
				],
			})
			await expectRunChangeStartRejectsWithoutCreate(cyclic, /cycle/i)
		})
	})

	describe('runChangeStart: stash dance', () => {
		test('dirty tree → stashPush before createChange, then checkout Change branch, then stashPop (in that order)', async () => {
			const startChangeOut = minimalStartChangeOutJson()
			const { rt, calls } = makeFakes({
				startChangeOut,
				createChangeResult: { id: 'pid', changeBranch: 'pid-branch' },
				createSliceIds: ['s1'],
				currentBranch: 'main',
				cleanTree: false,
			})
			await runChangeStart(rt)
			expect(calls.git).toEqual(['stashPush', 'createRemoteBranch(change-pid-t,main)', 'fetch(change-pid-t)', 'checkout(change-pid-t)', 'stashPop'])
		})

		test('clean tree → no stashPush/stashPop, just checkout', async () => {
			const startChangeOut = minimalStartChangeOutJson()
			const { rt, calls } = makeFakes({
				startChangeOut,
				createChangeResult: { id: 'pid', changeBranch: 'pid-branch' },
				createSliceIds: ['s1'],
				currentBranch: 'main',
				cleanTree: true,
			})
			await runChangeStart(rt)
			expect(calls.git).toEqual(['createRemoteBranch(change-pid-t,main)', 'fetch(change-pid-t)', 'checkout(change-pid-t)'])
		})
	})

	describe('runChangeStart: stash-pop conflict', () => {
		test('stashPop throws → user stays on Change branch (no restore), error surfaces', async () => {
			const startChangeOut = minimalStartChangeOutJson()
			const { rt, gitState } = makeFakes({
				startChangeOut,
				createChangeResult: { id: 'pid', changeBranch: 'pid-branch' },
				createSliceIds: ['s1'],
				currentBranch: 'main',
				cleanTree: false,
				stashPopThrows: new Error('CONFLICT (content): Merge conflict in CONTEXT.md'),
			})
			await expect(runChangeStart(rt)).rejects.toThrow(/conflict/i)
			expect(gitState.current).toBe('change-pid-t')
		})
	})

	describe('runChangeStart: createChange fails after stash', () => {
		test('storage.createChange throws while stashed → stash popped on BACK_TO, BACK_TO restored, error re-raised', async () => {
			const startChangeOut = minimalStartChangeOutJson()
			const { rt, calls, gitState } = makeFakes({
				startChangeOut,
				currentBranch: 'main',
				cleanTree: false,
				createChangeThrows: new Error('GitHub API down'),
			})
			await expect(runChangeStart(rt)).rejects.toThrow(/GitHub API down/)
			// stash was pushed; createChange failed; stash must be popped back on the original branch
			expect(calls.git).toEqual(['stashPush', 'stashPop'])
			expect(gitState.current).toBe('main')
			expect(gitState.stashStack).toBe(0)
		})
	})

	describe('runChangeStart: preflight short-circuit', () => {
		test('preflight failures → throws before claude is launched; no createChange', async () => {
			const { rt, calls } = makeFakes({
				startChangeOut: null,
				preflightFailures: ['working tree dirty', 'gh not authenticated'],
			})
			let claudeRan = false
			rt.runInteractive = async () => { claudeRan = true }
			await expect(runChangeStart(rt)).rejects.toThrow(/working tree dirty[\s\S]*gh not authenticated/i)
			expect(claudeRan).toBe(false)
			expect(calls.createChange).toEqual([])
		})
	})

	describe('runChangeStart: summary', () => {
		test('prints Change id, Change branch, slice ids, and a commit-reminder hint after success', async () => {
			const startChangeOut = JSON.stringify({
				outcome: 'create-change' as const,
				change: { title: 'Rename Foo', body: 'b' },
				slices: [
					{ title: 'A', body: 'b', blockedBy: [], readyForAgent: true },
					{ title: 'B', body: 'b', blockedBy: [0], readyForAgent: true },
				],
			})
			const { rt, calls } = makeFakes({
				startChangeOut,
				createChangeResult: { id: 'abc123', changeBranch: 'change-abc123-rename-foo' },
				createSliceIds: ['s1', 's2'],
				currentBranch: 'main',
			})
			await runChangeStart(rt)
			const out = calls.stdout.join('')
			expect(out).toMatch(/abc123/)
			expect(out).toMatch(/change-abc123-rename-foo/)
			expect(out).toMatch(/s1/)
			expect(out).toMatch(/s2/)
			expect(out).toMatch(/trowel change work abc123/)
			expect(out).toMatch(/commit/i)
		})
	})

	describe('runChangeStart: happy path', () => {
		test('passes the invocation branch as the Change target branch', async () => {
			const startChangeOutJson = JSON.stringify({
				outcome: 'create-change' as const,
				change: { title: 'Target Develop', body: 'spec body' },
				slices: [],
			})
			const { rt, calls } = makeFakes({
				startChangeOut: startChangeOutJson,
				createChangeResult: { id: 'abc123', changeBranch: 'change-abc123-target-develop' },
				currentBranch: 'develop',
			})

			await runChangeStart(rt)

			expect(calls.createChange).toEqual([{ title: 'Target Develop', body: 'spec body' }])
		})

		test('creates Change branch metadata before creating Slices without eager Slice branch metadata', async () => {
			const startChangeOutJson = JSON.stringify({
				outcome: 'create-change' as const,
				change: { title: 'Rename Foo', body: 'spec body' },
				slices: [
					{ title: 'Rename type', body: 'a', blockedBy: [], readyForAgent: true },
					{ title: 'Update callsites', body: 'b', blockedBy: [0], readyForAgent: false },
				],
			})
			const { rt, calls } = makeFakes({
				startChangeOut: startChangeOutJson,
				createChangeResult: { id: 'abc123', title: 'Rename Foo' },
				createSliceIds: ['slice-a', 'slice-b'],
				currentBranch: 'main',
			})

			await runChangeStart(rt)

			expect(calls.order).toEqual([
				'createChange(Rename Foo)',
				'createRemoteBranch(change-abc123-rename-foo,main)',
				'updateChangeMetadata(abc123,main,change-abc123-rename-foo)',
				'fetch(change-abc123-rename-foo)',
				'checkout(change-abc123-rename-foo)',
				'createSlice(abc123,Rename type)',
				'createSlice(abc123,Update callsites)',
				'setSliceBlockers(abc123,slice-a)',
				'setSliceReadyForAgent(abc123,slice-a)',
				'setSliceBlockers(abc123,slice-b)',
				'setSliceReadyForAgent(abc123,slice-b)',
			])
		})

		test('perSliceBranches:false also leaves Slice branch metadata unassigned until preparation', async () => {
			const startChangeOutJson = JSON.stringify({
				outcome: 'create-change' as const,
				change: { title: 'Shared Branch', body: 'spec body' },
				slices: [{ title: 'One Slice', body: 'a', blockedBy: [], readyForAgent: true }],
			})
			const { rt, calls } = makeFakes({
				startChangeOut: startChangeOutJson,
				createChangeResult: { id: 'abc123', title: 'Shared Branch' },
				createSliceIds: ['slice-a'],
				currentBranch: 'main',
			})

			await runChangeStart(rt)

			expect(calls.git).toEqual(['createRemoteBranch(change-abc123-shared-branch,main)', 'fetch(change-abc123-shared-branch)', 'checkout(change-abc123-shared-branch)'])
			expect(calls.updateSliceMetadata).toEqual([])
		})

		test('Change metadata update failure is loud after the Change record and branch have been created', async () => {
			const startChangeOutJson = JSON.stringify({
				outcome: 'create-change' as const,
				change: { title: 'Metadata Failure', body: 'spec body' },
				slices: [],
			})
			const { rt, calls } = makeFakes({
				startChangeOut: startChangeOutJson,
				createChangeResult: { id: 'abc123', title: 'Metadata Failure' },
				currentBranch: 'main',
				updateChangeMetadataThrows: new Error('storage API down'),
			})

			await expect(runChangeStart(rt)).rejects.toThrow(/failed to update Change metadata for abc123: storage API down/)
			expect(calls.order).toEqual([
				'createChange(Metadata Failure)',
				'createRemoteBranch(change-abc123-metadata-failure,main)',
				'updateChangeMetadata(abc123,main,change-abc123-metadata-failure)',
			])
		})

		test('Slice metadata is not updated during start; prepareImplement assigns it later', async () => {
			const startChangeOutJson = JSON.stringify({
				outcome: 'create-change' as const,
				change: { title: 'Lazy Slice Metadata', body: 'spec body' },
				slices: [{ title: 'One Slice', body: 'a', blockedBy: [], readyForAgent: true }],
			})
			const { rt, calls } = makeFakes({
				startChangeOut: startChangeOutJson,
				createChangeResult: { id: 'abc123', title: 'Lazy Slice Metadata' },
				createSliceIds: ['slice-a'],
				currentBranch: 'main',
			})

			await runChangeStart(rt)
			expect(calls.order).toContain('createSlice(abc123,One Slice)')
			expect(calls.order).not.toContain('createRemoteBranch(change-abc123/slice-slice-a-one-slice,change-abc123-lazy-slice-metadata)')
			expect(calls.updateSliceMetadata).toEqual([])
		})

		test('claude writes valid 2-slice spec → createChange + 2× createSlice + 2× updateSlice with resolved blockedBy and readyForAgent', async () => {
			const startChangeOutJson = JSON.stringify({
				outcome: 'create-change' as const,
				change: { title: 'Rename Foo', body: 'spec body' },
				slices: [
					{ title: 'Rename type', body: 'a', blockedBy: [], readyForAgent: true },
					{ title: 'Update callsites', body: 'b', blockedBy: [0], readyForAgent: false },
				],
			})
			const { rt, calls, gitState } = makeFakes({
				startChangeOut: startChangeOutJson,
				createChangeResult: { id: 'abc123', changeBranch: 'change-abc123-rename-foo' },
				createSliceIds: ['slice-a', 'slice-b'],
				currentBranch: 'main',
			})

			await runChangeStart(rt)

			expect(calls.createChange).toEqual([{ title: 'Rename Foo', body: 'spec body' }])
			expect(calls.createSlice).toEqual([
				{ changeId: 'abc123', spec: { title: 'Rename type', body: 'a' } },
				{ changeId: 'abc123', spec: { title: 'Update callsites', body: 'b' } },
			])
			expect(calls.setSliceBlockers).toEqual([
				{ changeId: 'abc123', sliceId: 'slice-a', blockedBy: [] },
				{ changeId: 'abc123', sliceId: 'slice-b', blockedBy: ['slice-a'] },
			])
			expect(calls.setSliceReadyForAgent).toEqual([
				{ changeId: 'abc123', sliceId: 'slice-a', ready: true },
				{ changeId: 'abc123', sliceId: 'slice-b', ready: false },
			])
			expect(gitState.current).toBe('change-abc123-rename-foo')
		})
	})
}
