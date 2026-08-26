import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { runGenerators } from '../../src/generators/index.js'
import { parseJsonc } from '../../src/lib/jsonc.js'
import { GvKitConfig } from '../../src/schema/config.js'

const fixturesDir = join(import.meta.dir, '..', '..', 'fixtures')

function planFixture(name: string) {
	const raw = parseJsonc(readFileSync(join(fixturesDir, `${name}.jsonc`), 'utf8'))
	return runGenerators(GvKitConfig.parse(raw))
}

type GatewayTarget = { fetch(request: Request): Promise<Response> }
type GatewayModule = {
	createGateway(targets: { AUTH?: GatewayTarget }): { fetch(request: Request): Promise<Response> }
}

async function loadGeneratedGateway(): Promise<GatewayModule> {
	const app = planFixture('hono-skip-auth-emailotp').find(
		(entry) => entry.path === 'apps/api/src/app.ts'
	)
	if (!app) throw new Error('generated gateway app is missing')

	const honoUrl = import.meta.resolve('hono')
	const source = app.content.replace("from 'hono'", `from '${honoUrl}'`)
	const transpiler = new Bun.Transpiler({ loader: 'ts', target: 'bun' })
	const javascript = transpiler.transformSync(source)
	const moduleUrl = URL.createObjectURL(new Blob([javascript], { type: 'text/javascript' }))
	const module = (await import(moduleUrl)) as GatewayModule
	URL.revokeObjectURL(moduleUrl)
	return module
}

async function loadAuthUtils() {
	const utils = planFixture('hono-skip-auth-emailotp').find(
		(entry) => entry.path === 'services/auth/src/lib/utils.ts'
	)
	if (!utils) throw new Error('generated auth utils are missing')

	const transpiler = new Bun.Transpiler({ loader: 'ts', target: 'bun' })
	const javascript = transpiler.transformSync(utils.content)
	const dataUrl = `data:text/javascript;base64,${Buffer.from(javascript).toString('base64')}`
	return (await import(dataUrl)) as {
		parseAllowedHosts(raw: string | undefined): string[]
		resolveCorsOrigin(origin: string, raw: string | undefined): string
	}
}

