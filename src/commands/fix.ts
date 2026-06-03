import { stat } from 'node:fs/promises'
import path from 'node:path'

import { resolveGrillSpec } from './grill-flow.ts'
import { buildGrillCommandRuntime, exitOnCommandError } from './runtime.ts'
import type { Storage } from '../storages/types.ts'
import type { GitOps } from '../utils/git-ops.ts'
import { parseFixOut } from '../work/fix-out.ts'

type FixRuntime = {
	projectRoot: string
	storage: Storage
	git: GitOps
	fixPromptText: string
	runInteractive: (opts: { promptText: string; cwd: string }) => Promise<void>
	readFixOut: () => Promise<string | null>
	preflight: () => Promise<string[]>
	stdout: (s: string) => void
	confirm: (msg: string) => Promise<boolean>
}

async function runFix(rt: FixRuntime): Promise<void> {
	const result = await resolveGrillSpec({
		projectRoot: rt.projectRoot,
		git: rt.git,
		readOut: rt.readFixOut,
		preflight: rt.preflight,
		stdout: rt.stdout,
		confirm: rt.confirm,
		parseOut: parseFixOut,
		printResumePreview: (spec) => printResumePreview(rt, spec),
		runInteractive: () => rt.runInteractive({ promptText: rt.fixPromptText, cwd: rt.projectRoot }),
		missingOutMessage: 'Fix not created. Working tree has grill changes; review with `git status`, then `git checkout .` to discard or stash/commit to keep.\n',
		missingOutError: 'fix-out.json missing — grill aborted',
		resumePrompt: 'Continue with the fix above? (no → discard and start a fresh grill)',
		invalidPrompt: 'Discard the invalid file and start a fresh grill? (no → abort)',
		outFileName: 'fix-out.json',
	})

	try {
		const { id, branch } = await rt.storage.createFix({ title: result.spec.title, body: result.spec.body, targetBranch: result.targetBranch })
		result.markMaterialised()
		if ((await rt.git.currentBranch()) !== result.backTo) await rt.git.checkout(result.backTo)
		if (result.stashed) await rt.git.stashPop()

		rt.stdout(`\nCreated Fix ${id}\n`)
		rt.stdout(`Branch: ${branch}\n`)
		rt.stdout('\nReview `git status` for uncommitted files from the grill. Commit at your discretion.\n')
		rt.stdout(`\nNext: trowel work fix ${id}\n`)

		await result.clearOut()
	} catch (e) {
		await result.recover()
		throw e
	}
}

function printResumePreview(rt: FixRuntime, spec: ReturnType<typeof parseFixOut>): void {
	rt.stdout('\nFound existing .trowel/fix-out.json from a prior run:\n')
	rt.stdout(`\n# ${spec.title}\n\n${spec.body}\n`)
}

export async function fix(opts: { storage?: string; harness?: string }): Promise<void> {
	const rtBase = await buildGrillCommandRuntime('fix', opts, 'fix-out.json')
	await exitOnCommandError('fix', () => runFix({
		projectRoot: rtBase.projectRoot,
		storage: rtBase.storage,
		git: rtBase.git,
		fixPromptText: rtBase.promptText,
		runInteractive: rtBase.runInteractive,
		readFixOut: rtBase.readOut,
		preflight: rtBase.preflight,
		stdout: rtBase.stdout,
		confirm: rtBase.confirm,
	}))
}

