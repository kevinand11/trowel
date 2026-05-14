const ID_LEN = 10
const BASE = 36

export function generateId(): string {
	let out = ''
	while (out.length < ID_LEN) {
		out += Math.floor(Math.random() * BASE).toString(BASE)
	}
	return out.slice(0, ID_LEN)
}
