import type { Config } from '../config'
import { exitOnCommandError, loadCommandBase } from './runtime.ts'
import { createIssueStorage } from '../storages/implementations/issue.ts'
import type { StorageDeps } from '../storages/types.ts'
import type { GhOps, IssueSummary, RawSubIssue } from '../utils/gh-ops.ts'
import type { GitOps } from '../utils/git-ops.ts'
import { withMutationLock } from '../utils/mutation-lock.ts'
import { slug as slugify } from '../utils/slug.ts'

export type BranchMetadataRepairMode = 'dry-run' | 'apply'

export type BranchMetadataRepairRuntime = {
	gh: GhOps
	git: GitOps
	labels: Config['labels']
	abortOptions: Config['abort']
	projectRoot: string
	repoRoot: string
	changesDir: string
	perSliceBranches: boolean
	targetBranch?: string
	stdout: (s: string) => void
}

type BranchMetadataRepairOptions = {
	mode: BranchMetadataRepairMode
	perSliceBranches?: boolean
	targetBranch?: string
}

type TrowelMetadata = Record<string, unknown>
type IssueKind = 'Change' | 'Slice'
type MetadataPatch = Record<string, string>
type PlannedPatch = {
	kind: IssueKind
	issueId: string
	title: string
	patch: MetadataPatch
	newBody: string
}

export async function runRepairBranchMetadata(rt: BranchMetadataRepairRuntime, opts: BranchMetadataRepairOptions): Promise<void> {
	const targetBranch = opts.targetBranch ?? rt.targetBranch ?? (await rt.git.baseBranch())
	const perSliceBranches = opts.perSliceBranches ?? rt.perSliceBranches
	const patches = await planIssueBranchMetadataPatches(rt, { targetBranch, perSliceBranches })
	if (patches.length === 0) {
		rt.stdout('No issue-storage branch metadata patches needed.\n')
		return
	}
	printPatchPlan(rt, patches, opts.mode, targetBranch, perSliceBranches)
	if (opts.mode === 'dry-run') return
	for (const patch of patches) await rt.gh.editIssueBody(patch.issueId, patch.newBody)
	rt.stdout(`Applied ${patches.length} issue-storage branch metadata patch(es).\n`)
	await assertStrictIssueStorageCanRead(rt)
	rt.stdout('Strict issue storage reads succeeded after repair.\n')
}

async function planIssueBranchMetadataPatches(
	rt: BranchMetadataRepairRuntime,
	opts: { targetBranch: string; perSliceBranches: boolean },
): Promise<PlannedPatch[]> {
	const patches: PlannedPatch[] = []
	const changes = await rt.gh.listIssues({ label: rt.labels.change, state: 'all' })
	for (const change of changes) {
		const changeMeta = metadataFromBody(change.body)
		const changeBranch = metadataString(changeMeta, 'changeBranch') ?? legacyChangeBranchName(change)
		const changePatch = missingChangeMetadataPatch(changeMeta, opts.targetBranch, changeBranch)
		if (Object.keys(changePatch).length > 0) patches.push(plannedPatch('Change', change, changePatch))
		patches.push(...(await planSlicePatches(rt, String(change.number), changeBranch, opts.perSliceBranches)))
	}
	return patches
}

async function planSlicePatches(
	rt: BranchMetadataRepairRuntime,
	changeId: string,
	changeBranch: string,
	perSliceBranches: boolean,
): Promise<PlannedPatch[]> {
	const slices = await rt.gh.listSubIssues(changeId)
	return slices.flatMap((slice) => {
		const meta = metadataFromBody(slice.body)
		if (metadataString(meta, 'sliceBranch') !== null) return []
		const sliceBranch = perSliceBranches ? legacySliceBranchName(changeId, slice) : changeBranch
		return [plannedPatch('Slice', issueLike(slice), { sliceBranch })]
	})
}

function missingChangeMetadataPatch(meta: TrowelMetadata, targetBranch: string, changeBranch: string): MetadataPatch {
	const patch: MetadataPatch = {}
	if (metadataString(meta, 'targetBranch') === null) patch.targetBranch = targetBranch
	if (metadataString(meta, 'changeBranch') === null) patch.changeBranch = changeBranch
	return patch
}

function plannedPatch(kind: IssueKind, issue: Pick<IssueSummary, 'number' | 'title' | 'body'>, patch: MetadataPatch): PlannedPatch {
	return {
		kind,
		issueId: String(issue.number),
		title: issue.title,
		patch,
		newBody: replaceOrAppendMetadata(issue.body, { ...metadataFromBody(issue.body), ...patch }),
	}
}

function issueLike(issue: RawSubIssue): Pick<IssueSummary, 'number' | 'title' | 'body'> {
	return { number: issue.number, title: issue.title, body: issue.body }
}

function legacyChangeBranchName(issue: Pick<IssueSummary, 'number' | 'title'>): string {
	return `change-${issue.number}-${slugify(issue.title)}`
}

