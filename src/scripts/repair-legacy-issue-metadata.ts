import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs, promisify } from 'node:util'

import { loadConfig } from '../config.ts'
import type { Config } from '../schema.ts'
import type { ShellResult } from '../utils/shell.ts'

export type RepoGhRunner = (args: string[], opts: { cwd: string }) => Promise<ShellResult>

type IssueSummary = {
	number: number
	title: string
	body: string | null
	state?: string
	createdAt?: string
}

type RepoIdentity = { owner: string; name: string }

type SubIssue = {
	number: number
	title: string
	body: string | null
	state?: string
}

type LinkedPullRequest = {
	number: number
	baseRefName: string
	headRefName: string
	state?: string
	url?: string
}

type Metadata = Record<string, unknown>

type MetadataRead =
	| { ok: true; metadata: Metadata }
	| { ok: false; error: string }

export type MetadataPatch = {
	issueNumber: number
	kind: 'change' | 'slice'
	changeNumber: number
	title: string
	patch: Metadata
	bodyBefore: string
	bodyAfter: string
}

export type RepairProblem = {
	issueNumber: number
	kind: 'change' | 'slice'
	changeNumber: number
	title: string
	reason: 'invalid-metadata' | 'unresolved' | 'ambiguous'
	message: string
}

export type RepairResult = {
	mode: 'dry-run' | 'apply'
	targetRepoPath: string
	projectRoot: string
	patches: MetadataPatch[]
	problems: RepairProblem[]
	exitCode: number
}

export type RepairOptions = {
	targetRepoPath: string
	apply?: boolean
	home?: string
	runner?: RepoGhRunner
	stdout?: (message: string) => void
}

const REQUIRED_CHANGE_KEYS = ['targetBranch', 'changeBranch'] as const
const REQUIRED_SLICE_KEYS = ['sliceBranch'] as const
const METADATA_RE = /<!--\s*trowel:(.*?)-->/s
const LINKED_PRS_QUERY = /* GraphQL */ `
query TrowelLinkedPullRequests($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    issue(number: $number) {
      closedByPullRequestsReferences(first: 50) {
        nodes {
          number
          baseRefName
          headRefName
          state
          url
        }
      }
      timelineItems(first: 100, itemTypes: [CONNECTED_EVENT, CROSS_REFERENCED_EVENT]) {
        nodes {
          __typename
          ... on ConnectedEvent {
            source {
              __typename
              ... on PullRequest { number baseRefName headRefName state url }
            }
            subject {
              __typename
              ... on PullRequest { number baseRefName headRefName state url }
            }
          }
          ... on CrossReferencedEvent {
            source {
              __typename
              ... on PullRequest { number baseRefName headRefName state url }
            }
            target {
              __typename
              ... on PullRequest { number baseRefName headRefName state url }
            }
          }
        }
      }
    }
  }
}`

export async function repairLegacyIssueMetadata(opts: RepairOptions): Promise<RepairResult> {
	const targetRepoPath = path.resolve(opts.targetRepoPath)
	const { config, projectRoot } = await loadConfig(targetRepoPath, opts.home ?? homedir())
	if (!projectRoot) throw new Error(`no target repo root found from ${targetRepoPath}`)
	if (config.storage !== 'issue') throw new Error(`target repo uses storage=${config.storage}; legacy issue metadata repair only supports issue storage`)

	const stdout = opts.stdout ?? ((message: string) => process.stdout.write(message))
	const gh = new RepoGh(projectRoot, opts.runner ?? defaultRepoGhRunner)
	const repo = await gh.repoIdentity()
	const changes = await gh.listIssues(config.labels.change)
	const plan = await planMetadataRepair({ gh, repo, config, changes })

	if (opts.apply) {
		for (const patch of plan.patches) await gh.editIssueBody(patch.issueNumber, patch.bodyAfter)
	}

	const result: RepairResult = {
		mode: opts.apply ? 'apply' : 'dry-run',
		targetRepoPath,
		projectRoot,
		patches: plan.patches,
		problems: plan.problems,
		exitCode: opts.apply && plan.problems.length > 0 ? 1 : 0,
	}
	stdout(formatRepairResult(result))
	return result
}

