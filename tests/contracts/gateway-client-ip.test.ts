import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { runGenerators } from '../../src/generators/index.js'
import { parseJsonc } from '../../src/lib/jsonc.js'
import { GvKitConfig } from '../../src/schema/config.js'

const fixturesDir = join(import.meta.dir, '..', '..', 'fixtures')

type ClientIpModule = {
	withAuthenticatedClientIp(options: {
		request: Request
		peerAddress: string | undefined
		trustedIngressSecret: string
	}): Request | undefined
}

async function loadClientIpModule(): Promise<ClientIpModule> {
	const raw = parseJsonc(
		readFileSync(join(fixturesDir, 'hono-skip-auth-emailotp.jsonc'), 'utf8')
	)
	const entry = runGenerators(GvKitConfig.parse(raw)).find(
		(candidate) => candidate.path === 'apps/api/src/client-ip.ts'
	)
	if (!entry) throw new Error('generated Node client IP boundary is missing')
	const transpiler = new Bun.Transpiler({ loader: 'ts', target: 'bun' })
	const javascript = transpiler.transformSync(entry.content)
	const moduleUrl = `data:text/javascript;base64,${Buffer.from(javascript).toString('base64')}`
	return (await import(moduleUrl)) as ClientIpModule
}

describe('Node gateway client IP boundary', () => {
	test('direct callers cannot rotate forwarding headers away from their connection peer', async () => {
		const { withAuthenticatedClientIp } = await loadClientIpModule()
		const forwarded = ['198.51.100.10', '198.51.100.11'].map((suppliedIp) =>
			withAuthenticatedClientIp({
				request: new Request('http://api.example.test/api/auth/get-session', {
					headers: {
						'cf-connecting-ip': suppliedIp,
						'x-forwarded-for': suppliedIp,
						'x-real-ip': suppliedIp
					}
				}),
				peerAddress: '203.0.113.7',
				trustedIngressSecret: 'trusted-secret'
			})
		)

		expect(forwarded.map((request) => request?.headers.get('x-forwarded-for'))).toEqual([
			'203.0.113.7',
			'203.0.113.7'
		])
	})

	test('authenticated ingress preserves distinct single-address client identities', async () => {
		const { withAuthenticatedClientIp } = await loadClientIpModule()
		const forwarded = ['198.51.100.20', '198.51.100.21'].map((clientIp) =>
			withAuthenticatedClientIp({
				request: new Request('http://api.example.test/api/auth/get-session', {
					headers: {
						'x-forwarded-for': clientIp,
						'x-gateway-ingress-secret': 'trusted-secret'
					}
				}),
				peerAddress: '172.20.0.5',
				trustedIngressSecret: 'trusted-secret'
			})
		)

		expect(forwarded.map((request) => request?.headers.get('x-forwarded-for'))).toEqual([
			'198.51.100.20',
			'198.51.100.21'
		])
	})

	test('invalid forwarding falls back to the peer and missing trustworthy data fails closed', async () => {
		const { withAuthenticatedClientIp } = await loadClientIpModule()
		const malformed = withAuthenticatedClientIp({
			request: new Request('http://api.example.test/api/auth/get-session', {
				headers: {
					'x-forwarded-for': '198.51.100.30, 198.51.100.31',
					'x-gateway-ingress-secret': 'trusted-secret'
				}
			}),
			peerAddress: '172.20.0.5',
			trustedIngressSecret: 'trusted-secret'
		})
		const unavailable = withAuthenticatedClientIp({
			request: new Request('http://api.example.test/api/auth/get-session', {
				headers: { 'x-forwarded-for': '198.51.100.30' }
			}),
			peerAddress: undefined,
			trustedIngressSecret: 'trusted-secret'
		})

		expect(malformed?.headers.get('x-forwarded-for')).toBe('172.20.0.5')
		expect(unavailable).toBeUndefined()
	})

	test('internal Node SSR cannot authenticate a carried caller IP header', () => {
		const raw = parseJsonc(
			readFileSync(join(fixturesDir, 'hono-skip-auth-emailotp.jsonc'), 'utf8')
		)
		const hooks = runGenerators(GvKitConfig.parse(raw)).find(
			(candidate) => candidate.path === 'apps/web/src/hooks.server.ts'
		)?.content
		if (!hooks) throw new Error('generated web hooks are missing')

		const removeCallerIp = hooks.indexOf("forwarded.headers.delete('x-forwarded-for')")
		const authenticateSsr = hooks.indexOf("forwarded.headers.set('x-gateway-ingress-secret'")
		expect(removeCallerIp).toBeGreaterThan(-1)
		expect(authenticateSsr).toBeGreaterThan(removeCallerIp)
	})

	test('Node fails closed without a connection address while Cloudflare keeps its platform IP path', () => {
		const nodeRaw = parseJsonc(
			readFileSync(join(fixturesDir, 'hono-skip-auth-emailotp.jsonc'), 'utf8')
		)
		const cloudflareRaw = parseJsonc(
			readFileSync(join(fixturesDir, 'hono-cf-workers-passwordless.jsonc'), 'utf8')
		)
		const nodeEntries = runGenerators(GvKitConfig.parse(nodeRaw))
		const cloudflareEntries = runGenerators(GvKitConfig.parse(cloudflareRaw))
		const nodeIndex = nodeEntries.find(
			(candidate) => candidate.path === 'apps/api/src/index.ts'
		)?.content
		const cloudflareIndex = cloudflareEntries.find(
			(candidate) => candidate.path === 'apps/api/src/index.ts'
		)?.content
		const cloudflareAuth = cloudflareEntries.find(
			(candidate) => candidate.path === 'services/auth/src/auth.ts'
		)?.content
		const nodeReadme = nodeEntries.find(
			(candidate) => candidate.path === 'apps/api/README.md'
		)?.content
		const cloudflareReadme = cloudflareEntries.find(
			(candidate) => candidate.path === 'apps/api/README.md'
		)?.content

		expect(nodeIndex).toContain('env.incoming.socket.remoteAddress')
		expect(nodeIndex).toContain("new Response('client address unavailable', { status: 503 })")
		expect(cloudflareEntries.some(({ path }) => path === 'apps/api/src/client-ip.ts')).toBe(
			false
		)
		expect(cloudflareIndex).not.toContain('withAuthenticatedClientIp')
		expect(cloudflareAuth).toContain("ipAddressHeaders: ['cf-connecting-ip']")
		expect(cloudflareReadme).toContain('platform-provided `cf-connecting-ip`')
		expect(cloudflareReadme).not.toContain('`GATEWAY_TRUSTED_INGRESS_SECRET`')
		expect(nodeReadme).toContain('Configure `set_real_ip_from` with only the proxy')
		expect(nodeReadme).toContain('rate limiting safely groups traffic under the proxy address')
	})

	test('trusted Nginx overwrites caller forwarding with the transport peer', () => {
		const raw = parseJsonc(
			readFileSync(join(fixturesDir, 'hono-docker-emailotp-only.jsonc'), 'utf8')
		)
		const ingress = runGenerators(GvKitConfig.parse(raw)).find(
			(candidate) => candidate.path === 'docker/ingress.conf.template'
		)?.content
		if (!ingress) throw new Error('generated Docker ingress is missing')

		expect(ingress.match(/proxy_set_header X-Forwarded-For \$remote_addr;/g)).toHaveLength(3)
		expect(ingress).not.toContain('proxy_add_x_forwarded_for')
	})
})