if (import.meta.vitest) {
	const { describe, test, expect } = import.meta.vitest
	const { mkdtemp, mkdir, writeFile, readFile: fsReadFile, rm } = await import('node:fs/promises')
	const { tmpdir } = await import('node:os')

	async function setupTmp(): Promise<{ projectRoot: string; fixOutPath: string; cleanup: () => Promise<void> }> {
		const projectRoot = await mkdtemp(path.join(tmpdir(), 'trowel-fix-cleanup-'))
		await mkdir(path.join(projectRoot, '.trowel'), { recursive: true })
		const fixOutPath = path.join(projectRoot, '.trowel', 'fix-out.json')
		return { projectRoot, fixOutPath, cleanup: () => rm(projectRoot, { recursive: true, force: true }) }
	}

	async function fileExists(p: string): Promise<boolean> {
		try {
			await stat(p)
			return true
		} catch {
			return false
		}
	}

	function makeFixFakes(opts: { fixOut: string | null; currentBranch?: string; cleanTree?: boolean; preflightFailures?: string[] }) {
		const created: Array<{ title: string; body: string; targetBranch?: string }> = []
		const calls = { git: [] as string[], stdout: [] as string[], created }
		let current = opts.currentBranch ?? 'main'
		let clean = opts.cleanTree ?? true
		const storage: Storage = {
			createPrd: async () => ({ id: 'p', branch: 'p' }),
			findPrd: async () => null,
			listPrds: async () => [],
			closePrd: async () => {},
			createSlice: async () => { throw new Error('not used') },
			findSlices: async () => [],
			findSlice: async () => null,
			updateSlice: async () => {},
			createFix: async (spec) => {
				created.push(spec)
				current = 'fix/5-tabs'
				return { id: '5', branch: 'fix/5-tabs' }
			},
			findFix: async () => null,
			listFixes: async () => [],
			updateFix: async () => {},
			closeFix: async () => {},
		}
		const git: GitOps = {
			currentBranch: async () => current,
			branchExists: async () => true,
			checkout: async (b) => { calls.git.push(`checkout(${b})`); current = b },
			baseBranch: async () => 'main',
			isWorkingTreeClean: async () => clean,
			stashPush: async () => { calls.git.push('stashPush'); clean = true },
			stashPop: async () => { calls.git.push('stashPop') },
			fetch: async () => {},
			push: async () => {},
			mergeNoFf: async () => {},
			mergeAbort: async () => {},
			deleteRemoteBranch: async () => {},
			createRemoteBranch: async () => {},
			createLocalBranch: async () => {},
			pushSetUpstream: async () => {},
			isMerged: async () => false,
			deleteBranch: async () => {},
			worktreeAdd: async () => {},
			worktreeRemove: async () => {},
			worktreeList: async () => [],
			restoreAll: async () => {},
			cleanUntracked: async () => {},
			commitsAhead: async () => 0,
			detectVersion: async () => ({ installed: true, version: '0.0.0' }),
		}
		const rt: FixRuntime = {
			projectRoot: '/fake/proj',
			storage,
			git,
			fixPromptText: '<prompt>',
			runInteractive: async () => {},
			readFixOut: async () => opts.fixOut,
			preflight: async () => opts.preflightFailures ?? [],
			stdout: (s) => calls.stdout.push(s),
			confirm: async () => false,
		}
		return { rt, calls, getCurrent: () => current }
	}

	describe('runFix', () => {
		test('passes the invocation branch as the Fix target branch', async () => {
			const { rt, calls } = makeFixFakes({
				fixOut: JSON.stringify({ title: 'Fix Tabs', body: 'body' }),
				currentBranch: 'release/1.2',
			})

			await runFix(rt)

			expect(calls.created).toEqual([{ title: 'Fix Tabs', body: 'body', targetBranch: 'release/1.2' }])
		})

		test('valid existing fix-out + user confirms continue + preflight would fail → skips preflight and materialises', async () => {
			const tmp = await setupTmp()
			try {
				await writeFile(tmp.fixOutPath, JSON.stringify({ title: 'Resume Fix', body: 'body from prior grill' }))
				const { rt, calls } = makeFixFakes({ fixOut: null, preflightFailures: ['working tree dirty'] })
				rt.projectRoot = tmp.projectRoot
				let interactiveCalled = false
				rt.runInteractive = async () => { interactiveCalled = true }
				rt.readFixOut = async () => {
					try { return await fsReadFile(tmp.fixOutPath, 'utf8') } catch { return null }
				}
				rt.confirm = async () => true

				await runFix(rt)

				expect(interactiveCalled).toBe(false)
				expect(calls.created).toEqual([{ title: 'Resume Fix', body: 'body from prior grill', targetBranch: 'main' }])
				expect(await fileExists(tmp.fixOutPath)).toBe(false)
			} finally {
				await tmp.cleanup()
			}
		})

		test('valid existing fix-out + user starts fresh + preflight fails → stale fix-out.json persists', async () => {
			const tmp = await setupTmp()
			try {
				await writeFile(tmp.fixOutPath, JSON.stringify({ title: 'Stale Fix', body: 'old' }))
				const { rt, calls } = makeFixFakes({ fixOut: null, preflightFailures: ['working tree dirty'] })
				rt.projectRoot = tmp.projectRoot
				let interactiveCalled = false
				rt.runInteractive = async () => { interactiveCalled = true }
				rt.readFixOut = async () => {
					try { return await fsReadFile(tmp.fixOutPath, 'utf8') } catch { return null }
				}
				rt.confirm = async () => false

				await expect(runFix(rt)).rejects.toThrow(/preflight failed/i)

				expect(interactiveCalled).toBe(false)
				expect(calls.created).toEqual([])
				expect(await fileExists(tmp.fixOutPath)).toBe(true)
			} finally {
				await tmp.cleanup()
			}
		})

		test('dirty tree after grill is stashed while creating the Fix branch, then restored on the invocation branch', async () => {
			const { rt, calls, getCurrent } = makeFixFakes({
				fixOut: JSON.stringify({ title: 'Fix Tabs', body: 'body' }),
				cleanTree: false,
			})

			await runFix(rt)

			expect(calls.git).toEqual(['stashPush', 'checkout(main)', 'stashPop'])
			expect(getCurrent()).toBe('main')
		})
	})
}
