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

export async function diagnose(desc: string): Promise<void> {
	notImplemented('diagnose', `Diagnostic workflow pending. Description: ${desc}`)
}

export async function fix(desc: string): Promise<void> {
	notImplemented('fix', `Fix flow pending (always creates an issue + PR linked to issue, no PRD). Description: ${desc}`)
}
