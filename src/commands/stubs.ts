/**
 * Shared stubs for commands whose real implementation is deferred to per-backend
 * grilling sessions or the sandcastle port. Each prints a clear "not implemented"
 * message and exits non-zero.
 */

function notImplemented(commandName: string, reason: string): never {
	process.stderr.write(`trowel ${commandName}: not yet implemented\n  ${reason}\n`)
	process.exit(1)
}

export async function start(opts: { prd?: string; backend?: string }): Promise<void> {
	notImplemented('start', `Requires a backend implementation. Backends are deferred to per-backend grilling. Opts: ${JSON.stringify(opts)}`)
}

export async function work(prdId: string, opts: { backend?: string }): Promise<void> {
	notImplemented('work', `Requires both a backend implementation and the sandcastle port. prdId=${prdId} opts=${JSON.stringify(opts)}`)
}

export async function diagnose(desc: string): Promise<void> {
	notImplemented('diagnose', `Diagnostic workflow pending. Description: ${desc}`)
}

export async function fix(desc: string): Promise<void> {
	notImplemented('fix', `Fix flow pending (always creates an issue + PR linked to issue, no PRD). Description: ${desc}`)
}

export async function implement(prdId: string, sliceId: string): Promise<void> {
	notImplemented('implement', `Requires a backend implementation to validate slice-id belongs to prd-id. prdId=${prdId} sliceId=${sliceId}`)
}

export async function address(prdId: string, sliceId: string): Promise<void> {
	notImplemented('address', `Requires backend + PR resolver. prdId=${prdId} sliceId=${sliceId}`)
}

export async function review(prdId: string, sliceId: string): Promise<void> {
	notImplemented('review', `Requires backend + PR resolver. prdId=${prdId} sliceId=${sliceId}`)
}
