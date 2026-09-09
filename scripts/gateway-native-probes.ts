import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import http from 'node:http'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { brotliDecompressSync, gunzipSync, inflateSync } from 'node:zlib'

const PREFIX = '/api/v1/users/__verify/'
const FIRST = 'first transport chunk\n'
const SECOND = 'second transport chunk\n'
type Encoding = 'gzip' | 'deflate' | 'br'
type Framing = 'known' | 'streamed'
export type NativeResponse = { status: number; headers: http.IncomingHttpHeaders; body: Buffer }
type ProbeState = {
	requests: number
	firstSeen: boolean
	complete: boolean
	closed: boolean
	ended: boolean
	released: boolean
	bytes: number
	sha256: string
}

// Verification-only release handshakes reject buffered exchanges without timing guesses.
export function usersTransportProbeRoutes(): string {
	return String.raw`
type VerifyTransportState = {
	requests: number; firstSeen: boolean; complete: boolean; closed: boolean; ended: boolean;
	released: boolean; bytes: number; sha256: string; release?: () => void
}
const verifyStates = new Map<string, VerifyTransportState>()
app.all('/api/v1/users/__verify/:probe', async (c) => {
	const id = c.req.query('id')
	if (!id) return c.json({ error: 'probe id required' }, 400)
	const kind = c.req.param('probe')
	if (kind === 'state' || kind === 'release') {
		const state = verifyStates.get(id)
		if (!state) return c.json({ error: 'unknown probe' }, 404)
		if (kind === 'release') {
			state.released = true
			state.release?.()
		}
		const { release: _release, ...result } = state
		return c.json(result)
	}
	const state: VerifyTransportState = verifyStates.get(id) ?? {
		requests: 0, firstSeen: false, complete: false, closed: false, ended: false,
		released: false, bytes: 0, sha256: ''
	}
	verifyStates.set(id, state)
	state.requests += 1
	const { createHash } = await import('node:crypto')
	const outgoing = (c.env as unknown as { outgoing: import('node:http').ServerResponse }).outgoing
	if (!outgoing) return c.json({ error: 'Node response unavailable' }, 500)
	outgoing.once('close', () => {
		state.closed = true
		state.ended = outgoing.writableFinished
	})
	if (kind === 'upload') {
		const reader = c.req.raw.body?.getReader()
		if (!reader) return c.json({ error: 'body required' }, 400)
		const hash = createHash('sha256')
		try {
			for (;;) {
				const chunk = await reader.read()
				if (chunk.done) break
				state.firstSeen = true
				state.bytes += chunk.value.byteLength
				hash.update(chunk.value)
			}
		} finally {
			reader.releaseLock()
		}
		state.sha256 = hash.digest('hex')
		state.complete = true
		return c.json({ bytes: state.bytes, sha256: state.sha256, requests: state.requests })
	}
	if (kind === 'empty') {
		const status = Number(c.req.query('status') ?? 200)
		if (![200, 204, 205, 304].includes(status)) return c.json({ error: 'invalid status' }, 400)
		const headers = new Headers({ etag: '"transport-representation"' })
		if (c.req.method === 'HEAD' || status === 304) headers.set('content-length', '123')
		return new Response(null, { status, headers })
	}
	if (kind === 'redirect') {
		const headers = new Headers({ location: '/api/v1/users/__verify/redirect-target?id=' + id })
		headers.append('set-cookie', 'probe_a=one; Path=/')
		headers.append('set-cookie', 'probe_b=two; Path=/')
		return new Response(null, { status: 302, headers })
	}
	let first = new TextEncoder().encode('first transport chunk\n')
	let second = new TextEncoder().encode('second transport chunk\n')
	const headers = new Headers({ 'content-type': 'application/octet-stream' })
	if (kind === 'compressed') {
		const encoding = c.req.query('encoding')
		const mode = c.req.query('mode')
		const { gzipSync, deflateSync, brotliCompressSync } = await import('node:zlib')
		const plain = Buffer.from(encoding + ':' + mode + ':' + 'transport payload\n'.repeat(64))
		const encoded = encoding === 'gzip' ? gzipSync(plain)
			: encoding === 'deflate' ? deflateSync(plain)
			: encoding === 'br' ? brotliCompressSync(plain) : null
		if (!encoded || !['known', 'streamed'].includes(mode ?? '')) return c.json({ error: 'invalid encoding or framing' }, 400)
		state.bytes = encoded.length
		state.sha256 = createHash('sha256').update(encoded).digest('hex')
		headers.set('content-encoding', encoding!)
		if (mode === 'known') {
			headers.set('content-length', String(encoded.length))
			state.complete = true
			return new Response(encoded, { headers })
		}
		const middle = Math.ceil(encoded.length / 2)
		first = encoded.subarray(0, middle)
		second = encoded.subarray(middle)
	} else if (kind !== 'stream' && kind !== 'never') return c.json({ error: 'unknown probe' }, 404)
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(first)
			state.firstSeen = true
			state.release = () => {
				if (state.complete) return
				state.complete = true
				controller.enqueue(second)
				controller.close()
			}
		},
		cancel() { state.release = undefined }
	})
	return new Response(body, { headers })
})
`
}

