import { Command } from 'commander'

import { address } from './commands/address.ts'
import { close } from './commands/close.ts'
import { showConfig } from './commands/config.ts'
import { doctor } from './commands/doctor.ts'
import { implement } from './commands/implement.ts'
import { init } from './commands/init.ts'
import { list, type PrdState } from './commands/list.ts'
import { review } from './commands/review.ts'
import { start } from './commands/start.ts'
import { status } from './commands/status.ts'
import * as stubs from './commands/stubs.ts'
import { work } from './commands/work.ts'

export function run(): void {
	const program = new Command()

	program.name('trowel').description('Personal CLI for PRD-driven feature work').version('0.0.0')

	program
		.command('start')
		.description('Start a new PRD: grill, create artifacts, branch, slice')
		.option('--storage <kind>', 'Override project storage')
		.action(async (opts: { storage?: string }) => {
			await start(opts)
		})

	program
		.command('work')
		.description('Run the AFK loop on a PRD\'s open slices')
		.argument('<prd-id>')
		.option('--storage <kind>', 'Override project storage')
		.action(async (prdId: string, opts) => {
			await work(prdId, opts)
		})

	program
		.command('close')
		.description('Close a PRD and tidy branches/orphans')
		.argument('<prd-id>')
		.option('--storage <kind>', 'Override project storage')
		.action(async (prdId: string, opts) => {
			await close(prdId, opts)
		})

	program
		.command('status')
		.description('Show a PRD\'s current state (done / in-flight / ready slices)')
		.argument('<prd-id>')
		.option('--storage <kind>', 'Override project storage')
		.action(async (prdId: string, opts) => {
			await status(prdId, opts)
		})

	program
		.command('init')
		.description("Initialise a config file. Layer arg defaults to 'project'.")
		.argument('[layer]', "Which layer to write: global | private | project", 'project')
		.action(async (layer: string) => {
			await init(layer)
		})

	const listCmd = program.command('list').description('List entities in this project')

	listCmd
		.command('prds')
		.description('List PRDs in this project')
		.option('--state <kind>', 'Filter by state: open | closed | all', 'open')
		.option('--storage <kind>', 'Override project storage')
		.action(async (opts: { state: string; storage?: string }) => {
			const validStates: PrdState[] = ['open', 'closed', 'all']
			if (!validStates.includes(opts.state as PrdState)) {
				process.stderr.write(`trowel list prds: invalid --state '${opts.state}' (expected open | closed | all)\n`)
				process.exit(1)
			}
			await list(opts.state as PrdState, { storage: opts.storage })
		})

	program
		.command('doctor')
		.description('Verify trowel\'s environment (node, gh, git, project root)')
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
		.description('Bug-fix flow without a PRD: branch + implement + PR to main, with issue linked')
		.argument('<description>')
		.action(async (description: string) => {
			await stubs.fix(description)
		})

	program
		.command('implement')
		.description('Run implementer on one slice of a PRD')
		.argument('<prd-id>')
		.argument('<slice-id>')
		.action(async (prdId: string, sliceId: string) => {
			await implement(prdId, sliceId)
		})

	program
		.command('address')
		.description('Run addresser on a slice\'s PR (PR resolved internally)')
		.argument('<prd-id>')
		.argument('<slice-id>')
		.action(async (prdId: string, sliceId: string) => {
			await address(prdId, sliceId)
		})

	program
		.command('review')
		.description('Run reviewer on a slice\'s PR')
		.argument('<prd-id>')
		.argument('<slice-id>')
		.action(async (prdId: string, sliceId: string) => {
			await review(prdId, sliceId)
		})

	program.parseAsync(process.argv).catch((error: Error) => {
		process.stderr.write(`trowel: ${error.message}\n`)
		process.exit(1)
	})
}