type PlanArgs = {
	gh: Pick<RepoGh, 'listSubIssues' | 'linkedPullRequests'>
	repo: RepoIdentity
	config: Config
	changes: IssueSummary[]
}

type RepairPlan = { patches: MetadataPatch[]; problems: RepairProblem[] }

async function planMetadataRepair(args: PlanArgs): Promise<RepairPlan> {
	const patches: MetadataPatch[] = []
	const problems: RepairProblem[] = []

	for (const change of args.changes) {
		const changeBody = change.body ?? ''
		const changeMeta = readMetadata(changeBody)
		let parentChangeBranch: string | undefined

		if (!changeMeta.ok) {
			problems.push(problemFor(change, 'change', change.number, 'invalid-metadata', changeMeta.error))
		} else {
			parentChangeBranch = metadataString(changeMeta.metadata, 'changeBranch')
			if (missingKeys(changeMeta.metadata, REQUIRED_CHANGE_KEYS).length > 0) {
				const prs = await args.gh.linkedPullRequests(args.repo, change.number)
				const resolution = resolveChangeBranches(prs)
				if (resolution.ok) {
					const patch = missingChangePatch(changeMeta.metadata, resolution.value)
					if (Object.keys(patch).length > 0) {
						const bodyAfter = bodyWithMergedMetadata(changeBody, patch)
						patches.push({ issueNumber: change.number, kind: 'change', changeNumber: change.number, title: change.title, patch, bodyBefore: changeBody, bodyAfter })
						parentChangeBranch = metadataString({ ...changeMeta.metadata, ...patch }, 'changeBranch')
					}
				} else {
					problems.push(problemFor(change, 'change', change.number, resolution.reason, resolution.message))
				}
			}
		}

		const slices = await args.gh.listSubIssues(change.number)
		for (const slice of slices) {
			const sliceBody = slice.body ?? ''
			const sliceMeta = readMetadata(sliceBody)
			if (!sliceMeta.ok) {
				problems.push(problemFor(slice, 'slice', change.number, 'invalid-metadata', sliceMeta.error))
				continue
			}
			if (missingKeys(sliceMeta.metadata, REQUIRED_SLICE_KEYS).length === 0) continue

			const resolution = await resolveSliceBranch({ gh: args.gh, repo: args.repo, slice, parentChangeBranch, perSliceBranches: args.config.work.perSliceBranches })
			if (!resolution.ok) {
				problems.push(problemFor(slice, 'slice', change.number, resolution.reason, resolution.message))
				continue
			}
			const patch = { sliceBranch: resolution.value.sliceBranch }
			patches.push({ issueNumber: slice.number, kind: 'slice', changeNumber: change.number, title: slice.title, patch, bodyBefore: sliceBody, bodyAfter: bodyWithMergedMetadata(sliceBody, patch) })
		}
	}

	return { patches, problems }
}

type Resolution<T> = { ok: true; value: T } | { ok: false; reason: 'unresolved' | 'ambiguous'; message: string }

function resolveChangeBranches(prs: LinkedPullRequest[]): Resolution<{ targetBranch: string; changeBranch: string }> {
	const pairs = uniqueBy(prs.filter(hasBothBranchNames), (pr) => `${pr.baseRefName}\0${pr.headRefName}`)
	if (pairs.length === 0) return { ok: false, reason: 'unresolved', message: 'no Development-linked PR with base/head branch names was found' }
	if (pairs.length > 1) {
		return {
			ok: false,
			reason: 'ambiguous',
			message: `multiple Development-linked PR branch pairs: ${pairs.map((pr) => `#${pr.number} ${pr.headRefName}->${pr.baseRefName}`).join(', ')}`,
		}
	}
	return { ok: true, value: { targetBranch: pairs[0]!.baseRefName, changeBranch: pairs[0]!.headRefName } }
}

