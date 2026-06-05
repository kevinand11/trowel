import type { GhOps } from '../utils/gh-ops.ts'

const nullValue = async (): Promise<null> => null
const emptyList = async (): Promise<never[]> => []
const noop = async (): Promise<void> => undefined
const zero = async (): Promise<number> => 0
const defaultPr = async (): Promise<Awaited<ReturnType<GhOps['createDraftPr']>>> => ({ number: 0, headRefName: '', isDraft: true, url: '#0' })

export const DEFAULT_GH_OPS: GhOps = {
	detectVersion: async () => ({ installed: true, version: '0.0.0' }),
	isAuthenticated: async () => true,
	createIssue: async () => ({ number: 0, internalId: 0, title: '', url: '#0' }),
	viewIssue: async () => ({ internalId: 0, number: 0, title: '', state: 'open', body: '', createdAt: '', closedAt: null }),
	listIssues: emptyList,
	closeIssue: noop,
	reopenIssue: noop,
	editIssueBody: noop,
	editIssueLabels: noop,
	listSubIssues: emptyList,
	addSubIssue: noop,
	listBlockedBy: emptyList,
	addBlockedBy: noop,
	removeBlockedBy: noop,
	createDraftPr: defaultPr,
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
