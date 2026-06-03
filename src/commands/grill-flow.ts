import { readFile, unlink } from 'node:fs/promises'
import path from 'node:path'

import type { GitOps } from '../utils/git-ops.ts'

export type GrillRuntime<Spec> = {
	projectRoot: string
	git: GitOps
	readOut: () => Promise<string | null>
	preflight: () => Promise<string[]>
	stdout: (s: string) => void
	confirm: (msg: string) => Promise<boolean>
	parseOut: (raw: string) => Spec
	printResumePreview: (spec: Spec) => void
	runInteractive: () => Promise<void>
	missingOutMessage: string
	missingOutError: string
	resumePrompt: string
	invalidPrompt: string
	outFileName: string
}

export type GrillSpecResult<Spec> = {
	spec: Spec
	targetBranch: string
	backTo: string
	stashed: boolean
	markMaterialised: () => void
	clearOut: () => Promise<void>
	recover: () => Promise<void>
}

type ExistingOutDecision<Spec> = { resumedSpec: Spec | null; discardExistingOut: boolean }
type ExistingOutParse<Spec> = { ok: true; spec: Spec } | { ok: false; error: Error }
type CollectedGrillSpec<Spec> = { spec: Spec; stashed: boolean }

export async function resolveGrillSpec<Spec>(rt: GrillRuntime<Spec>): Promise<GrillSpecResult<Spec>> {
	const outPath = path.join(rt.projectRoot, '.trowel', rt.outFileName)
	const existing = await resolveExistingOut(rt)
	if (existing.resumedSpec === null) await prepareFreshGrill(rt, outPath, existing.discardExistingOut)
	const targetBranch = await rt.git.currentBranch()
	const collected = await collectGrillSpec(rt, existing.resumedSpec, targetBranch)
	return grillSpecResult(rt, outPath, targetBranch, collected)
}

async function resolveExistingOut<Spec>(rt: GrillRuntime<Spec>): Promise<ExistingOutDecision<Spec>> {
	const existingRaw = await rt.readOut()
	if (existingRaw === null) return { resumedSpec: null, discardExistingOut: false }
	const parsed = parseExistingOut(rt, existingRaw)
	return parsed.ok ? resolveParsedExistingOut(rt, parsed.spec) : resolveInvalidExistingOut(rt, parsed.error)
}

function parseExistingOut<Spec>(rt: GrillRuntime<Spec>, raw: string): ExistingOutParse<Spec> {
	try {
		return { ok: true, spec: rt.parseOut(raw) }
	} catch (e) {
		return { ok: false, error: e as Error }
	}
}

async function resolveParsedExistingOut<Spec>(rt: GrillRuntime<Spec>, spec: Spec): Promise<ExistingOutDecision<Spec>> {
	rt.printResumePreview(spec)
	const cont = await rt.confirm(rt.resumePrompt)
	return cont ? { resumedSpec: spec, discardExistingOut: false } : { resumedSpec: null, discardExistingOut: true }
}

async function resolveInvalidExistingOut<Spec>(rt: GrillRuntime<Spec>, parseError: Error): Promise<ExistingOutDecision<Spec>> {
	rt.stdout(`\nExisting .trowel/${rt.outFileName} is invalid:\n${parseError.message}\n\n`)
	const wipe = await rt.confirm(rt.invalidPrompt)
	if (!wipe) throw parseError
	return { resumedSpec: null, discardExistingOut: true }
}

async function prepareFreshGrill<Spec>(rt: GrillRuntime<Spec>, outPath: string, discardExistingOut: boolean): Promise<void> {
	const failures = await rt.preflight()
	if (failures.length > 0) throw new Error(`preflight failed:\n${failures.map((f) => `  · ${f}`).join('\n')}`)
	if (discardExistingOut) await unlinkSwallowEnoent(outPath)
}

async function collectGrillSpec<Spec>(rt: GrillRuntime<Spec>, resumedSpec: Spec | null, targetBranch: string): Promise<CollectedGrillSpec<Spec>> {
	let stashed = false
	try {
		const spec = resumedSpec ?? await runInteractiveAndParseOut(rt)
		stashed = await stashIfDirty(rt)
		return { spec, stashed }
	} catch (e) {
		await recoverCollectedSpec(rt, targetBranch, stashed)
		throw e
	}
}

async function runInteractiveAndParseOut<Spec>(rt: GrillRuntime<Spec>): Promise<Spec> {
	await rt.runInteractive()
	const raw = await rt.readOut()
	if (raw === null) {
		rt.stdout(rt.missingOutMessage)
		throw new Error(rt.missingOutError)
	}
	return rt.parseOut(raw)
}

async function stashIfDirty<Spec>(rt: GrillRuntime<Spec>): Promise<boolean> {
	if (await rt.git.isWorkingTreeClean()) return false
	await rt.git.stashPush({ includeUntracked: true })
	return true
}

async function recoverCollectedSpec<Spec>(rt: GrillRuntime<Spec>, targetBranch: string, stashed: boolean): Promise<void> {
	if ((await rt.git.currentBranch()) !== targetBranch) await rt.git.checkout(targetBranch)
	if (stashed) await rt.git.stashPop()
}

function grillSpecResult<Spec>(rt: GrillRuntime<Spec>, outPath: string, targetBranch: string, collected: CollectedGrillSpec<Spec>): GrillSpecResult<Spec> {
	let materialised = false
	return {
		spec: collected.spec,
		targetBranch,
		backTo: targetBranch,
		stashed: collected.stashed,
		markMaterialised: () => { materialised = true },
		clearOut: () => unlinkSwallowEnoent(outPath),
		recover: () => recoverGrillSpecResult(rt, targetBranch, collected.stashed, materialised),
	}
}

async function recoverGrillSpecResult<Spec>(rt: GrillRuntime<Spec>, targetBranch: string, stashed: boolean, materialised: boolean): Promise<void> {
	if (materialised) return
	await recoverCollectedSpec(rt, targetBranch, stashed)
}

async function unlinkSwallowEnoent(p: string): Promise<void> {
	try {
		await unlink(p)
	} catch (e) {
		if ((e as { code?: string }).code !== 'ENOENT') throw e
	}
}

export function readOptionalFile(filePath: string): Promise<string | null> {
	return readFile(filePath, 'utf8').catch((e) => {
		if ((e as { code?: string }).code === 'ENOENT') return null
		throw e
	})
}
