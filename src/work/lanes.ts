import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { v, type PipeOutput } from 'valleyed'

import { pathExists } from '../utils/fs.ts'
import type { GitOps } from '../utils/git-ops.ts'
import { validateJson } from '../utils/parse-json.ts'
import { slug as slugify } from '../utils/slug.ts'

const LANE_SCHEMA_VERSION = 1

const lanePipe = v.object({
	schemaVersion: v.is(LANE_SCHEMA_VERSION),
	id: v.string(),
	title: v.string(),
	branch: v.string(),
	targetBranch: v.string(),
	worktreePath: v.string(),
	createdAt: v.string(),
	closedAt: v.nullable(v.string()),
	mergedAt: v.nullable(v.string()),
})

export type Lane = PipeOutput<typeof lanePipe>
export type LaneState = 'open' | 'dirty' | 'missing-worktree' | 'missing-branch' | 'closed' | 'conflict'

type GitWorktree = Awaited<ReturnType<GitOps['worktreeList']>>[number]

export function laneBranchName(id: string, title: string): string {
	return `lane-${id}-${slugify(title)}`
}

export function laneWorktreePath(projectRoot: string, id: string): string {
	return path.resolve(projectRoot, '.trowel', 'worktrees', 'lanes', id)
}

export function laneMergeWorktreePath(projectRoot: string, id: string): string {
	return path.resolve(projectRoot, '.trowel', 'worktrees', 'lanes', `${id}-merge`)
}

function laneMetadataPath(projectRoot: string, id: string): string {
	return path.resolve(projectRoot, '.trowel', 'lanes', `${id}.json`)
}

export async function allocateNextLaneId(projectRoot: string): Promise<string> {
	const lanes = await listLanes(projectRoot)
	const ids = lanes.map((lane) => laneIdNumber(lane.id))
	return String(ids.length === 0 ? 1 : Math.max(...ids) + 1)
}

export async function writeLane(projectRoot: string, lane: Lane): Promise<void> {
	const metadataPath = laneMetadataPath(projectRoot, lane.id)
	await mkdir(path.dirname(metadataPath), { recursive: true })
	await writeFile(metadataPath, `${JSON.stringify(lane, null, 2)}\n`, 'utf8')
}

export async function readLane(projectRoot: string, id: string): Promise<Lane | null> {
	const metadataPath = laneMetadataPath(projectRoot, id)
	const raw = await readFile(metadataPath, 'utf8').catch((error) => {
		if ((error as { code?: string }).code === 'ENOENT') return null
		throw error
	})
	if (raw === null) return null
	return parseLaneMetadata(raw, metadataPath, id)
}

export async function listLanes(projectRoot: string): Promise<Lane[]> {
	const lanesDir = path.resolve(projectRoot, '.trowel', 'lanes')
	const entries = await readdir(lanesDir).catch((error) => {
		if ((error as { code?: string }).code === 'ENOENT') return []
		throw error
	})
	const lanes = await Promise.all(entries.filter((entry) => entry.endsWith('.json')).map((entry) => readLaneFile(projectRoot, entry)))
	return lanes.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

async function readLaneFile(projectRoot: string, entry: string): Promise<Lane> {
	const id = entry.slice(0, -'.json'.length)
	if (!/^\d+$/.test(id)) throw new Error(`Invalid Lane metadata filename '${entry}': expected <id>.json`)
	const lane = await readLane(projectRoot, id)
	if (lane === null) throw new Error(`Lane metadata disappeared while reading: ${entry}`)
	return lane
}

function parseLaneMetadata(raw: string, metadataPath: string, expectedId: string): Lane {
	const lane = validateJson<Lane>(lanePipe, raw, `Invalid Lane metadata at ${metadataPath}`)
	if (lane.id !== expectedId) throw new Error(`Invalid Lane metadata at ${metadataPath}: id '${lane.id}' does not match filename '${expectedId}.json'`)
	return lane
}

function laneIdNumber(id: string): number {
	const parsed = Number(id)
	if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`Invalid Lane id '${id}'`)
	return parsed
}

export async function markLaneClosed(projectRoot: string, id: string, at: string): Promise<Lane> {
	const lane = await readLane(projectRoot, id)
	if (!lane) throw new Error(`Lane '${id}' not found`)
	const closed = { ...lane, closedAt: at, mergedAt: at }
	await writeLane(projectRoot, closed)
	return closed
}

export async function computeLaneState(projectRoot: string, lane: Lane, git: GitOps): Promise<LaneState> {
	const worktrees = await git.worktreeList()
	for (const rule of laneStateRules(projectRoot, lane, git, worktrees)) {
		const state = await rule()
		if (state) return state
	}
	return 'open'
}

type LaneStateRule = () => Promise<LaneState | null> | LaneState | null

function laneStateRules(projectRoot: string, lane: Lane, git: GitOps, worktrees: GitWorktree[]): LaneStateRule[] {
	return [
		() => lane.closedAt !== null ? 'closed' : null,
		() => hasMergeWorktree(projectRoot, lane, worktrees) ? 'conflict' : null,
		async () => (await git.localBranchExists(lane.branch)) ? null : 'missing-branch',
		() => hasLaneWorktree(lane, worktrees) ? null : 'missing-worktree',
		async () => (await git.isWorkingTreeCleanIn(lane.worktreePath)) ? null : 'dirty',
	]
}

