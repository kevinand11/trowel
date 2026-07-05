import { Command } from 'commander'

import { abortChange } from './commands/abort/index.ts'
import { changeStart } from './commands/change-start.ts'
import { showConfig } from './commands/config.ts'
import { doctor } from './commands/doctor.ts'
import { init } from './commands/init.ts'
import { laneClose, laneContinue, laneList, laneStart } from './commands/lane/index.ts'
import { list } from './commands/list/index.ts'
import { shipChange } from './commands/ship/index.ts'
import { statusChange } from './commands/status/index.ts'
import { changeWork } from './commands/work/index.ts'

async function initialRequest(requestWords: string[]): Promise<string | undefined> {
	return chooseInitialRequest(requestWords.join(' ').trim(), await pipedStdin())
}

function chooseInitialRequest(positional: string, stdin: string): string | undefined {
	return positional ? initialRequestFromPositional(positional, stdin) : stdin || undefined
}

function initialRequestFromPositional(positional: string, stdin: string): string {
	if (stdin) throw new Error('provide the change start request either as arguments or via stdin, not both')
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

	const changeCmd = program.command('change').description('Manage Changes')

	changeCmd
		.command('start')
		.description('Understand a user request by grilling, plan repository work, and create a Change when needed')
		.argument('[request...]', 'Initial request words')
		.option('--storage <kind>', 'Override project storage')
		.option('--harness <kind>', 'Override project agent harness (claude | codex | pi)')
		.action(async (requestWords: string[], opts: { storage?: string; harness?: string }) => {
			await changeStart({ ...opts, request: await initialRequest(requestWords) })
		})

	changeCmd
		.command('list')
		.description('List all Changes in this project, newest first')
		.option('--storage <kind>', 'Override project storage')
		.action(async (opts: { storage?: string }) => {
			await list({ storage: opts.storage })
		})

	changeCmd
		.command('status')
		.description("Show a Change's current state and Slice states")
		.argument('<change-id>')
		.option('--storage <kind>', 'Override project storage')
		.action(async (changeId: string, opts) => {
			await statusChange(changeId, opts)
		})

	changeCmd
		.command('work')
		.description('Run AFK work across Changes, or on one Change when a Change id is provided')
		.argument('[change-id]')
		.option('--storage <kind>', 'Override project storage')
		.option('--harness <kind>', 'Override project agent harness (claude | codex | pi)')
		.option('--loop', 'Keep polling for newly actionable work')
		.action(async (changeId: string | undefined, opts) => {
			await changeWork(changeId, opts)
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

	const laneCmd = program.command('lane').description('Manage interactive local implementation Lanes')

	laneCmd
		.command('start')
		.description('Start a foreground human-in-the-loop implementation Lane in a managed worktree')
		.argument('<title...>', 'Lane title/request words')
		.option('--harness <kind>', 'Override project agent harness (claude | codex | pi)')
		.action(async (titleWords: string[], opts: { harness?: string }) => {
			await laneStart(titleWords.join(' '), opts)
		})

	laneCmd
		.command('continue')
		.description('Open an interactive agent session in an existing Lane worktree')
		.argument('<lane-id>')
		.option('--harness <kind>', 'Override project agent harness (claude | codex | pi)')
		.action(async (laneId: string, opts: { harness?: string }) => {
			await laneContinue(laneId, opts)
		})

	laneCmd
		.command('close')
		.description('Confirm, merge a Lane into its captured Target branch, and clean up')
		.argument('<lane-id>')
		.action(async (laneId: string) => {
			await laneClose(laneId)
		})

	laneCmd
		.command('list')
		.description('List all Lanes newest first')
		.action(async () => {
			await laneList()
		})

	program
		.command('init')
		.description("Initialise a config file. Layer arg defaults to 'project'.")
		.argument('[layer]', "Which layer to write: global | project", 'project')
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
