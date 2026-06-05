import { v, type Pipe } from 'valleyed'

export function validateJson<T> (pipe: Pipe<any, T>, json: string, label: string): T {
	const result = v.validate(v.fromJson(pipe), json)
	if (!result.valid) {
		const messages = result.error.messages.map((m) => `  · ${m.message ?? JSON.stringify(m)}`).join('\n')
		throw new Error(`${label}:\n${messages}`)
	}
	return result.value
}
