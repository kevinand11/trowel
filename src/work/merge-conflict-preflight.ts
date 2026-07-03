import type { GitOps } from '../utils/git-ops.ts'

const CONFLICT_FILE_LIMIT = 20

export type MergeConflictSummary = {
	destinationBranch: string
	sourceBranch: string
	mergeLocation: string
	files: string[]
	messages: string
}

export type ConfirmMergeConflict = (summary: MergeConflictSummary) => Promise<boolean>

type RunMergeConflictPreflightArgs = {
	git: GitOps
	destinationRef: string
	sourceRef: string
	destinationBranch: string
	sourceBranch: string
	mergeLocation: string
	cwd?: string
}

type RequireMergeConflictPreflightArgs = RunMergeConflictPreflightArgs & {
	confirm?: ConfirmMergeConflict
}

export async function runMergeConflictPreflight(args: RunMergeConflictPreflightArgs): Promise<MergeConflictSummary | null> {
	const preflight = await args.git.mergeConflictPreflight(args.destinationRef, args.sourceRef, args.cwd)
	if (preflight.ok) return null
	return {
		destinationBranch: args.destinationBranch,
		sourceBranch: args.sourceBranch,
		mergeLocation: args.mergeLocation,
		files: preflight.files,
		messages: preflight.messages,
	}
}

export async function requireMergeConflictPreflight(args: RequireMergeConflictPreflightArgs): Promise<MergeConflictSummary | null> {
	const conflict = await runMergeConflictPreflight(args)
	if (!conflict) return null
	if (args.confirm && (await args.confirm(conflict))) return conflict
	throw new Error(formatMergeConflictPreflightError(conflict))
}

export function formatMergeConflictPreflightError(summary: MergeConflictSummary): string {
	return `Merge conflict preflight predicted conflicts before merging '${summary.sourceBranch}' into '${summary.destinationBranch}'.\n${formatMergeConflictDetails(summary)}`
}

export function formatMergeConflictDetails(summary: MergeConflictSummary): string {
	const lines = [
		`Destination: ${summary.destinationBranch}`,
		`Source: ${summary.sourceBranch}`,
		`Merge location: ${summary.mergeLocation}`,
	]
	return [...lines, ...formatConflictFiles(summary)].join('\n')
}

function formatConflictFiles(summary: MergeConflictSummary): string[] {
	if (summary.files.length === 0) return ['Git output:', indent(summary.messages || '(no conflict paths reported)')]
	const shown = summary.files.slice(0, CONFLICT_FILE_LIMIT)
	const hidden = summary.files.length - shown.length
	const lines = ['Conflicting files:', ...shown.map((file) => `  ${file}`)]
	return hidden > 0 ? [...lines, `  ... and ${hidden} more`] : lines
}

function indent(text: string): string {
	return text.split('\n').map((line) => `  ${line}`).join('\n')
}
