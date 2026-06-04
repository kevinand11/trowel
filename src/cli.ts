import { Command } from 'commander'

import { address } from './commands/address.ts'
import { closeFix, closeChange, closeSlice } from './commands/close/index.ts'
import { showConfig } from './commands/config.ts'
import { doctor } from './commands/doctor.ts'
import { fix } from './commands/fix.ts'
import { implement } from './commands/implement.ts'
import { init } from './commands/init.ts'
import { list, listFix, type ListState } from './commands/list/index.ts'
import { review } from './commands/review.ts'
import { start } from './commands/start.ts'
import { statusFix, statusChange, statusSlice } from './commands/status/index.ts'
import * as stubs from './commands/stubs.ts'
import { work, type WorkScope } from './commands/work/index.ts'

function parseListState(commandName: string, raw: string): ListState {
	const validStates: ListState[] = ['open', 'closed', 'all']
	if (validStates.includes(raw as ListState)) return raw as ListState
	process.stderr.write(`trowel ${commandName}: invalid --state '${raw}' (expected open | closed | all)\n`)
	process.exit(1)
}

export function run(): void {
	const program = new Command()

	program.name('trowel').description('Personal CLI for Change-driven feature work').version('0.0.0')

	program
		.command('start')
		.description('Start a new Change: grill, create artifacts, branch, slice')
		.option('--storage <kind>', 'Override project storage')
		.option('--harness <kind>', 'Override project agent harness (claude | codex | pi)')
		.action(async (opts: { storage?: string; harness?: string }) => {
			await start(opts)
		})

	const workCmd = program.command('work').description("Run the AFK loop on a Change or a Fix")

	workCmd
		.command('change')
		.description("Run the AFK loop on a Change's open slices")
		.argument('<change-id>')
		.option('--storage <kind>', 'Override project storage')
		.option('--harness <kind>', 'Override project agent harness (claude | codex | pi)')
		.action(async (changeId: string, opts) => {
			await work('change' as WorkScope, changeId, opts)
		})

	workCmd
		.command('fix')
		.description("Run the AFK loop on a Fix")
		.argument('<fix-id>')
		.option('--storage <kind>', 'Override project storage')
		.option('--harness <kind>', 'Override project agent harness (claude | codex | pi)')
		.action(async (fixId: string, opts) => {
			await work('fix' as WorkScope, fixId, opts)
		})

	const listCmd = program.command('list').description('List entities in this project')

	listCmd
		.command('change')
		.description('List Changes in this project')
		.option('--state <kind>', 'Filter by state: open | closed | all', 'open')
		.option('--storage <kind>', 'Override project storage')
		.action(async (opts: { state: string; storage?: string }) => {
			await list(parseListState('list change', opts.state), { storage: opts.storage })
		})

	listCmd
		.command('fix')
		.description('List fixes in this project')
		.option('--state <kind>', 'Filter by state: open | closed | all', 'open')
		.option('--storage <kind>', 'Override project storage')
		.action(async (opts: { state: string; storage?: string }) => {
			await listFix(parseListState('list fix', opts.state), { storage: opts.storage })
		})

	const statusCmd = program.command('status').description('Show the current state of a Change, Slice, or Fix')

	statusCmd
		.command('change')
		.description("Show a Change's current state (done / in-flight / ready slices)")
		.argument('<change-id>')
		.option('--storage <kind>', 'Override project storage')
		.action(async (changeId: string, opts) => {
			await statusChange(changeId, opts)
		})

	statusCmd
		.command('slice')
		.description("Show a single slice's state (parent Change, bucket, blockers)")
		.argument('<slice-id>')
		.option('--storage <kind>', 'Override project storage')
		.action(async (sliceId: string, opts) => {
			await statusSlice(sliceId, opts)
		})

	statusCmd
		.command('fix')
		.description("Show a Fix's current state")
		.argument('<fix-id>')
		.option('--storage <kind>', 'Override project storage')
		.action(async (fixId: string, opts) => {
			await statusFix(fixId, opts)
		})

	const closeCmd = program.command('close').description('Close a Change, Slice, or Fix (manual abort)')

	closeCmd
		.command('change')
		.description('Close a Change and tidy branches/orphans')
		.argument('<change-id>')
		.option('--storage <kind>', 'Override project storage')
		.action(async (changeId: string, opts) => {
			await closeChange(changeId, opts)
		})

	closeCmd
		.command('slice')
		.description('Close a single Slice; tidy its branch under the project policy')
		.argument('<slice-id>')
		.option('--storage <kind>', 'Override project storage')
		.action(async (sliceId: string, opts) => {
			await closeSlice(sliceId, opts)
		})

	closeCmd
		.command('fix')
		.description('Close a Fix (manual abort); tidy its branch under the project policy')
		.argument('<fix-id>')
		.option('--storage <kind>', 'Override project storage')
		.action(async (fixId: string, opts) => {
			await closeFix(fixId, opts)
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

	program
		.command('diagnose')
		.description('Diagnose a bug; recommends next workflow (work / fix / start)')
		.argument('<description>')
		.action(async (description: string) => {
			await stubs.diagnose(description)
		})

	program
		.command('fix')
		.description('Bug-fix flow: interactive grill + Fix entity. Run `trowel work fix <id>` to execute.')
		.option('--storage <kind>', 'Override project storage')
		.option('--harness <kind>', 'Override project agent harness (claude | codex | pi)')
		.action(async (opts: { storage?: string; harness?: string }) => {
			await fix(opts)
		})

	program
		.command('implement')
		.description('Run implementer on one slice')
		.argument('<slice-id>')
		.option('--storage <kind>', 'Override project storage')
		.option('--harness <kind>', 'Override project agent harness (claude | codex | pi)')
		.action(async (sliceId: string, opts) => {
			await implement(sliceId, opts)
		})

	program
		.command('address')
		.description("Run addresser on a slice's PR (PR resolved internally)")
		.argument('<slice-id>')
		.option('--storage <kind>', 'Override project storage')
		.option('--harness <kind>', 'Override project agent harness (claude | codex | pi)')
		.action(async (sliceId: string, opts) => {
			await address(sliceId, opts)
		})

	program
		.command('review')
		.description("Run reviewer on a slice's PR")
		.argument('<slice-id>')
		.option('--storage <kind>', 'Override project storage')
		.option('--harness <kind>', 'Override project agent harness (claude | codex | pi)')
		.action(async (sliceId: string, opts) => {
			await review(sliceId, opts)
		})

	program.parseAsync(process.argv).catch((error: Error) => {
		process.stderr.write(`trowel: ${error.message}\n`)
		process.exit(1)
	})
}
