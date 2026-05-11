import { Command } from 'commander'

import { showConfig } from './commands/config.ts'
import { doctor } from './commands/doctor.ts'
import * as stubs from './commands/stubs.ts'

export function run(): void {
	const program = new Command()

	program.name('trowel').description('Personal CLI for PRD-driven feature work').version('0.0.0')

	program
		.command('start')
		.description('Start a new PRD: grill, create artifacts, branch, slice')
		.option('--prd <id>', 'Resume an existing PRD by id')
		.option('--backend <kind>', 'Override project backend (markdown | draft-pr | issue)')
		.action(async (opts) => {
			await stubs.start(opts)
		})

	program
		.command('work')
		.description('Run the AFK loop on a PRD\'s open slices')
		.argument('<prd-id>')
		.option('--backend <kind>', 'Override project backend')
		.action(async (prdId: string, opts) => {
			await stubs.work(prdId, opts)
		})

	program
		.command('close')
		.description('Close a PRD and tidy branches/orphans')
		.argument('<prd-id>')
		.option('--backend <kind>', 'Override project backend')
		.action(async (prdId: string, opts) => {
			await stubs.close(prdId, opts)
		})

	program
		.command('status')
		.description('Show a PRD\'s current state (done / in-flight / ready slices)')
		.argument('<prd-id>')
		.option('--backend <kind>', 'Override project backend')
		.action(async (prdId: string, opts) => {
			await stubs.status(prdId, opts)
		})

	program
		.command('init')
		.description("Initialise a config file. Layer arg defaults to 'project'.")
		.argument('[layer]', "Which layer to write: global | private | project", 'project')
		.action(async (layer: string) => {
			await stubs.init(layer)
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
			await stubs.implement(prdId, sliceId)
		})

	program
		.command('address')
		.description('Run addresser on a slice\'s PR (PR resolved internally)')
		.argument('<prd-id>')
		.argument('<slice-id>')
		.action(async (prdId: string, sliceId: string) => {
			await stubs.address(prdId, sliceId)
		})

	program
		.command('review')
		.description('Run reviewer on a slice\'s PR')
		.argument('<prd-id>')
		.argument('<slice-id>')
		.action(async (prdId: string, sliceId: string) => {
			await stubs.review(prdId, sliceId)
		})

	program.parseAsync(process.argv).catch((error: Error) => {
		process.stderr.write(`trowel: ${error.message}\n`)
		process.exit(1)
	})
}