function legacySliceBranchName(changeId: string, issue: Pick<RawSubIssue, 'number' | 'title'>): string {
	return `change-${changeId}/slice-${issue.number}-${slugify(issue.title)}`
}

function metadataString(meta: TrowelMetadata, key: string): string | null {
	const value = meta[key]
	return typeof value === 'string' && value.length > 0 ? value : null
}

function metadataFromBody(body: string | null | undefined): TrowelMetadata {
	const raw = trowelMetadataFromBody(body)
	if (!raw) return {}
	try {
		const parsed = JSON.parse(raw) as unknown
		if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as TrowelMetadata
	} catch {
		// Fall through to loud repair failure below.
	}
	throw new Error('issue body contains invalid Trowel metadata JSON')
}

function trowelMetadataFromBody(body: string | null | undefined): string | null {
	const match = /<!--\s*trowel:(.*?)-->/s.exec(body ?? '')
	return match?.[1]?.trim() ?? null
}

function bodyWithoutMetadata(body: string): string {
	return body.replace(/\n?\n?<!--\s*trowel:.*?-->/s, '').trimEnd()
}

function replaceOrAppendMetadata(body: string, metadata: TrowelMetadata): string {
	const serialized = `<!-- trowel:${JSON.stringify(metadata)} -->`
	const publicBody = bodyWithoutMetadata(body)
	return publicBody ? `${publicBody}\n\n${serialized}` : serialized
}

function printPatchPlan(
	rt: BranchMetadataRepairRuntime,
	patches: PlannedPatch[],
	mode: BranchMetadataRepairMode,
	targetBranch: string,
	perSliceBranches: boolean,
): void {
	rt.stdout(`${mode === 'apply' ? 'Applying' : 'Dry run: would apply'} ${patches.length} issue-storage branch metadata patch(es).\n`)
	rt.stdout(`Target branch for missing Change metadata: ${targetBranch}\n`)
	rt.stdout(`Slice branch mode: ${perSliceBranches ? 'per-slice branches' : 'shared Change branch'}\n`)
	for (const patch of patches) {
		rt.stdout(`${patch.kind} #${patch.issueId} ${patch.title}\n`)
		for (const [key, value] of Object.entries(patch.patch)) rt.stdout(`  ${key}: ${value}\n`)
	}
}

async function assertStrictIssueStorageCanRead(rt: BranchMetadataRepairRuntime): Promise<void> {
	const storage = createIssueStorage(storageDepsForStrictRead(rt))
	const changes = await rt.gh.listIssues({ label: rt.labels.change, state: 'all' })
	for (const change of changes) {
		await storage.findChange(String(change.number))
		await storage.findSlices(String(change.number))
	}
}

function storageDepsForStrictRead(rt: BranchMetadataRepairRuntime): StorageDeps {
	return {
		gh: rt.gh,
		git: rt.git,
		repoRoot: rt.repoRoot,
		projectRoot: rt.projectRoot,
		changesDir: rt.changesDir,
		labels: rt.labels,
		abortOptions: rt.abortOptions,
	}
}

function parseRepairOptions(opts: {
	apply?: boolean
	dryRun?: boolean
	targetBranch?: string
	perSliceBranches?: boolean
	sharedSliceBranches?: boolean
}): BranchMetadataRepairOptions {
	if (opts.apply && opts.dryRun) throw new Error('choose either --apply or --dry-run, not both')
	if (opts.perSliceBranches && opts.sharedSliceBranches)
		throw new Error('choose either --per-slice-branches or --shared-slice-branches, not both')
	return {
		mode: opts.apply ? 'apply' : 'dry-run',
		targetBranch: opts.targetBranch,
		perSliceBranches: opts.perSliceBranches ? true : opts.sharedSliceBranches ? false : undefined,
	}
}

export async function repairBranchMetadata(opts: {
	apply?: boolean
	dryRun?: boolean
	targetBranch?: string
	perSliceBranches?: boolean
	sharedSliceBranches?: boolean
}): Promise<void> {
	const base = await loadCommandBase('repair branch-metadata')
	const parsed = parseRepairOptions(opts)
	await exitOnCommandError('repair branch-metadata', () =>
		withMutationLock(base.projectRoot, () =>
			runRepairBranchMetadata(
				{
					gh: base.gh,
					git: base.git,
					labels: base.config.labels,
					abortOptions: base.config.abort,
					projectRoot: base.projectRoot,
					repoRoot: base.projectRoot,
					changesDir: base.config.docs.changesDir,
					perSliceBranches: base.config.work.perSliceBranches,
					targetBranch: parsed.targetBranch,
					stdout: (s) => process.stdout.write(s),
				},
				parsed,
			),
		),
	)
}

