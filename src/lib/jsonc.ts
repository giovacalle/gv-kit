export function parseJsonc<T = unknown>(text: string): T {
	return JSON.parse(stripJsoncComments(text)) as T
}

export function stripJsoncComments(text: string): string {
	let out = ''
	let i = 0
	const len = text.length
	let inString = false

	while (i < len) {
		const ch = text[i]
		const next = text[i + 1]

		if (inString) {
			if (ch === '\\' && i + 1 < len) {
				out += ch + (next ?? '')
				i += 2
				continue
			}
			if (ch === '"') inString = false
			out += ch
			i++
			continue
		}

		if (ch === '"') {
			inString = true
			out += ch
			i++
			continue
		}

		if (ch === '/' && next === '/') {
			i += 2
			while (i < len && text[i] !== '\n') i++
			continue
		}

		if (ch === '/' && next === '*') {
			i += 2
			while (i < len && !(text[i] === '*' && text[i + 1] === '/')) i++
			i += 2
			continue
		}

		out += ch
		i++
	}

	return out
}
