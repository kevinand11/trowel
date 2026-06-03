import { v } from 'valleyed'

export function parseJson(raw: string, label: string): unknown {
	try {
		return JSON.parse(raw)
	} catch (e) {
		throw new Error(`Invalid ${label}: ${(e as Error).message}`)
	}
}

export function validateJson<T>(pipe: unknown, parsed: unknown, label: string): T {
	const result = v.validate(pipe as never, parsed)
	if (!result.valid) {
		const messages = result.error.messages.map((m) => `  · ${m.message ?? JSON.stringify(m)}`).join('\n')
		throw new Error(`${label}:\n${messages}`)
	}
	return result.value as T
}
