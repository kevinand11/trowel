import { createSliceBranch } from '../../backends/implementations/issue.ts'
import type { Backend, Slice } from '../../backends/types.ts'
import type { GhRunner } from '../../utils/gh-runner.ts'
import { fetchPrFeedback } from '../feedback.ts'
import type { Role } from '../prompts.ts'
import type { SandboxIn, SandboxOut } from '../verdict.ts'

export type ResumeState = 'done' | 'implement' | 'create-pr-then-review' | 'review' | 'address'

export type ClassifyInput = Pick<Slice, 'state' | 'readyForAgent' | 'needsRevision' | 'prState' | 'branchAhead'>

export function classifyResumeState(s: ClassifyInput): ResumeState {
	if (s.state === 'CLOSED') return 'done'
	if (!s.readyForAgent) return 'done'
	if (s.prState === 'merged' || s.prState === 'ready') return 'done'
	if (s.needsRevision) return 'address'
	if (s.prState === 'draft') return 'review'
	if (s.prState === null && s.branchAhead) return 'create-pr-then-review'
	return 'implement'
}

export type ProcessOutcome = 'done' | 'partial' | 'no-work'
type PhaseOutcome = 'done' | 'progress' | 'partial' | 'no-work'

export type PerSliceDeps = {
	backend: Backend
	prdId: string
	integrationBranch: string
	gh: GhRunner
	gitFetch: (branch: string) => Promise<void>
	gitPush: (branch: string) => Promise<void>
	gitCheckout: (branch: string) => Promise<void>
	gitMergeNoFf: (branch: string) => Promise<void>
	gitDeleteRemoteBranch: (branch: string) => Promise<void>
	findPrNumber: (sliceBranch: string) => Promise<number>
	spawnSandbox: (args: { role: Role; slice: Slice; branch: string; sandboxIn: SandboxIn }) => Promise<SandboxOut>
	log: (msg: string) => void
	slugify: (title: string) => string
	config: { usePrs: boolean; sliceStepCap: number }
}

export type IssueLoopDeps = PerSliceDeps & {
	config: { usePrs: boolean; sliceStepCap: number; maxIterations: number; maxConcurrent: number | null }
}

export async function runIssueLoop(prdId: string, deps: IssueLoopDeps): Promise<void> {
	const tag = `[work prd-${prdId}]`
	const failed = new Set<string>()
	for (let iter = 0; iter < deps.config.maxIterations; iter++) {
		const slices = await deps.backend.findSlices(prdId)
		const actionable = slices.filter((s) => !failed.has(s.id) && s.bucket !== 'blocked' && classifyResumeState(s) !== 'done')
		if (actionable.length === 0) {
			deps.log(`${tag} no actionable slices; exiting after ${iter} iteration(s)`)
			return
		}
		deps.log(`${tag} iter ${iter + 1}/${deps.config.maxIterations}: ${actionable.length} actionable slice(s) [${actionable.map((s) => s.id).join(', ')}]`)
		const limit = deps.config.maxConcurrent ?? actionable.length
		for (let start = 0; start < actionable.length; start += limit) {
			const batch = actionable.slice(start, start + limit)
			const results = await Promise.allSettled(batch.map((s) => processIssueSlice(s, deps)))
			results.forEach((r, i) => {
				if (r.status === 'rejected') {
					const slice = batch[i]!
					const msg = r.reason instanceof Error ? r.reason.message : String(r.reason)
					deps.log(`[work prd-${prdId} slice-${slice.id}] error: ${msg}; skipping for the rest of this run`)
					failed.add(slice.id)
				}
			})
		}
	}
	deps.log(`issue loop hit maxIterations (${deps.config.maxIterations}); leaving remaining slices for next invocation`)
}

export async function processIssueSlice(initial: Slice, deps: PerSliceDeps): Promise<ProcessOutcome> {
	if (initial.bucket === 'blocked') {
		deps.log(`[work prd-${deps.prdId} slice-${initial.id}] blocked by [${initial.blockedBy.join(', ')}]; skipping`)
		return 'no-work'
	}
	let slice = initial
	for (let step = 0; step < deps.config.sliceStepCap; step++) {
		const outcome = await processOnePhase(slice, deps)
		if (outcome === 'done') return 'done'
		if (outcome === 'no-work') return 'no-work'
		if (outcome === 'partial') return 'partial'
		// outcome === 'progress' — re-fetch and continue
		const refreshed = (await deps.backend.findSlices(deps.prdId)).find((s) => s.id === slice.id)
		if (!refreshed) return 'partial'
		slice = refreshed
	}
	deps.log(`[work prd-${deps.prdId} slice-${slice.id}] step-cap reached after ${deps.config.sliceStepCap} step(s); returning partial`)
	return 'partial'
}

