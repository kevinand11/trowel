import { v } from 'valleyed'

import { parseJson, validateJson } from './parse-json.ts'

const createChangePipe = () =>
	v.object({
		outcome: v.eq('create-change'),
		change: v.object({
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

const existingChangePipe = () =>
	v.object({
		outcome: v.eq('existing-change'),
		changeId: v.string(),
		reason: v.string(),
	})

const noChangePipe = () =>
	v.object({
		outcome: v.eq('no-change'),
		reason: v.string(),
	})

const startOutPipe = () => v.or([createChangePipe(), existingChangePipe(), noChangePipe()])

export type CreateChangeStartOut = {
	outcome: 'create-change'
	change: { title: string; body: string }
	slices: Array<{ title: string; body: string; blockedBy: number[]; readyForAgent: boolean }>
}
export type ExistingChangeStartOut = { outcome: 'existing-change'; changeId: string; reason: string }
export type NoChangeStartOut = { outcome: 'no-change'; reason: string }
export type StartOut = CreateChangeStartOut | ExistingChangeStartOut | NoChangeStartOut

export function parseStartOut(raw: string): StartOut {
	const parsed = parseJson(raw, 'start-out.json')
	const value = validateJson<StartOut>(startOutPipe(), parsed, 'Invalid start-out.json')
	if (value.outcome === 'create-change') checkBlockedBy(value.slices)
	return value
}

function checkBlockedBy(slices: CreateChangeStartOut['slices']): void {
	checkBlockedByReferences(slices)
	checkBlockedByAcyclic(slices)
}

function checkBlockedByReferences(slices: CreateChangeStartOut['slices']): void {
	for (const [i, slice] of slices.entries()) {
		for (const ref of slice.blockedBy) checkBlockedByReference(slices, i, ref)
	}
}

function checkBlockedByReference(slices: CreateChangeStartOut['slices'], sliceIndex: number, ref: number): void {
	if (!isSliceIndex(ref, slices.length)) {
		throw new Error(`Invalid start-out.json: slice ${sliceIndex} blockedBy references out-of-range index ${ref} (valid range: 0..${slices.length - 1})`)
	}
	if (ref === sliceIndex) throw new Error(`Invalid start-out.json: slice ${sliceIndex} blockedBy contains a self-reference`)
}

function isSliceIndex(ref: number, length: number): boolean {
	return Number.isInteger(ref) && ref >= 0 && ref < length
}

function checkBlockedByAcyclic(slices: CreateChangeStartOut['slices']): void {
	const state = {
		visited: new Array<0 | 1 | 2>(slices.length).fill(0), // 0=unseen, 1=in-stack, 2=done
		stack: [] as number[],
	}
	for (let i = 0; i < slices.length; i++) visitBlockedBy(slices, state, i)
}

function visitBlockedBy(slices: CreateChangeStartOut['slices'], state: { visited: Array<0 | 1 | 2>; stack: number[] }, i: number): void {
	if (state.visited[i] === 2) return
	if (state.visited[i] === 1) throw blockedByCycleError(state.stack, i)
	state.visited[i] = 1
	state.stack.push(i)
	for (const ref of slices[i].blockedBy) visitBlockedBy(slices, state, ref)
	state.stack.pop()
	state.visited[i] = 2
}

function blockedByCycleError(stack: number[], repeated: number): Error {
	const start = stack.indexOf(repeated)
	return new Error(`Invalid start-out.json: blockedBy cycle detected: ${stack.slice(start).concat(repeated).join(' → ')}`)
}

if (import.meta.vitest) {
	const { describe, test, expect } = import.meta.vitest
	const { parseStartOut } = await import('./start-out.ts')

	describe('parseStartOut', () => {
		test('rejects a payload missing the change field', () => {
			const raw = JSON.stringify({ slices: [] })
			expect(() => parseStartOut(raw)).toThrow(/Invalid start-out\.json/)
		})

		test('rejects a payload missing the slices field', () => {
			const raw = JSON.stringify({ outcome: 'create-change', change: { title: 'x', body: 'y' } })
			expect(() => parseStartOut(raw)).toThrow(/Invalid start-out\.json/)
		})

		test('rejects a blockedBy index ≥ slices.length, naming the offending slice index', () => {
			const raw = JSON.stringify({
				outcome: 'create-change',
				change: { title: 't', body: 'b' },
				slices: [
					{ title: 'a', body: 'b', blockedBy: [], readyForAgent: true },
					{ title: 'a', body: 'b', blockedBy: [5], readyForAgent: true },
				],
			})
			expect(() => parseStartOut(raw)).toThrow(/slice 1.*blockedBy.*5/i)
		})

		test('rejects a negative blockedBy index', () => {
			const raw = JSON.stringify({
				outcome: 'create-change',
				change: { title: 't', body: 'b' },
				slices: [{ title: 'a', body: 'b', blockedBy: [-1], readyForAgent: true }],
			})
			expect(() => parseStartOut(raw)).toThrow(/slice 0.*blockedBy.*-1/i)
		})

		test('rejects a slice that blocks on itself', () => {
			const raw = JSON.stringify({
				outcome: 'create-change',
				change: { title: 't', body: 'b' },
				slices: [{ title: 'a', body: 'b', blockedBy: [0], readyForAgent: true }],
			})
			expect(() => parseStartOut(raw)).toThrow(/slice 0.*self/i)
		})

		test('rejects a 2-cycle (A blocks B, B blocks A)', () => {
			const raw = JSON.stringify({
				outcome: 'create-change',
				change: { title: 't', body: 'b' },
				slices: [
					{ title: 'A', body: 'b', blockedBy: [1], readyForAgent: true },
					{ title: 'B', body: 'b', blockedBy: [0], readyForAgent: true },
				],
			})
			expect(() => parseStartOut(raw)).toThrow(/cycle/i)
		})

		test('rejects a 3-cycle (A→B→C→A)', () => {
			const raw = JSON.stringify({
				outcome: 'create-change',
				change: { title: 't', body: 'b' },
				slices: [
					{ title: 'A', body: 'b', blockedBy: [2], readyForAgent: true },
					{ title: 'B', body: 'b', blockedBy: [0], readyForAgent: true },
					{ title: 'C', body: 'b', blockedBy: [1], readyForAgent: true },
				],
			})
			expect(() => parseStartOut(raw)).toThrow(/cycle/i)
		})

		test('accepts an empty slices array (single-slice Change or "add slices later" cases)', () => {
			const raw = JSON.stringify({
				outcome: 'create-change',
				change: { title: 'Spec-only Change', body: 'body' },
				slices: [],
			})
			const out = parseStartOut(raw)
			expect(out.outcome).toBe('create-change')
			if (out.outcome !== 'create-change') throw new Error('expected create-change')
			expect(out.slices).toEqual([])
		})

		test('rejects non-JSON input with a clear error', () => {
			expect(() => parseStartOut('this is not json {{{')).toThrow(/start-out\.json/i)
		})

		test('parses a valid 2-slice spec where the second slice blocks on the first', () => {
			const raw = JSON.stringify({
				outcome: 'create-change',
				change: { title: 'Rename Foo to Bar', body: '## Problem Statement\n…' },
				slices: [
					{ title: 'Rename Foo type', body: '## What to build\n…', blockedBy: [], readyForAgent: true },
					{ title: 'Update callsites', body: '## What to build\n…', blockedBy: [0], readyForAgent: true },
				],
			})

			const out = parseStartOut(raw)

			expect(out.outcome).toBe('create-change')
			if (out.outcome !== 'create-change') throw new Error('expected create-change')
			expect(out.change.title).toBe('Rename Foo to Bar')
			expect(out.slices).toHaveLength(2)
			expect(out.slices[1].blockedBy).toEqual([0])
			expect(out.slices[0].readyForAgent).toBe(true)
		})
	})
}