async function resolveSliceBranch(args: {
	gh: Pick<RepoGh, 'linkedPullRequests'>
	repo: RepoIdentity
	slice: SubIssue
	parentChangeBranch: string | undefined
	perSliceBranches: boolean
}): Promise<Resolution<{ sliceBranch: string }>> {
	if (!args.perSliceBranches) {
		if (args.parentChangeBranch) return { ok: true, value: { sliceBranch: args.parentChangeBranch } }
		return { ok: false, reason: 'unresolved', message: 'slice should use parent Change branch, but the parent Change branch is unresolved' }
	}

	const prs = await args.gh.linkedPullRequests(args.repo, args.slice.number)
	const heads = uniqueBy(prs.filter((pr) => pr.headRefName), (pr) => pr.headRefName)
	if (heads.length === 0) return { ok: false, reason: 'unresolved', message: 'no Development-linked PR with a head branch name was found' }
	if (heads.length > 1) {
		return {
			ok: false,
			reason: 'ambiguous',
			message: `multiple Development-linked PR head branches: ${heads.map((pr) => `#${pr.number} ${pr.headRefName}`).join(', ')}`,
		}
	}
	return { ok: true, value: { sliceBranch: heads[0]!.headRefName } }
}

function missingChangePatch(metadata: Metadata, discovered: { targetBranch: string; changeBranch: string }): Metadata {
	const patch: Metadata = {}
	if (!metadataString(metadata, 'targetBranch')) patch.targetBranch = discovered.targetBranch
	if (!metadataString(metadata, 'changeBranch')) patch.changeBranch = discovered.changeBranch
	return patch
}

function missingKeys(metadata: Metadata, keys: readonly string[]): string[] {
	return keys.filter((key) => !metadataString(metadata, key))
}

function metadataString(metadata: Metadata, key: string): string | undefined {
	const value = metadata[key]
	return typeof value === 'string' && value.length > 0 ? value : undefined
}

function readMetadata(body: string): MetadataRead {
	const match = METADATA_RE.exec(body)
	if (!match) return { ok: true, metadata: {} }
	try {
		const parsed = JSON.parse(match[1]!.trim()) as unknown
		if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return { ok: true, metadata: parsed as Metadata }
	} catch {
		// Report below.
	}
	return { ok: false, error: 'issue body contains invalid Trowel metadata JSON' }
}

function bodyWithoutMetadata(body: string): string {
	return body.replace(/\n?\n?<!--\s*trowel:.*?-->/s, '').trimEnd()
}

function bodyWithMergedMetadata(body: string, patch: Metadata): string {
	const existing = readMetadata(body)
	if (!existing.ok) throw new Error(existing.error)
	const metadata = { ...existing.metadata, ...withoutUndefined(patch) }
	const serialized = `<!-- trowel:${JSON.stringify(metadata)} -->`
	const publicBody = bodyWithoutMetadata(body)
	return publicBody ? `${publicBody}\n\n${serialized}` : serialized
}

function withoutUndefined(metadata: Metadata): Metadata {
	return Object.fromEntries(Object.entries(metadata).filter(([, value]) => value !== undefined))
}

function hasBothBranchNames(pr: LinkedPullRequest): boolean {
	return pr.baseRefName.length > 0 && pr.headRefName.length > 0
}

function uniqueBy<T>(items: T[], keyFor: (item: T) => string): T[] {
	const seen = new Set<string>()
	const out: T[] = []
	for (const item of items) {
		const key = keyFor(item)
		if (seen.has(key)) continue
		seen.add(key)
		out.push(item)
	}
	return out
}

function problemFor(issue: IssueSummary | SubIssue, kind: 'change' | 'slice', changeNumber: number, reason: RepairProblem['reason'], message: string): RepairProblem {
	return { issueNumber: issue.number, kind, changeNumber, title: issue.title, reason, message }
}

