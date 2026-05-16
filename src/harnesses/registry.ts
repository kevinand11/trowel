import { claudeHarness } from './claude.ts'
import { codexHarness } from './codex.ts'
import { piHarness } from './pi.ts'
import type { HarnessAdapter } from './types.ts'

export const harnessFactories = {
	claude: claudeHarness,
	codex: codexHarness,
	pi: piHarness,
} satisfies Record<string, HarnessAdapter>

export type HarnessKind = keyof typeof harnessFactories

export function getHarness(kind: string): HarnessAdapter {
	const adapter = harnessFactories[kind as HarnessKind]
	if (!adapter) throw new Error(`No agent harness registered for kind '${kind}'`)
	return adapter
}

if (import.meta.vitest) {
	const { describe, test, expect } = import.meta.vitest

	describe('getHarness', () => {
		test('returns the registered adapter', () => {
			expect(getHarness('claude').kind).toBe('claude')
			expect(getHarness('codex').kind).toBe('codex')
			expect(getHarness('pi').kind).toBe('pi')
		})

		test('throws when no harness is registered for the kind', () => {
			expect(() => getHarness('cursor')).toThrow(/No agent harness registered/)
		})
	})
}
