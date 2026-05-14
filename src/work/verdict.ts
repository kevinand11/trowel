import type { Role } from './prompts.ts'

export type VerdictKind = 'ready' | 'needs-revision' | 'no-work-needed' | 'partial'

export type TurnOut = {
	verdict: VerdictKind
	notes?: string
	commits: number
}

export type FeedbackEntry =
	| { kind: 'line'; author: string; createdAt: string; body: string; path: string; line: number; resolved: boolean }
	| { kind: 'review'; author: string; createdAt: string; body: string; state: 'COMMENTED' | 'CHANGES_REQUESTED' | 'APPROVED' }
	| { kind: 'thread'; author: string; createdAt: string; body: string }

export type TurnIn = {
	slice: { id: string; title: string; body: string }
	pr?: { number: number; branch: string }
	feedback?: FeedbackEntry[]
}

const ALL_VERDICTS: VerdictKind[] = ['ready', 'needs-revision', 'no-work-needed', 'partial']

const ROLE_VERDICTS: Record<Role, VerdictKind[]> = {
	implement: ['ready', 'no-work-needed', 'partial'],
	review: ['ready', 'needs-revision', 'partial'],
	address: ['ready', 'no-work-needed', 'partial'],
}

export function parseVerdict(raw: string | null, role: Role, commits: number): TurnOut {
	if (raw === null) return { verdict: 'partial', notes: 'verdict file missing', commits }
	let parsed: unknown
	try {
		parsed = JSON.parse(raw)
	} catch (e) {
		return { verdict: 'partial', notes: `verdict file parse error: ${(e as Error).message}`, commits }
	}
	if (!isObject(parsed) || typeof parsed.verdict !== 'string') {
		return { verdict: 'partial', notes: 'verdict file parse error: missing or non-string `verdict` field', commits }
	}
	if (!ALL_VERDICTS.includes(parsed.verdict as VerdictKind)) {
		return { verdict: 'partial', notes: `unknown verdict kind: ${parsed.verdict}`, commits }
	}
	const kind = parsed.verdict as VerdictKind
	if (!ROLE_VERDICTS[role].includes(kind)) {
		return { verdict: 'partial', notes: `verdict '${kind}' is not valid for role '${role}'`, commits }
	}
	if (role === 'implement' && kind === 'ready' && commits === 0) {
		return { verdict: 'partial', notes: 'implementer reported ready but made no commits', commits }
	}
	const notes = typeof parsed.notes === 'string' ? parsed.notes : undefined
	return notes === undefined ? { verdict: kind, commits } : { verdict: kind, notes, commits }
}

function isObject(x: unknown): x is Record<string, unknown> {
	return typeof x === 'object' && x !== null && !Array.isArray(x)
}

if (import.meta.vitest) {
	const { describe, test, expect } = import.meta.vitest

	describe('parseVerdict', () => {
		test('parses a valid implementer "ready" verdict', () => {
			const out = parseVerdict('{"verdict":"ready"}', 'implement', 1)
			expect(out.verdict).toBe('ready')
		})

		test('carries the commits count through onto the parsed verdict', () => {
			const out = parseVerdict('{"verdict":"ready"}', 'implement', 3)
			expect(out.commits).toBe(3)
		})

		test('coerces a null input (missing verdict file) to partial with notes', () => {
			const out = parseVerdict(null, 'implement', 0)
			expect(out.verdict).toBe('partial')
			expect(out.notes).toMatch(/missing/i)
		})

		test('coerces malformed JSON to partial with notes', () => {
			const out = parseVerdict('this is not json {{{', 'implement', 0)
			expect(out.verdict).toBe('partial')
			expect(out.notes).toMatch(/parse/i)
		})

		test('coerces an unknown verdict kind to partial with notes', () => {
			const out = parseVerdict('{"verdict":"something-weird"}', 'implement', 0)
			expect(out.verdict).toBe('partial')
			expect(out.notes).toMatch(/something-weird/)
		})

		test('coerces a role-invalid verdict to partial', () => {
			// implementer cannot return needs-revision (reviewer's verdict)
			const impl = parseVerdict('{"verdict":"needs-revision"}', 'implement', 0)
			expect(impl.verdict).toBe('partial')
			expect(impl.notes).toMatch(/needs-revision/)
			expect(impl.notes).toMatch(/implement/)

			// reviewer cannot return no-work-needed (implementer/addresser verdict)
			const rev = parseVerdict('{"verdict":"no-work-needed"}', 'review', 0)
			expect(rev.verdict).toBe('partial')

			// addresser cannot return needs-revision (reviewer's verdict)
			const addr = parseVerdict('{"verdict":"needs-revision"}', 'address', 0)
			expect(addr.verdict).toBe('partial')
		})

		test('accepts the valid verdicts for each role', () => {
			// implementer: ready, no-work-needed, partial
			expect(parseVerdict('{"verdict":"ready"}', 'implement', 1).verdict).toBe('ready')
			expect(parseVerdict('{"verdict":"no-work-needed"}', 'implement', 0).verdict).toBe('no-work-needed')
			expect(parseVerdict('{"verdict":"partial"}', 'implement', 0).verdict).toBe('partial')
			// reviewer: ready, needs-revision, partial
			expect(parseVerdict('{"verdict":"ready"}', 'review', 0).verdict).toBe('ready')
			expect(parseVerdict('{"verdict":"needs-revision"}', 'review', 0).verdict).toBe('needs-revision')
			expect(parseVerdict('{"verdict":"partial"}', 'review', 0).verdict).toBe('partial')
			// addresser: ready, no-work-needed, partial
			expect(parseVerdict('{"verdict":"ready"}', 'address', 0).verdict).toBe('ready')
			expect(parseVerdict('{"verdict":"no-work-needed"}', 'address', 0).verdict).toBe('no-work-needed')
			expect(parseVerdict('{"verdict":"partial"}', 'address', 0).verdict).toBe('partial')
		})

		test('preserves the notes field from the input when present', () => {
			const out = parseVerdict('{"verdict":"partial","notes":"hit cap mid-test"}', 'implement', 0)
			expect(out.verdict).toBe('partial')
			expect(out.notes).toBe('hit cap mid-test')
		})

		test('ignores a non-string notes field', () => {
			const out = parseVerdict('{"verdict":"ready","notes":42}', 'implement', 1)
			expect(out.verdict).toBe('ready')
			expect(out.notes).toBeUndefined()
		})

		test('coerces implementer ready + zero commits to partial with a logged reason', () => {
			const out = parseVerdict('{"verdict":"ready"}', 'implement', 0)
			expect(out.verdict).toBe('partial')
			expect(out.notes).toMatch(/implementer.*no commits/i)
			expect(out.commits).toBe(0)
		})

		test('reviewer and addresser ready + zero commits stay ready (coercion is implementer-only)', () => {
			expect(parseVerdict('{"verdict":"ready"}', 'review', 0).verdict).toBe('ready')
			expect(parseVerdict('{"verdict":"ready"}', 'address', 0).verdict).toBe('ready')
		})
	})
}
