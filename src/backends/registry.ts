import type { Backend } from './types.ts'

class NotImplementedBackend implements Backend {
	name = 'not-yet-implemented'

	#fail(method: string): never {
		throw new Error(
			`Backend '${this.name}' is not yet implemented (called .${method}()). The backends will be added in subsequent grilling sessions.`,
		)
	}

	proposeIdentifier(): string {
		this.#fail('proposeIdentifier')
	}
	branchFor(): string {
		this.#fail('branchFor')
	}
	async writeArtifacts(): Promise<void> {
		this.#fail('writeArtifacts')
	}
	async createRemoteObject(): Promise<string> {
		this.#fail('createRemoteObject')
	}
	async linkBranchToPrd(): Promise<void> {
		this.#fail('linkBranchToPrd')
	}
	sliceMarker(): string {
		this.#fail('sliceMarker')
	}
	async attachSlice(): Promise<void> {
		this.#fail('attachSlice')
	}
	async findSlices(): Promise<never> {
		this.#fail('findSlices')
	}
	async listOpen(): Promise<never> {
		this.#fail('listOpen')
	}
	async close(): Promise<void> {
		this.#fail('close')
	}
}

export const backendRegistry = Object.fromEntries([new NotImplementedBackend()].map((backend) => [backend.name, backend] as const))

export function getBackend(kind: string): Backend {
	const backend = backendRegistry[kind]
	if (!backend) throw new Error(`No backend registered for kind '${kind}'`)
	return backend
}

if (import.meta.vitest) {
	const { describe, test, expect } = import.meta.vitest

	describe('getBackend', () => {
		test('returns an object whose kind matches the requested kind', () => {
			expect(getBackend('not-yet-implemented').name).toBe('not-yet-implemented')
		})

		test('every method throws with a clear "not yet implemented" message', async () => {
			const b = getBackend('not-yet-implemented')
			expect(() => b.proposeIdentifier('x')).toThrow(/not yet implemented/)
			expect(() => b.branchFor('x')).toThrow(/not yet implemented/)
			expect(() => b.sliceMarker('x')).toThrow(/not yet implemented/)
			await expect(b.writeArtifacts({ title: '', slug: '', body: '' }, '/')).rejects.toThrow(/not yet implemented/)
			await expect(b.createRemoteObject({ title: '', slug: '', body: '' }, 'b')).rejects.toThrow(/not yet implemented/)
			await expect(b.linkBranchToPrd('1', 'b')).rejects.toThrow(/not yet implemented/)
			await expect(b.attachSlice('1', '2')).rejects.toThrow(/not yet implemented/)
			await expect(b.findSlices('1')).rejects.toThrow(/not yet implemented/)
			await expect(b.listOpen()).rejects.toThrow(/not yet implemented/)
			await expect(b.close('1')).rejects.toThrow(/not yet implemented/)
		})

		test('error message names the kind for diagnostics', () => {
			expect(() => getBackend('not-yet-implemented').proposeIdentifier('x')).toThrow(/not-yet-implemented/)
		})
	})
}
