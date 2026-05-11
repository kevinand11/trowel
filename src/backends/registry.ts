import type { BackendKind } from '../schema.ts'
import type { Backend } from './types.ts'

class NotImplementedBackend implements Backend {
	constructor(public kind: BackendKind) {}

	#fail(method: string): never {
		throw new Error(`Backend '${this.kind}' is not yet implemented (called .${method}()). The backends will be added in subsequent grilling sessions.`)
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

export function getBackend(kind: BackendKind): Backend {
	return new NotImplementedBackend(kind)
}