describe('dual-origin gateway authentication', () => {
	test('Better Auth resolves only explicit hosts and keeps cookies host-only', async () => {
		const entries = planFixture('hono-skip-auth-emailotp')
		const auth = entries.find((entry) => entry.path === 'services/auth/src/auth.ts')!.content
		const env = entries.find((entry) => entry.path === 'services/auth/env.d.ts')!.content
		const { parseAllowedHosts } = await loadAuthUtils()

		expect(auth).toContain('baseURL: {')
		expect(auth).toContain('allowedHosts: parseAllowedHosts(')
		expect(auth).not.toContain('fallback:')
		expect(auth).toContain('trustedProxyHeaders: true')
		expect(auth).toContain('crossSubDomainCookies: { enabled: false }')
		expect(auth).not.toContain('BETTER_AUTH_URL')
		expect(env).toContain('BETTER_AUTH_ALLOWED_HOSTS')
		expect(parseAllowedHosts(undefined)).toEqual([
			'localhost:3000',
			'localhost:5173',
			'localhost:8786',
			'127.0.0.1:8786'
		])
		expect(parseAllowedHosts('app.example.test,api.example.test,*.preview.example.test')).toEqual([
			'app.example.test',
			'api.example.test',
			'*.preview.example.test'
		])
	})

	test('auth CORS echoes approved origins and rejects unknown origins without a wildcard', async () => {
		const entries = planFixture('hono-skip-auth-emailotp')
		const app = entries.find((entry) => entry.path === 'services/auth/src/app.ts')!.content
		const { resolveCorsOrigin } = await loadAuthUtils()
		const allowlist = 'https://app.example.test,https://preview.example.test'

		expect(app).toContain('AUTH_CORS_ORIGINS')
		expect(app).toContain('resolveCorsOrigin(origin,')
		expect(app).toContain('credentials: true')
		expect(app).not.toContain("origin: '*'")
		expect(resolveCorsOrigin('https://app.example.test', allowlist)).toBe(
			'https://app.example.test'
		)
		expect(resolveCorsOrigin('https://evil.example.test', allowlist)).toBe('')
	})

	test('CAPTCHA, cookies, redirects, and Set-Cookie pass through the gateway unchanged', async () => {
		const { createGateway } = await loadGeneratedGateway()
		let forwarded: Request | undefined
		const upstream = new Response(null, {
			status: 302,
			headers: [
				['location', 'https://accounts.example.test/authorize'],
				['set-cookie', 'oauth_state=one; Path=/; HttpOnly; SameSite=Lax'],
				['set-cookie', 'session=two; Path=/; HttpOnly; SameSite=Lax']
			]
		})
		const gateway = createGateway({
			AUTH: {
				async fetch(request) {
					forwarded = request
					return upstream
				}
			}
		})
		const request = new Request('https://app.example.test/api/auth/sign-in/email-otp', {
			method: 'POST',
			headers: {
				cookie: 'oauth_state=before',
				origin: 'https://app.example.test',
				'x-captcha-response': 'captcha-token'
			},
			body: '{}'
		})

		const response = await gateway.fetch(request)

		expect(forwarded).toBe(request)
		expect(forwarded?.headers.get('cookie')).toBe('oauth_state=before')
		expect(forwarded?.headers.get('origin')).toBe('https://app.example.test')
		expect(forwarded?.headers.get('x-captcha-response')).toBe('captcha-token')
		expect(response).toBe(upstream)
		expect(response.status).toBe(302)
		expect(response.headers.get('location')).toBe('https://accounts.example.test/authorize')
		expect(response.headers.getSetCookie()).toHaveLength(2)
	})

	test('the Hono web client and SSR use the gateway without an auth facade', () => {
		const entries = planFixture('hono-skip-auth-emailotp')
		const paths = entries.map((entry) => entry.path)
		const client = entries.find(
			(entry) => entry.path === 'apps/web/src/lib/auth/client.ts'
		)!.content
		const session = entries.find(
			(entry) => entry.path === 'apps/web/src/lib/server/load-session.ts'
		)!.content
		const hooks = entries.find((entry) => entry.path === 'apps/web/src/hooks.server.ts')!.content

		expect(paths).not.toContain('apps/web/src/routes/api/auth/[...path]/+server.ts')
		expect(client).not.toContain('PUBLIC_AUTH_URL')
		expect(client).not.toContain('baseURL:')
		expect(session).toContain("event.fetch('/api/auth/get-session'")
		expect(hooks).toContain('env.GATEWAY_URL')
		expect(hooks).not.toContain('AUTH_URL')
		const authRule = entries.find((entry) => entry.path === '.ai/rules/auth-flow.md')!.content
		expect(authRule).not.toContain('same-origin `/api/auth/get-session` façade')
		expect(authRule).not.toContain('through the `AUTH` Service Binding')
	})

	test('the auth service prepares a missing mailer build without rewriting a running watcher', () => {
		const authPackage = planFixture('hono-skip-auth-emailotp').find(
			(entry) => entry.path === 'services/auth/package.json'
		)!.content
		expect(JSON.parse(authPackage).scripts.dev).toBe(
			'(test -f ../../packages/mailer/dist/index.js || pnpm --filter @repo/mailer build) && tsx watch src/index.ts'
		)
	})

	test('the Node gateway preserves public host and protocol for Better Auth', () => {
		const entries = planFixture('hono-skip-auth-emailotp')
		const gateway = entries.find((entry) => entry.path === 'apps/api/src/index.ts')!.content

		expect(gateway).toMatch(
			/request\.headers\.get\('x-forwarded-host'\)\s*\?\? request\.headers\.get\('host'\)\s*\?\? incoming\.host/
		)
		expect(gateway).toMatch(
			/request\.headers\.get\('x-forwarded-proto'\)\s*\?\? incoming\.protocol\.slice\(0, -1\)/
		)
		expect(gateway).toContain("redirect: 'manual'")
	})

	test('private session validation preserves the authoritative public origin', () => {
		const entries = planFixture('hono-skip-auth-emailotp')
		const authClient = entries.find(
			(entry) => entry.path === 'packages/backend/src/middleware/auth/client.ts'
		)!.content

		expect(authClient).toContain(
			"request.headers.get('x-forwarded-host') ?? new URL(request.url).host"
		)
		expect(authClient).toContain(
			"request.headers.get('x-forwarded-proto') ?? new URL(request.url).protocol.slice(0, -1)"
		)
		expect(authClient).toContain("headers.set('x-forwarded-host', forwardedHost)")
		expect(authClient).toContain("headers.set('x-forwarded-proto', forwardedProto)")
	})

	test('the gateway remains a transparent router and creates no trusted principal', () => {
		const gateway = planFixture('hono-skip-auth-emailotp').find(
			(entry) => entry.path === 'apps/api/src/app.ts'
		)!.content

		expect(gateway).not.toMatch(/x-(user|principal|roles?)/i)
		expect(gateway).not.toContain('Authorization')
		expect(gateway).not.toContain('Bearer')
		expect(gateway).not.toContain('API key')
	})
})
