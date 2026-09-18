import { describe, expect, mock, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { gzipSync } from 'node:zlib'
import { assertEncoded, assertUpload, type NativeResponse } from '../../scripts/gateway-native-probes.js'
import { Readable } from 'node:stream'
import { runGenerators } from '../../src/generators/index.js'
import type { GvKitConfig } from '../../src/schema/config.js'

const config: GvKitConfig = {
	configVersion: 2,
	choices: {
		name: 'transport', frontend: 'sveltekit', marketing: 'inside-web', backend: 'hono',
		i18n: 'skip', monitoring: [], db: 'postgres', apiClient: 'hey-api',
		auth: ['emailOTP'], email: 'resend', aiTooling: [], deploy: 'skip'
	}
}

// Execute the emitted transport with an in-memory HTTP adapter. No listeners, network, or writes.
async function bodylessResponse(options: { status: number; method?: string; length?: string }) {
	const source = runGenerators(config).find((entry) => entry.path === 'apps/api/src/index.ts')!.content
	const start = source.indexOf('const HOP_BY_HOP_HEADERS')
	const end = source.indexOf('const canonicalApiOrigin')
	expect(start).toBeGreaterThanOrEqual(0)
	expect(end).toBeGreaterThan(start)
	const message = Object.assign(Readable.from([]), {
		statusCode: options.status,
		statusMessage: 'upstream status',
		rawHeaders: ['etag', '"representation"', ...(options.length ? ['content-length', options.length] : [])]
	})
	let drained = false
	message.on('end', () => { drained = true })
	const upstreamRequest = Object.assign(new EventEmitter(), {
		end(): void {
			queueMicrotask(() => {
				const suppliedArguments: readonly unknown[] = transport.request.mock.calls[0] ?? []
				const respond = suppliedArguments[2]
				if (typeof respond !== 'function') throw new Error('HTTP response callback missing')
				respond(message)
			})
		},
		destroy(): void { message.destroy() }
	})
	const transport = { request: mock(() => upstreamRequest) }
	const javascript = new Bun.Transpiler({ loader: 'ts' }).transformSync(source.slice(start, end))
	const factory = new Function('dependencies', `const { http, https, Readable } = dependencies;\n${javascript}\nreturn httpTarget`)
	const target: { fetch(request: Request): Promise<Response> } = factory({ http: transport, https: transport, Readable })('http://upstream.invalid')
	const response = await target.fetch(new Request('http://gateway.invalid/api/v1/users', { method: options.method ?? 'GET' }))
	await new Promise((resolve) => setImmediate(resolve))
	return { response, drained }
}

describe('native probe assertion sensitivity without network', () => {
	const payload = Buffer.from('an intact upload')
	const digest = (body: Buffer) => createHash('sha256').update(body).digest('hex')
	const upload = (changes: Record<string, unknown> = {}): NativeResponse => ({
		status: 200,
		headers: { 'x-request-id': 'synthetic-probe' },
		body: Buffer.from(JSON.stringify({ bytes: payload.length, sha256: digest(payload), requests: 1, ...changes }))
	})

	test('accepts an intact successful upload exactly once', () => {
		expect(() => assertUpload(upload(), payload)).not.toThrow()
	})

	test('rejects rejected uploads, discarded bytes, corruption, and retries', () => {
		expect(() => assertUpload({ ...upload(), status: 400 }, payload)).toThrow('status')
		for (const changes of [{ bytes: 0 }, { sha256: digest(Buffer.from('corrupted')) }, { requests: 2 }]) expect(() => assertUpload(upload(changes), payload)).toThrow()
	})

	const plain = Buffer.from(`gzip:known:${'transport payload\n'.repeat(64)}`)
	const encoded = gzipSync(plain)
	const response = (body = encoded): NativeResponse => ({
		status: 200,
		headers: { 'content-encoding': 'gzip', 'content-length': String(body.length), 'x-request-id': 'synthetic-probe' },
		body
	})
	const check = (value: NativeResponse) => assertEncoded({
		response: value, encoding: 'gzip', mode: 'known',
		expected: { bytes: value.body.length, sha256: digest(value.body) }
	})

	test('accepts exact compressed bytes and the complete decoded payload', () => {
		expect(() => check(response())).not.toThrow()
	})

	test('rejects plaintext masquerading as compressed output and decodable truncation', () => {
		expect(() => check(response(plain))).toThrow()
		expect(() => check(response(gzipSync(plain.subarray(0, 20))))).toThrow('truncated')
		expect(() => check({ ...response(), status: 502 })).toThrow('status')
		expect(() => check({ ...response(), headers: { 'content-length': String(encoded.length) } })).toThrow('encoding')
		expect(() => check({ ...response(), headers: { ...response().headers, 'content-length': '999' } })).toThrow('length')
	})
})

describe('generated Node null-body response semantics', () => {
	for (const status of [204, 205, 304]) {
		test(`preserves ${status} with a null body and drains its upstream`, async () => {
			const { response, drained } = await bodylessResponse({ status })
			expect(response.status).toBe(status)
			expect(response.body).toBeNull()
			expect(response.headers.get('etag')).toBe('"representation"')
			expect(drained).toBe(true)
		})
	}

	test('preserves representation length on HEAD and 304 without inventing a body', async () => {
		for (const options of [{ status: 200, method: 'HEAD' }, { status: 304 }]) {
			const { response, drained } = await bodylessResponse({ ...options, length: '123' })
			expect(response.status).toBe(options.status)
			expect(response.body).toBeNull()
			expect(response.headers.get('content-length')).toBe('123')
			expect(drained).toBe(true)
		}
	})
})
