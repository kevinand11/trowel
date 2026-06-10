import { fetchFreshnessMarkedPrFeedback } from './pr-flow.ts'
import type { TurnIn, TurnOut } from './verdict.ts'
import type { Change } from '../storages/types.ts'
import type { GhOps } from '../utils/gh-ops.ts'
import type { GitOps } from '../utils/git-ops.ts'
import { withMutationLock } from '../utils/mutation-lock.ts'

export type ChangeReviewDeps = {
	git: GitOps
	gh: GhOps
	spawnTurn: (args: { role: 'review'; change: Pick<Change, 'id' | 'title' | 'body'>; branch: string; turnIn: TurnIn }) => Promise<TurnOut>
	log: (msg: string) => void
	needsRevisionLabel?: string
	projectRoot?: string
}

export type ChangeReviewOutcome = 'progress' | 'partial' | 'no-work' | 'skipped'

export async function runCloseOutReview(change: Change, deps: ChangeReviewDeps): Promise<ChangeReviewOutcome> {
	const tag = `[work change-${change.id}]`
	const prNumber = await deps.gh.findPrNumberByHead(change.changeBranch)
	const reviewFeedback = await fetchFreshnessMarkedPrFeedback(deps.gh, deps.git, prNumber, change.changeBranch)
	if (!reviewFeedback.hasFreshFeedback) {
		deps.log(`${tag} state=needs-revision; no Fresh PR feedback after latest commit; awaiting new review comment`)
		return 'skipped'
	}
	const turnIn: TurnIn = {
		change: { id: change.id, title: change.title, body: change.body },
		pr: { number: prNumber, branch: change.changeBranch },
		feedback: reviewFeedback.feedback,
	}
	deps.log(`${tag} state=needs-revision action=Reviewer: "${change.title}"`)
	deps.log(`${tag} spawning Reviewer Turn on ${change.changeBranch}`)
	const verdict = await deps.spawnTurn({ role: 'review', change, branch: change.changeBranch, turnIn })
	deps.log(`${tag} Reviewer verdict: ${verdict.verdict}, ${verdict.commits} commit(s)`)
	return landCloseOutReview(change, prNumber, verdict, deps)
}

async function landCloseOutReview(change: Change, prNumber: number, verdict: TurnOut, deps: ChangeReviewDeps): Promise<ChangeReviewOutcome> {
	if (verdict.verdict === 'partial') return 'partial'
	if (verdict.verdict === 'ready') return withChangeReviewLock(deps, () => landReady(change, prNumber, verdict, deps))
	if (verdict.verdict === 'no-work-needed') return withChangeReviewLock(deps, () => landNoWorkNeeded(change, prNumber, deps))
	return 'partial'
}

function withChangeReviewLock<T>(deps: ChangeReviewDeps, fn: () => Promise<T>): Promise<T> {
	if (!deps.projectRoot) return fn()
	return withMutationLock(deps.projectRoot, fn)
}

async function landReady(change: Change, prNumber: number, verdict: TurnOut, deps: ChangeReviewDeps): Promise<ChangeReviewOutcome> {
	const tag = `[work change-${change.id}]`
	if (verdict.commits > 0) {
		await deps.git.push(change.changeBranch)
		deps.log(`${tag} pushed ${change.changeBranch}`)
	}
	await clearNeedsRevision(prNumber, tag, deps)
	return 'progress'
}

async function landNoWorkNeeded(change: Change, prNumber: number, deps: ChangeReviewDeps): Promise<ChangeReviewOutcome> {
	await clearNeedsRevision(prNumber, `[work change-${change.id}]`, deps, 'no-work-needed: ')
	return 'no-work'
}

async function clearNeedsRevision(prNumber: number, tag: string, deps: ChangeReviewDeps, prefix = ''): Promise<void> {
	await deps.gh.editIssueLabels(prNumber, { remove: [deps.needsRevisionLabel ?? 'needs-revision'] })
	deps.log(`${tag} ${prefix}cleared PR needs-revision`)
}
