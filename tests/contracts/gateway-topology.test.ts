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
	createGateway(targets: { AUTH?: GatewayTarget; USERS?: GatewayTarget }): {
		fetch(request: Request): Promise<Response>
	}
}

type HandleFetchModule = {
	handleFetch(input: {
		event: { url: URL; platform?: { env: { GATEWAY?: GatewayTarget } } }
		request: Request
		fetch(request: Request): Promise<Response>
	}): Promise<Response>
}

async function loadGeneratedGateway(): Promise<GatewayModule> {
	const app = planFixture('hono-skip-deploy').find((entry) => entry.path === 'apps/api/src/app.ts')
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

async function loadGeneratedHandleFetch(): Promise<HandleFetchModule> {
	const hooks = planFixture('hono-skip-deploy').find(
		(entry) => entry.path === 'apps/web/src/hooks.server.ts'
	)
	if (!hooks) throw new Error('generated web server hooks are missing')

	const source = hooks.content
		.replace(
			"import { env } from '$env/dynamic/private'",
			"const env = { GATEWAY_URL: 'http://gateway.test' }"
		)
		.replace(
			"import { sequence } from '@sveltejs/kit/hooks'",
			'const sequence = (...handlers: unknown[]) => handlers'
		)
	const transpiler = new Bun.Transpiler({ loader: 'ts', target: 'bun' })
	const javascript = transpiler.transformSync(source)
	const moduleUrl = URL.createObjectURL(new Blob([javascript], { type: 'text/javascript' }))
	const module = (await import(moduleUrl)) as HandleFetchModule
	URL.revokeObjectURL(moduleUrl)
	return module
}

describe('local private-service gateway topology', () => {
	test('every Hono plan emits a gateway and private service packages', () => {
		for (const fixture of ['hono-skip-deploy', 'hono-docker-full', 'hono-cf-workers-full']) {
			const entries = planFixture(fixture)
			const paths = entries.map((entry) => entry.path)

			expect(paths).toContain('apps/api/package.json')
			expect(paths).toContain('apps/api/src/app.ts')
			expect(paths).toContain('services/auth/package.json')
			expect(paths).toContain('services/users/package.json')
			expect(paths.some((path) => path.startsWith('apps/api/auth/'))).toBe(false)
			expect(paths.some((path) => path.startsWith('apps/api/users/'))).toBe(false)
		}
	})

	test('the gateway forwards the original request and returns the upstream response', async () => {
		const { createGateway } = await loadGeneratedGateway()
		let forwarded: Request | undefined
		const upstream = new Response('streamed response', {
			status: 207,
			headers: [
				['content-type', 'text/plain'],
				['set-cookie', 'first=1; Path=/'],
				['set-cookie', 'second=2; Path=/']
			]
		})
		const gateway = createGateway({
			USERS: {
				async fetch(request) {
					forwarded = request
					return upstream
				}
			}
		})
		const request = new Request('http://web.test/api/v1/users/me?expanded=true', {
			method: 'POST',
			headers: { cookie: 'session=abc', 'x-trace': 'one' },
			body: 'request body'
		})

		const response = await gateway.fetch(request)

		expect(forwarded).toBe(request)
		expect(forwarded?.method).toBe('POST')
		expect(forwarded?.url).toBe('http://web.test/api/v1/users/me?expanded=true')
		expect(forwarded?.headers.get('cookie')).toBe('session=abc')
		expect(forwarded?.headers.get('x-trace')).toBe('one')
		expect(await forwarded?.text()).toBe('request body')
		expect(response).toBe(upstream)
		expect(response.status).toBe(207)
		expect(response.headers.getSetCookie()).toEqual(['first=1; Path=/', 'second=2; Path=/'])
		expect(await response.text()).toBe('streamed response')
	})

	test('the gateway applies explicit routing and failure semantics without retrying', async () => {
		const { createGateway } = await loadGeneratedGateway()
		let authCalls = 0
		let usersCalls = 0
		const gateway = createGateway({
			AUTH: {
				async fetch() {
					authCalls += 1
					return new Response('auth')
				}
			},
			USERS: {
				async fetch() {
					usersCalls += 1
					throw new Error('transport failed')
				}
			}
		})

		expect(await (await gateway.fetch(new Request('http://web.test/api/healthz'))).text()).toBe(
			'ok'
		)
		expect((await gateway.fetch(new Request('http://web.test/api/unknown'))).status).toBe(404)
		expect(
			(await createGateway({}).fetch(new Request('http://web.test/api/auth/session'))).status
		).toBe(503)
		expect((await gateway.fetch(new Request('http://web.test/api/auth/session'))).status).toBe(200)
		expect((await gateway.fetch(new Request('http://web.test/api/v1/users/me'))).status).toBe(502)
		expect(authCalls).toBe(1)
		expect(usersCalls).toBe(1)
	})

	test('one root command starts the gateway and loopback-only services', () => {
		const entries = planFixture('hono-skip-deploy')
		const rootPackage = entries.find((entry) => entry.path === 'package.json')
		const gatewayIndex = entries.find((entry) => entry.path === 'apps/api/src/index.ts')
		const authIndex = entries.find((entry) => entry.path === 'services/auth/src/index.ts')
		const usersIndex = entries.find((entry) => entry.path === 'services/users/src/index.ts')
		const usersPackage = entries.find((entry) => entry.path === 'services/users/package.json')

		expect(JSON.parse(rootPackage!.content).scripts.dev).toBe('turbo run dev')
		expect(gatewayIndex?.content).toContain("process.env.HOST ?? '127.0.0.1'")
		expect(gatewayIndex?.content).toContain('process.env.PORT ?? 8786')
		expect(gatewayIndex?.content).toContain("redirect: 'manual'")
		expect(authIndex?.content).toContain("process.env.HOST ?? '127.0.0.1'")
		expect(usersIndex?.content).toContain("process.env.HOST ?? '127.0.0.1'")
		expect(usersIndex?.content).toContain(
			"const authUrl = process.env.AUTH_URL ?? 'http://127.0.0.1:8787'"
		)
		expect(usersIndex?.content).toContain('return app.fetch(request, { AUTH_URL: authUrl })')
		expect(usersPackage?.content).toContain('@hono/node-server')
	})

	test('browser examples use the same-origin alias and SSR uses a private gateway transport', () => {
		const entries = planFixture('hono-skip-deploy')
		const vite = entries.find((entry) => entry.path === 'apps/web/vite.config.ts')
		const layout = entries.find((entry) => entry.path === 'apps/web/src/routes/+layout.ts')
		const hooks = entries.find((entry) => entry.path === 'apps/web/src/hooks.server.ts')

		expect(vite?.content).toContain("'/api': { target: 'http://127.0.0.1:8786' }")
		expect(layout?.content).toContain("baseUrl: ''")
		expect(layout?.content).not.toContain('PUBLIC_USERS_URL')
		expect(hooks?.content).toContain('export const handleFetch')
		expect(hooks?.content).toContain('env.GATEWAY_URL')
		expect(hooks?.content).toContain('new Request(upstream, request)')
	})

	test('SSR sends only same-origin API requests through the private gateway', async () => {
		const { handleFetch } = await loadGeneratedHandleFetch()
		const gatewayRequests: Request[] = []
		const passthroughRequests: Request[] = []
		const event = {
			url: new URL('https://app.example/account'),
			platform: {
				env: {
					GATEWAY: {
						async fetch(request: Request) {
							gatewayRequests.push(request)
							return new Response('gateway')
						}
					}
				}
			}
		}
		const passthrough = async (request: Request) => {
			passthroughRequests.push(request)
			return new Response('passthrough')
		}
		const exactApiRequest = new Request('https://app.example/api')
		const sameOriginApiRequest = new Request('https://app.example/api/v1/users/me')
		const externalApiRequest = new Request('https://third-party.example/api/data')
		const outsideApiRequest = new Request('https://app.example/apiary')

		expect(
			await (await handleFetch({ event, request: exactApiRequest, fetch: passthrough })).text()
		).toBe('gateway')
		expect(
			await (await handleFetch({ event, request: sameOriginApiRequest, fetch: passthrough })).text()
		).toBe('gateway')
		expect(
			await (await handleFetch({ event, request: externalApiRequest, fetch: passthrough })).text()
		).toBe('passthrough')
		expect(
			await (await handleFetch({ event, request: outsideApiRequest, fetch: passthrough })).text()
		).toBe('passthrough')
		expect(gatewayRequests).toEqual([exactApiRequest, sameOriginApiRequest])
		expect(passthroughRequests).toEqual([externalApiRequest, outsideApiRequest])
	})

	test('the workspace and root tooling discover the gateway and private services', () => {
		const entries = planFixture('hono-skip-deploy')
		const workspace = entries.find((entry) => entry.path === 'pnpm-workspace.yaml')
		const tsconfig = entries.find((entry) => entry.path === 'tsconfig.json')

		expect(workspace?.content).toContain("- 'apps/*'")
		expect(workspace?.content).toContain("- 'services/*'")
		expect(workspace?.content).not.toContain("- 'apps/api/*'")
		expect(tsconfig?.content).toContain('"services/**/*"')
	})

	test('generated Hono documentation contracts one public gateway topology', () => {
		for (const fixture of ['hono-skip-deploy', 'hono-docker-full', 'hono-cf-workers-full']) {
			const entries = planFixture(fixture)
			const rootReadme = entries.find((entry) => entry.path === 'README.md')?.content ?? ''
			const gatewayReadme = entries.find((entry) => entry.path === 'apps/api/README.md')?.content ?? ''
			const authReadme = entries.find((entry) => entry.path === 'services/auth/README.md')?.content ?? ''
			const usersReadme = entries.find((entry) => entry.path === 'services/users/README.md')?.content ?? ''

			expect(rootReadme).toContain('## API topology')
			expect(rootReadme).toContain('web origin\'s `/api/*` alias')
			expect(rootReadme).toContain('canonical API origin')
			expect(rootReadme).toContain('`/api/auth/*`')
			expect(rootReadme).toContain('`/api/v1/*`')
			expect(rootReadme).toContain('`/api/openapi.json`')
			expect(rootReadme).toContain('request-scoped SSR transport')
			expect(gatewayReadme).toContain('must not import or mount service applications')
			expect(authReadme).toContain('private service')
			expect(authReadme).toContain('reachable externally only through the gateway')
			expect(usersReadme).toContain('private service')
			expect(usersReadme).toContain('composition input owned by this service')
			expect(usersReadme).not.toContain('| `GET /openapi.json` | public |')
		}
	})

	test('generated Hono plans contain no direct-service compatibility output', () => {
		for (const fixture of ['hono-skip-deploy', 'hono-docker-full', 'hono-cf-workers-full']) {
			const entries = planFixture(fixture)
			const paths = entries.map((entry) => entry.path)
			const output = entries.map((entry) => entry.content).join('\n')

			expect(paths.some((path) => /^apps\/api\/(?:auth|users)(?:\/|$)/.test(path))).toBe(false)
			expect(paths.some((path) => path.includes('/routes/api/auth/'))).toBe(false)
			expect(output).not.toMatch(/^PUBLIC_(?:API|AUTH|USERS)_URL=/m)
			expect(output).not.toContain('@repo/openapi-client/users')
			expect(output).not.toContain('apps/api/auth')
			expect(output).not.toContain('apps/api/users')
		}
	})

	test('environment examples separate ingress, private transports, and allowlists', () => {
		const entries = planFixture('hono-docker-full')
		const env = entries.find((entry) => entry.path === '.env.example')?.content ?? ''

		expect(env).toContain('# Canonical API origin advertised by the gateway OpenAPI endpoint')
		expect(env).toContain('# Browser API alias: http://localhost:3000/api/*')
		expect(env).toContain('# Private gateway and service targets')
		expect(env).toContain('GATEWAY_URL=http://127.0.0.1:8786')
		expect(env).toContain('AUTH_URL=http://127.0.0.1:8787')
		expect(env).toContain('USERS_URL=http://127.0.0.1:8788')
		expect(env).toContain('BETTER_AUTH_ALLOWED_HOSTS=')
		expect(env).toContain('AUTH_CORS_ORIGINS=')
	})

	test('release artifacts document the breaking generated-output migration', () => {
		const migration = readFileSync(
			join(fixturesDir, '..', 'docs/migrations/hono-api-gateway.md'),
			'utf8'
		)
		const changeset = readFileSync(
			join(fixturesDir, '..', '.changeset/contract-hono-gateway.md'),
			'utf8'
		)

		for (const section of [
			'## Layout',
			'## Routes',
			'## Environment',
			'## Client imports',
			'## Deployment',
			'## Cookies and CORS',
			'## OpenAPI'
		]) {
			expect(migration).toContain(section)
		}
		expect(migration).toContain('No automatic migration is provided')
		expect(changeset).toContain('"gv-kit": major')
		expect(changeset).toContain('Hono gateway')
	})
})
