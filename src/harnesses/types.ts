import type { ChildProcess } from 'node:child_process'
import type { Writable } from 'node:stream'

export type HarnessSpawnPrintArgs = {
	model: string
	prompt: string
	cwd: string
	logStream: Writable
}

export type HarnessSpawnInteractiveArgs = {
	model: string
	systemPrompt: string
	cwd: string
}

export type HarnessSpawnHandle = {
	child: ChildProcess
	waitForExit: Promise<number>
}

export type HarnessVersionInfo = {
	installed: boolean
	version?: string
}

export interface HarnessAdapter {
	readonly kind: string
	readonly defaultModel: string
	spawnPrint(args: HarnessSpawnPrintArgs): Promise<HarnessSpawnHandle>
	spawnInteractive(args: HarnessSpawnInteractiveArgs): Promise<HarnessSpawnHandle>
	detectVersion(): Promise<HarnessVersionInfo>
}
