import { readFile } from 'node:fs/promises'
import path from 'node:path'

const VAR = 'CLAUDE_CODE_OAUTH_TOKEN'

export type LoadOauthTokenDeps = {
	env: Record<string, string | undefined>
	readEnvFile: (filePath: string) => Promise<string | null>
}

export const realLoadOauthTokenDeps: LoadOauthTokenDeps = {
	env: process.env,
	readEnvFile: async (filePath: string) => {
		try {
			return await readFile(filePath, 'utf8')
		} catch {
			return null
		}
	},
}

export async function loadClaudeOauthToken(projectRoot: string, deps: LoadOauthTokenDeps): Promise<string | null> {
	const fromEnv = deps.env[VAR]
	if (fromEnv && fromEnv.length > 0) return fromEnv
	const fileContents = await deps.readEnvFile(path.join(projectRoot, '.trowel', '.env'))
	if (fileContents === null) return null
	const parsed = parseEnvFile(fileContents)
	const fromFile = parsed[VAR]
	return fromFile && fromFile.length > 0 ? fromFile : null
}

function parseEnvFile(text: string): Record<string, string> {
	const result: Record<string, string> = {}
	for (const rawLine of text.split('\n')) {
		const line = rawLine.trim()
		if (!line || line.startsWith('#')) continue
		const eq = line.indexOf('=')
		if (eq <= 0) continue
		const key = line.slice(0, eq).trim()
		let value = line.slice(eq + 1).trim()
		if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
			value = value.slice(1, -1)
		}
		result[key] = value
	}
	return result
}

if (import.meta.vitest) {
	const { describe, test, expect } = import.meta.vitest

	function fakeDeps(env: Record<string, string | undefined>, files: Record<string, string | null> = {}): LoadOauthTokenDeps {
		return {
			env,
			readEnvFile: async (p: string) => (p in files ? files[p]! : null),
		}
	}

	describe('loadClaudeOauthToken', () => {
		test('prefers process env when set', async () => {
			const token = await loadClaudeOauthToken('/p', fakeDeps({ CLAUDE_CODE_OAUTH_TOKEN: 'from-env' }, { '/p/.trowel/.env': 'CLAUDE_CODE_OAUTH_TOKEN=from-file' }))
			expect(token).toBe('from-env')
		})

		test('falls back to .trowel/.env when env var is unset', async () => {
			const token = await loadClaudeOauthToken('/p', fakeDeps({}, { '/p/.trowel/.env': 'CLAUDE_CODE_OAUTH_TOKEN=from-file' }))
			expect(token).toBe('from-file')
		})

		test('strips surrounding quotes in env file values', async () => {
			const token = await loadClaudeOauthToken('/p', fakeDeps({}, { '/p/.trowel/.env': 'CLAUDE_CODE_OAUTH_TOKEN="quoted-token"' }))
			expect(token).toBe('quoted-token')
		})

		test('ignores blank lines and # comments in env file', async () => {
			const contents = '# comment\n\nCLAUDE_CODE_OAUTH_TOKEN=tok\n  # another\n'
			const token = await loadClaudeOauthToken('/p', fakeDeps({}, { '/p/.trowel/.env': contents }))
			expect(token).toBe('tok')
		})

		test('returns null when env var is empty string and file is missing', async () => {
			const token = await loadClaudeOauthToken('/p', fakeDeps({ CLAUDE_CODE_OAUTH_TOKEN: '' }, {}))
			expect(token).toBeNull()
		})

		test('returns null when env file is missing entirely', async () => {
			const token = await loadClaudeOauthToken('/p', fakeDeps({}, {}))
			expect(token).toBeNull()
		})

		test('returns null when env file exists but the var is absent', async () => {
			const token = await loadClaudeOauthToken('/p', fakeDeps({}, { '/p/.trowel/.env': 'OTHER=value' }))
			expect(token).toBeNull()
		})
	})
}
