import type { GhOps } from '../utils/gh-ops.ts'

const installedVersion = async (): Promise<Awaited<ReturnType<GhOps['detectVersion']>>> => ({ installed: true, version: '0.0.0' })
const authenticated = async (): Promise<boolean> => true
const defaultIssueUrl = async (): Promise<string> => 'https://github.com/o/r/issues/0\n'
const nullValue = async (): Promise<null> => null
const emptyList = async (): Promise<never[]> => []
const noop = async (): Promise<void> => undefined
const zero = async (): Promise<number> => 0
const internalId = async (): Promise<string> => '0'

export const DEFAULT_GH_OPS: GhOps = {
	detectVersion: installedVersion,
	isAuthenticated: authenticated,
	createIssue: defaultIssueUrl,
	viewIssue: nullValue,
	getIssueState: nullValue,
	listIssues: emptyList,
	closeIssue: noop,
	reopenIssue: noop,
	editIssueBody: noop,
	editIssueLabels: noop,
	listSubIssues: emptyList,
	getIssueInternalId: internalId,
	addSubIssue: noop,
	listBlockedBy: emptyList,
	addBlockedBy: noop,
	removeBlockedBy: noop,
	createDraftPr: noop,
	markPrReady: noop,
	findPrNumberByHead: zero,
	listOpenPrs: emptyList,
	findAnyPrByHead: nullValue,
	closePr: noop,
	mergePr: noop,
	fetchPrLineComments: emptyList,
	fetchPrReviews: emptyList,
	fetchPrThread: emptyList,
}