function formatRepairResult(result: RepairResult): string {
	const lines = [
		`trowel legacy issue metadata repair (${result.mode})`,
		`Target repo: ${result.projectRoot}`,
		`Patches: ${result.patches.length}`,
	]
	for (const patch of result.patches) {
		lines.push(`  · ${patch.kind} #${patch.issueNumber} (${patch.title}): ${JSON.stringify(patch.patch)}`)
	}
	if (result.problems.length > 0) {
		lines.push(`Problems: ${result.problems.length}`)
		for (const problem of result.problems) lines.push(`  · ${problem.reason} ${problem.kind} #${problem.issueNumber} (${problem.title}): ${problem.message}`)
	} else {
		lines.push('Problems: 0')
	}
	if (result.mode === 'dry-run') lines.push('Dry-run only; rerun with --apply to write issue bodies.')
	if (result.mode === 'apply' && result.problems.length > 0) lines.push('Apply finished with unresolved/ambiguous entities; exiting non-zero.')
	return `${lines.join('\n')}\n`
}

class RepoGh {
	constructor(private readonly cwd: string, private readonly runner: RepoGhRunner) {}

	async repoIdentity(): Promise<RepoIdentity> {
		const raw = await this.json<{ owner: { login: string }; name: string }>(['api', 'repos/{owner}/{repo}'])
		return { owner: raw.owner.login, name: raw.name }
	}

	async listIssues(label: string): Promise<IssueSummary[]> {
		const out = await this.json<Array<IssueSummary & { body?: string | null }>>([
			'issue',
			'list',
			'--label',
			label,
			'--state',
			'all',
			'--limit',
			'1000',
			'--json',
			'number,title,body,state,createdAt',
		])
		return out.map((issue) => ({ ...issue, body: issue.body ?? '' }))
	}

	async listSubIssues(changeNumber: number): Promise<SubIssue[]> {
		const out = await this.json<Array<SubIssue & { body?: string | null }>>(['api', '--paginate', `repos/{owner}/{repo}/issues/${changeNumber}/sub_issues`])
		return out.map((issue) => ({ ...issue, body: issue.body ?? '' }))
	}

	async linkedPullRequests(repo: RepoIdentity, issueNumber: number): Promise<LinkedPullRequest[]> {
		const payload = await this.json<GraphqlLinkedPrResponse>([
			'api',
			'graphql',
			'-f',
			`query=${LINKED_PRS_QUERY}`,
			'-F',
			`owner=${repo.owner}`,
			'-F',
			`name=${repo.name}`,
			'-F',
			`number=${issueNumber}`,
		])
		return pullRequestsFromGraphql(payload)
	}

	async editIssueBody(issueNumber: number, body: string): Promise<void> {
		await this.run(['issue', 'edit', String(issueNumber), '--body', body])
	}

	private async json<T>(args: string[]): Promise<T> {
		const out = await this.run(args)
		return JSON.parse(out) as T
	}

	private async run(args: string[]): Promise<string> {
		const result = await this.runner(args, { cwd: this.cwd })
		if (!result.ok) throw new Error(`gh ${args.join(' ')} failed: ${result.error.message}`)
		return result.stdout
	}
}

type GraphqlPrNode = {
	__typename?: string
	number?: number
	baseRefName?: string | null
	headRefName?: string | null
	state?: string
	url?: string
}

type GraphqlTimelineNode = {
	__typename?: string
	source?: GraphqlPrNode | null
	subject?: GraphqlPrNode | null
	target?: GraphqlPrNode | null
}

type GraphqlLinkedPrResponse = {
	repository?: {
		issue?: {
			closedByPullRequestsReferences?: { nodes?: GraphqlPrNode[] | null } | null
			timelineItems?: { nodes?: GraphqlTimelineNode[] | null } | null
		} | null
	} | null
}

