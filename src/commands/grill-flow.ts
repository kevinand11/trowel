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

export async function resolveGrillSpec<Spec>(rt: GrillRuntime<Spec>): Promise<GrillSpecResult<Spec>> {
	const outPath = path.join(rt.projectRoot, '.trowel', rt.outFileName)
	let resumedSpec: Spec | null = null
	let discardExistingOut = false
	const existingRaw = await rt.readOut()
	if (existingRaw !== null) {
		let parsed: Spec | null = null
		let parseError: Error | null = null
		try {
			parsed = rt.parseOut(existingRaw)
		} catch (e) {
			parseError = e as Error
		}
		if (parsed) {
			rt.printResumePreview(parsed)
			const cont = await rt.confirm(rt.resumePrompt)
			if (cont) resumedSpec = parsed
			else discardExistingOut = true
		} else {
			rt.stdout(`\nExisting .trowel/${rt.outFileName} is invalid:\n${parseError!.message}\n\n`)
			const wipe = await rt.confirm(rt.invalidPrompt)
			if (!wipe) throw parseError!
			discardExistingOut = true
		}
	}

	if (resumedSpec === null) {
		const failures = await rt.preflight()
		if (failures.length > 0) throw new Error(`preflight failed:\n${failures.map((f) => `  · ${f}`).join('\n')}`)
		if (discardExistingOut) await unlinkSwallowEnoent(outPath)
	}

	const targetBranch = await rt.git.currentBranch()
	let stashed = false
	let materialised = false
	let spec: Spec
	try {
		if (resumedSpec) {
			spec = resumedSpec
		} else {
			await rt.runInteractive()
			const raw = await rt.readOut()
			if (raw === null) {
				rt.stdout(rt.missingOutMessage)
				throw new Error(rt.missingOutError)
			}
			spec = rt.parseOut(raw)
		}

		if (!(await rt.git.isWorkingTreeClean())) {
			await rt.git.stashPush({ includeUntracked: true })
			stashed = true
		}
	} catch (e) {
		if ((await rt.git.currentBranch()) !== targetBranch) await rt.git.checkout(targetBranch)
		if (stashed) await rt.git.stashPop()
		throw e
	}

	return {
		spec,
		targetBranch,
		backTo: targetBranch,
		stashed,
		markMaterialised: () => { materialised = true },
		clearOut: () => unlinkSwallowEnoent(outPath),
		recover: async () => {
			if (!materialised) {
				if ((await rt.git.currentBranch()) !== targetBranch) await rt.git.checkout(targetBranch)
				if (stashed) await rt.git.stashPop()
			}
		},
	}
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
