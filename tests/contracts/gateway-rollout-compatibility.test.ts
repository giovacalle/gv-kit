import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { runGenerators } from '../../src/generators/index.js'
import { parseJsonc } from '../../src/lib/jsonc.js'
import { GvKitConfig } from '../../src/schema/config.js'

const fixturesDir = join(import.meta.dir, '..', '..', 'fixtures')
const previousContractPath = join(import.meta.dir, 'fixtures', 'gateway-rollout-v1.json')
const previousContractSource = readFileSync(previousContractPath, 'utf8')

type TargetName = 'AUTH' | 'USERS'
type HeaderEntries = Array<[string, string]>
type RequestFixture = {
	name?: string
	target?: TargetName
	method: string
	path?: string
	url?: string
	headers: Record<string, string>
	body?: string
}
type PublicRequestFixture = RequestFixture & { name: string; path: string }
type ResponseFixture = {
	status: number
	statusText?: string
	headers: HeaderEntries
	chunks?: string[]
	body?: unknown
}
type PreviousContract = {
	fixtureVersion: string
	webOrigin: string
	apiOrigin: string
	publicRequests: PublicRequestFixture[]
	oldServiceResponses: Record<TargetName, ResponseFixture>
	oldGatewayRequests: { auth: RequestFixture; users: RequestFixture }
	oldAuthSessionResponse: ResponseFixture
	currentServiceDependencies: { usersMe: Record<string, unknown> }
	currentServiceResponses: Record<TargetName, ResponseFixture>
}
type GatewayTarget = { fetch(request: Request): Promise<Response> }
type GatewayModule = {
	createGateway(
		targets: Partial<Record<TargetName, GatewayTarget>>,
		options: {
			openApiDocument: {
				openapi: string
				info: Record<string, unknown>
				paths: Record<string, unknown>
			}
			canonicalApiOrigin: string
			publicOrigins: string
			logger?: (line: string) => void
		}
	): { fetch(request: Request): Promise<Response> }
}
type ServiceModule = {
	default?: { fetch(request: Request, env?: Record<string, unknown>): Promise<Response> }
	app?: { fetch(request: Request, env?: Record<string, unknown>): Promise<Response> }
}

function deepFreeze<T>(value: T): Readonly<T> {
	if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value
	for (const nested of Object.values(value)) deepFreeze(nested)
	return Object.freeze(value)
}

const previousContract = deepFreeze(JSON.parse(previousContractSource) as PreviousContract)

function planCurrentFixture() {
	const raw = parseJsonc(readFileSync(join(fixturesDir, 'hono-skip-auth-emailotp.jsonc'), 'utf8'))
	return runGenerators(GvKitConfig.parse(raw))
}

const currentEntries = planCurrentFixture()

function currentSource(path: string): string {
	const entry = currentEntries.find((candidate) => candidate.path === path)
	if (!entry) throw new Error(`current generated source is missing: ${path}`)
	return entry.content
}

function javascriptModuleUrl(source: string): string {
	const transpiler = new Bun.Transpiler({ loader: 'ts', target: 'bun' })
	const javascript = transpiler.transformSync(source)
	return URL.createObjectURL(new Blob([javascript], { type: 'text/javascript' }))
}

function replaceImport({ source, from, to }: { source: string; from: string; to: string }): string {
	if (!source.includes(from)) throw new Error(`generated import is missing: ${from}`)
	return source.replace(from, to)
}

function currentLoggerModuleUrl(): string {
	const source = currentSource('packages/backend/src/middleware/logger.ts').replace(
		'(line) => console.log(line)',
		'() => undefined'
	)
	return javascriptModuleUrl(source)
}

function openApiCompatModuleUrl(): string {
	const honoUrl = import.meta.resolve('hono')
	return javascriptModuleUrl(`import { Hono } from '${honoUrl}'

export function createRoute(route) {
	return route
}

export class OpenAPIHono extends Hono {
	openapi(route, handler) {
		return this.on(route.method, route.path, handler)
	}

	doc(path, document) {
		return this.get(path, (context) => context.json(document))
	}
}
`)
}

async function loadCurrentGateway(): Promise<GatewayModule> {
	const honoUrl = import.meta.resolve('hono')
	const source = currentSource('apps/api/src/app.ts').replace("from 'hono'", `from '${honoUrl}'`)
	return (await import(javascriptModuleUrl(source))) as GatewayModule
}

