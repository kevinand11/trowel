import { spawn, type ChildProcess } from 'node:child_process'
import type { Writable } from 'node:stream'

import type { HarnessSpawnHandle } from './types.ts'
import { tryExec } from '../utils/shell.ts'

export function waitForChildExit(child: ChildProcess): Promise<number> {
	return new Promise<number>((resolve, reject) => {
		child.on('error', reject)
		child.on('exit', (code) => resolve(code ?? -1))
	})
}

export function spawnHarness(command: string, args: string[], opts: { cwd: string; stdio: 'inherit' | ['pipe', 'pipe', 'pipe'] }): ChildProcess {
	return spawn(command, args, { cwd: opts.cwd, env: process.env, stdio: opts.stdio })
}

function pipeHarnessOutput(child: ChildProcess, logStream: Writable): void {
	child.stdout?.pipe(logStream, { end: false })
	child.stderr?.pipe(logStream, { end: false })
}

function printSpawnHandle(child: ChildProcess, prompt?: string): HarnessSpawnHandle {
	if (prompt !== undefined) child.stdin?.write(prompt)
	child.stdin?.end()
	return { child, waitForExit: waitForChildExit(child) }
}

export function spawnPrintCommand(command: string, commandArgs: string[], opts: { cwd: string; prompt?: string; logStream: Writable }): HarnessSpawnHandle {
	const child = spawnHarness(command, commandArgs, { cwd: opts.cwd, stdio: ['pipe', 'pipe', 'pipe'] })
	pipeHarnessOutput(child, opts.logStream)
	return printSpawnHandle(child, opts.prompt)
}

export async function detectCliVersion(command: string, flags: string[]): Promise<{ installed: boolean; version?: string }> {
	for (const flag of flags) {
		const r = await tryExec(command, [flag])
		if (!r.ok) continue
		const m = `${r.stdout}\n${r.stderr}`.match(/(\d+\.\d+\.\d+)/)
		return { installed: true, version: m?.[1] }
	}
	return { installed: false }
}