function pullRequestsFromGraphql(payload: GraphqlLinkedPrResponse): LinkedPullRequest[] {
	const issue = payload.repository?.issue
	if (!issue) return []
	const candidates: GraphqlPrNode[] = []
	candidates.push(...(issue.closedByPullRequestsReferences?.nodes ?? []))
	for (const item of issue.timelineItems?.nodes ?? []) {
		for (const node of [item.source, item.subject, item.target]) {
			if (node?.__typename === 'PullRequest') candidates.push(node)
		}
	}
	return uniqueBy(candidates.flatMap(toLinkedPullRequest), (pr) => `${pr.number}\0${pr.baseRefName}\0${pr.headRefName}`)
}

function toLinkedPullRequest(node: GraphqlPrNode): LinkedPullRequest[] {
	if (typeof node.number !== 'number') return []
	return [{
		number: node.number,
		baseRefName: node.baseRefName ?? '',
		headRefName: node.headRefName ?? '',
		state: node.state,
		url: node.url,
	}]
}

const execFileAsync = promisify(execFile)

async function defaultRepoGhRunner(args: string[], opts: { cwd: string }): Promise<ShellResult> {
	try {
		const { stdout, stderr } = await execFileAsync('gh', args, { cwd: opts.cwd })
		return { ok: true, stdout, stderr }
	} catch (error) {
		return { ok: false, error: error as Error }
	}
}

type CliArgs = { targetRepoPath: string; apply: boolean; help: boolean }

export function parseRepairCliArgs(argv: string[]): CliArgs {
	const parsed = parseArgs({
		args: argv,
		allowPositionals: true,
		options: {
			apply: { type: 'boolean', default: false },
			'dry-run': { type: 'boolean', default: false },
			help: { type: 'boolean', short: 'h', default: false },
		},
	})
	if (parsed.values.help) return { targetRepoPath: '', apply: false, help: true }
	if (parsed.values.apply && parsed.values['dry-run']) throw new Error('choose either --apply or --dry-run, not both')
	if (parsed.positionals.length !== 1) throw new Error('usage: tsx src/scripts/repair-legacy-issue-metadata.ts [--apply] <target-repo-path>')
	return { targetRepoPath: parsed.positionals[0]!, apply: Boolean(parsed.values.apply), help: false }
}

export async function repairLegacyIssueMetadataMain(argv: string[] = process.argv.slice(2)): Promise<void> {
	const parsed = parseRepairCliArgs(argv)
	if (parsed.help) {
		process.stdout.write('usage: tsx src/scripts/repair-legacy-issue-metadata.ts [--apply] <target-repo-path>\n')
		return
	}
	const result = await repairLegacyIssueMetadata({ targetRepoPath: parsed.targetRepoPath, apply: parsed.apply })
	process.exitCode = result.exitCode
}

function isDirectModule(): boolean {
	return process.argv[1] ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) : false
}

if (isDirectModule()) {
	repairLegacyIssueMetadataMain().catch((error: Error) => {
		process.stderr.write(`repair-legacy-issue-metadata: ${error.message}\n`)
		process.exitCode = 1
	})
}