async function loadCurrentWebAlias(gateway: GatewayTarget) {
	const pluginStubUrl = javascriptModuleUrl(`export function paraglideVitePlugin() { return {} }
export function sveltekit() { return {} }
export default function tailwindcss() { return {} }
`)
	const viteStubUrl = javascriptModuleUrl('export function defineConfig(config) { return config }')
	let source = currentSource('apps/web/vite.config.ts')
	const pluginDependencies = ['@inlang/paraglide-js', '@sveltejs/kit/vite', '@tailwindcss/vite']
	for (const dependency of pluginDependencies) source = source.replace(dependency, pluginStubUrl)
	source = source.replace("from 'vite'", `from '${viteStubUrl}'`)
	const module = (await import(javascriptModuleUrl(source))) as {
		default: {
			server?: {
				proxy?: Record<string, string | { target: string }>
			}
		}
	}
	const proxy = module.default.server?.proxy ?? {}
	const routedTargets: string[] = []

	return {
		routedTargets,
		async fetch(request: Request): Promise<Response> {
			const pathname = new URL(request.url).pathname
			const route = Object.entries(proxy).find(([pattern]) => new RegExp(pattern).test(pathname))
			if (!route) return new Response('web route not found', { status: 404 })
			const target = typeof route[1] === 'string' ? route[1] : route[1].target
			routedTargets.push(target)
			const unavailable = new Response('web alias target unavailable', { status: 502 })
			if (target !== 'http://127.0.0.1:8786') return unavailable
			return gateway.fetch(new Request(request))
		}
	}
}

async function loadCurrentAuthService(): Promise<ServiceModule> {
	const loggerUrl = currentLoggerModuleUrl()
	const dbStubUrl = javascriptModuleUrl('export function createDb() { return {} }')
	const mailerStubUrl = javascriptModuleUrl(
		'export function createMailer() { return { sendTemplate: async () => undefined } }'
	)
	const utilsUrl = javascriptModuleUrl(currentSource('services/auth/src/lib/utils.ts'))
	let authSource = currentSource('services/auth/src/auth.ts')
	authSource = replaceImport({
		source: authSource,
		from: "import { betterAuth } from 'better-auth'",
		to: `import { betterAuth } from '${import.meta.resolve('better-auth')}'`
	})
	authSource = replaceImport({
		source: authSource,
		from: "import { drizzleAdapter } from 'better-auth/adapters/drizzle'",
		to: `import { memoryAdapter } from '${import.meta.resolve('better-auth/adapters/memory')}'`
	})
	authSource = replaceImport({
		source: authSource,
		from: "import { captcha, emailOTP } from 'better-auth/plugins'",
		to: `import { captcha, emailOTP } from '${import.meta.resolve('better-auth/plugins')}'`
	})
	authSource = replaceImport({
		source: authSource,
		from: "import { createDb } from '@repo/db/client'",
		to: `import { createDb } from '${dbStubUrl}'`
	})
	authSource = replaceImport({
		source: authSource,
		from: "import { createMailer, type Locale } from '@repo/mailer'",
		to: `import { createMailer } from '${mailerStubUrl}'`
	})
	authSource = replaceImport({
		source: authSource,
		from: "import { parseAllowedHosts, pickLocale } from './lib/utils.js'",
		to: `import { parseAllowedHosts, pickLocale } from '${utilsUrl}'`
	})
	authSource = authSource.replace(
		"database: drizzleAdapter(db, { provider: 'sqlite' }),",
		'database: memoryAdapter({}),'
	)
	const previousEnvironment = {
		allowedHosts: process.env.BETTER_AUTH_ALLOWED_HOSTS,
		secret: process.env.BETTER_AUTH_SECRET,
		turnstile: process.env.TURNSTILE_SECRET_KEY
	}
	process.env.BETTER_AUTH_ALLOWED_HOSTS = 'app.previous.example.test'
	process.env.BETTER_AUTH_SECRET = 'previous-contract-secret-at-least-32-characters'
	process.env.TURNSTILE_SECRET_KEY = '1x0000000000000000000000000000000AA'
	let authUrl: string
	try {
		authUrl = javascriptModuleUrl(authSource)
		await import(authUrl)
	} finally {
		if (previousEnvironment.allowedHosts === undefined) delete process.env.BETTER_AUTH_ALLOWED_HOSTS
		else process.env.BETTER_AUTH_ALLOWED_HOSTS = previousEnvironment.allowedHosts
		if (previousEnvironment.secret === undefined) delete process.env.BETTER_AUTH_SECRET
		else process.env.BETTER_AUTH_SECRET = previousEnvironment.secret
		if (previousEnvironment.turnstile === undefined) delete process.env.TURNSTILE_SECRET_KEY
		else process.env.TURNSTILE_SECRET_KEY = previousEnvironment.turnstile
	}
	const openApiStubUrl = javascriptModuleUrl(`export const sessionRoute = {
	method: 'get',
	path: '/internal/session'
}
export function mountOpenApi() {}
`)
	let source = currentSource('services/auth/src/app.ts')
	source = replaceImport({
		source,
		from: "import { OpenAPIHono } from '@hono/zod-openapi'",
		to: `import { OpenAPIHono } from '${openApiCompatModuleUrl()}'`
	})
	source = replaceImport({
		source,
		from: "import { logger } from '@repo/backend/middleware'",
		to: `import { logger } from '${loggerUrl}'`
	})
	source = replaceImport({
		source,
		from: "import { cors } from 'hono/cors'",
		to: `import { cors } from '${import.meta.resolve('hono/cors')}'`
	})
	source = replaceImport({
		source,
		from: "import { auth } from './auth.js'",
		to: `import { auth } from '${authUrl}'`
	})
	source = replaceImport({
		source,
		from: "import { resolveCorsOrigin } from './lib/utils.js'",
		to: `import { resolveCorsOrigin } from '${utilsUrl}'`
	})
	source = replaceImport({
		source,
		from: "import { mountOpenApi, sessionRoute } from './openapi.js'",
		to: `import { mountOpenApi, sessionRoute } from '${openApiStubUrl}'`
	})
	return (await import(javascriptModuleUrl(source))) as ServiceModule
}

