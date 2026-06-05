import type { Change, Slice, StorageDeps, StorageFactory } from '../types.ts'

type TrowelMetadata = Record<string, unknown>
type IssueChangeArtifact = {
	number: number
	title: string
	body: string
	createdAt: string
	closedAt?: string | null
}
type SubIssueArtifact = Awaited<ReturnType<StorageDeps['gh']['listSubIssues']>>[number]

const entityIdToGhNumber = (id: string): number => Number(id)

export const createIssueStorage: StorageFactory = (deps) => {
	function optionalMetadataStringOrNull(body: string | null | undefined, source: string, key: string): string | null {
		const metadata = metadataFromBody(body)
		if (metadata[key] === undefined || metadata[key] === null) return null
		return requiredMetadataStringValue(metadata[key], source, key)
	}

	function requiredMetadataStringOrNull(body: string | null | undefined, source: string, key: string): string | null {
		const metadata = metadataFromBody(body)
		if (metadata[key] === null) return null
		return requiredMetadataStringValue(metadata[key], source, key)
	}

	function requiredMetadataString(body: string | null | undefined, source: string, key: string): string {
		return requiredMetadataStringValue(metadataFromBody(body)[key], source, key)
	}

	function requiredMetadataStringValue(value: unknown, source: string, key: string): string {
		if (typeof value !== 'string' || value.length === 0)
			throw new Error(
				`${source} is missing required Trowel metadata: ${key}. Repair legacy issue storage with \`trowel repair branch-metadata --dry-run\`, review the patches, then run \`trowel repair branch-metadata --apply\`.`,
			)
		return value
	}

	function metadataFromBody(body: string | null | undefined): TrowelMetadata {
		const match = /<!--\s*trowel:(.*?)-->/s.exec(body ?? '')
		const raw = match?.[1]?.trim() ?? null
		if (!raw) return {}
		try {
			const parsed = JSON.parse(raw) as unknown
			if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as TrowelMetadata
		} catch {
			// Fall through to loud read/update failure below.
		}
		throw new Error('issue body contains invalid Trowel metadata JSON')
	}

	function bodyWithMetadata(body: string, patch: TrowelMetadata): string {
		const metadata = { ...metadataFromBody(body), ...patch }
		const serialized = `<!-- trowel:${JSON.stringify(metadata)} -->`
		const publicBody = bodyWithoutMetadata(body)
		return publicBody ? `${publicBody}\n\n${serialized}` : serialized
	}

	function bodyWithoutMetadata(body: string): string {
		return body.replace(/\n?\n?<!--\s*trowel:.*?-->/s, '').trimEnd()
	}

	async function updateIssueMetadata(issueId: string, patch: TrowelMetadata): Promise<void> {
		const no = entityIdToGhNumber(issueId)
		const issue = await deps.gh.viewIssue(no)
		await deps.gh.editIssueBody(no, bodyWithMetadata(issue.body, patch))
	}

	function changeFromIssue(issue: IssueChangeArtifact): Change {
		const source = `issue #${issue.number}`
		return {
			id: String(issue.number),
			title: issue.title,
			body: bodyWithoutMetadata(issue.body),
			createdAt: issue.createdAt,
			closedAt: issue.closedAt ?? null,
			targetBranch: requiredMetadataString(issue.body, source, 'targetBranch'),
			changeBranch: requiredMetadataString(issue.body, source, 'changeBranch'),
		}
	}

	async function sliceFromSubIssue(issue: SubIssueArtifact): Promise<Slice> {
		const totalBlockedBy = issue.issue_dependencies_summary?.total_blocked_by ?? 0
		const blockedBy = totalBlockedBy === 0 ? [] : (await deps.gh.listBlockedBy(issue.number)).map((b) => String(b.number))
		const source = `issue #${issue.number}`
		return {
			id: String(issue.number),
			title: issue.title,
			body: bodyWithoutMetadata(issue.body),
			closedAt: issue.closed_at ?? issue.closedAt ?? null,
			implementedAt: optionalMetadataStringOrNull(issue.body, source, 'implementedAt'),
			auditedAt: optionalMetadataStringOrNull(issue.body, source, 'auditedAt'),
			sliceBranch: requiredMetadataStringOrNull(issue.body, source, 'sliceBranch'),
			readyForAgent: issue.labels.some((l) => l.name === deps.labels.readyForAgent),
			blockedBy,
		}
	}

	return {
		createChange: async (spec) => {
			const issue = await deps.gh.createIssue({ title: spec.title, body: spec.body, labels: [deps.labels.change] })
			return { id: String(issue.number), title: issue.title }
		},
		findChange: async (id) => changeFromIssue(await deps.gh.viewIssue(entityIdToGhNumber(id))),
		listChanges: async () => (await deps.gh.listIssues({ label: deps.labels.change, state: 'all' })).map(changeFromIssue),
		finalizeChange: async (id) => {
			const no = entityIdToGhNumber(id)
			const issue = await deps.gh.viewIssue(no)
			if (issue.state === 'closed') return
			await deps.gh.closeIssue(no)
		},
		abortChange: async (id, opts) => {
			const no = entityIdToGhNumber(id)
			const issue = await deps.gh.viewIssue(no)
			if (issue.state === 'closed') return
			await deps.gh.closeIssue(no, opts)
		},
		updateChangeMetadata: async (changeId, patch) => updateIssueMetadata(changeId, patch),
		createSlice: async (changeId, spec) => {
			const issue = await deps.gh.createIssue({
				title: spec.title,
				body: bodyWithMetadata(spec.body, { sliceBranch: null, implementedAt: null, auditedAt: null }),
			})
			await deps.gh.addSubIssue(entityIdToGhNumber(changeId), issue.internalId)

			return { id: String(issue.number), title: issue.title }
		},
		findSlices: async (changeId) => Promise.all((await deps.gh.listSubIssues(entityIdToGhNumber(changeId))).map(sliceFromSubIssue)),
		setSliceReadyForAgent: async (_changeId, sliceId, ready) => {
			const label = deps.labels.readyForAgent
			const opts = ready ? { add: [label] } : { remove: [label] }
			await deps.gh.editIssueLabels(entityIdToGhNumber(sliceId), opts)
		},
		setSliceBlockers: async (_changeId, sliceId, blockedBy) => {
			const current = await deps.gh.listBlockedBy(entityIdToGhNumber(sliceId))
			const currentByNumber = new Map(current.map((b) => [String(b.number), b.id]))
			const target = new Set(blockedBy)
			for (const [number, internalId] of currentByNumber) {
				if (!target.has(number)) await deps.gh.removeBlockedBy(entityIdToGhNumber(sliceId), internalId)
			}
			for (const blockerId of blockedBy) {
				const number = entityIdToGhNumber(blockerId)
				if (currentByNumber.has(blockerId)) continue
				const blocker = await deps.gh.viewIssue(number)
				await deps.gh.addBlockedBy(entityIdToGhNumber(sliceId), blocker.internalId)
			}
		},
		markSliceImplemented: async (_changeId, sliceId, at) => updateIssueMetadata(sliceId, { implementedAt: at }),
		markSliceAudited: async (_changeId, sliceId, at) => updateIssueMetadata(sliceId, { auditedAt: at }),
		finalizeSlice: async (_changeId, sliceId) => await deps.gh.closeIssue(entityIdToGhNumber(sliceId)),
		abortSlice: async (_changeId, sliceId, opts) => {
			await deps.gh.closeIssue(entityIdToGhNumber(sliceId), opts)
		},
		updateSliceMetadata: async (_changeId, sliceId, patch) => updateIssueMetadata(sliceId, patch),
	}
}

