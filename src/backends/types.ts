export type PrdSpec = {
	title: string
	slug: string
	body: string
}

export type PrdSummary = {
	id: string
	title: string
	branch: string
}

export type Slice = {
	id: string
	title: string
	body: string
	labels: string[]
	state: 'OPEN' | 'CLOSED'
}

export interface Backend {
	name: string
	// identifier helpers
	proposeIdentifier(title: string): string
	branchFor(id: string): string
	// creation flow (called by `trowel start`)
	writeArtifacts(spec: PrdSpec, repoRoot: string): Promise<void>
	createRemoteObject(spec: PrdSpec, branch: string): Promise<string>
	linkBranchToPrd(id: string, branch: string): Promise<void>
	// slicing
	sliceMarker(prdId: string): string
	attachSlice(prdId: string, sliceId: string): Promise<void>
	findSlices(prdId: string): Promise<Slice[]>
	// discovery
	listOpen(): Promise<PrdSummary[]>
	close(id: string): Promise<void>
}
