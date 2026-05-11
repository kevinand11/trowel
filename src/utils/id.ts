const ID_LEN = 6
const BASE = 36
const DEFAULT_MAX_RETRIES = 5

export function generateId(): string {
	let out = ''
	while (out.length < ID_LEN) {
		out += Math.floor(Math.random() * BASE).toString(BASE)
	}
	return out.slice(0, ID_LEN)
}

export async function generateUniqueId(
	isUnique: (candidate: string) => Promise<boolean>,
	opts: { maxRetries?: number; gen?: () => string } = {},
): Promise<string> {
	const max = opts.maxRetries ?? DEFAULT_MAX_RETRIES
	const gen = opts.gen ?? generateId
	for (let attempt = 0; attempt < max; attempt++) {
		const candidate = gen()
		if (await isUnique(candidate)) return candidate
	}
	throw new Error(`generateUniqueId: retries exhausted (${max}) without producing a unique id`)
}

if (import.meta.vitest) {
	const { describe, test, expect } = import.meta.vitest

	describe('generateId', () => {
		test('returns a 6-character base-36 string', () => {
			const id = generateId()
			expect(id).toMatch(/^[0-9a-z]{6}$/)
		})
	})

	describe('generateUniqueId', () => {
		test('returns an id immediately when the predicate accepts the first attempt', async () => {
			const id = await generateUniqueId(async () => true)
			expect(id).toMatch(/^[0-9a-z]{6}$/)
		})

		test('retries until the predicate accepts and returns that id', async () => {
			let calls = 0
			const id = await generateUniqueId(async () => {
				calls++
				return calls >= 3
			})
			expect(calls).toBe(3)
			expect(id).toMatch(/^[0-9a-z]{6}$/)
		})

		test('throws when retries are exhausted', async () => {
			await expect(generateUniqueId(async () => false, { maxRetries: 5 })).rejects.toThrow(/exhausted/)
		})
	})
}