export async function installUsersStreamingProbe(project: string): Promise<void> {
	const path = join(project, 'services/users/src/app.ts')
	const app = await readFile(path, 'utf8')
	const boundary = "app.use('/api/v1/users/*', requireAuth)"
	if (!app.includes(boundary) || app.includes('const verifyStates')) throw new Error('Could not uniquely install transport probe routes')
	const entryPath = join(project, 'services/users/src/index.ts')
	const entry = await readFile(entryPath, 'utf8')
	if (!entry.includes('fetch(request) {') || !entry.includes('return app.fetch(request, { AUTH_URL: authUrl })')) throw new Error('Could not install the upstream response observer')
	// Expose ServerResponse in the disposable private service without changing the gateway.
	await writeFile(entryPath, entry.replace('fetch(request) {', 'fetch(request, bindings) {')
		.replace('return app.fetch(request, { AUTH_URL: authUrl })', 'return app.fetch(request, { ...bindings, AUTH_URL: authUrl })'))
	await writeFile(path, app.replace(boundary, `${usersTransportProbeRoutes()}\n${boundary}`))
}

function requireProbe(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(`Native transport probe failed: ${message}`)
}

function hash(body: Uint8Array): string {
	return createHash('sha256').update(body).digest('hex')
}

function endpoint({ origin, kind, parameters }: { origin: string; kind: string; parameters: Record<string, string> }): string {
	const url = new URL(PREFIX + kind, origin)
	url.search = new URLSearchParams(parameters).toString()
	return url.toString()
}

type Exchange = {
	request: http.ClientRequest
	response: Promise<NativeResponse>
	first: Promise<void>
	stop: () => void
}

// Bound every exchange and destroy owned sockets on failure, even for an endless response.
function openExchange(options: { url: string; method?: string; headers?: Record<string, string> }): Exchange {
	const url = new URL(options.url)
	requireProbe(url.protocol === 'http:', 'only local HTTP verification origins are supported')
	requireProbe(url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname.endsWith('.localhost'), 'non-local verification origin')
	let resolveFirst!: () => void
	let rejectFirst!: (error: Error) => void
	const first = new Promise<void>((resolve, reject) => { resolveFirst = resolve; rejectFirst = reject })
	let incoming: http.IncomingMessage | undefined
	let done = false
	let request!: http.ClientRequest
	let rejectResponse!: (error: Error) => void
	const fail = (error: Error) => {
		if (done) return
		done = true
		clearTimeout(timer)
		rejectFirst(error)
		rejectResponse(error)
		incoming?.destroy()
		request.destroy()
	}
	const timer = setTimeout(() => fail(new Error('native HTTP exchange deadline exceeded')), 10_000)
	const response = new Promise<NativeResponse>((resolve, reject) => {
		rejectResponse = reject
		request = http.request({
			hostname: url.hostname.endsWith('.localhost') ? '127.0.0.1' : url.hostname,
			port: url.port || 80, path: url.pathname + url.search,
			method: options.method ?? 'GET', agent: false,
			headers: { ...options.headers, host: url.host }
		}, (message) => {
			incoming = message
			const chunks: Buffer[] = []
			let bytes = 0
			message.on('data', (chunk: Buffer) => {
				bytes += chunk.length
				if (bytes > 1024 * 1024) return fail(new Error('probe response exceeded its bounded payload'))
				chunks.push(chunk)
				resolveFirst()
			})
			message.on('error', fail)
			message.on('aborted', () => fail(new Error('native HTTP response aborted')))
			message.on('end', () => {
				if (done) return
				done = true
				clearTimeout(timer)
				rejectFirst(new Error('response ended before any body data'))
				resolve({ status: message.statusCode ?? 0, headers: message.headers, body: Buffer.concat(chunks) })
			})
		})
		request.on('error', fail)
	})
	// Some probes await a state handshake before awaiting response completion.
	void first.catch(() => undefined)
	void response.catch(() => undefined)
	return { request, response, first, stop: () => { fail(new Error('probe client cancelled')); request.destroy() } }
}