if (import.meta.vitest) {
	const { describe, test, expect } = import.meta.vitest
	const { recordingGhOps } = await import('../test-utils/gh-ops-recorder.ts')
	const { noopGitOps } = await import('../test-utils/git-ops-fixtures.ts')

	function makeRt(
		overrides: Partial<BranchMetadataRepairRuntime> = {},
		data?: { changes: IssueSummary[]; slicesByChange: Record<string, RawSubIssue[]> },
	): { rt: BranchMetadataRepairRuntime; calls: unknown[][]; out: string[] } {
		const store = data ?? { changes: [], slicesByChange: {} }
		const { gh, calls } = recordingGhOps({
			listIssues: async () => store.changes,
			listSubIssues: async (changeId) => store.slicesByChange[changeId] ?? [],
			viewIssue: async (id) => {
				const change = store.changes.find((issue) => String(issue.number) === id)
				return change ? { number: change.number, title: change.title, state: 'OPEN', body: change.body, closedAt: null } : null
			},
			editIssueBody: async (id, body) => {
				const change = store.changes.find((issue) => String(issue.number) === id)
				if (change) change.body = body
				for (const slices of Object.values(store.slicesByChange)) {
					const slice = slices.find((issue) => String(issue.number) === id)
					if (slice) slice.body = body
				}
			},
		})
		const out: string[] = []
		return {
			rt: {
				gh,
				git: noopGitOps({ baseBranch: async () => 'main' }),
				labels: { change: 'change', readyForAgent: 'ready-for-agent', needsRevision: 'needs-revision' },
				abortOptions: { comment: null, deleteBranch: 'never' },
				projectRoot: '/tmp/trowel-repair-test',
				repoRoot: '/tmp/trowel-repair-test',
				changesDir: '/tmp/trowel-repair-test/.trowel/changes',
				perSliceBranches: true,
				stdout: (s) => {
					out.push(s)
				},
				...overrides,
			},
			calls,
			out,
		}
	}

	function trowelBody(body: string, metadata: Record<string, string>): string {
		return `${body}\n\n<!-- trowel:${JSON.stringify(metadata)} -->`
	}

	describe('repair branch-metadata', () => {
		test('dry-run shows intended issue-storage metadata patches without mutation', async () => {
			const data = {
				changes: [{ number: 42, title: 'Fix Tabs', createdAt: '2026-06-01T00:00:00Z', body: 'change body' }],
				slicesByChange: { '42': [{ number: 57, title: 'Implement Parser', body: 'slice body', state: 'open', labels: [] }] },
			}
			const { rt, calls, out } = makeRt({}, data)

			await runRepairBranchMetadata(rt, { mode: 'dry-run' })

			expect(out.join('')).toContain('Dry run: would apply 2 issue-storage branch metadata patch(es)')
			expect(out.join('')).toContain('Change #42 Fix Tabs')
			expect(out.join('')).toContain('changeBranch: change-42-fix-tabs')
			expect(out.join('')).toContain('targetBranch: main')
			expect(out.join('')).toContain('Slice #57 Implement Parser')
			expect(out.join('')).toContain('sliceBranch: change-42/slice-57-implement-parser')
			expect(calls.filter((call) => call[0] === 'editIssueBody')).toEqual([])
			expect(data.changes[0]!.body).toBe('change body')
			expect(data.slicesByChange['42']![0]!.body).toBe('slice body')
		})

		test('apply patches legacy issues, preserves existing metadata, and strict issue storage can read them', async () => {
			const data = {
				changes: [
					{
						number: 42,
						title: 'Fix Tabs',
						createdAt: '2026-06-01T00:00:00Z',
						body: trowelBody('change body', { owner: 'docs' }),
					},
				],
				slicesByChange: {
					'42': [
						{ number: 57, title: 'Implement Parser', body: 'slice body', state: 'open', labels: [{ name: 'ready-for-agent' }] },
					],
				},
			}
			const { rt, calls, out } = makeRt({}, data)

			await runRepairBranchMetadata(rt, { mode: 'apply', targetBranch: 'release/1.2' })

			expect(calls.filter((call) => call[0] === 'editIssueBody')).toHaveLength(2)
			expect(data.changes[0]!.body).toContain('"owner":"docs"')
			expect(data.changes[0]!.body).toContain('"targetBranch":"release/1.2"')
			expect(data.changes[0]!.body).toContain('"changeBranch":"change-42-fix-tabs"')
			expect(data.slicesByChange['42']![0]!.body).toContain('"sliceBranch":"change-42/slice-57-implement-parser"')
			expect(out.join('')).toContain('Strict issue storage reads succeeded after repair')
		})

		test('shared Slice branch mode records the Change branch as missing Slice metadata', async () => {
			const data = {
				changes: [
					{
						number: 42,
						title: 'Fix Tabs',
						createdAt: '2026-06-01T00:00:00Z',
						body: trowelBody('change body', { targetBranch: 'main', changeBranch: 'stored-change' }),
					},
				],
				slicesByChange: { '42': [{ number: 57, title: 'Implement Parser', body: 'slice body', state: 'open', labels: [] }] },
			}
			const { rt, out } = makeRt({ perSliceBranches: false }, data)

			await runRepairBranchMetadata(rt, { mode: 'dry-run' })

			expect(out.join('')).toContain('Slice branch mode: shared Change branch')
			expect(out.join('')).toContain('sliceBranch: stored-change')
		})
	})
}