async function processOnePhase(slice: Slice, deps: PerSliceDeps): Promise<PhaseOutcome> {
	const tag = `[work prd-${deps.prdId} slice-${slice.id}]`
	const resumeState = classifyResumeState(slice)
	if (resumeState === 'done') return 'done'
	deps.log(`${tag} state=${resumeState}: "${slice.title}"`)

	if (resumeState === 'create-pr-then-review') {
		const sliceBranch = `prd-${deps.prdId}/slice-${slice.id}-${deps.slugify(slice.title)}`
		const result = await deps.gh([
			'pr',
			'create',
			'--draft',
			'--title',
			slice.title,
			'--head',
			sliceBranch,
			'--base',
			deps.integrationBranch,
			'--body',
			`Closes #${slice.id}`,
		])
		if (!result.ok) throw new Error(`gh pr create failed: ${result.error.message}`)
		deps.log(`${tag} opened draft PR for ${sliceBranch}`)
		return 'progress'
	}

	if (resumeState === 'address') {
		const sliceBranch = `prd-${deps.prdId}/slice-${slice.id}-${deps.slugify(slice.title)}`
		const prNumber = await deps.findPrNumber(sliceBranch)
		const feedback = await fetchPrFeedback(prNumber, { gh: deps.gh })
		deps.log(`${tag} fetched ${feedback.length} feedback item(s) from PR #${prNumber}`)
		const sandboxIn: SandboxIn = {
			slice: { id: slice.id, title: slice.title, body: slice.body },
			pr: { number: prNumber, branch: sliceBranch },
			feedback,
		}
		deps.log(`${tag} spawning address sandbox on ${sliceBranch}`)
		const verdict = await deps.spawnSandbox({ role: 'address', slice, branch: sliceBranch, sandboxIn })
		deps.log(`${tag} address verdict: ${verdict.verdict}, ${verdict.commits} commit(s)`)
		if (verdict.verdict === 'partial') return 'partial'
		if (verdict.verdict === 'ready') {
			if (verdict.commits > 0) {
				await deps.gitPush(sliceBranch)
				deps.log(`${tag} pushed ${sliceBranch}`)
			}
			await deps.backend.updateSlice(deps.prdId, slice.id, { needsRevision: false })
			deps.log(`${tag} cleared needsRevision`)
			return 'progress'
		}
		if (verdict.verdict === 'no-work-needed') {
			await deps.backend.updateSlice(deps.prdId, slice.id, { needsRevision: false })
			deps.log(`${tag} no-work-needed: cleared needsRevision`)
			return 'no-work'
		}
		return 'progress'
	}

	if (resumeState === 'review') {
		const sliceBranch = `prd-${deps.prdId}/slice-${slice.id}-${deps.slugify(slice.title)}`
		const prNumber = await deps.findPrNumber(sliceBranch)
		const sandboxIn: SandboxIn = {
			slice: { id: slice.id, title: slice.title, body: slice.body },
			pr: { number: prNumber, branch: sliceBranch },
		}
		deps.log(`${tag} spawning review sandbox on ${sliceBranch} (PR #${prNumber})`)
		const verdict = await deps.spawnSandbox({ role: 'review', slice, branch: sliceBranch, sandboxIn })
		deps.log(`${tag} review verdict: ${verdict.verdict}, ${verdict.commits} commit(s)`)
		if (verdict.verdict === 'partial') return 'partial'
		if (verdict.verdict === 'ready') {
			if (verdict.commits > 0) {
				await deps.gitPush(sliceBranch)
				deps.log(`${tag} pushed ${sliceBranch}`)
			}
			const result = await deps.gh(['pr', 'ready', String(prNumber)])
			if (!result.ok) throw new Error(`gh pr ready failed: ${result.error.message}`)
			deps.log(`${tag} marked PR #${prNumber} ready for merge`)
			return 'progress'
		}
		if (verdict.verdict === 'needs-revision') {
			if (verdict.commits > 0) {
				await deps.gitPush(sliceBranch)
				deps.log(`${tag} pushed ${sliceBranch}`)
			}
			await deps.backend.updateSlice(deps.prdId, slice.id, { needsRevision: true })
			deps.log(`${tag} flagged needsRevision`)
			return 'progress'
		}
		return 'progress'
	}

	if (resumeState === 'implement') {
		const slug = deps.slugify(slice.title)
		const sliceBranch = await createSliceBranch({ gh: deps.gh, gitFetch: deps.gitFetch }, deps.prdId, slice.id, slug, deps.integrationBranch)
		deps.log(`${tag} created slice branch ${sliceBranch}`)
		const sandboxIn: SandboxIn = { slice: { id: slice.id, title: slice.title, body: slice.body } }
		deps.log(`${tag} spawning implement sandbox on ${sliceBranch}`)
		const verdict = await deps.spawnSandbox({ role: 'implement', slice, branch: sliceBranch, sandboxIn })
		deps.log(`${tag} implement verdict: ${verdict.verdict}, ${verdict.commits} commit(s)`)
		if (verdict.verdict === 'partial') return 'partial'
		if (verdict.verdict === 'no-work-needed') {
			await deps.backend.updateSlice(deps.prdId, slice.id, { readyForAgent: false })
			deps.log(`${tag} no-work-needed: cleared readyForAgent`)
			return 'no-work'
		}
		if (verdict.verdict === 'ready') {
			await deps.gitPush(sliceBranch)
			deps.log(`${tag} pushed ${sliceBranch}`)
			if (deps.config.usePrs) {
				const result = await deps.gh([
					'pr',
					'create',
					'--draft',
					'--title',
					slice.title,
					'--head',
					sliceBranch,
					'--base',
					deps.integrationBranch,
					'--body',
					`Closes #${slice.id}`,
				])
				if (!result.ok) throw new Error(`gh pr create failed: ${result.error.message}`)
				deps.log(`${tag} opened draft PR for ${sliceBranch}`)
			} else {
				await deps.gitCheckout(deps.integrationBranch)
				await deps.gitMergeNoFf(sliceBranch)
				await deps.gitPush(deps.integrationBranch)
				await deps.gitDeleteRemoteBranch(sliceBranch)
				deps.log(`${tag} merged ${sliceBranch} into ${deps.integrationBranch}; deleted slice branch`)
				const closeResult = await deps.gh(['issue', 'close', slice.id])
				if (!closeResult.ok) throw new Error(`gh issue close failed: ${closeResult.error.message}`)
				deps.log(`${tag} closed sub-issue #${slice.id}`)
			}
			return 'progress'
		}
		// Coerced invalid verdict (e.g. parseVerdict treated something role-invalid as partial; but if a raw verdict slipped through, treat as progress).
		return 'progress'
	}

	return 'partial'
}