export async function rawRequest(url: string, options: { method?: string; headers?: Record<string, string>; body?: Buffer } = {}): Promise<NativeResponse> {
	const exchange = openExchange({ url, ...options })
	try {
		exchange.request.end(options.body)
		return await exchange.response
	} finally {
		exchange.stop()
	}
}

async function readState(origin: string, id: string): Promise<ProbeState | undefined> {
	const response = await rawRequest(endpoint({ origin, kind: 'state', parameters: { id } }))
	if (response.status === 404) return undefined
	requireProbe(response.status === 200, 'upstream state endpoint rejected the probe')
	return JSON.parse(response.body.toString()) as ProbeState
}

async function waitForState(options: { origin: string; id: string; matches: (state: ProbeState) => boolean }): Promise<ProbeState> {
	const deadline = Date.now() + 5_000
	while (Date.now() < deadline) {
		const state = await readState(options.origin, options.id)
		if (state && options.matches(state)) return state
		await delay(25)
	}
	throw new Error('Native transport probe failed: upstream state handshake did not complete')
}

function assertOneRequest(state: ProbeState): void {
	requireProbe(state.requests === 1, 'upstream request count is not exactly one')
}

export function assertUpload(response: NativeResponse, payload: Buffer): void {
	requireProbe(response.status === 200, 'upload status is not 200')
	const report = JSON.parse(response.body.toString()) as { bytes: number; sha256: string; requests: number }
	requireProbe(report.bytes === payload.length, 'upload byte count differs')
	requireProbe(report.sha256 === hash(payload), 'upload SHA-256 differs')
	requireProbe(report.requests === 1, 'upload was retried')
	requireProbe(Boolean(response.headers['x-request-id']), 'gateway request id missing')
}

async function verifyUpload(origin: string): Promise<unknown> {
	const payload = Buffer.alloc(48 * 1024, 5)
	const id = randomUUID()
	const exchange = openExchange({ url: endpoint({ origin, kind: 'upload', parameters: { id } }), method: 'POST', headers: { 'content-type': 'application/octet-stream', 'transfer-encoding': 'chunked' } })
	try {
		exchange.request.write(payload.subarray(0, 16 * 1024))
		const partial = await waitForState({ origin, id, matches: (state) => state.firstSeen })
		assertOneRequest(partial)
		requireProbe(!partial.complete && partial.bytes > 0 && partial.bytes < payload.length, 'upload did not arrive before request completion')
		exchange.request.end(payload.subarray(16 * 1024))
		assertUpload(await exchange.response, payload)
		const complete = await waitForState({ origin, id, matches: (state) => state.complete })
		assertOneRequest(complete)
		requireProbe(complete.bytes === payload.length && complete.sha256 === hash(payload), 'completed upstream upload differs')
	} finally {
		exchange.stop()
	}
	const fixedId = randomUUID()
	assertUpload(await rawRequest(endpoint({ origin, kind: 'upload', parameters: { id: fixedId } }), {
		method: 'POST', headers: { 'content-length': String(payload.length), 'content-type': 'application/octet-stream' }, body: payload
	}), payload)
	assertOneRequest((await readState(origin, fixedId))!)
	return { bytes: payload.length, sha256: hash(payload), chunked: 'passed', fixed: 'passed', firstChunkBeforeEnd: true, requestsPerCase: 1 }
}

