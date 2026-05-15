import { v } from 'valleyed'

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

const ALL_VERDICTS = ['ready', 'needs-revision', 'no-work-needed', 'partial'] as const

const ROLE_VERDICTS: Record<Role, VerdictKind[]> = {
	implement: ['ready', 'no-work-needed', 'partial'],
	review: ['ready', 'needs-revision', 'partial'],
	address: ['ready', 'no-work-needed', 'partial'],
}

const turnOutPipe = () =>
	v.object({
		verdict: v.in(ALL_VERDICTS),
		notes: v.optional(v.string()),
	})

export function parseVerdict(raw: string | null, role: Role, commits: number): TurnOut {
	if (raw === null) throw new Error('verdict file missing (.trowel/turn-out.json)')
	let parsed: unknown
	try {
		parsed = JSON.parse(raw)
	} catch (e) {
		throw new Error(`verdict file parse error: ${(e as Error).message}`)
	}
	// Peek at the verdict field before pipe validation so the unknown-verdict error
	// surfaces the offending value (the pipe's "not in enum" message doesn't).
	if (typeof parsed === 'object' && parsed !== null && 'verdict' in parsed) {
		const v = (parsed as { verdict: unknown }).verdict
		if (typeof v === 'string' && !ALL_VERDICTS.includes(v as VerdictKind)) {
			throw new Error(`verdict file rejected: unknown verdict kind '${v}'`)
		}
	}
	const result = v.validate(turnOutPipe(), parsed)
	if (!result.valid) {
		const messages = result.error.messages.map((m) => `  · ${m.message ?? JSON.stringify(m)}`).join('\n')
		throw new Error(`verdict file rejected:\n${messages}`)
	}
	const kind = result.value.verdict as VerdictKind
	if (!ROLE_VERDICTS[role].includes(kind)) {
		throw new Error(`verdict '${kind}' is not valid for role '${role}'`)
	}
	if (role === 'implement' && kind === 'ready' && commits === 0) {
		throw new Error('implementer reported ready but made no commits')
	}
	const notes = result.value.notes
	return notes === undefined ? { verdict: kind, commits } : { verdict: kind, notes, commits }
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

		test('throws on null input (missing verdict file) with a message naming the missing file', () => {
			expect(() => parseVerdict(null, 'implement', 0)).toThrow(/verdict file missing/i)
		})

		test('throws on malformed JSON', () => {
			expect(() => parseVerdict('this is not json {{{', 'implement', 0)).toThrow(/verdict file/i)
		})

		test('throws on missing or non-string verdict field', () => {
			expect(() => parseVerdict('{}', 'implement', 0)).toThrow(/verdict/i)
			expect(() => parseVerdict('{"verdict":42}', 'implement', 0)).toThrow(/verdict/i)
		})

		test('throws on an unknown verdict kind, surfacing the offending value', () => {
			expect(() => parseVerdict('{"verdict":"something-weird"}', 'implement', 0)).toThrow(/something-weird/)
		})

		test('throws on a role-invalid verdict, naming both the kind and the role', () => {
			expect(() => parseVerdict('{"verdict":"needs-revision"}', 'implement', 0)).toThrow(/needs-revision.*implement|implement.*needs-revision/i)
			expect(() => parseVerdict('{"verdict":"no-work-needed"}', 'review', 0)).toThrow(/no-work-needed.*review|review.*no-work-needed/i)
			expect(() => parseVerdict('{"verdict":"needs-revision"}', 'address', 0)).toThrow(/needs-revision.*address|address.*needs-revision/i)
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

		test('throws on a non-string notes field (no silent coercion)', () => {
			expect(() => parseVerdict('{"verdict":"ready","notes":42}', 'implement', 1)).toThrow(/verdict file rejected/i)
		})

		test('throws when implementer reports ready but made zero commits', () => {
			expect(() => parseVerdict('{"verdict":"ready"}', 'implement', 0)).toThrow(/implementer.*no commits|no commits.*implementer/i)
		})

		test('reviewer and addresser ready + zero commits stay ready (coercion is implementer-only)', () => {
			expect(parseVerdict('{"verdict":"ready"}', 'review', 0).verdict).toBe('ready')
			expect(parseVerdict('{"verdict":"ready"}', 'address', 0).verdict).toBe('ready')
		})
	})
}