function hasLaneWorktree(lane: Lane, worktrees: GitWorktree[]): boolean {
	return worktrees.some((w) => pathsEqual(w.path, lane.worktreePath))
}

function hasMergeWorktree(projectRoot: string, lane: Lane, worktrees: GitWorktree[]): boolean {
	const mergePath = laneMergeWorktreePath(projectRoot, lane.id)
	return worktrees.some((w) => pathsEqual(w.path, mergePath))
}

function pathsEqual(a: string, b: string): boolean {
	return path.resolve(a) === path.resolve(b)
}

export { pathExists }

if (import.meta.vitest) {
	const { describe, test, expect, beforeEach, afterEach } = import.meta.vitest
	const { mkdtemp, rm } = await import('node:fs/promises')
	const { tmpdir } = await import('node:os')
	const { noopGitOps } = await import('../test-utils/git-ops-fixtures.ts')

	function lane(overrides: Partial<Lane> = {}): Lane {
		const id = '1'
		const title = 'Add cache invalidation'
		const defaults: Lane = {
			schemaVersion: 1,
			id,
			title,
			branch: laneBranchName(id, title),
			targetBranch: 'main',
			worktreePath: laneWorktreePath('/tmp/project', id),
			createdAt: '2026-01-01T00:00:00.000Z',
			closedAt: null,
			mergedAt: null,
		}
		return { ...defaults, ...overrides }
	}

	describe('lanes', () => {
		let root: string

		beforeEach(async () => {
			root = await mkdtemp(path.join(tmpdir(), 'trowel-lanes-'))
		})

		afterEach(async () => {
			await rm(root, { recursive: true, force: true })
		})

		test('laneBranchName matches lane-<id>-<slug(title)> and allows empty slug', () => {
			expect(laneBranchName('17', 'Add cache invalidation')).toBe('lane-17-add-cache-invalidation')
			expect(laneBranchName('17', '!!!')).toBe('lane-17-')
		})

		test('allocateNextLaneId scans open and closed metadata so ids are not reused', async () => {
			await writeLane(root, lane({ id: '1', closedAt: null }))
			await writeLane(root, lane({ id: '2', closedAt: '2026-01-02T00:00:00.000Z', mergedAt: '2026-01-02T00:00:00.000Z' }))
			expect(await allocateNextLaneId(root)).toBe('3')
		})

		test('listLanes returns newest first by createdAt and includes closed lanes', async () => {
			await writeLane(root, lane({ id: '1', createdAt: '2026-01-01T00:00:00.000Z' }))
			await writeLane(root, lane({ id: '2', createdAt: '2026-01-02T00:00:00.000Z', closedAt: '2026-01-03T00:00:00.000Z', mergedAt: '2026-01-03T00:00:00.000Z' }))
			expect((await listLanes(root)).map((l) => l.id)).toEqual(['2', '1'])
		})

		test('readLane rejects malformed metadata loudly', async () => {
			await mkdir(path.join(root, '.trowel', 'lanes'), { recursive: true })
			await writeFile(path.join(root, '.trowel', 'lanes', '1.json'), '{"id":1}', 'utf8')
			await expect(readLane(root, '1')).rejects.toThrow(/Invalid Lane metadata/)
		})

		test('readLane ignores obsolete baseRef metadata from older Lane records', async () => {
			await mkdir(path.join(root, '.trowel', 'lanes'), { recursive: true })
			await writeFile(path.join(root, '.trowel', 'lanes', '1.json'), `${JSON.stringify({ ...lane({ id: '1' }), baseRef: 'HEAD' }, null, 2)}\n`, 'utf8')

			const parsed = await readLane(root, '1')

			expect(parsed).toMatchObject({ id: '1', targetBranch: 'main' })
			expect(parsed).not.toHaveProperty('baseRef')
		})

		test('markLaneClosed records closedAt and mergedAt without deleting metadata', async () => {
			await writeLane(root, lane({ id: '1' }))
			await markLaneClosed(root, '1', '2026-01-04T00:00:00.000Z')
			expect(await readLane(root, '1')).toMatchObject({ closedAt: '2026-01-04T00:00:00.000Z', mergedAt: '2026-01-04T00:00:00.000Z' })
		})

		test('computeLaneState distinguishes closed, dirty, missing branch, and missing worktree', async () => {
			const open = lane({ id: '1', branch: 'lane-1-x', worktreePath: '/tmp/lane-1' })
			await expect(computeLaneState(root, { ...open, closedAt: '2026-01-01T00:00:00.000Z' }, noopGitOps())).resolves.toBe('closed')
			await expect(computeLaneState(root, open, noopGitOps({ localBranchExists: async () => false }))).resolves.toBe('missing-branch')
			await expect(computeLaneState(root, open, noopGitOps({ worktreeList: async () => [] }))).resolves.toBe('missing-worktree')
			await expect(computeLaneState(root, open, noopGitOps({ worktreeList: async () => [{ path: '/tmp/lane-1', branch: 'lane-1-x', head: '1' }], isWorkingTreeCleanIn: async () => false }))).resolves.toBe('dirty')
		})
	})
}
