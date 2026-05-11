import type { Role } from './prompts.ts'

export type VerdictKind = 'ready' | 'needs-revision' | 'no-work-needed' | 'partial'

export type SandboxOut = {
	verdict: VerdictKind
	notes?: string
}

const ALL_VERDICTS: VerdictKind[] = ['ready', 'needs-revision', 'no-work-needed', 'partial']

const ROLE_VERDICTS: Record<Role, VerdictKind[]> = {
	implement: ['ready', 'no-work-needed', 'partial'],
	review: ['ready', 'needs-revision', 'partial'],
	address: ['ready', 'no-work-needed', 'partial'],
}

export function parseVerdict(raw: string | null, role: Role): SandboxOut {
	if (raw === null) return { verdict: 'partial', notes: 'verdict file missing' }
	let parsed: unknown
	try {
		parsed = JSON.parse(raw)
	} catch (e) {
		return { verdict: 'partial', notes: `verdict file parse error: ${(e as Error).message}` }
	}
	if (!isObject(parsed) || typeof parsed.verdict !== 'string') {
		return { verdict: 'partial', notes: 'verdict file parse error: missing or non-string `verdict` field' }
	}
	if (!ALL_VERDICTS.includes(parsed.verdict as VerdictKind)) {
		return { verdict: 'partial', notes: `unknown verdict kind: ${parsed.verdict}` }
	}
	const kind = parsed.verdict as VerdictKind
	if (!ROLE_VERDICTS[role].includes(kind)) {
		return { verdict: 'partial', notes: `verdict '${kind}' is not valid for role '${role}'` }
	}
	const notes = typeof parsed.notes === 'string' ? parsed.notes : undefined
	return notes === undefined ? { verdict: kind } : { verdict: kind, notes }
}

function isObject(x: unknown): x is Record<string, unknown> {
	return typeof x === 'object' && x !== null && !Array.isArray(x)
}

if (import.meta.vitest) {
	const { describe, test, expect } = import.meta.vitest

	describe('parseVerdict', () => {
		test('parses a valid implementer "ready" verdict', () => {
			const out = parseVerdict('{"verdict":"ready"}', 'implement')
			expect(out.verdict).toBe('ready')
		})

		test('coerces a null input (missing verdict file) to partial with notes', () => {
			const out = parseVerdict(null, 'implement')
			expect(out.verdict).toBe('partial')
			expect(out.notes).toMatch(/missing/i)
		})

		test('coerces malformed JSON to partial with notes', () => {
			const out = parseVerdict('this is not json {{{', 'implement')
			expect(out.verdict).toBe('partial')
			expect(out.notes).toMatch(/parse/i)
		})

		test('coerces an unknown verdict kind to partial with notes', () => {
			const out = parseVerdict('{"verdict":"something-weird"}', 'implement')
			expect(out.verdict).toBe('partial')
			expect(out.notes).toMatch(/something-weird/)
		})

		test('coerces a role-invalid verdict to partial', () => {
			// implementer cannot return needs-revision (reviewer's verdict)
			const impl = parseVerdict('{"verdict":"needs-revision"}', 'implement')
			expect(impl.verdict).toBe('partial')
			expect(impl.notes).toMatch(/needs-revision/)
			expect(impl.notes).toMatch(/implement/)

			// reviewer cannot return no-work-needed (implementer/addresser verdict)
			const rev = parseVerdict('{"verdict":"no-work-needed"}', 'review')
			expect(rev.verdict).toBe('partial')

			// addresser cannot return needs-revision (reviewer's verdict)
			const addr = parseVerdict('{"verdict":"needs-revision"}', 'address')
			expect(addr.verdict).toBe('partial')
		})

		test('accepts the valid verdicts for each role', () => {
			// implementer: ready, no-work-needed, partial
			expect(parseVerdict('{"verdict":"ready"}', 'implement').verdict).toBe('ready')
			expect(parseVerdict('{"verdict":"no-work-needed"}', 'implement').verdict).toBe('no-work-needed')
			expect(parseVerdict('{"verdict":"partial"}', 'implement').verdict).toBe('partial')
			// reviewer: ready, needs-revision, partial
			expect(parseVerdict('{"verdict":"ready"}', 'review').verdict).toBe('ready')
			expect(parseVerdict('{"verdict":"needs-revision"}', 'review').verdict).toBe('needs-revision')
			expect(parseVerdict('{"verdict":"partial"}', 'review').verdict).toBe('partial')
			// addresser: ready, no-work-needed, partial
			expect(parseVerdict('{"verdict":"ready"}', 'address').verdict).toBe('ready')
			expect(parseVerdict('{"verdict":"no-work-needed"}', 'address').verdict).toBe('no-work-needed')
			expect(parseVerdict('{"verdict":"partial"}', 'address').verdict).toBe('partial')
		})

		test('preserves the notes field from the input when present', () => {
			const out = parseVerdict('{"verdict":"partial","notes":"hit cap mid-test"}', 'implement')
			expect(out.verdict).toBe('partial')
			expect(out.notes).toBe('hit cap mid-test')
		})

		test('ignores a non-string notes field', () => {
			const out = parseVerdict('{"verdict":"ready","notes":42}', 'implement')
			expect(out.verdict).toBe('ready')
			expect(out.notes).toBeUndefined()
		})
	})
}
