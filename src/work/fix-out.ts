import { v, type PipeOutput } from 'valleyed'

const fixOutPipe = () =>
	v.object({
		title: v.string(),
		body: v.string(),
	})

export type FixOut = PipeOutput<ReturnType<typeof fixOutPipe>>

export function parseFixOut(raw: string): FixOut {
	let parsed: unknown
	try {
		parsed = JSON.parse(raw)
	} catch (e) {
		throw new Error(`Invalid fix-out.json: ${(e as Error).message}`)
	}
	const result = v.validate(fixOutPipe(), parsed)
	if (!result.valid) {
		const messages = result.error.messages.map((m) => `  · ${m.message ?? JSON.stringify(m)}`).join('\n')
		throw new Error(`Invalid fix-out.json:\n${messages}`)
	}
	return result.value as FixOut
}

if (import.meta.vitest) {
	const { describe, test, expect } = import.meta.vitest

	describe('parseFixOut', () => {
		test('parses a valid blob', () => {
			const raw = JSON.stringify({ title: 'Tabs render wrong on macOS', body: '## Symptoms\n…' })
			const out = parseFixOut(raw)
			expect(out.title).toBe('Tabs render wrong on macOS')
			expect(out.body).toMatch(/Symptoms/)
		})

		test('rejects missing title', () => {
			expect(() => parseFixOut(JSON.stringify({ body: 'b' }))).toThrow(/Invalid fix-out\.json/)
		})

		test('rejects missing body', () => {
			expect(() => parseFixOut(JSON.stringify({ title: 't' }))).toThrow(/Invalid fix-out\.json/)
		})

		test('rejects non-JSON input', () => {
			expect(() => parseFixOut('not json {{{')).toThrow(/fix-out\.json/i)
		})
	})
}