if (import.meta.vitest) {
	const { describe, test, expect } = import.meta.vitest
	const { recordingGhOps } = await import('../../test-utils/gh-ops-recorder.ts')
	const { noopGitOps } = await import('../../test-utils/git-ops-fixtures.ts')

	type GhOverrides = Partial<import('../../utils/gh-ops.ts').GhOps>
	function trowelBody(body: string, metadata: Record<string, unknown>): string {
		return `${body}\n\n<!-- trowel:${JSON.stringify(metadata)} -->`
	}

	function createdIssue(number: number, title: string): Awaited<ReturnType<import('../../utils/gh-ops.ts').GhOps['createIssue']>> {
		return { number, internalId: number * 1000, title, url: `#${number}` }
	}

	function issueRecord(number: number, internalId: number): Awaited<ReturnType<import('../../utils/gh-ops.ts').GhOps['viewIssue']>> {
		return { internalId, number, title: `Issue ${number}`, state: 'open', body: '', createdAt: '', closedAt: null }
	}

	function makeDeps(overrides: GhOverrides = {}): {
		deps: StorageDeps
		calls: Array<[string, ...unknown[]]>
	} {
		const { gh, calls } = recordingGhOps(overrides)
		const deps: StorageDeps = {
			gh,
			changesDir: '/tmp/x/docs/changes',
			labels: { change: 'change', readyForAgent: 'ready-for-agent', needsRevision: 'needs-revision' },
			git: noopGitOps(),
		}
		return { deps, calls }
	}

	describe('issue storage: createChange', () => {
		test('creates the issue record and returns allocated id+title without branch metadata', async () => {
			const { deps, calls } = makeDeps({
				createIssue: async ({ title }) => createdIssue(42, title),
			})
			const storage = createIssueStorage(deps)
			const result = await storage.createChange({ title: 'Fix Tabs on macOS', body: 'the spec' })
			expect(result).toEqual({ id: '42', title: 'Fix Tabs on macOS' })
			expect(calls[0]).toEqual(['createIssue', { title: 'Fix Tabs on macOS', body: 'the spec', labels: ['change'] }])
			expect(calls.find((c) => c[0] === 'editIssueBody')).toBeUndefined()
		})

		test('createChange ignores targetBranch because branch metadata is updated after branch creation', async () => {
			const { deps, calls } = makeDeps({
				createIssue: async ({ title }) => createdIssue(99, title),
			})
			const storage = createIssueStorage(deps)

			const result = await storage.createChange({ title: 'Release Feature', body: 'body', targetBranch: 'release/1.2' })

			expect(result).toEqual({ id: '99', title: 'Release Feature' })
			expect(calls[0]).toEqual(['createIssue', { title: 'Release Feature', body: 'body', labels: ['change'] }])
		})

		test('applies configured labels.change to the createIssue call', async () => {
			const { deps, calls } = makeDeps({
				createIssue: async ({ title }) => createdIssue(7, title),
			})
			deps.labels.change = 'roadmap'
			const storage = createIssueStorage(deps)
			const result = await storage.createChange({ title: 'Add ORM', body: 'b' })
			expect(result).toEqual({ id: '7', title: 'Add ORM' })
			const [name, args] = calls[0]!
			expect(name).toBe('createIssue')
			expect((args as { labels: string[] }).labels).toEqual(['roadmap'])
			expect((args as { body: string }).body).toBe('b')
		})

		test('throws if gh createIssue fails', async () => {
			const { deps } = makeDeps({
				createIssue: async () => {
					throw new Error('rate limited')
				},
			})
			const storage = createIssueStorage(deps)
			await expect(storage.createChange({ title: 'Fix', body: 'b' })).rejects.toThrow(/rate limited/)
		})
	})

	describe('issue storage: listChanges', () => {
		test('returns empty array when no issues match the change label', async () => {
			const { deps, calls } = makeDeps()
			const storage = createIssueStorage(deps)
			expect(await storage.listChanges()).toEqual([])
			expect(calls).toEqual([['listIssues', { label: 'change', state: 'all' }]])
		})

		test('queries all Change issues through GhOps', async () => {
			const { deps, calls } = makeDeps()
			const storage = createIssueStorage(deps)
			await storage.listChanges()
			expect(calls).toEqual([['listIssues', { label: 'change', state: 'all' }]])
		})

		test('returns one Change per matching issue with stored Change branch metadata', async () => {
			const { deps, calls } = makeDeps({
				listIssues: async () => [
					{
						number: 42,
						title: 'Fix Tabs',
						createdAt: '2026-05-12T00:00:00Z',
						body: 'fix tabs\n\n<!-- trowel:{"changeBranch":"change-42-fix-tabs","targetBranch":"main"} -->',
						state: 'open',
						closedAt: null,
					},
					{
						number: 7,
						title: 'Add ORM',
						createdAt: '2026-05-11T00:00:00Z',
						body: 'add orm\n\n<!-- trowel:{"changeBranch":"change-7-add-orm","targetBranch":"main"} -->',
						state: 'closed',
						closedAt: '2026-05-12T00:00:00Z',
					},
				],
			})
			const storage = createIssueStorage(deps)
			const result = await storage.listChanges()
			expect(result).toEqual([
				{
					id: '42',
					title: 'Fix Tabs',
					body: 'fix tabs',
					createdAt: '2026-05-12T00:00:00Z',
					closedAt: null,
					targetBranch: 'main',
					changeBranch: 'change-42-fix-tabs',
				},
				{
					id: '7',
					title: 'Add ORM',
					body: 'add orm',
					createdAt: '2026-05-11T00:00:00Z',
					closedAt: '2026-05-12T00:00:00Z',
					targetBranch: 'main',
					changeBranch: 'change-7-add-orm',
				},
			])
			expect(calls.filter((c) => c[0] === 'viewIssue')).toEqual([])
		})
	})

	describe('issue storage: createSlice', () => {
		test('creates issue, links as sub-issue using the create response internal id, returns id+title', async () => {
			const { deps, calls } = makeDeps({
				createIssue: async ({ title }) => ({ ...createdIssue(57, title), internalId: 57000 }),
			})
			const storage = createIssueStorage(deps)
			const slice = await storage.createSlice('42', { title: 'Implement Tab Parser', body: 'the slice spec' })

			expect(slice).toEqual({ id: '57', title: 'Implement Tab Parser' })
			expect(calls[0]).toEqual([
				'createIssue',
				{
					title: 'Implement Tab Parser',
					body: trowelBody('the slice spec', { sliceBranch: null, implementedAt: null, auditedAt: null }),
				},
			])
			expect(calls[1]).toEqual(['addSubIssue', 42, 57000])
			expect(calls.find((c) => c[0] === 'editIssueBody')).toBeUndefined()
		})
	})

	describe('issue storage: createSlice blocker handling', () => {
		test('createSlice never writes blockers directly', async () => {
			const { deps, calls } = makeDeps({
				createIssue: async ({ title }) => createdIssue(57, title),
			})
			const storage = createIssueStorage(deps)
			await storage.createSlice('42', { title: 'A', body: 'b' })
			expect(calls.find((c) => c[0] === 'addBlockedBy')).toBeUndefined()
		})
	})

	describe('issue storage: findSlices', () => {
		test('queries sub-issues endpoint and maps to Slice[]', async () => {
			const { deps, calls } = makeDeps({
				listSubIssues: async () => [
					{
						number: 57,
						title: 'Implement Parser',
						body: trowelBody('parser spec', { sliceBranch: 'change-42/slice-57-implement-parser' }),
						state: 'open',
						labels: [{ name: 'ready-for-agent' }],
					},
					{
						number: 58,
						title: 'Wire CLI',
						body: trowelBody('cli spec', { sliceBranch: 'change-42/slice-58-wire-cli' }),
						state: 'closed',
						closed_at: '2026-06-04T00:00:00Z',
						labels: [{ name: 'needs-revision' }, { name: 'other' }],
					},
				],
			})
			const storage = createIssueStorage(deps)
			const slices = await storage.findSlices('42')
			expect(calls[0]).toEqual(['listSubIssues', 42])
			expect(slices).toEqual([
				{
					id: '57',
					title: 'Implement Parser',
					body: 'parser spec',
					closedAt: null,
					implementedAt: null,
					auditedAt: null,
					readyForAgent: true,
					blockedBy: [],
					sliceBranch: 'change-42/slice-57-implement-parser',
					},
				{
					id: '58',
					title: 'Wire CLI',
					body: 'cli spec',
					closedAt: '2026-06-04T00:00:00Z',
					implementedAt: null,
					auditedAt: null,
					readyForAgent: false,
					blockedBy: [],
					sliceBranch: 'change-42/slice-58-wire-cli',
					},
			])
		})

		test('uses configured ready label name and ignores issue-level needs-revision labels', async () => {
			const { deps } = makeDeps({
				listSubIssues: async () => [
					{
						number: 9,
						title: 't',
						body: trowelBody('b', { sliceBranch: 'change-42/slice-9-t' }),
						state: 'open',
						labels: [{ name: 'CUSTOM-ready' }, { name: 'CUSTOM-needs' }],
					},
				],
			})
			deps.labels.readyForAgent = 'CUSTOM-ready'
			deps.labels.needsRevision = 'CUSTOM-needs'
			const storage = createIssueStorage(deps)
			const [slice] = await storage.findSlices('42')
			expect(slice!.readyForAgent).toBe(true)
		})
	})

	describe('issue storage: findSlices raw persistence fields', () => {
		test('readyForAgent label maps to the raw readyForAgent flag without PR queries', async () => {
			const { deps, calls } = makeDeps({
				listSubIssues: async () => [
					{
						number: 57,
						title: 'Implement Parser',
						body: trowelBody('b', { sliceBranch: 'change-42/slice-57-implement-parser' }),
						state: 'open',
						labels: [{ name: 'ready-for-agent' }],
					},
				],
			})
			const storage = createIssueStorage(deps)
			const [slice] = await storage.findSlices('42')
			expect(slice).toMatchObject({ readyForAgent: true, closedAt: null, blockedBy: [] })
			expect(calls.find((c) => c[0] === 'listOpenPrs')).toBeUndefined()
		})

		test('issue-level needsRevision label is not persisted as Slice state', async () => {
			const { deps } = makeDeps({
				listSubIssues: async () => [
					{
						number: 57,
						title: 'P',
						body: trowelBody('b', { sliceBranch: 'change-42/slice-57-p' }),
						state: 'open',
						labels: [{ name: 'ready-for-agent' }, { name: 'needs-revision' }],
					},
				],
			})
			const storage = createIssueStorage(deps)
			const [slice] = await storage.findSlices('42')
			expect(slice).not.toHaveProperty('needsRevision')
		})

		test('total_blocked_by > 0 fetches dependencies and populates raw blockedBy', async () => {
			const { deps, calls } = makeDeps({
				listSubIssues: async () => [
					{
						number: 57,
						title: 'A',
						body: trowelBody('spec', { sliceBranch: 'change-42/slice-57-a' }),
						state: 'open',
						labels: [],
						issue_dependencies_summary: { total_blocked_by: 0 },
					},
					{
						number: 58,
						title: 'B',
						body: trowelBody('spec', { sliceBranch: 'change-42/slice-58-b' }),
						state: 'open',
						labels: [{ name: 'ready-for-agent' }],
						issue_dependencies_summary: { total_blocked_by: 1 },
					},
				],
				listBlockedBy: async (id) => (id === 58 ? [{ id: 1, number: 57 }] : []),
			})
			const storage = createIssueStorage(deps)
			const slices = await storage.findSlices('42')
			const b = slices.find((x) => x.id === '58')!
			expect(b.blockedBy).toEqual(['57'])
			expect(calls.filter((c) => c[0] === 'listBlockedBy').map((c) => c[1])).toEqual([58])
		})

		test('closed slice maps to raw closedAt without PR queries', async () => {
			const { deps, calls } = makeDeps({
				listSubIssues: async () => [
					{
						number: 57,
						title: 'A',
						body: trowelBody('spec', { sliceBranch: 'change-42/slice-57-a' }),
						state: 'closed',
						closed_at: '2026-06-04T00:00:00Z',
						labels: [],
					},
				],
			})
			const storage = createIssueStorage(deps)
			const [slice] = await storage.findSlices('42')
			expect(slice!.closedAt).toBe('2026-06-04T00:00:00Z')
			expect(calls.some((c) => c[0] === 'listOpenPrs')).toBe(false)
		})
	})

	describe('issue storage: findChange', () => {
		test('returns Change with changeBranch and targetBranch for an existing issue', async () => {
			const { deps } = makeDeps({
				viewIssue: async () => ({
					number: 42,
					internalId: 42000,
					title: 'Fix Tabs',
					state: 'open',
					createdAt: '',
					body: 'body\n\n<!-- trowel:{"targetBranch":"release/1.2","changeBranch":"change-42-fix-tabs"} -->',
				}),
			})
			const storage = createIssueStorage(deps)
			expect(await storage.findChange('42')).toEqual({
				id: '42',
				title: 'Fix Tabs',
				body: 'body',
				createdAt: '',
				closedAt: null,
				targetBranch: 'release/1.2',
				changeBranch: 'change-42-fix-tabs',
			})
		})

		test('propagates viewIssue errors when an issue is not found', async () => {
			const { deps } = makeDeps({
				viewIssue: async () => {
					throw new Error('issue not found')
				},
			})
			const storage = createIssueStorage(deps)
			await expect(storage.findChange('999999')).rejects.toThrow(/issue not found/)
		})
	})

	describe('issue storage: branch metadata', () => {
		test('updateChangeMetadata merges into the existing hidden JSON object without clobbering unrelated keys', async () => {
			const { deps, calls } = makeDeps({
				viewIssue: async () => ({
					number: 42,
					internalId: 42000,
					title: 'Fix Tabs',
					state: 'open',
					createdAt: '',
					body: trowelBody('body', { targetBranch: 'main', owner: 'docs' }),
				}),
			})
			const storage = createIssueStorage(deps)

			await storage.updateChangeMetadata('42', { changeBranch: 'change-42-fix-tabs' })

			expect(calls).toEqual([
				['viewIssue', 42],
				['editIssueBody', 42, 'body\n\n<!-- trowel:{"targetBranch":"main","owner":"docs","changeBranch":"change-42-fix-tabs"} -->'],
			])
		})

		test('updateSliceMetadata merges into the existing hidden JSON object without clobbering unrelated keys', async () => {
			const { deps, calls } = makeDeps({
				viewIssue: async () => ({
					number: 57,
					internalId: 57000,
					title: 'Slice',
					state: 'open',
					createdAt: '',
					body: trowelBody('body', { reviewer: 'bot', sliceBranch: 'old' }),
				}),
			})
			const storage = createIssueStorage(deps)

			await storage.updateSliceMetadata('42', '57', { sliceBranch: 'change-42/slice-57-slice' })

			expect(calls).toEqual([
				['viewIssue', 57],
				['editIssueBody', 57, 'body\n\n<!-- trowel:{"reviewer":"bot","sliceBranch":"change-42/slice-57-slice"} -->'],
			])
		})

		test('findChange fails loudly with repair guidance when required branch metadata is missing', async () => {
			const { deps } = makeDeps({
				viewIssue: async () => ({
					number: 42,
					internalId: 42000,
					title: 'Missing',
					state: 'open',
					createdAt: '',
					body: trowelBody('body', { targetBranch: 'main' }),
				}),
			})
			const storage = createIssueStorage(deps)
			await expect(storage.findChange('42')).rejects.toThrow(
				/missing required Trowel metadata: changeBranch[\s\S]*trowel repair branch-metadata --dry-run[\s\S]*--apply/,
			)
		})

		test('findSlices accepts null Slice branch metadata before first implementation preparation', async () => {
			const { deps } = makeDeps({
				listSubIssues: async () => [
					{ number: 57, title: 'Slice', body: trowelBody('body', { sliceBranch: null }), state: 'open', labels: [] },
				],
			})
			const storage = createIssueStorage(deps)
			expect((await storage.findSlices('42'))[0]).toMatchObject({ id: '57', sliceBranch: null })
		})

		test('findSlices fails loudly with repair guidance when required Slice branch metadata is missing', async () => {
			const { deps } = makeDeps({
				listSubIssues: async () => [{ number: 57, title: 'Slice', body: 'body', state: 'open', labels: [] }],
			})
			const storage = createIssueStorage(deps)
			await expect(storage.findSlices('42')).rejects.toThrow(
				/missing required Trowel metadata: sliceBranch[\s\S]*trowel repair branch-metadata --dry-run[\s\S]*--apply/,
			)
		})
	})

	describe('issue storage: slice intent writes', () => {
		test('setSliceReadyForAgent(true) adds the configured label', async () => {
			const { deps, calls } = makeDeps()
			const storage = createIssueStorage(deps)
			await storage.setSliceReadyForAgent('42', '57', true)
			expect(calls).toEqual([['editIssueLabels', 57, { add: ['ready-for-agent'] }]])
		})

		test('setSliceReadyForAgent(false) removes the configured label', async () => {
			const { deps, calls } = makeDeps()
			const storage = createIssueStorage(deps)
			await storage.setSliceReadyForAgent('42', '57', false)
			expect(calls).toEqual([['editIssueLabels', 57, { remove: ['ready-for-agent'] }]])
		})

		test('finalizeSlice closes without abort comment', async () => {
			const { deps, calls } = makeDeps()
			const storage = createIssueStorage(deps)
			await storage.finalizeSlice('42', '57')
			expect(calls).toEqual([['closeIssue', 57]])
		})

		test('abortSlice passes the supplied abort comment when present', async () => {
			const { deps, calls } = makeDeps()
			const storage = createIssueStorage(deps)
			await storage.abortSlice('42', '57', { comment: 'Closed via trowel' })
			expect(calls).toEqual([['closeIssue', 57, { comment: 'Closed via trowel' }]])
		})
	})

	describe('issue storage: setSliceBlockers', () => {
		test('diffs old vs new: removes deleted blockers, adds new ones', async () => {
			const issues = new Map([
				[8, issueRecord(8, 800)],
				[9, issueRecord(9, 900)],
			])
			const { deps, calls } = makeDeps({
				listBlockedBy: async () => [{ id: 700, number: 7 }],
				viewIssue: async (number) => {
					const issue = issues.get(number)
					if (!issue) throw new Error(`unexpected issue ${number}`)
					return issue
				},
			})
			const storage = createIssueStorage(deps)
			await storage.setSliceBlockers('42', '100', ['8', '9'])

			expect(calls).toContainEqual(['removeBlockedBy', 100, 700])
			expect(calls).toContainEqual(['addBlockedBy', 100, 800])
			expect(calls).toContainEqual(['addBlockedBy', 100, 900])
		})

		test('blockedBy unchanged → no add/remove calls', async () => {
			const { deps, calls } = makeDeps({
				listBlockedBy: async () => [{ id: 700, number: 7 }],
			})
			const storage = createIssueStorage(deps)
			await storage.setSliceBlockers('42', '100', ['7'])
			expect(calls.find((c) => c[0] === 'addBlockedBy' || c[0] === 'removeBlockedBy')).toBeUndefined()
		})
	})

	describe('issue storage: abortChange', () => {
		test('runs closeIssue (no PR check, no branch ops — those are orchestrator-owned)', async () => {
			const { deps, calls } = makeDeps()
			const storage = createIssueStorage(deps)
			await storage.abortChange('42')
			expect(calls).toContainEqual(['closeIssue', 42, undefined])
			expect(calls.find((c) => c[0] === 'listOpenPrs')).toBeUndefined()
		})

		test('idempotent: closeIssue not invoked if issue already CLOSED', async () => {
			const { deps, calls } = makeDeps()
			const storage = createIssueStorage(deps)
			await storage.abortChange('42')
			expect(calls.find((c) => c[1] === 'closeIssue')).toBeUndefined()
		})

		test('passes the supplied comment through to closeIssue', async () => {
			const { deps, calls } = makeDeps()
			const storage = createIssueStorage(deps)
			await storage.abortChange('42', { comment: 'Closed via trowel' })
			expect(calls).toContainEqual(['closeIssue', 42, { comment: 'Closed via trowel' }])
		})
	})
}
