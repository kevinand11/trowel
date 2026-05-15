import { v, type PipeOutput } from 'valleyed'

const startOutPipe = () =>
	v.object({
		prd: v.object({
			title: v.string(),
			body: v.string(),
		}),
		slices: v.array(
			v.object({
				title: v.string(),
				body: v.string(),
				blockedBy: v.array(v.number()),
				readyForAgent: v.boolean(),
			}),
		),
	})

export type StartOut = PipeOutput<ReturnType<typeof startOutPipe>>

export function parseStartOut(raw: string): StartOut {
	let parsed: unknown
	try {
		parsed = JSON.parse(raw)
	} catch (e) {
		throw new Error(`Invalid start-out.json: ${(e as Error).message}`)
	}
	const result = v.validate(startOutPipe(), parsed)
	if (!result.valid) {
		const messages = result.error.messages.map((m) => `  · ${m.message ?? JSON.stringify(m)}`).join('\n')
		throw new Error(`Invalid start-out.json:\n${messages}`)
	}
	const value = result.value as StartOut
	checkBlockedBy(value.slices)
	return value
}

function checkBlockedBy(slices: StartOut['slices']): void {
	for (const [i, slice] of slices.entries()) {
		for (const ref of slice.blockedBy) {
			if (!Number.isInteger(ref) || ref < 0 || ref >= slices.length) {
				throw new Error(`Invalid start-out.json: slice ${i} blockedBy references out-of-range index ${ref} (valid range: 0..${slices.length - 1})`)
			}
			if (ref === i) {
				throw new Error(`Invalid start-out.json: slice ${i} blockedBy contains a self-reference`)
			}
		}
	}
	const visited = new Array<0 | 1 | 2>(slices.length).fill(0) // 0=unseen, 1=in-stack, 2=done
	const stack: number[] = []
	const visit = (i: number): void => {
		if (visited[i] === 2) return
		if (visited[i] === 1) {
			const start = stack.indexOf(i)
			throw new Error(`Invalid start-out.json: blockedBy cycle detected: ${stack.slice(start).concat(i).join(' → ')}`)
		}
		visited[i] = 1
		stack.push(i)
		for (const ref of slices[i].blockedBy) visit(ref)
		stack.pop()
		visited[i] = 2
	}
	for (let i = 0; i < slices.length; i++) visit(i)
}

if (import.meta.vitest) {
	const { describe, test, expect } = import.meta.vitest
	const { parseStartOut } = await import('./start-out.ts')

	describe('parseStartOut', () => {
		test('rejects a payload missing the prd field', () => {
			const raw = JSON.stringify({ slices: [] })
			expect(() => parseStartOut(raw)).toThrow(/Invalid start-out\.json/)
		})

		test('rejects a payload missing the slices field', () => {
			const raw = JSON.stringify({ prd: { title: 'x', body: 'y' } })
			expect(() => parseStartOut(raw)).toThrow(/Invalid start-out\.json/)
		})

		test('rejects a blockedBy index ≥ slices.length, naming the offending slice index', () => {
			const raw = JSON.stringify({
				prd: { title: 't', body: 'b' },
				slices: [
					{ title: 'a', body: 'b', blockedBy: [], readyForAgent: true },
					{ title: 'a', body: 'b', blockedBy: [5], readyForAgent: true },
				],
			})
			expect(() => parseStartOut(raw)).toThrow(/slice 1.*blockedBy.*5/i)
		})

		test('rejects a negative blockedBy index', () => {
			const raw = JSON.stringify({
				prd: { title: 't', body: 'b' },
				slices: [{ title: 'a', body: 'b', blockedBy: [-1], readyForAgent: true }],
			})
			expect(() => parseStartOut(raw)).toThrow(/slice 0.*blockedBy.*-1/i)
		})

		test('rejects a slice that blocks on itself', () => {
			const raw = JSON.stringify({
				prd: { title: 't', body: 'b' },
				slices: [{ title: 'a', body: 'b', blockedBy: [0], readyForAgent: true }],
			})
			expect(() => parseStartOut(raw)).toThrow(/slice 0.*self/i)
		})

		test('rejects a 2-cycle (A blocks B, B blocks A)', () => {
			const raw = JSON.stringify({
				prd: { title: 't', body: 'b' },
				slices: [
					{ title: 'A', body: 'b', blockedBy: [1], readyForAgent: true },
					{ title: 'B', body: 'b', blockedBy: [0], readyForAgent: true },
				],
			})
			expect(() => parseStartOut(raw)).toThrow(/cycle/i)
		})

		test('rejects a 3-cycle (A→B→C→A)', () => {
			const raw = JSON.stringify({
				prd: { title: 't', body: 'b' },
				slices: [
					{ title: 'A', body: 'b', blockedBy: [2], readyForAgent: true },
					{ title: 'B', body: 'b', blockedBy: [0], readyForAgent: true },
					{ title: 'C', body: 'b', blockedBy: [1], readyForAgent: true },
				],
			})
			expect(() => parseStartOut(raw)).toThrow(/cycle/i)
		})

		test('accepts an empty slices array (single-slice PRD or "add slices later" cases)', () => {
			const raw = JSON.stringify({
				prd: { title: 'Spec-only PRD', body: 'body' },
				slices: [],
			})
			const out = parseStartOut(raw)
			expect(out.slices).toEqual([])
		})

		test('rejects non-JSON input with a clear error', () => {
			expect(() => parseStartOut('this is not json {{{')).toThrow(/start-out\.json/i)
		})

		test('parses a valid 2-slice spec where the second slice blocks on the first', () => {
			const raw = JSON.stringify({
				prd: { title: 'Rename Foo to Bar', body: '## Problem Statement\n…' },
				slices: [
					{ title: 'Rename Foo type', body: '## What to build\n…', blockedBy: [], readyForAgent: true },
					{ title: 'Update callsites', body: '## What to build\n…', blockedBy: [0], readyForAgent: true },
				],
			})

			const out = parseStartOut(raw)

			expect(out.prd.title).toBe('Rename Foo to Bar')
			expect(out.slices).toHaveLength(2)
			expect(out.slices[1].blockedBy).toEqual([0])
			expect(out.slices[0].readyForAgent).toBe(true)
		})
	})
}