if (import.meta.vitest) {
	const { describe, test, expect, beforeEach, afterEach } = import.meta.vitest

	type Fixture = {
		root: string
		home: string
		calls: string[][]
		edits: Array<{ issueNumber: number; body: string }>
		runner: RepoGhRunner
		setLinkedPrs(issueNumber: number, prs: LinkedPullRequest[]): void
		setSubIssues(changeNumber: number, subIssues: SubIssue[]): void
	}

	async function makeFixture(changes: IssueSummary[], opts: { perSliceBranches?: boolean; label?: string } = {}): Promise<Fixture> {
		const root = await mkdtemp(path.join(tmpdir(), 'trowel-repair-target-'))
		const home = path.join(root, 'home')
		await mkdir(path.join(root, '.git'))
		await mkdir(path.join(root, '.trowel'), { recursive: true })
		await mkdir(home)
		await writeFile(path.join(root, '.trowel', 'config.json'), JSON.stringify({
			storage: 'issue',
			labels: { change: opts.label ?? 'change' },
			work: { perSliceBranches: opts.perSliceBranches ?? true },
		}), 'utf8')
		const linked = new Map<number, LinkedPullRequest[]>()
		const subIssues = new Map<number, SubIssue[]>()
		const calls: string[][] = []
		const edits: Array<{ issueNumber: number; body: string }> = []
		const runner: RepoGhRunner = async (args) => {
			calls.push(args)
			if (args[0] === 'api' && args[1] === 'repos/{owner}/{repo}') return okJson({ owner: { login: 'owner' }, name: 'repo' })
			if (args[0] === 'issue' && args[1] === 'list') return okJson(changes)
			if (args[0] === 'api' && args[1] === '--paginate') {
				const match = /issues\/(\d+)\/sub_issues/.exec(args[2] ?? '')
				return okJson(subIssues.get(Number(match?.[1])) ?? [])
			}
			if (args[0] === 'api' && args[1] === 'graphql') {
				const issueNumber = Number((args.find((arg) => arg.startsWith('number=')) ?? 'number=0').split('=')[1])
				return okJson(graphqlResponse(linked.get(issueNumber) ?? []))
			}
			if (args[0] === 'issue' && args[1] === 'edit') {
				edits.push({ issueNumber: Number(args[2]), body: args[4] ?? '' })
				return { ok: true, stdout: '', stderr: '' }
			}
			return { ok: false, error: new Error(`unexpected gh call: ${args.join(' ')}`) }
		}
		return {
			root,
			home,
			calls,
			edits,
			runner,
			setLinkedPrs(issueNumber, prs) { linked.set(issueNumber, prs) },
			setSubIssues(changeNumber, entries) { subIssues.set(changeNumber, entries) },
		}
	}

	function okJson(value: unknown): ShellResult {
		return { ok: true, stdout: JSON.stringify(value), stderr: '' }
	}

	function graphqlResponse(prs: LinkedPullRequest[]): GraphqlLinkedPrResponse {
		return {
			repository: {
				issue: {
					closedByPullRequestsReferences: { nodes: prs.map((pr) => ({ ...pr, __typename: 'PullRequest' })) },
					timelineItems: { nodes: [] },
				},
			},
		}
	}

	describe('legacy issue metadata repair', () => {
		let fixtures: Fixture[] = []
		beforeEach(() => { fixtures = [] })
		afterEach(async () => {
			await Promise.all(fixtures.map((f) => rm(f.root, { recursive: true, force: true })))
		})

		test('dry-run discovers missing Change and Slice metadata without editing issue bodies', async () => {
			const fixture = await makeFixture([{ number: 10, title: 'Change', body: 'change body' }])
			fixtures.push(fixture)
			fixture.setSubIssues(10, [{ number: 11, title: 'Slice', body: 'slice body' }])
			fixture.setLinkedPrs(10, [{ number: 50, baseRefName: 'main', headRefName: 'legacy-change', state: 'OPEN' }])
			fixture.setLinkedPrs(11, [{ number: 51, baseRefName: 'legacy-change', headRefName: 'legacy-slice', state: 'MERGED' }])
			let output = ''

			const result = await repairLegacyIssueMetadata({ targetRepoPath: fixture.root, home: fixture.home, runner: fixture.runner, stdout: (s) => { output += s } })

			expect(result.mode).toBe('dry-run')
			expect(result.exitCode).toBe(0)
			expect(result.patches.map((p) => [p.issueNumber, p.patch])).toEqual([
				[10, { targetBranch: 'main', changeBranch: 'legacy-change' }],
				[11, { sliceBranch: 'legacy-slice' }],
			])
			expect(fixture.edits).toEqual([])
			expect(output).toContain('Dry-run only')
			expect(fixture.calls).toContainEqual(['issue', 'list', '--label', 'change', '--state', 'all', '--limit', '1000', '--json', 'number,title,body,state,createdAt'])
			expect(fixture.calls.some((args) => args[0] === 'api' && args[1] === 'graphql')).toBe(true)
		})

		test('apply mode writes generated issue-body patches', async () => {
			const fixture = await makeFixture([{ number: 20, title: 'Change', body: 'change body' }])
			fixtures.push(fixture)
			fixture.setSubIssues(20, [])
			fixture.setLinkedPrs(20, [{ number: 60, baseRefName: 'develop', headRefName: 'actual-change', state: 'OPEN' }])

			const result = await repairLegacyIssueMetadata({ targetRepoPath: fixture.root, home: fixture.home, runner: fixture.runner, apply: true, stdout: () => {} })

			expect(result.mode).toBe('apply')
			expect(result.exitCode).toBe(0)
			expect(fixture.edits).toEqual([{ issueNumber: 20, body: 'change body\n\n<!-- trowel:{"targetBranch":"develop","changeBranch":"actual-change"} -->' }])
		})

		test('metadata patches merge with existing hidden Trowel JSON', async () => {
			const fixture = await makeFixture([{ number: 30, title: 'Change', body: 'change body\n\n<!-- trowel:{"legacy":"keep","targetBranch":"main"} -->' }])
			fixtures.push(fixture)
			fixture.setSubIssues(30, [])
			fixture.setLinkedPrs(30, [{ number: 70, baseRefName: 'main', headRefName: 'actual-change', state: 'OPEN' }])

			await repairLegacyIssueMetadata({ targetRepoPath: fixture.root, home: fixture.home, runner: fixture.runner, apply: true, stdout: () => {} })

			expect(fixture.edits[0]?.body).toBe('change body\n\n<!-- trowel:{"legacy":"keep","targetBranch":"main","changeBranch":"actual-change"} -->')
		})

		test('reports ambiguous linked PR branch discovery and skips that entity', async () => {
			const fixture = await makeFixture([{ number: 40, title: 'Change', body: 'change body' }])
			fixtures.push(fixture)
			fixture.setSubIssues(40, [])
			fixture.setLinkedPrs(40, [
				{ number: 80, baseRefName: 'main', headRefName: 'one', state: 'OPEN' },
				{ number: 81, baseRefName: 'main', headRefName: 'two', state: 'OPEN' },
			])
			let output = ''

			const result = await repairLegacyIssueMetadata({ targetRepoPath: fixture.root, home: fixture.home, runner: fixture.runner, stdout: (s) => { output += s } })

			expect(result.patches).toEqual([])
			expect(result.problems).toEqual([expect.objectContaining({ issueNumber: 40, reason: 'ambiguous' })])
			expect(output).toContain('ambiguous change #40')
		})

		test('apply mode returns non-zero when required metadata is unresolved', async () => {
			const fixture = await makeFixture([{ number: 90, title: 'Change', body: 'change body' }])
			fixtures.push(fixture)
			fixture.setSubIssues(90, [])
			fixture.setLinkedPrs(90, [])

			const result = await repairLegacyIssueMetadata({ targetRepoPath: fixture.root, home: fixture.home, runner: fixture.runner, apply: true, stdout: () => {} })

			expect(result.exitCode).toBe(1)
			expect(result.problems).toEqual([expect.objectContaining({ issueNumber: 90, reason: 'unresolved' })])
			expect(fixture.edits).toEqual([])
		})

		test('uses the parent Change branch for Slices when per-slice branches are disabled', async () => {
			const fixture = await makeFixture([{ number: 100, title: 'Change', body: 'change body\n\n<!-- trowel:{"targetBranch":"main","changeBranch":"shared-change"} -->' }], { perSliceBranches: false, label: 'custom-change' })
			fixtures.push(fixture)
			fixture.setSubIssues(100, [{ number: 101, title: 'Slice', body: 'slice body' }])

			const result = await repairLegacyIssueMetadata({ targetRepoPath: fixture.root, home: fixture.home, runner: fixture.runner, stdout: () => {} })

			expect(result.patches.map((p) => [p.issueNumber, p.patch])).toEqual([[101, { sliceBranch: 'shared-change' }]])
			expect(fixture.calls).toContainEqual(['issue', 'list', '--label', 'custom-change', '--state', 'all', '--limit', '1000', '--json', 'number,title,body,state,createdAt'])
		})
	})
}