export function assertEncoded(options: { response: NativeResponse; encoding: Encoding; mode: Framing; expected: { bytes: number; sha256: string } }): void {
	const { response, encoding, mode, expected } = options
	requireProbe(response.status === 200, 'compressed response status is not 200')
	requireProbe(response.headers['content-encoding'] === encoding, 'content-encoding differs')
	requireProbe(response.body.length === expected.bytes && hash(response.body) === expected.sha256, 'encoded bytes differ from the upstream record')
	const length = response.headers['content-length']
	if (mode === 'known') requireProbe(length === String(response.body.length), 'known content-length differs')
	else requireProbe(length === undefined, 'streamed response unexpectedly has a content-length')
	const decoded = encoding === 'gzip' ? gunzipSync(response.body) : encoding === 'deflate' ? inflateSync(response.body) : brotliDecompressSync(response.body)
	const expectedPlain = Buffer.from(`${encoding}:${mode}:${'transport payload\n'.repeat(64)}`)
	requireProbe(decoded.equals(expectedPlain), 'decoded payload differs or was truncated')
	requireProbe(Boolean(response.headers['x-request-id']), 'gateway request id missing')
}

async function verifyResponse(options: { origin: string; encoding?: Encoding; mode?: Framing }): Promise<unknown> {
	const { origin, encoding, mode } = options
	const id = randomUUID()
	const exchange = openExchange({ url: endpoint({ origin, kind: encoding ? 'compressed' : 'stream', parameters: { id, ...(encoding && mode ? { encoding, mode } : {}) } }) })
	try {
		exchange.request.end()
		if (!encoding || mode === 'streamed') {
			await exchange.first
			const before = (await readState(origin, id))!
			assertOneRequest(before)
			requireProbe(before.firstSeen && !before.complete && !before.ended && !before.released, 'response completed before client released its second chunk')
			const released = await rawRequest(endpoint({ origin, kind: 'release', parameters: { id } }))
			requireProbe(released.status === 200, 'response release was rejected')
		}
		const response = await exchange.response
		const state = (await readState(origin, id))!
		assertOneRequest(state)
		if (encoding && mode) assertEncoded({ response, encoding, mode, expected: state })
		else requireProbe(response.status === 200 && response.body.equals(Buffer.from(FIRST + SECOND)), 'incremental response payload differs')
		return { encoding: encoding ?? 'identity', mode: mode ?? 'streamed', status: response.status, bytes: response.body.length, sha256: hash(response.body), requests: state.requests, ...(mode !== 'known' ? { firstChunkBeforeRelease: true } : {}) }
	} finally {
		exchange.stop()
	}
}

async function verifyCancellation(origin: string): Promise<unknown> {
	const id = randomUUID()
	const exchange = openExchange({ url: endpoint({ origin, kind: 'never', parameters: { id } }) })
	try {
		exchange.request.end()
		await exchange.first
		const before = (await readState(origin, id))!
		assertOneRequest(before)
		requireProbe(before.firstSeen && !before.closed && !before.ended && !before.complete, 'upstream was not open before cancellation')
		exchange.stop()
		const after = await waitForState({ origin, id, matches: (state) => state.closed })
		assertOneRequest(after)
		requireProbe(!after.ended && !after.complete, 'upstream ended normally instead of being cancelled')
		return { openBeforeCancellation: true, closedAfterCancellation: true, upstreamEnded: false, requests: 1 }
	} finally {
		exchange.stop()
		// Release a deliberately broken cancellation control so the failed probe cannot leak it.
		await rawRequest(endpoint({ origin, kind: 'release', parameters: { id } })).catch(() => undefined)
	}
}