async function loadCurrentUsersService(): Promise<{
	module: ServiceModule
	requestedUserIds: string[]
}> {
	const loggerUrl = currentLoggerModuleUrl()
	const helperUrl = javascriptModuleUrl('export class HttpError extends Error {}')
	let errorHandlerSource = currentSource('packages/backend/src/middleware/error-handler.ts')
	errorHandlerSource = replaceImport({
		source: errorHandlerSource,
		from: "import { HttpError } from '../helpers/index.js'",
		to: `import { HttpError } from '${helperUrl}'`
	})
	const errorHandlerUrl = javascriptModuleUrl(errorHandlerSource)
	const middlewareUrl = javascriptModuleUrl(`export { logger } from '${loggerUrl}'
export { errorHandler } from '${errorHandlerUrl}'
`)
	const authClientUrl = javascriptModuleUrl(
		currentSource('packages/backend/src/middleware/auth/client.ts')
	)
	let requireAuthSource = currentSource('packages/backend/src/middleware/auth/require.ts')
	requireAuthSource = replaceImport({
		source: requireAuthSource,
		from: "import { getSession, type SessionLike } from './client.js'",
		to: `import { getSession } from '${authClientUrl}'`
	})
	const requireAuthUrl = javascriptModuleUrl(requireAuthSource)
	const authMiddlewareUrl = javascriptModuleUrl(`export { requireAuth } from '${requireAuthUrl}'`)
	const usersUseCaseUrl = javascriptModuleUrl(`export const requestedUserIds = []
export async function getMeUseCase(_db, userId) {
	requestedUserIds.push(userId)
	return ${JSON.stringify(previousContract.currentServiceDependencies.usersMe)}
}
`)
	const usersUseCase = (await import(usersUseCaseUrl)) as { requestedUserIds: string[] }
	const dbUrl = javascriptModuleUrl('export function createDb() { return {} }')
	let handlerSource = currentSource('services/users/src/routes/me/handler.ts')
	handlerSource = replaceImport({
		source: handlerSource,
		from: "import { getMeUseCase } from '@repo/backend/core/use-cases/users'",
		to: `import { getMeUseCase } from '${usersUseCaseUrl}'`
	})
	handlerSource = replaceImport({
		source: handlerSource,
		from: "import { createDb } from '@repo/db/client'",
		to: `import { createDb } from '${dbUrl}'`
	})
	const handlerUrl = javascriptModuleUrl(handlerSource)
	const schemaUrl = javascriptModuleUrl('export const UserResponse = {}')
	let routeSource = currentSource('services/users/src/routes/me/route.ts')
	routeSource = replaceImport({
		source: routeSource,
		from: "import { createRoute } from '@hono/zod-openapi'",
		to: `import { createRoute } from '${openApiCompatModuleUrl()}'`
	})
	routeSource = replaceImport({
		source: routeSource,
		from: "import { UserResponse } from './schema.js'",
		to: `import { UserResponse } from '${schemaUrl}'`
	})
	const routeUrl = javascriptModuleUrl(routeSource)
	let routerSource = currentSource('services/users/src/routes/me/index.ts')
	routerSource = replaceImport({
		source: routerSource,
		from: "import { OpenAPIHono } from '@hono/zod-openapi'",
		to: `import { OpenAPIHono } from '${openApiCompatModuleUrl()}'`
	})
	routerSource = replaceImport({
		source: routerSource,
		from: "import { meHandler } from './handler.js'",
		to: `import { meHandler } from '${handlerUrl}'`
	})
	routerSource = replaceImport({
		source: routerSource,
		from: "import { meRoute } from './route.js'",
		to: `import { meRoute } from '${routeUrl}'`
	})
	const routerUrl = javascriptModuleUrl(routerSource)
	const openApiStubUrl = javascriptModuleUrl('export function mountOpenApi() {}')
	let source = currentSource('services/users/src/app.ts')
	source = replaceImport({
		source,
		from: "import { OpenAPIHono } from '@hono/zod-openapi'",
		to: `import { OpenAPIHono } from '${openApiCompatModuleUrl()}'`
	})
	source = replaceImport({
		source,
		from: "import { errorHandler, logger } from '@repo/backend/middleware'",
		to: `import { errorHandler, logger } from '${middlewareUrl}'`
	})
	source = replaceImport({
		source,
		from: "import { requireAuth, type SessionLike } from '@repo/backend/middleware/auth'",
		to: `import { requireAuth } from '${authMiddlewareUrl}'`
	})
	source = replaceImport({
		source,
		from: "import { mountOpenApi } from './openapi.js'",
		to: `import { mountOpenApi } from '${openApiStubUrl}'`
	})
	source = replaceImport({
		source,
		from: "import { meRouter } from './routes/me/index.js'",
		to: `import { meRouter } from '${routerUrl}'`
	})
	return {
		module: (await import(javascriptModuleUrl(source))) as ServiceModule,
		requestedUserIds: usersUseCase.requestedUserIds
	}
}