if (import.meta.vitest) {
	const { describe, test, expect } = import.meta.vitest

	const base: ClassifyInput = {
		state: 'OPEN',
		readyForAgent: true,
		needsRevision: false,
		prState: null,
		branchAhead: false,
	}

	describe('classifyResumeState', () => {
		test('ready slice with no PR and no branch ahead → implement', () => {
			expect(classifyResumeState(base)).toBe('implement')
		})

		test('CLOSED slice → done (even when other signals would say otherwise)', () => {
			expect(classifyResumeState({ ...base, state: 'CLOSED', needsRevision: true, prState: 'draft' })).toBe('done')
		})

		test('!readyForAgent → done (loop has no work)', () => {
			expect(classifyResumeState({ ...base, readyForAgent: false })).toBe('done')
		})

		test('prState merged → done', () => {
			expect(classifyResumeState({ ...base, prState: 'merged' })).toBe('done')
		})

		test('prState ready (PR ready for merge) → done', () => {
			expect(classifyResumeState({ ...base, prState: 'ready' })).toBe('done')
		})

		test('needsRevision (with an open PR) → address', () => {
			expect(classifyResumeState({ ...base, needsRevision: true, prState: 'draft' })).toBe('address')
		})

		test('prState draft (no needsRevision) → review', () => {
			expect(classifyResumeState({ ...base, prState: 'draft' })).toBe('review')
		})

		test('branch ahead of integration with no PR → create-pr-then-review (self-heal)', () => {
			expect(classifyResumeState({ ...base, prState: null, branchAhead: true })).toBe('create-pr-then-review')
		})
	})

	describe('processIssueSlice', () => {
		function makeIssueSlice(overrides: Partial<Slice> = {}): Slice {
			return {
				id: '145',
				title: 'Session Middleware',
				body: 'wire JWT validation into the request path',
				state: 'OPEN',
				readyForAgent: true,
				needsRevision: false,
				bucket: 'ready',
				blockedBy: [],
				prState: null,
				branchAhead: false,
				...overrides,
			}
		}

		function makeDeps(overrides: Partial<PerSliceDeps> = {}): PerSliceDeps {
			const backend: Backend = {
				name: 'issue',
				defaultBranchPrefix: '',
				createPrd: async () => ({ id: 'x', branch: 'x' }),
				branchForExisting: async () => 'x',
				findPrd: async () => null,
				listPrds: async () => [],
				close: async () => {},
				createSlice: async () => {
					throw new Error('not used')
				},
				findSlices: async () => [],
				updateSlice: async () => {},
			}
			return {
				backend,
				prdId: '142',
				integrationBranch: 'prds-issue-142',
				gh: async () => ({ ok: true, stdout: '', stderr: '' }),
				gitFetch: async () => {},
				gitPush: async () => {},
				gitCheckout: async () => {},
				gitMergeNoFf: async () => {},
				gitDeleteRemoteBranch: async () => {},
				findPrNumber: async () => 168,
				spawnSandbox: async () => ({ verdict: 'partial', notes: 'stop', commits: 0 }),
				log: () => {},
				slugify: (t) => t.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''),
				config: { usePrs: true, sliceStepCap: 1 },
				...overrides,
			}
		}

		test('blocked slice: skipped, no sandbox spawn, returns no-work', async () => {
			const slice = makeIssueSlice({ bucket: 'blocked', blockedBy: ['144'] })
			let sandboxCalled = false
			const outcome = await processIssueSlice(slice, makeDeps({
				spawnSandbox: async () => {
					sandboxCalled = true
					return { verdict: 'partial', notes: 'x', commits: 0 }
				},
			}))
			expect(sandboxCalled).toBe(false)
			expect(outcome).toBe('no-work')
		})

		test('runIssueLoop: a slice that throws is logged, added to skip set, and not retried in subsequent iterations', async () => {
			const sliceA = makeIssueSlice({ id: 'a' })
			const sliceB = makeIssueSlice({ id: 'b' })
			const spawnCalls: string[] = []
			const logs: string[] = []
			const deps = makeDeps({
				spawnSandbox: async ({ slice }) => {
					spawnCalls.push(slice.id)
					if (slice.id === 'a') throw new Error('docker unreachable')
					return { verdict: 'partial', notes: 'stop', commits: 0 }
				},
				log: (m) => logs.push(m),
			})
			// Always return both slices as actionable; only the skip-set should keep 'a' out.
			deps.backend.findSlices = async () => [{ ...sliceA }, { ...sliceB }]
			const loopDeps: IssueLoopDeps = {
				...deps,
				config: { ...deps.config, maxIterations: 3, maxConcurrent: 5 },
			}

			await runIssueLoop('142', loopDeps)

			// 'a' spawns once (iter 1), then never again. 'b' spawns each iteration.
			expect(spawnCalls.filter((id) => id === 'a')).toHaveLength(1)
			expect(spawnCalls.filter((id) => id === 'b')).toHaveLength(3)
			expect(logs.some((m) => /slice-a\] error: docker unreachable/.test(m))).toBe(true)
		})

		test('runIssueLoop: one slice throwing does not block sibling slices in the same batch', async () => {
			const sliceA = makeIssueSlice({ id: 'a' })
			const sliceB = makeIssueSlice({ id: 'b' })
			const spawned: string[] = []
			const deps = makeDeps({
				spawnSandbox: async ({ slice }) => {
					spawned.push(slice.id)
					if (slice.id === 'a') throw new Error('boom')
					return { verdict: 'partial', notes: 'stop', commits: 0 }
				},
			})
			deps.backend.findSlices = async () => [{ ...sliceA }, { ...sliceB }]
			const loopDeps: IssueLoopDeps = {
				...deps,
				config: { ...deps.config, maxIterations: 1, maxConcurrent: 2 },
			}

			await runIssueLoop('142', loopDeps)

			expect(spawned).toContain('a')
			expect(spawned).toContain('b')
		})

		test('runIssueLoop: blocked slices excluded from actionable filter', async () => {
			const blocked = makeIssueSlice({ id: 'b', bucket: 'blocked', blockedBy: ['a'] })
			const ready = makeIssueSlice({ id: 'r' })
			const sandboxIds: string[] = []
			const deps = makeDeps({
				spawnSandbox: async ({ slice }) => {
					sandboxIds.push(slice.id)
					return { verdict: 'partial', notes: 'stop', commits: 0 }
				},
			})
			let findCalls = 0
			deps.backend.findSlices = async () => {
				findCalls += 1
				if (findCalls === 1) return [blocked, ready]
				return [blocked, { ...ready, state: 'CLOSED' as const, bucket: 'done' as const }]
			}
			const loopDeps: IssueLoopDeps = {
				...deps,
				config: { ...deps.config, maxIterations: 3, maxConcurrent: 5 },
			}
			await runIssueLoop('142', loopDeps)
			expect(sandboxIds).toEqual(['r'])
		})

		test('on implement state: spawns the implementer sandbox with role=implement and slice spec', async () => {
			const slice = makeIssueSlice()
			let captured: { role: Role; sliceId: string; sandboxIn: SandboxIn } | null = null
			await processIssueSlice(slice, makeDeps({
				spawnSandbox: async ({ role, slice: s, sandboxIn }) => {
					captured = { role, sliceId: s.id, sandboxIn }
					return { verdict: 'partial', notes: 'stop here', commits: 0 }
				},
			}))
			expect(captured).not.toBeNull()
			expect(captured!.role).toBe('implement')
			expect(captured!.sliceId).toBe('145')
			expect(captured!.sandboxIn.slice).toEqual({ id: '145', title: 'Session Middleware', body: 'wire JWT validation into the request path' })
		})

		test('runIssueLoop: hitting maxIterations exits the loop and logs a message', async () => {
			const slice = makeIssueSlice()
			const logs: string[] = []
			const deps = makeDeps({
				spawnSandbox: async () => ({ verdict: 'partial', notes: 'always stuck', commits: 0 }),
				log: (msg) => logs.push(msg),
			})
			// findSlices always returns the same slice as actionable; queue never drains.
			deps.backend.findSlices = async () => [{ ...slice }]
			const loopDeps: IssueLoopDeps = {
				...deps,
				config: { ...deps.config, maxIterations: 3, maxConcurrent: 1 },
			}

			await runIssueLoop('142', loopDeps)

			expect(logs.some((m) => /maxIterations \(3\)/.test(m))).toBe(true)
		})

		test('runIssueLoop with maxConcurrent=2: at most 2 sandboxes running at once across 4 ready slices', async () => {
			const slices: Slice[] = ['1', '2', '3', '4'].map((id) => makeIssueSlice({ id }))
			let findCalls = 0
			let live = 0
			let peakLive = 0
			const deps = makeDeps({
				spawnSandbox: async () => {
					live += 1
					peakLive = Math.max(peakLive, live)
					await new Promise((r) => setTimeout(r, 10))
					live -= 1
					return { verdict: 'partial', notes: 'stop', commits: 0 }
				},
			})
			deps.backend.findSlices = async () => {
				findCalls += 1
				if (findCalls === 1) return slices.map((s) => ({ ...s }))
				return slices.map((s) => ({ ...s, state: 'CLOSED' as const, bucket: 'done' as const }))
			}
			const loopDeps: IssueLoopDeps = {
				...deps,
				config: { ...deps.config, maxIterations: 5, maxConcurrent: 2 },
			}

			await runIssueLoop('142', loopDeps)

			expect(peakLive).toBeLessThanOrEqual(2)
		})

		test('runIssueLoop: processes one ready slice; exits when next findSlices shows nothing actionable', async () => {
			let findCalls = 0
			const slice = makeIssueSlice()
			let sandboxCalls = 0
			const deps = makeDeps({
				spawnSandbox: async () => {
					sandboxCalls += 1
					return { verdict: 'partial', notes: 'stop', commits: 0 }
				},
			})
			deps.backend.findSlices = async () => {
				findCalls += 1
				if (findCalls === 1) return [{ ...slice }]
				return [{ ...slice, state: 'CLOSED' as const, bucket: 'done' as const }]
			}
			const loopDeps: IssueLoopDeps = {
				...deps,
				config: { ...deps.config, maxIterations: 5, maxConcurrent: 3 },
			}

			await runIssueLoop('142', loopDeps)

			expect(sandboxCalls).toBe(1)
			expect(findCalls).toBeGreaterThanOrEqual(2)
		})

		test('inner step-cap loop: a slice goes implement → review in one call when sliceStepCap >= 2', async () => {
			const initial = makeIssueSlice()
			const afterImplement: Slice = { ...initial, prState: 'draft', bucket: 'in-flight' }
			let callCount = 0
			const ghCalls: string[][] = []
			const sandboxRoles: Role[] = []
			const deps = makeDeps({
				gh: async (args) => {
					ghCalls.push(args)
					return { ok: true, stdout: '', stderr: '' }
				},
				spawnSandbox: async ({ role }) => {
					sandboxRoles.push(role)
					return { verdict: 'ready', commits: 1 }
				},
				config: { usePrs: true, sliceStepCap: 5 },
			})
			// Need a non-empty backend findSlices so the inner loop's refetch works.
			void callCount
			// First call returns the initial slice (so the loop's first re-fetch sees the post-implement state).
			deps.backend.findSlices = async () => {
				callCount += 1
				return [callCount === 1 ? afterImplement : { ...afterImplement, prState: 'ready' as const }]
			}

			await processIssueSlice(initial, deps)

			// Implementer ran on initial, reviewer ran on post-implement state.
			expect(sandboxRoles).toEqual(['implement', 'review'])
			expect(ghCalls.find((c) => c[0] === 'pr' && c[1] === 'create')).toBeTruthy()
			expect(ghCalls.find((c) => c[0] === 'pr' && c[1] === 'ready')).toBeTruthy()
		})

		test('create-pr-then-review: just opens the draft PR (no sandbox), then exits as progress', async () => {
			const slice = makeIssueSlice({ branchAhead: true })
			const ghCalls: string[][] = []
			let sandboxCalled = false
			await processIssueSlice(slice, makeDeps({
				gh: async (args) => {
					ghCalls.push(args)
					return { ok: true, stdout: '', stderr: '' }
				},
				spawnSandbox: async () => {
					sandboxCalled = true
					return { verdict: 'ready', commits: 1 }
				},
			}))
			expect(sandboxCalled).toBe(false)
			expect(ghCalls).toContainEqual([
				'pr',
				'create',
				'--draft',
				'--title',
				'Session Middleware',
				'--head',
				'prd-142/slice-145-session-middleware',
				'--base',
				'prds-issue-142',
				'--body',
				'Closes #145',
			])
		})

		test('address + ready verdict + commits > 0: pushes the slice branch before clearing needsRevision', async () => {
			const slice = makeIssueSlice({ prState: 'draft', needsRevision: true })
			const pushedBranches: string[] = []
			await processIssueSlice(slice, makeDeps({
				gh: async (args) => {
					if (args[0] === 'api' && args[1]!.endsWith('/comments')) return { ok: true, stdout: '[]', stderr: '' }
					if (args[0] === 'pr' && args[1] === 'view' && args.includes('reviews')) return { ok: true, stdout: '{"reviews":[]}', stderr: '' }
					if (args[0] === 'pr' && args[1] === 'view' && args.includes('comments')) return { ok: true, stdout: '{"comments":[]}', stderr: '' }
					return { ok: true, stdout: '', stderr: '' }
				},
				gitPush: async (b) => {
					pushedBranches.push(b)
				},
				findPrNumber: async () => 168,
				spawnSandbox: async () => ({ verdict: 'ready', commits: 3 }),
			}))
			expect(pushedBranches).toEqual(['prd-142/slice-145-session-middleware'])
		})

		test('address + ready verdict: spawns addresser sandbox with feedback, then clears needsRevision via backend.updateSlice', async () => {
			const slice = makeIssueSlice({ prState: 'draft', needsRevision: true })
			const ghCalls: string[][] = []
			const updateCalls: Array<{ id: string; patch: Record<string, unknown> }> = []
			let sandboxRole: Role | null = null
			let sandboxFeedback: unknown = undefined
			const deps = makeDeps({
				gh: async (args) => {
					ghCalls.push(args)
					// stub the three feedback fetches as empty
					if (args[0] === 'api' && args[1]!.endsWith('/comments')) return { ok: true, stdout: '[]', stderr: '' }
					if (args[0] === 'pr' && args[1] === 'view' && args.includes('reviews')) return { ok: true, stdout: '{"reviews":[]}', stderr: '' }
					if (args[0] === 'pr' && args[1] === 'view' && args.includes('comments')) return { ok: true, stdout: '{"comments":[]}', stderr: '' }
					return { ok: true, stdout: '', stderr: '' }
				},
				spawnSandbox: async ({ role, sandboxIn }) => {
					sandboxRole = role
					sandboxFeedback = sandboxIn.feedback
					return { verdict: 'ready', commits: 1 }
				},
			})
			deps.backend.updateSlice = async (_p, sliceId, patch) => {
				updateCalls.push({ id: sliceId, patch })
			}

			await processIssueSlice(slice, deps)

			expect(sandboxRole).toBe('address')
			expect(sandboxFeedback).toEqual([])
			expect(updateCalls).toContainEqual({ id: '145', patch: { needsRevision: false } })
		})

		test('review + needs-revision verdict: flips slice.needsRevision via backend.updateSlice; PR not marked ready', async () => {
			const slice = makeIssueSlice({ prState: 'draft' })
			const ghCalls: string[][] = []
			const updateCalls: Array<{ id: string; patch: Record<string, unknown> }> = []
			const deps = makeDeps({
				gh: async (args) => {
					ghCalls.push(args)
					return { ok: true, stdout: '', stderr: '' }
				},
				spawnSandbox: async () => ({ verdict: 'needs-revision', notes: 'add tests for the edge case', commits: 0 }),
			})
			deps.backend.updateSlice = async (_p, sliceId, patch) => {
				updateCalls.push({ id: sliceId, patch })
			}

			await processIssueSlice(slice, deps)

			expect(updateCalls).toContainEqual({ id: '145', patch: { needsRevision: true } })
			expect(ghCalls.find((c) => c[0] === 'pr' && c[1] === 'ready')).toBeUndefined()
		})

		test('review + ready verdict: spawns reviewer sandbox on the slice branch, then runs `gh pr ready <prNumber>`', async () => {
			const slice = makeIssueSlice({ prState: 'draft' })
			const ghCalls: string[][] = []
			let sandboxRole: Role | null = null
			let sandboxBranch: string | null = null
			await processIssueSlice(slice, makeDeps({
				gh: async (args) => {
					ghCalls.push(args)
					return { ok: true, stdout: '', stderr: '' }
				},
				findPrNumber: async () => 168,
				spawnSandbox: async ({ role, branch }) => {
					sandboxRole = role
					sandboxBranch = branch
					return { verdict: 'ready', commits: 1 }
				},
			}))
			expect(sandboxRole).toBe('review')
			expect(sandboxBranch).toBe('prd-142/slice-145-session-middleware')
			expect(ghCalls).toContainEqual(['pr', 'ready', '168'])
		})

		test('all `if commits > 0` gates skip the push when commits === 0 (reviewer ready, reviewer needs-revision, addresser ready)', async () => {
			const stubFeedbackGh = async (args: string[]) => {
				if (args[0] === 'api' && args[1]!.endsWith('/comments')) return { ok: true as const, stdout: '[]', stderr: '' }
				if (args[0] === 'pr' && args[1] === 'view' && args.includes('reviews')) return { ok: true as const, stdout: '{"reviews":[]}', stderr: '' }
				if (args[0] === 'pr' && args[1] === 'view' && args.includes('comments')) return { ok: true as const, stdout: '{"comments":[]}', stderr: '' }
				return { ok: true as const, stdout: '', stderr: '' }
			}

			// reviewer ready, zero commits → gh pr ready fires, no push
			const reviewerReadyPushes: string[] = []
			const reviewerReadyGh: string[][] = []
			await processIssueSlice(makeIssueSlice({ prState: 'draft' }), makeDeps({
				gh: async (args) => {
					reviewerReadyGh.push(args)
					return { ok: true, stdout: '', stderr: '' }
				},
				gitPush: async (b) => {
					reviewerReadyPushes.push(b)
				},
				findPrNumber: async () => 168,
				spawnSandbox: async () => ({ verdict: 'ready', commits: 0 }),
			}))
			expect(reviewerReadyPushes).toEqual([])
			expect(reviewerReadyGh).toContainEqual(['pr', 'ready', '168'])

			// reviewer needs-revision, zero commits → updateSlice fires, no push
			const reviewerNrPushes: string[] = []
			const reviewerNrUpdates: Array<{ id: string; patch: Record<string, unknown> }> = []
			const reviewerNrDeps = makeDeps({
				gitPush: async (b) => {
					reviewerNrPushes.push(b)
				},
				findPrNumber: async () => 168,
				spawnSandbox: async () => ({ verdict: 'needs-revision', commits: 0 }),
			})
			reviewerNrDeps.backend.updateSlice = async (_p, sliceId, patch) => {
				reviewerNrUpdates.push({ id: sliceId, patch })
			}
			await processIssueSlice(makeIssueSlice({ prState: 'draft' }), reviewerNrDeps)
			expect(reviewerNrPushes).toEqual([])
			expect(reviewerNrUpdates).toContainEqual({ id: '145', patch: { needsRevision: true } })

			// addresser ready, zero commits → updateSlice fires, no push
			const addresserPushes: string[] = []
			const addresserUpdates: Array<{ id: string; patch: Record<string, unknown> }> = []
			const addresserDeps = makeDeps({
				gh: stubFeedbackGh,
				gitPush: async (b) => {
					addresserPushes.push(b)
				},
				findPrNumber: async () => 168,
				spawnSandbox: async () => ({ verdict: 'ready', commits: 0 }),
			})
			addresserDeps.backend.updateSlice = async (_p, sliceId, patch) => {
				addresserUpdates.push({ id: sliceId, patch })
			}
			await processIssueSlice(makeIssueSlice({ prState: 'draft', needsRevision: true }), addresserDeps)
			expect(addresserPushes).toEqual([])
			expect(addresserUpdates).toContainEqual({ id: '145', patch: { needsRevision: false } })
		})

		test('review + ready verdict + commits > 0: pushes the slice branch before `gh pr ready`', async () => {
			const slice = makeIssueSlice({ prState: 'draft' })
			const pushedBranches: string[] = []
			await processIssueSlice(slice, makeDeps({
				gitPush: async (b) => {
					pushedBranches.push(b)
				},
				findPrNumber: async () => 168,
				spawnSandbox: async () => ({ verdict: 'ready', commits: 2 }),
			}))
			expect(pushedBranches).toEqual(['prd-142/slice-145-session-middleware'])
		})

		test('implement + ready verdict + usePrs=false: pushes slice branch, merges --no-ff into integration, pushes integration, deletes slice branch, closes sub-issue', async () => {
			const slice = makeIssueSlice()
			const ghCalls: string[][] = []
			const pushCalls: string[] = []
			const checkoutCalls: string[] = []
			const mergeCalls: string[] = []
			const deleteRemoteCalls: string[] = []
			await processIssueSlice(slice, makeDeps({
				gh: async (args) => {
					ghCalls.push(args)
					return { ok: true, stdout: '', stderr: '' }
				},
				gitPush: async (b) => {
					pushCalls.push(b)
				},
				gitCheckout: async (b) => {
					checkoutCalls.push(b)
				},
				gitMergeNoFf: async (b) => {
					mergeCalls.push(b)
				},
				gitDeleteRemoteBranch: async (b) => {
					deleteRemoteCalls.push(b)
				},
				spawnSandbox: async () => ({ verdict: 'ready', commits: 1 }),
				config: { usePrs: false, sliceStepCap: 1 },
			}))
			const expectedBranch = 'prd-142/slice-145-session-middleware'
			// Order matters: push slice → checkout integration → merge slice → push integration → delete slice branch
			expect(pushCalls).toEqual([expectedBranch, 'prds-issue-142'])
			expect(checkoutCalls).toEqual(['prds-issue-142'])
			expect(mergeCalls).toEqual([expectedBranch])
			expect(deleteRemoteCalls).toEqual([expectedBranch])
			// No `gh pr create` in this mode
			expect(ghCalls.find((c) => c[0] === 'pr' && c[1] === 'create')).toBeUndefined()
			// Sub-issue closed
			expect(ghCalls).toContainEqual(['issue', 'close', '145'])
		})

		test('implement + no-work-needed verdict: clears readyForAgent on the slice; no push, no PR', async () => {
			const slice = makeIssueSlice()
			const ghCalls: string[][] = []
			const pushCalls: string[] = []
			const updateCalls: Array<{ id: string; patch: Record<string, unknown> }> = []
			const deps = makeDeps({
				gh: async (args) => {
					ghCalls.push(args)
					return { ok: true, stdout: '', stderr: '' }
				},
				gitPush: async (b) => {
					pushCalls.push(b)
				},
				spawnSandbox: async () => ({ verdict: 'no-work-needed', notes: 'spec already met', commits: 0 }),
			})
			deps.backend.updateSlice = async (_p, sliceId, patch) => {
				updateCalls.push({ id: sliceId, patch })
			}

			const outcome = await processIssueSlice(slice, deps)

			expect(outcome).toBe('no-work')
			expect(pushCalls).toEqual([])
			expect(ghCalls.find((c) => c[0] === 'pr' && c[1] === 'create')).toBeUndefined()
			expect(updateCalls).toContainEqual({ id: '145', patch: { readyForAgent: false } })
		})

		test('implement + ready verdict + usePrs=true: pushes slice branch and creates a draft PR', async () => {
			const slice = makeIssueSlice()
			const ghCalls: string[][] = []
			const pushCalls: string[] = []
			const outcome = await processIssueSlice(slice, makeDeps({
				gh: async (args) => {
					ghCalls.push(args)
					return { ok: true, stdout: '', stderr: '' }
				},
				gitPush: async (b) => {
					pushCalls.push(b)
				},
				spawnSandbox: async () => ({ verdict: 'ready', commits: 1 }),
			}))
			const expectedBranch = 'prd-142/slice-145-session-middleware'
			expect(outcome).toBe('partial') // sliceStepCap=1; phase progressed; slice still in-flight after
			expect(pushCalls).toEqual([expectedBranch])
			expect(ghCalls).toContainEqual([
				'pr',
				'create',
				'--draft',
				'--title',
				'Session Middleware',
				'--head',
				expectedBranch,
				'--base',
				'prds-issue-142',
				'--body',
				'Closes #145',
			])
		})

		test('on implement state: creates the slice branch via gh issue develop, fetches it, then spawns the sandbox on that branch', async () => {
			const slice = makeIssueSlice()
			const ghCalls: string[][] = []
			const fetchCalls: string[] = []
			let sandboxBranch: string | null = null
			await processIssueSlice(slice, makeDeps({
				gh: async (args) => {
					ghCalls.push(args)
					return { ok: true, stdout: '', stderr: '' }
				},
				gitFetch: async (b) => {
					fetchCalls.push(b)
				},
				spawnSandbox: async ({ branch }) => {
					sandboxBranch = branch
					return { verdict: 'partial', notes: 'stop', commits: 0 }
				},
			}))
			const expectedBranch = 'prd-142/slice-145-session-middleware'
			expect(ghCalls).toContainEqual(['issue', 'develop', '145', '--name', expectedBranch, '--base', 'prds-issue-142'])
			expect(fetchCalls).toContain(expectedBranch)
			expect(sandboxBranch).toBe(expectedBranch)
		})
	})
}