async function verifyStatuses(origin: string): Promise<unknown> {
	const outcomes: unknown[] = []
	for (const entry of [{ status: 204, method: 'GET' }, { status: 205, method: 'GET' }, { status: 304, method: 'GET' }, { status: 200, method: 'HEAD' }]) {
		const id = randomUUID()
		const response = await rawRequest(endpoint({ origin, kind: 'empty', parameters: { id, status: String(entry.status) } }), { method: entry.method })
		requireProbe(response.status === entry.status && response.body.length === 0, 'bodyless response status or body differs')
		requireProbe(response.headers.etag === '"transport-representation"', 'bodyless response metadata differs')
		if (entry.method === 'HEAD' || entry.status === 304) requireProbe(response.headers['content-length'] === '123', 'representation content-length lost')
		assertOneRequest((await readState(origin, id))!)
		outcomes.push({ ...entry, bytes: 0 })
	}
	const id = randomUUID()
	const response = await rawRequest(endpoint({ origin, kind: 'redirect', parameters: { id } }))
	requireProbe(response.status === 302 && response.headers.location === PREFIX + 'redirect-target?id=' + id, 'redirect followed or location changed')
	requireProbe(JSON.stringify(response.headers['set-cookie']) === JSON.stringify(['probe_a=one; Path=/', 'probe_b=two; Path=/']), 'multiple cookies lost')
	assertOneRequest((await readState(origin, id))!)
	return { bodyless: outcomes, manualRedirect: true, separateCookies: true }
}

export type NativeCase = { kind: 'upload' | 'fixed-upload' | 'cancellation' | 'statuses' | 'encoded'; encoding?: Encoding; mode?: Framing }

export async function runNativeIngressProbes(origins: string[], only?: NativeCase): Promise<unknown> {
	const results: unknown[] = []
	for (const origin of origins) {
		if (only) {
			if (only.kind === 'upload') results.push(await verifyUpload(origin))
			else if (only.kind === 'cancellation') results.push(await verifyCancellation(origin))
			else if (only.kind === 'statuses') results.push(await verifyStatuses(origin))
			else if (only.kind === 'encoded') {
				requireProbe(only.encoding && only.mode, 'encoding and framing are required')
				results.push(await verifyResponse({ origin, encoding: only.encoding, mode: only.mode }))
			} else {
				const payload = Buffer.alloc(48 * 1024, 5)
				const id = randomUUID()
				assertUpload(await rawRequest(endpoint({ origin, kind: 'upload', parameters: { id } }), {
					method: 'POST', headers: { 'content-length': String(payload.length) }, body: payload
				}), payload)
				assertOneRequest((await readState(origin, id))!)
				results.push({ fixedUpload: true, bytes: payload.length, sha256: hash(payload) })
			}
			continue
		}
		const upload = await verifyUpload(origin)
		const stream = await verifyResponse({ origin })
		const encoded: unknown[] = []
		for (const encoding of ['gzip', 'deflate', 'br'] as const) for (const mode of ['known', 'streamed'] as const) encoded.push(await verifyResponse({ origin, encoding, mode }))
		const cancellation = await verifyCancellation(origin)
		const statuses = await verifyStatuses(origin)
		results.push({ origin, upload, stream, encoded, cancellation, statuses })
	}
	return { runtime: process.version, results }
}

// Run wire probes on real Node against the complete gateway, never an extracted helper.
export async function verifyNativeIngresses(origins: string[], only?: NativeCase): Promise<unknown> {
	const source = await readFile(new URL(import.meta.url), 'utf8')
	const javascript = new Bun.Transpiler({ loader: 'ts', target: 'node' }).transformSync(source)
	const program = `${javascript}\nconst options = JSON.parse(process.argv[1]); console.log(JSON.stringify(await runNativeIngressProbes(options.origins, options.only)))`
	const child = spawn('node', ['--input-type=module', '--eval', program, JSON.stringify({ origins, only })], { stdio: ['ignore', 'pipe', 'pipe'] })
	let output = ''
	let errors = ''
	child.stdout.on('data', (chunk) => { output += chunk.toString() })
	child.stderr.on('data', (chunk) => { errors += chunk.toString() })
	const timer = setTimeout(() => child.kill('SIGTERM'), 180_000)
	try {
		const code = await new Promise<number | null>((resolve, reject) => {
			child.on('error', reject)
			child.on('close', resolve)
		})
		if (code !== 0) throw new Error(`Native Node ingress probes failed: ${errors.slice(-4000)}`)
		return JSON.parse(output) as unknown
	} finally {
		clearTimeout(timer)
	}
}
