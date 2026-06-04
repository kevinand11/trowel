import { Command } from 'commander'

import { abortChange, abortSlice } from './commands/abort/index.ts'
import { address } from './commands/address.ts'
import { showConfig } from './commands/config.ts'
import { doctor } from './commands/doctor.ts'
import { implement } from './commands/implement.ts'
import { init } from './commands/init.ts'
import { list } from './commands/list/index.ts'
import { review } from './commands/review.ts'
import { shipChange } from './commands/ship/index.ts'
import { start } from './commands/start.ts'
import { statusChange, statusSlice } from './commands/status/index.ts'
import { work } from './commands/work/index.ts'

async function initialRequest(requestWords: string[]): Promise<string | undefined> {
	return chooseInitialRequest(requestWords.join(' ').trim(), await pipedStdin())
}

function chooseInitialRequest(positional: string, stdin: string): string | undefined {
	return positional ? initialRequestFromPositional(positional, stdin) : stdin || undefined
}

function initialRequestFromPositional(positional: string, stdin: string): string {
	if (stdin) throw new Error('provide the start request either as arguments or via stdin, not both')
	return positional
}

async function pipedStdin(): Promise<string> {
	if (process.stdin.isTTY) return ''
	const chunks: Buffer[] = []
	for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
	return Buffer.concat(chunks).toString('utf8').trim()
}

export function run(): void {
	const program = new Command()

	program.name('trowel').description('Personal CLI for Change-driven feature work').version('0.0.0')

	program
		.command('start')
		.description('Understand a user request by grilling, plan repository work, and create a Change when needed')
		.argument('[request...]', 'Initial request words')
		.option('--storage <kind>', 'Override project storage')
		.option('--harness <kind>', 'Override project agent harness (claude | codex | pi)')
		.action(async (requestWords: string[], opts: { storage?: string; harness?: string }) => {
			await start({ ...opts, request: await initialRequest(requestWords) })
		})

	const changeCmd = program.command('change').description('Manage Changes')

	changeCmd
		.command('list')
		.description('List all Changes in this project, newest first')
		.option('--storage <kind>', 'Override project storage')
		.action(async (opts: { storage?: string }) => {
			await list({ storage: opts.storage })
		})

	changeCmd
		.command('status')
		.description("Show a Change's current state (done / in-flight / ready slices)")
		.argument('<change-id>')
		.option('--storage <kind>', 'Override project storage')
		.action(async (changeId: string, opts) => {
			await statusChange(changeId, opts)
		})

	changeCmd
		.command('work')
		.description("Run the AFK loop on a Change's open slices")
		.argument('<change-id>')
		.option('--storage <kind>', 'Override project storage')
		.option('--harness <kind>', 'Override project agent harness (claude | codex | pi)')
		.action(async (changeId: string, opts) => {
			await work(changeId, opts)
		})

	changeCmd
		.command('ship')
		.description('Ship a finished Change')
		.argument('<change-id>')
		.option('--storage <kind>', 'Override project storage')
		.action(async (changeId: string, opts) => {
			await shipChange(changeId, opts)
		})

	changeCmd
		.command('abort')
		.description('Abort a Change and tidy branches/orphans')
		.argument('<change-id>')
		.option('--storage <kind>', 'Override project storage')
		.action(async (changeId: string, opts) => {
			await abortChange(changeId, opts)
		})

	const sliceCmd = program.command('slice').description('Manage Slices')

	sliceCmd
		.command('status')
		.description("Show a single slice's state (parent Change, state, blockers)")
		.argument('<slice-id>')
		.option('--storage <kind>', 'Override project storage')
		.action(async (sliceId: string, opts) => {
			await statusSlice(sliceId, opts)
		})

	sliceCmd
		.command('abort')
		.description('Abort a single Slice; tidy its branch under the project policy')
		.argument('<slice-id>')
		.option('--storage <kind>', 'Override project storage')
		.action(async (sliceId: string, opts) => {
			await abortSlice(sliceId, opts)
		})

	sliceCmd
		.command('implement')
		.description('Run implementer on one slice')
		.argument('<slice-id>')
		.option('--storage <kind>', 'Override project storage')
		.option('--harness <kind>', 'Override project agent harness (claude | codex | pi)')
		.action(async (sliceId: string, opts) => {
			await implement(sliceId, opts)
		})

	sliceCmd
		.command('address')
		.description("Run addresser on a slice's PR (PR resolved internally)")
		.argument('<slice-id>')
		.option('--storage <kind>', 'Override project storage')
		.option('--harness <kind>', 'Override project agent harness (claude | codex | pi)')
		.action(async (sliceId: string, opts) => {
			await address(sliceId, opts)
		})

	sliceCmd
		.command('review')
		.description("Run reviewer on a slice's PR")
		.argument('<slice-id>')
		.option('--storage <kind>', 'Override project storage')
		.option('--harness <kind>', 'Override project agent harness (claude | codex | pi)')
		.action(async (sliceId: string, opts) => {
			await review(sliceId, opts)
		})

	program
		.command('init')
		.description("Initialise a config file. Layer arg defaults to 'project'.")
		.argument('[layer]', "Which layer to write: global | private | project", 'project')
		.action(async (layer: string) => {
			await init(layer)
		})

	program
		.command('doctor')
		.description("Verify trowel's environment (node, gh, git, project root)")
		.action(async () => {
			await doctor()
		})

	program
		.command('config')
		.description('Print the resolved effective config and loaded layers')
		.action(async () => {
			await showConfig()
		})

	program.parseAsync(process.argv).catch((error: Error) => {
		process.stderr.write(`trowel: ${error.message}\n`)
		process.exit(1)
	})
}