function publicRequest(name: string): PublicRequestFixture {
	const fixture = previousContract.publicRequests.find((candidate) => candidate.name === name)
	if (!fixture) throw new Error(`previous public request is missing: ${name}`)
	return fixture
}

function requestFromFixture({
	fixture,
	origin
}: {
	fixture: RequestFixture
	origin?: string
}): Request {
	const url = fixture.url ?? `${origin}${fixture.path}`
	return new Request(url, {
		method: fixture.method,
		headers: fixture.headers,
		body: fixture.body
	})
}

function immediateResponse(fixture: ResponseFixture): Response {
	return new Response(fixture.chunks?.join('') ?? JSON.stringify(fixture.body), {
		status: fixture.status,
		...(fixture.statusText ? { statusText: fixture.statusText } : {}),
		headers: fixture.headers
	})
}

function selectedHeaders(response: Response, fixture: ResponseFixture): HeaderEntries {
	return fixture.headers.map(([name]) => [name, response.headers.get(name) ?? ''])
}

describe('adjacent-version gateway rollout compatibility', () => {
	test('the previous HTTP contract is frozen independently of current generator output', () => {
		const digest = createHash('sha256').update(previousContractSource).digest('hex')

		expect(digest).toBe('e01be86c7742b6773c3a81100385454432470f6a498616d4e2de0ab8dfbe4d11')
		expect(previousContract.fixtureVersion).toBe('gateway-http-contract-v1')
		expect(Object.isFrozen(previousContract)).toBe(true)
		expect(Object.isFrozen(previousContract.publicRequests)).toBe(true)
		expect(previousContractSource).not.toMatch(/runGenerators|src\/generators|__snapshots__/)
	})

	test('previous web requests cross the current web alias and gateway contract', async () => {
		const { createGateway } = await loadCurrentGateway()
		const forwarded: Partial<Record<TargetName, Request[]>> = {}
		let releaseUsersResponse: () => void = () => undefined
		const usersResponseReleased = new Promise<void>((resolve) => {
			releaseUsersResponse = resolve
		})
		const targets: Record<TargetName, GatewayTarget> = {
			AUTH: {
				async fetch(request) {
					forwarded.AUTH = [...(forwarded.AUTH ?? []), request]
					return immediateResponse(previousContract.oldServiceResponses.AUTH)
				}
			},
			USERS: {
				async fetch(request) {
					forwarded.USERS = [...(forwarded.USERS ?? []), request]
					const fixture = previousContract.oldServiceResponses.USERS
					const body = new ReadableStream<Uint8Array>({
						start(controller) {
							controller.enqueue(new TextEncoder().encode(fixture.chunks![0]))
							void usersResponseReleased.then(() => {
								controller.enqueue(new TextEncoder().encode(fixture.chunks![1]))
								controller.close()
							})
						}
					})
					return new Response(body, {
						status: fixture.status,
						...(fixture.statusText ? { statusText: fixture.statusText } : {}),
						headers: fixture.headers
					})
				}
			}
		}
		const gateway = createGateway(targets, {
			openApiDocument: {
				openapi: '3.0.0',
				info: { title: 'Current API' },
				paths: { '/api/v1/users/me': {} }
			},
			canonicalApiOrigin: previousContract.apiOrigin,
			publicOrigins: `${previousContract.webOrigin},${previousContract.apiOrigin}`,
			logger: () => undefined
		})
		const webAlias = await loadCurrentWebAlias(gateway)
		const authFixture = publicRequest('auth')
		const auth = await webAlias.fetch(
			requestFromFixture({ fixture: authFixture, origin: previousContract.webOrigin })
		)
		const usersFixture = publicRequest('users')
		const users = await webAlias.fetch(
			requestFromFixture({ fixture: usersFixture, origin: previousContract.webOrigin })
		)
		const health = await webAlias.fetch(
			requestFromFixture({
				fixture: publicRequest('health'),
				origin: previousContract.webOrigin
			})
		)
		const openApi = await webAlias.fetch(
			requestFromFixture({
				fixture: publicRequest('openapi'),
				origin: previousContract.webOrigin
			})
		)

		expect(auth.status).toBe(307)
		expect(auth.statusText).toBe('Temporary Redirect')
		expect(auth.headers.get('location')).toBe('/api/auth/verify-email')
		expect(auth.headers.getSetCookie()).toEqual([
			'session=next-auth-session; Path=/; HttpOnly; SameSite=Lax'
		])
		expect(auth.headers.get('x-auth-contract')).toBe('previous')
		expect(auth.headers.get('x-request-id')).toBe('previous-web-auth')
		expect(await auth.text()).toBe('auth-redirect')
		expect(users.status).toBe(206)
		expect(users.statusText).toBe('Partial Content')
		expect(users.headers.get('etag')).toBe('previous-users-response')
		expect(users.headers.get('x-users-contract')).toBe('previous')
		expect(users.headers.get('x-request-id')).toBe('previous-web-users')
		const usersReader = users.body!.getReader()
		const firstChunk = await usersReader.read()
		expect(new TextDecoder().decode(firstChunk.value)).toBe(
			previousContract.oldServiceResponses.USERS.chunks![0]!
		)
		releaseUsersResponse()
		const secondChunk = await usersReader.read()
		expect(new TextDecoder().decode(secondChunk.value)).toBe(
			previousContract.oldServiceResponses.USERS.chunks![1]!
		)
		expect((await usersReader.read()).done).toBe(true)
		expect(health.status).toBe(200)
		expect(await health.text()).toBe('ok')
		expect(health.headers.get('x-request-id')).toBe('previous-web-health')
		expect(openApi.status).toBe(200)
		expect(openApi.headers.get('x-request-id')).toBe('previous-web-openapi')
		expect(await openApi.json()).toEqual({
			openapi: '3.0.0',
			info: { title: 'Current API' },
			paths: { '/api/v1/users/me': {} },
			servers: [{ url: previousContract.apiOrigin }]
		})

		const forwardedAuth = forwarded.AUTH![0]!
		expect(forwardedAuth.method).toBe(authFixture.method)
		expect(new URL(forwardedAuth.url).pathname).toBe('/api/auth/sign-in/email-otp')
		expect(forwardedAuth.headers.get('cookie')).toBe('session=previous-web-session')
		expect(forwardedAuth.headers.get('x-forwarded-host')).toBe('app.previous.example.test')
		expect(forwardedAuth.headers.get('x-forwarded-proto')).toBe('https')
		expect(await forwardedAuth.text()).toBe(authFixture.body!)
		const forwardedUsers = forwarded.USERS![0]!
		expect(forwardedUsers.method).toBe(usersFixture.method)
		expect(new URL(forwardedUsers.url).pathname).toBe('/api/v1/users/me')
		expect(new URL(forwardedUsers.url).search).toBe('?include=session')
		expect(forwardedUsers.headers.get('cookie')).toBe('session=previous-web-session')
		expect(forwardedUsers.headers.get('x-forwarded-host')).toBe('app.previous.example.test')
		expect(forwardedUsers.headers.get('x-forwarded-proto')).toBe('https')
		expect(webAlias.routedTargets).toEqual(
			previousContract.publicRequests.map(() => 'http://127.0.0.1:8786')
		)
	})

	test('previous gateway metadata and HTTP semantics remain valid for current services', async () => {
		const authModule = await loadCurrentAuthService()
		const authApp = authModule.default
		if (!authApp) throw new Error('current auth service app is missing')
		const authFixture = previousContract.oldGatewayRequests.auth
		const auth = await authApp.fetch(requestFromFixture({ fixture: authFixture }))
		const expectedAuth = previousContract.currentServiceResponses.AUTH

		expect(auth.status).toBe(expectedAuth.status)
		expect(selectedHeaders(auth, expectedAuth)).toEqual(expectedAuth.headers)
		expect(await auth.json()).toEqual(expectedAuth.body)

		const currentUsers = await loadCurrentUsersService()
		const usersApp = currentUsers.module.app
		if (!usersApp) throw new Error('current users service app is missing')
		let sessionRequest: Request | undefined
		const usersFixture = previousContract.oldGatewayRequests.users
		const users = await usersApp.fetch(requestFromFixture({ fixture: usersFixture }), {
			AUTH: {
				async fetch(request: Request) {
					sessionRequest = request
					return immediateResponse(previousContract.oldAuthSessionResponse)
				}
			}
		})
		const expectedUsers = previousContract.currentServiceResponses.USERS

		expect(users.status).toBe(expectedUsers.status)
		expect(selectedHeaders(users, expectedUsers)).toEqual(expectedUsers.headers)
		expect(await users.json()).toEqual(expectedUsers.body)
		expect(currentUsers.requestedUserIds).toEqual(['previous-user'])
		expect(sessionRequest).toBeDefined()
		expect(sessionRequest!.method).toBe('GET')
		expect(new URL(sessionRequest!.url).pathname).toBe('/internal/session')
		expect(sessionRequest!.headers.get('cookie')).toBe('session=previous-gateway-session')
		expect(sessionRequest!.headers.get('x-forwarded-host')).toBe('app.previous.example.test')
		expect(sessionRequest!.headers.get('x-forwarded-proto')).toBe('https')
		expect(sessionRequest!.headers.get('x-request-id')).toBe('previous-gateway-users')
	})

	test('generated guidance distinguishes additive changes from coordinated rollout', () => {
		const gatewayReadme = currentSource('apps/api/README.md')
		const guidance = gatewayReadme.replace(/\s+/g, ' ')

		expect(guidance).toContain('## Adjacent-version rollout')
		expect(guidance).toContain('Add fields, headers, and new `/api/v1` routes before using them')
		expect(guidance).toContain('accept both the previous and new request shape')
		expect(guidance).toContain('require a coordinated rollout')
		expect(guidance).toContain('path or method')
		expect(guidance).toContain('status or body semantics')
		expect(guidance).toContain('forwarded host or protocol, request IDs, or auth cookies')
	})
})
