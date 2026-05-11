import { tryExec } from './shell.ts'

export type GhResult = { ok: true; stdout: string; stderr: string } | { ok: false; error: Error }

export type GhRunner = (args: string[]) => Promise<GhResult>

export const realGhRunner: GhRunner = (args) => tryExec('gh', args)
