import type { FileEntry } from '../lib/files.js'
import { HONO_WORKERS_COMPAT_DATE } from '../lib/workers.js'
import type { GvKitConfig } from '../schema/config.js'
import {
	CLOUDFLARE_TYPEGEN_SCRIPT,
	CLOUDFLARE_TYPES_BOOTSTRAP_FILE,
	renderCloudflareBootstrapTypes
} from './cloudflare-worker-types.js'
import {
	AUTH_SERVICE,
	HONO_GATEWAY,
	honoPackageIdentity,
	honoServiceName,
	USERS_SERVICE
} from './hono-topology.js'
import {
	composeGatewayOpenApi,
	createUsersOpenApiFragment,
	stringifyOpenApi
} from './openapi-contract.js'

const API_CORS_ORIGINS = 'API_CORS_ORIGINS'
const API_PUBLIC_ORIGIN = 'API_PUBLIC_ORIGIN'
const GATEWAY_PUBLIC_ORIGINS = 'GATEWAY_PUBLIC_ORIGINS'
const GATEWAY_TRUSTED_INGRESS_SECRET = 'GATEWAY_TRUSTED_INGRESS_SECRET'
const GATEWAY_UPSTREAM_TIMEOUT_MS = 'GATEWAY_UPSTREAM_TIMEOUT_MS'

type Runtime = 'cf-workers' | 'node'

function deriveRuntime(deploy: GvKitConfig['choices']['deploy']): Runtime {
	return deploy === 'cf-workers' ? 'cf-workers' : 'node'
}

export function generateGateway(cfg: GvKitConfig): FileEntry[] {
	const project = cfg.choices.name
	const runtime = deriveRuntime(cfg.choices.deploy)
	const checkedOpenApi = composeGatewayOpenApi({
		title: `${project} API`,
		version: '0.0.0',
		fragments: [createUsersOpenApiFragment({ project, hasAuth: cfg.choices.auth.length > 0 })]
	})
	const entries: FileEntry[] = [
		{ path: 'apps/api/package.json', content: packageJson({ project, runtime }) },
		{ path: 'apps/api/tsconfig.json', content: tsconfig(runtime) },
		{ path: 'apps/api/openapi.json', content: stringifyOpenApi(checkedOpenApi) },
		{
			path: 'apps/api/scripts/compose-openapi.ts',
			content: composeOpenApiTs(project, runtime)
		},
		{ path: 'apps/api/src/app.ts', content: appTs() },
		{
			path: 'apps/api/src/index.ts',
			content: indexTs({ runtime, streamsChunkedIngress: cfg.choices.deploy === 'docker' })
		},
		{ path: 'apps/api/README.md', content: readme() }
	]

	if (runtime === 'cf-workers') {
		const webHost = cfg.choices.marketing === 'astro' ? 'app.<domain>' : '<domain>'
		const wrangler = wranglerJsonc(project, webHost)
		entries.push(
			{ path: 'apps/api/wrangler.jsonc', content: wrangler },
			{
				path: `apps/api/${CLOUDFLARE_TYPES_BOOTSTRAP_FILE}`,
				content: renderCloudflareBootstrapTypes(wrangler)
			}
		)
	}

	return entries
}

function packageJson({ project, runtime }: { project: string; runtime: Runtime }): string {
	const dependencies: Record<string, string> = { hono: '^4.6.0' }
	const devDependencies: Record<string, string> = {
		'@repo/tooling-typescript': 'workspace:*',
		'@types/node': '^24.0.0',
		tsx: '^4.19.0',
		typescript: '~5.9.0'
	}
	const scripts: Record<string, string> = {
		'openapi:compose': 'tsx scripts/compose-openapi.ts',
		'openapi:check': 'tsx scripts/compose-openapi.ts --check',
		typecheck: 'tsc --noEmit',
		lint: 'eslint .'
	}

	if (runtime === 'cf-workers') {
		devDependencies.wrangler = '^4.125.0'
		devDependencies['@cloudflare/workers-types'] = '^5.20260825.1'
		scripts['cf-typegen'] = CLOUDFLARE_TYPEGEN_SCRIPT
		scripts.dev = 'pnpm cf-typegen && wrangler dev'
		scripts.build = 'wrangler deploy --dry-run --outdir=dist'
		scripts.deploy = 'pnpm cf-typegen && wrangler deploy'
		scripts['deploy:production'] = 'pnpm cf-typegen && wrangler deploy'
		scripts['deploy:staging'] =
			'pnpm cf-typegen && test -n "$STAGING_ALIAS" && wrangler deploy --config "${STAGING_WRANGLER_CONFIG:-wrangler.jsonc}"'
		scripts.typecheck = 'tsc --noEmit'
	} else {
		dependencies['@hono/node-server'] = '^1.13.0'
		devDependencies.tsup = '^8.3.0'
		scripts.dev = 'tsx watch src/index.ts'
		scripts.build = 'tsup src/index.ts --format esm --target=node24 --out-dir dist'
		scripts.start = 'node dist/index.js'
	}

	return `${JSON.stringify(
		{
			name: honoPackageIdentity(project, HONO_GATEWAY),
			version: '0.0.0',
			private: true,
			type: 'module',
			main: 'src/index.ts',
			scripts,
			dependencies,
			devDependencies
		},
		null,
		2
	)}\n`
}

function tsconfig(runtime: Runtime): string {
	const base =
		runtime === 'cf-workers'
			? '@repo/tooling-typescript/workers.json'
			: '@repo/tooling-typescript/node.json'
	return `${JSON.stringify(
		{
			extends: base,
			compilerOptions: {
				noEmit: true,
				resolveJsonModule: true,
				...(runtime === 'cf-workers' ? { types: ['node', '@cloudflare/workers-types'] } : {})
			},
			include: ['src/**/*', 'scripts/**/*', '*.d.ts', 'openapi.json']
		},
		null,
		2
	)}\n`
}

function appTs(): string {
	return `import { Hono, type Context } from 'hono'

export type OpenApiDocument = {
	openapi: string
	info: Record<string, unknown>
	paths: Record<string, unknown>
	servers?: { url: string }[]
	[key: string]: unknown
}

export type GatewayTarget = {
	fetch(request: Request): Promise<Response>
}

export type GatewayTargets = {
	${AUTH_SERVICE.internalTarget}?: GatewayTarget
	${USERS_SERVICE.internalTarget}?: GatewayTarget
}

export type GatewayOptions = {
	openApiDocument: OpenApiDocument
	canonicalApiOrigin: string
	publicOrigins?: string
	trustedIngressSecret?: string
	corsOrigins?: string
	logger?: (line: string) => void
	upstreamTimeoutMs?: number
}

type PublicOrigin = { host: string; protocol: string }
type GatewayVariables = { publicOrigin: PublicOrigin; requestId: string }
type GatewayContext = Context<{ Variables: GatewayVariables }>
type PlatformResponse = Response & {
	readonly cf?: unknown
	readonly webSocket?: WebSocket | null
}
type PlatformResponseInit = ResponseInit & {
	cf?: unknown
	webSocket?: WebSocket | null
}

const DEFAULT_CORS_ORIGINS = ['http://localhost:3000', 'http://localhost:5173']
const DEFAULT_UPSTREAM_TIMEOUT_MS = 10_000
const MAX_UPSTREAM_TIMEOUT_MS = 300_000
const REQUEST_ID_HEADER = 'x-request-id'
const TRUSTED_INGRESS_HEADER = 'x-gateway-ingress-secret'
const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/

class UpstreamTimeoutError extends Error {}

const routes = [
	{ prefix: '${AUTH_SERVICE.publicPrefixes[0]}', target: '${AUTH_SERVICE.internalTarget}' },
	{ prefix: '${USERS_SERVICE.publicPrefixes[0]}', target: '${USERS_SERVICE.internalTarget}' }
] as const

function matchesPrefix(pathname: string, prefix: string): boolean {
	return pathname === prefix || pathname.startsWith(\`\${prefix}/\`)
}

function requestId(value: string | undefined): string {
	return value && REQUEST_ID_PATTERN.test(value) ? value : crypto.randomUUID()
}

function appendVary(headers: Headers, value: string): void {
	const values = (headers.get('vary') ?? '')
		.split(',')
		.map((entry) => entry.trim())
		.filter(Boolean)
	if (!values.some((entry) => entry.toLowerCase() === value.toLowerCase())) values.push(value)
	headers.set('vary', values.join(', '))
}

function gatewayResponse({
	response,
	requestId,
	origin,
	allowedCorsOrigins,
	preflight = false
}: {
	response: Response
	requestId: string
	origin: string | undefined
	allowedCorsOrigins: string[]
	preflight?: boolean
}): Response {
	const headers = new Headers(response.headers)
	const serviceCorsHeaders: string[] = []
	headers.forEach((_value, name) => {
		if (name.toLowerCase().startsWith('access-control-')) serviceCorsHeaders.push(name)
	})
	for (const name of serviceCorsHeaders) headers.delete(name)
	headers.set(REQUEST_ID_HEADER, requestId)
	appendVary(headers, 'Origin')
	if (origin && allowedCorsOrigins.includes(origin)) {
		headers.set('access-control-allow-origin', origin)
		headers.set('access-control-allow-credentials', 'true')
		headers.set('access-control-expose-headers', REQUEST_ID_HEADER)
		if (preflight) {
			headers.set('access-control-allow-methods', 'GET, HEAD, PUT, POST, DELETE, PATCH, OPTIONS')
			headers.set(
				'access-control-allow-headers',
				'content-type, x-locale, x-captcha-response, x-request-id'
			)
			headers.set('access-control-max-age', '600')
		}
	}
	const platformResponse = response as PlatformResponse
	const init: PlatformResponseInit = {
		status: response.status,
		statusText: response.statusText,
		headers,
		cf: platformResponse.cf,
		webSocket: platformResponse.webSocket
	}
	const result = new Response(response.body, init) as PlatformResponse
	if ('cf' in platformResponse && !('cf' in result)) Object.defineProperty(result, 'cf', { value: platformResponse.cf })
	if ('webSocket' in platformResponse && !('webSocket' in result)) Object.defineProperty(result, 'webSocket', { value: platformResponse.webSocket })
	return result
}

function corsAllowlist(value: string | undefined): string[] {
	const origins = (value ? value.split(',') : DEFAULT_CORS_ORIGINS)
		.map((origin) => origin.trim())
		.filter(Boolean)
	if (origins.includes('*')) throw new Error('corsOrigins must not contain a wildcard')
	const invalidOrigin = origins.find(
		(origin) => canonicalOrigin(origin, 'corsOrigins') !== origin
	)
	if (invalidOrigin) throw new Error('corsOrigins must contain only complete HTTP origins')
	return [...new Set(origins)]
}

function publicOriginAllowlist(value: string | undefined, canonicalApiOrigin: string) {
	const origins = (value ? value.split(',') : [canonicalApiOrigin])
		.map((origin) => origin.trim())
		.filter(Boolean)
	const allowed = new Map<string, PublicOrigin>()
	for (const origin of origins) {
		const url = new URL(canonicalOrigin(origin, 'publicOrigins'))
		const current = allowed.get(url.host)
		if (current && current.protocol !== url.protocol) throw new Error('publicOrigins must not assign multiple schemes to one host')
		allowed.set(url.host, { host: url.host, protocol: url.protocol.slice(0, -1) })
	}
	return allowed
}

function sameSecret(left: string | undefined, right: string | undefined): boolean {
	if (!left || !right) return false
	let difference = left.length ^ right.length
	const length = Math.max(left.length, right.length)
	for (let index = 0; index < length; index += 1) difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0)
	return difference === 0
}

function resolvePublicOrigin({
	request,
	allowed,
	trustedIngressSecret
}: {
	request: Request
	allowed: Map<string, PublicOrigin>
	trustedIngressSecret: string | undefined
}): PublicOrigin | undefined {
	const requestUrl = new URL(request.url)
	const direct = allowed.get(requestUrl.host)
	if (direct?.protocol === requestUrl.protocol.slice(0, -1)) return direct
	if (!sameSecret(request.headers.get(TRUSTED_INGRESS_HEADER) ?? undefined, trustedIngressSecret)) return undefined
	const host = request.headers.get('x-forwarded-host')?.toLowerCase()
	const protocol = request.headers.get('x-forwarded-proto')?.toLowerCase()
	const forwarded = host ? allowed.get(host) : undefined
	return forwarded?.protocol === protocol ? forwarded : undefined
}

function boundedTimeout(value: number | undefined): number {
	const timeout = value ?? DEFAULT_UPSTREAM_TIMEOUT_MS
	const invalid = !Number.isInteger(timeout) || timeout < 1 || timeout > MAX_UPSTREAM_TIMEOUT_MS
	if (invalid) throw new Error('upstreamTimeoutMs must be an integer between 1 and 300000')
	return timeout
}

async function fetchUpstream({
	target,
	request,
	requestId,
	publicOrigin,
	timeoutMs
}: {
	target: GatewayTarget
	request: Request
	requestId: string
	publicOrigin: PublicOrigin
	timeoutMs: number
}): Promise<Response> {
	const controller = new AbortController()
	const headers = new Headers(request.headers)
	headers.set(REQUEST_ID_HEADER, requestId)
	headers.delete(TRUSTED_INGRESS_HEADER)
	headers.set('x-forwarded-host', publicOrigin.host)
	headers.set('x-forwarded-proto', publicOrigin.protocol)
	const forwarded = new Request(request, { headers, signal: controller.signal })
	let timedOut = false
	const cancellation = new Promise<never>((_, reject) => {
		controller.signal.addEventListener('abort', () => reject(controller.signal.reason), {
			once: true
		})
	})
	const cancelFromCaller = () => controller.abort(request.signal.reason)
	if (request.signal.aborted) cancelFromCaller()
	else request.signal.addEventListener('abort', cancelFromCaller, { once: true })
	const timer = setTimeout(() => {
		timedOut = true
		controller.abort(new UpstreamTimeoutError())
	}, timeoutMs)
	try {
		return await Promise.race([target.fetch(forwarded), cancellation])
	} catch (error) {
		if (timedOut) throw new UpstreamTimeoutError()
		throw error
	} finally {
		clearTimeout(timer)
		request.signal.removeEventListener('abort', cancelFromCaller)
	}
}

function canonicalOrigin(value: string, name = '${API_PUBLIC_ORIGIN}'): string {
	const url = new URL(value)
	if (url.origin !== value && \`\${url.origin}/\` !== value) throw new Error(name + ' must be an HTTP origin without a path, query, or fragment')
	if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error(name + ' must use http or https')
	return url.origin
}

export function createGateway(
	targets: GatewayTargets,
	options: GatewayOptions = {
		openApiDocument: { openapi: '3.0.0', info: {}, paths: {} },
		canonicalApiOrigin: 'http://localhost:${HONO_GATEWAY.development.port}'
	}
) {
	const app = new Hono<{ Variables: GatewayVariables }>()
	const serverOrigin = canonicalOrigin(options.canonicalApiOrigin)
	const allowedPublicOrigins = publicOriginAllowlist(options.publicOrigins, serverOrigin)
	const allowedCorsOrigins = corsAllowlist(options.corsOrigins)
	const timeoutMs = boundedTimeout(options.upstreamTimeoutMs)
	const writeLog = options.logger ?? ((line: string) => console.log(line))

	const respond = ({
		context,
		response,
		preflight = false
	}: {
		context: GatewayContext
		response: Response
		preflight?: boolean
	}) =>
		gatewayResponse({
			response,
			requestId: context.get('requestId'),
			origin: context.req.header('origin'),
			allowedCorsOrigins,
			preflight
		})

	app.use('*', async (c, next) => {
		const id = requestId(c.req.header(REQUEST_ID_HEADER))
		const startedAt = Date.now()
		c.set('requestId', id)
		await next()
		writeLog(
			JSON.stringify({
				event: 'request_completed',
				requestId: id,
				method: c.req.method,
				path: new URL(c.req.url).pathname,
				status: c.res.status,
				durationMs: Date.now() - startedAt
			})
		)
	})

	app.use('*', async (c, next) => {
		const origin = resolvePublicOrigin({
			request: c.req.raw,
			allowed: allowedPublicOrigins,
			trustedIngressSecret: options.trustedIngressSecret
		})
		if (!origin) {
			writeLog(
				JSON.stringify({
					event: 'public_origin_rejected',
					requestId: c.get('requestId'),
					method: c.req.method,
					path: new URL(c.req.url).pathname
				})
			)
			return respond({ context: c, response: c.text('misdirected request', 421) })
		}
		c.set('publicOrigin', origin)
		await next()
	})

	app.use('/api/*', async (c, next) => {
		const pathname = new URL(c.req.url).pathname
		const isPublicPath =
			pathname === '/api/healthz' ||
			pathname === '/api/openapi.json' ||
			routes.some(({ prefix }) => matchesPrefix(pathname, prefix))
		const isPreflight =
			c.req.method === 'OPTIONS' &&
			Boolean(c.req.header('origin')) &&
			Boolean(c.req.header('access-control-request-method'))
		if (!isPublicPath || !isPreflight) return next()
		return respond({
			context: c,
			response: new Response(null, { status: 204 }),
			preflight: true
		})
	})

	app.get('/api/healthz', (c) => respond({ context: c, response: c.text('ok') }))
	app.get('/api/openapi.json', (c) =>
		respond({
			context: c,
			response: c.json({ ...options.openApiDocument, servers: [{ url: serverOrigin }] })
		})
	)
	app.all('*', async (c) => {
		const pathname = new URL(c.req.url).pathname
		const route = routes.find(({ prefix }) => matchesPrefix(pathname, prefix))
		if (!route) {
			writeLog(
				JSON.stringify({
					event: 'route_not_found',
					requestId: c.get('requestId'),
					method: c.req.method,
					path: pathname
				})
			)
			return respond({ context: c, response: c.text('not found', 404) })
		}

		writeLog(
			JSON.stringify({
				event: 'route_selected',
				requestId: c.get('requestId'),
				method: c.req.method,
				path: pathname,
				target: route.target
			})
		)
		const target = targets[route.target]
		if (!target) {
			writeLog(
				JSON.stringify({
					event: 'target_missing',
					requestId: c.get('requestId'),
					method: c.req.method,
					path: pathname,
					target: route.target
				})
			)
			return respond({ context: c, response: c.text('service unavailable', 503) })
		}

		try {
			const response = await fetchUpstream({
				target,
				request: c.req.raw,
				requestId: c.get('requestId'),
				publicOrigin: c.get('publicOrigin'),
				timeoutMs
			})
			return respond({ context: c, response })
		} catch (error) {
			if (error instanceof UpstreamTimeoutError) {
				writeLog(
					JSON.stringify({
						event: 'upstream_timeout',
						requestId: c.get('requestId'),
						method: c.req.method,
						path: pathname,
						target: route.target,
						timeoutMs
					})
				)
				return respond({ context: c, response: c.text('gateway timeout', 504) })
			}
			writeLog(
				JSON.stringify({
					event: 'transport_failure',
					requestId: c.get('requestId'),
					method: c.req.method,
					path: pathname,
					target: route.target
				})
			)
			return respond({ context: c, response: c.text('bad gateway', 502) })
		}
	})

	return app
}
`
}

function indexTs({
	runtime,
	streamsChunkedIngress
}: {
	runtime: Runtime
	streamsChunkedIngress: boolean
}): string {
	if (runtime === 'cf-workers') {
		return `import openApiDocument from '../openapi.json' with { type: 'json' }

import { createGateway } from './app.js'

export default {
	fetch(request, env) {
		return createGateway(env, {
			openApiDocument,
			canonicalApiOrigin: env.${API_PUBLIC_ORIGIN},
			publicOrigins: env.${GATEWAY_PUBLIC_ORIGINS},
			corsOrigins: env.${API_CORS_ORIGINS},
			upstreamTimeoutMs: Number(env.${GATEWAY_UPSTREAM_TIMEOUT_MS})
		}).fetch(request, env)
	}
} satisfies ExportedHandler<Env>
`
	}

	return `import { serve } from '@hono/node-server'
import openApiDocument from '../openapi.json' with { type: 'json' }

import { createGateway, type GatewayTarget } from './app.js'

function httpTarget(origin: string): GatewayTarget {
	return {
		fetch(request) {
			const incoming = new URL(request.url)
			const upstream = new URL(\`\${incoming.pathname}\${incoming.search}\`, origin)
			const forwarded = new Request(upstream, request)${streamsChunkedIngress ? "\n\t\t\tforwarded.headers.delete('transfer-encoding')" : ''}
			return fetch(forwarded, { redirect: 'manual' })
		}
	}
}

const canonicalApiOrigin = process.env.${API_PUBLIC_ORIGIN}
if (!canonicalApiOrigin) throw new Error('${API_PUBLIC_ORIGIN} is required')
const trustedIngressSecret = process.env.${GATEWAY_TRUSTED_INGRESS_SECRET}
if (!trustedIngressSecret) throw new Error('${GATEWAY_TRUSTED_INGRESS_SECRET} is required')

const app = createGateway(
	{
		${AUTH_SERVICE.internalTarget}: httpTarget(process.env.${AUTH_SERVICE.transport.node.targetEnvironmentVariable} ?? 'http://${AUTH_SERVICE.transport.node.hostname}:${AUTH_SERVICE.development.port}'),
		${USERS_SERVICE.internalTarget}: httpTarget(process.env.${USERS_SERVICE.transport.node.targetEnvironmentVariable} ?? 'http://${USERS_SERVICE.transport.node.hostname}:${USERS_SERVICE.development.port}')
	},
	{
		openApiDocument,
		canonicalApiOrigin,
		publicOrigins: process.env.${GATEWAY_PUBLIC_ORIGINS},
		trustedIngressSecret,
		corsOrigins: process.env.${API_CORS_ORIGINS},
		upstreamTimeoutMs: Number(process.env.${GATEWAY_UPSTREAM_TIMEOUT_MS} ?? 10000)
	}
)
const hostname = process.env.HOST ?? '${HONO_GATEWAY.development.ip}'
const port = Number(process.env.PORT ?? ${HONO_GATEWAY.development.port})
serve({ fetch: app.fetch, port, hostname })
console.log(\`${HONO_GATEWAY.identity} listening on http://\${hostname}:\${port}\`)
`
}

function wranglerJsonc(project: string, webHost: string): string {
	return `{
	"$schema": "node_modules/wrangler/config-schema.json",
	"name": "${honoServiceName(project, HONO_GATEWAY)}",
	"main": "src/index.ts",
	"tsconfig": "tsconfig.json",
	"compatibility_date": "${HONO_WORKERS_COMPAT_DATE}",
	"compatibility_flags": ["nodejs_compat"],
	"workers_dev": false,
	"preview_urls": false,
	// Replace <domain> with the project's apex domain.
	"routes": [
		{ "pattern": "api.<domain>", "custom_domain": true },
		{ "pattern": "${webHost}/api", "zone_name": "<domain>" },
		{ "pattern": "${webHost}/api/*", "zone_name": "<domain>" }
	],
	"vars": {
		"${API_PUBLIC_ORIGIN}": "https://api.<domain>",
		"${GATEWAY_PUBLIC_ORIGINS}": "https://${webHost},https://api.<domain>",
		"${API_CORS_ORIGINS}": "https://${webHost}",
		"${GATEWAY_UPSTREAM_TIMEOUT_MS}": "10000"
	},
	"secrets": { "required": [] },
	"services": [
		{ "binding": "${AUTH_SERVICE.internalTarget}", "service": "${honoServiceName(project, AUTH_SERVICE)}" },
		{ "binding": "${USERS_SERVICE.internalTarget}", "service": "${honoServiceName(project, USERS_SERVICE)}" }
	],
	"dev": {
		"ip": "${HONO_GATEWAY.development.ip}",
		"port": ${HONO_GATEWAY.development.port},
		"host": "${HONO_GATEWAY.development.hostname}",
		"inspector_port": ${HONO_GATEWAY.development.inspectorPort}
	},
	"observability": { "enabled": true }
}
`
}

function composeOpenApiTs(project: string, runtime: Runtime): string {
	return `import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

type JsonValue = boolean | null | number | string | JsonValue[] | { [key: string]: JsonValue }
type JsonObject = { [key: string]: JsonValue }
type OpenApiDocument = {
	openapi: string
	info: { title: string; version: string }
	paths: Record<string, JsonObject>
	components?: Record<string, Record<string, JsonValue>>
	servers?: { url: string }[]
}
type LoadedFragment = {
	owner: string
	operationIdPrefix: string
	document: OpenApiDocument
}

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const outputPath = resolve(scriptDirectory, '../openapi.json')
const fragmentFiles = [
	{
		owner: 'users',
		operationIdPrefix: 'users',
		path: resolve(scriptDirectory, '../../../services/users/openapi.json')
	}
] as const
const methods = new Set(['delete', 'get', 'head', 'options', 'patch', 'post', 'put', 'trace'])

function compareText(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0
}

function sortJson(value: JsonValue | OpenApiDocument): JsonValue {
	if (Array.isArray(value)) return value.map((entry) => sortJson(entry))
	if (typeof value !== 'object' || value === null) return value
	return Object.fromEntries(
		Object.entries(value)
			.sort(([left], [right]) => compareText(left, right))
			.map(([key, entry]) => [key, sortJson(entry as JsonValue)])
	)
}

function sameJson(left: JsonValue, right: JsonValue): boolean {
	return JSON.stringify(sortJson(left)) === JSON.stringify(sortJson(right))
}

function isObject(value: JsonValue | undefined): value is JsonObject {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function directParameterId(value: JsonValue): string | undefined {
	if (!isObject(value) || typeof value.in !== 'string' || typeof value.name !== 'string') return undefined
	const name = value.in === 'header' ? value.name.toLowerCase() : value.name
	return value.in + ':' + name
}

function resolveParameterReference({
	reference,
	parameterComponents,
	location,
	owner,
	seen
}: {
	reference: string
	parameterComponents: Record<string, JsonValue> | undefined
	location: string
	owner: string
	seen: Set<string>
}): JsonValue {
	const prefix = '#/components/parameters/'
	const encodedName = reference.startsWith(prefix) ? reference.slice(prefix.length) : ''
	if (!encodedName || encodedName.includes('/') || /~(?:[^01]|$)/.test(encodedName)) throw new Error('fragment "' + owner + '" uses unsupported parameter reference "' + reference + '" at ' + location)
	if (seen.has(reference)) throw new Error('fragment "' + owner + '" has cyclic parameter reference "' + reference + '" at ' + location)
	const name = encodedName.replaceAll('~1', '/').replaceAll('~0', '~')
	const definition = parameterComponents?.[name]
	if (definition === undefined) throw new Error('fragment "' + owner + '" cannot resolve parameter reference "' + reference + '" at ' + location)
	if (isObject(definition) && typeof definition.$ref === 'string') {
		return resolveParameterReference({
			reference: definition.$ref,
			parameterComponents,
			location,
			owner,
			seen: new Set([...seen, reference])
		})
	}
	if (!directParameterId(definition)) throw new Error('fragment "' + owner + '" cannot determine parameter identity for "' + reference + '" at ' + location)
	return definition
}

function parameterDescriptor({
	value,
	parameterComponents,
	location,
	owner
}: {
	value: JsonValue
	parameterComponents: Record<string, JsonValue> | undefined
	location: string
	owner: string
}): { definition: JsonValue; identity: string | undefined } {
	const definition =
		isObject(value) && typeof value.$ref === 'string'
			? resolveParameterReference({
					reference: value.$ref,
					parameterComponents,
					location,
					owner,
					seen: new Set()
				})
			: value
	return { definition, identity: directParameterId(definition) }
}

function rejectResponseLinks({
	response,
	location,
	owner
}: {
	response: JsonValue
	location: string
	owner: string
}): void {
	if (!isObject(response) || response.links === undefined) return
	throw new Error('fragment "' + owner + '" uses unsupported Link Objects at ' + location + '.links')
}

function validateParameters({
	value,
	location,
	parameterComponents,
	owner
}: {
	value: JsonValue | undefined
	location: string
	parameterComponents: Record<string, JsonValue> | undefined
	owner: string
}): void {
	if (value === undefined) return
	if (!Array.isArray(value)) throw new Error('invalid parameters at ' + location)
	const identities = new Map<string, JsonValue>()
	for (const [index, parameter] of value.entries()) {
		const descriptor = parameterDescriptor({
			value: parameter,
			parameterComponents,
			location: location + '[' + index + ']',
			owner
		})
		if (!descriptor.identity) continue
		const current = identities.get(descriptor.identity)
		if (current && !sameJson(current, descriptor.definition)) throw new Error('parameter collision at ' + location + '.' + descriptor.identity)
		identities.set(descriptor.identity, descriptor.definition)
	}
}

function mergeParameters({
	existing,
	incoming,
	location,
	parameterComponents,
	owner
}: {
	existing: JsonValue
	incoming: JsonValue
	location: string
	parameterComponents: Record<string, JsonValue> | undefined
	owner: string
}): JsonValue[] {
	if (!Array.isArray(existing) || !Array.isArray(incoming)) throw new Error('parameter collision at ' + location)
	const merged = structuredClone(existing)
	const identities = new Map<string, JsonValue>()
	for (const [index, parameter] of merged.entries()) {
		const descriptor = parameterDescriptor({
			value: parameter,
			parameterComponents,
			location: location + '[' + index + ']',
			owner
		})
		if (descriptor.identity) identities.set(descriptor.identity, descriptor.definition)
	}
	for (const [index, parameter] of incoming.entries()) {
		const descriptor = parameterDescriptor({
			value: parameter,
			parameterComponents,
			location: location + '[' + (merged.length + index) + ']',
			owner
		})
		const current = descriptor.identity ? identities.get(descriptor.identity) : undefined
		if (current && !sameJson(current, descriptor.definition)) throw new Error('parameter collision at ' + location + '.' + descriptor.identity)
		if (!current && !merged.some((candidate) => sameJson(candidate, parameter))) {
			merged.push(structuredClone(parameter))
			if (descriptor.identity) identities.set(descriptor.identity, descriptor.definition)
		}
	}
	return merged
}

export function composeOpenApi(fragments: readonly LoadedFragment[]): OpenApiDocument {
	const paths: Record<string, JsonObject> = {}
	const components: Record<string, Record<string, JsonValue>> = {}
	const operationOwners = new Map<string, string>()
	const pathIdentities = new Map<string, string>()
	for (const fragment of [...fragments].sort((left, right) => compareText(left.owner, right.owner))) {
		if (fragment.document.servers !== undefined) throw new Error('fragment "' + fragment.owner + '" must not declare servers')
		if (fragment.document.openapi !== '3.0.0') throw new Error('fragment "' + fragment.owner + '" must use OpenAPI 3.0.0')
		if (Object.keys(fragment.document.components?.callbacks ?? {}).length > 0) throw new Error('fragment "' + fragment.owner + '" uses unsupported callbacks at components.callbacks')
		if (Object.keys(fragment.document.components?.links ?? {}).length > 0) throw new Error('fragment "' + fragment.owner + '" uses unsupported Link Objects at components.links')
		for (const [name, response] of Object.entries(fragment.document.components?.responses ?? {})) {
			rejectResponseLinks({
				response,
				location: 'components.responses.' + name,
				owner: fragment.owner
			})
		}
		for (const [group, entries] of Object.entries(fragment.document.components ?? {})) {
			const target = (components[group] ??= {})
			for (const [name, value] of Object.entries(entries)) {
				if (target[name] !== undefined && !sameJson(target[name], value)) throw new Error('component collision at components.' + group + '.' + name)
				if (target[name] === undefined) target[name] = structuredClone(value)
			}
		}
		for (const [path, incoming] of Object.entries(fragment.document.paths)) {
			if (!path.startsWith('/api/v1/') || path.startsWith('/api/auth/')) throw new Error('fragment "' + fragment.owner + '" path "' + path + '" must use /api/v1')
			const pathIdentity = path.replaceAll(/\\{[^}]+\\}/g, '{}')
			const equivalentPath = pathIdentities.get(pathIdentity)
			if (equivalentPath && equivalentPath !== path) throw new Error('path collision between templates "' + equivalentPath + '" and "' + path + '"')
			pathIdentities.set(pathIdentity, path)
			if (incoming.$ref !== undefined) {
				throw new Error(
					'fragment "' + fragment.owner + '" uses unsupported Path Item $ref at paths.' + path + '.$ref'
				)
			}
			if (incoming.servers !== undefined) {
				throw new Error(
					'fragment "' + fragment.owner + '" must not declare servers at paths.' + path + '.servers'
				)
			}
			validateParameters({
				value: incoming.parameters,
				location: 'paths.' + path + '.parameters',
				parameterComponents: fragment.document.components?.parameters,
				owner: fragment.owner
			})
			for (const [method, operation] of Object.entries(incoming)) {
				if (!methods.has(method)) continue
				if (!isObject(operation) || typeof operation.operationId !== 'string') throw new Error('missing operationId at paths.' + path + '.' + method)
				if (operation.callbacks !== undefined) {
					throw new Error(
						'fragment "' + fragment.owner + '" uses unsupported callbacks at paths.' + path + '.' + method + '.callbacks'
					)
				}
				if (operation.servers !== undefined) {
					throw new Error(
						'fragment "' + fragment.owner + '" must not declare servers at paths.' + path + '.' + method + '.servers'
					)
				}
				validateParameters({
					value: operation.parameters,
					location: 'paths.' + path + '.' + method + '.parameters',
					parameterComponents: fragment.document.components?.parameters,
					owner: fragment.owner
				})
				if (isObject(operation.responses)) {
					for (const [status, response] of Object.entries(operation.responses)) {
						rejectResponseLinks({
							response,
							location: 'paths.' + path + '.' + method + '.responses.' + status,
							owner: fragment.owner
						})
					}
				}
				const operationId = operation.operationId
				if (!operationId.startsWith(fragment.operationIdPrefix)) throw new Error('operationId "' + operationId + '" must start with "' + fragment.operationIdPrefix + '"')
				const owner = operationOwners.get(operationId)
				if (owner) throw new Error('duplicate operationId "' + operationId + '" in "' + owner + '" and "' + fragment.owner + '"')
				operationOwners.set(operationId, fragment.owner)
			}
			const current = paths[path]
			if (!current) {
				paths[path] = structuredClone(incoming)
				continue
			}
			for (const [field, value] of Object.entries(incoming)) {
				const location = 'paths.' + path + '.' + field
				const existing = current[field]
				if (existing === undefined) current[field] = structuredClone(value)
				else if (methods.has(field)) throw new Error('method collision at ' + location)
				else if (field === 'parameters') {
					current[field] = mergeParameters({
						existing,
						incoming: value,
						location,
						parameterComponents: components.parameters,
						owner: fragment.owner
					})
				} else if (!sameJson(existing, value)) throw new Error('path collision at ' + location)
			}
		}
	}
	const document: OpenApiDocument = {
		openapi: '3.0.0',
		info: { title: '${project} API', version: '0.0.0' },
		paths
	}
	if (Object.keys(components).length > 0) document.components = components
	return sortJson(document) as OpenApiDocument
}

async function loadFragments(): Promise<LoadedFragment[]> {
	return Promise.all(
		[...fragmentFiles]
			.sort((left, right) => compareText(left.owner, right.owner))
			.map(async (fragment) => ({
				owner: fragment.owner,
				operationIdPrefix: fragment.operationIdPrefix,
				document: JSON.parse(await readFile(fragment.path, 'utf8')) as OpenApiDocument
			}))
	)
}

async function main(): Promise<void> {
	const rendered = JSON.stringify(sortJson(composeOpenApi(await loadFragments())), null, 2) + '\\n'
	const hash = createHash('sha256').update(rendered).digest('hex')
	if (process.argv.includes('--check')) {
		const checked = await readFile(outputPath, 'utf8').catch(() => '')
		if (checked !== rendered) throw new Error('apps/api/openapi.json drifted; run pnpm openapi:compose')
		console.log('OpenAPI is current (sha256:' + hash + ')')
		return
	}
	await writeFile(outputPath, rendered)
	console.log('Wrote apps/api/openapi.json (sha256:' + hash + ')')
}

${composeOpenApiMain(runtime)}
`
}

function composeOpenApiMain(runtime: Runtime): string {
	const guard =
		runtime === 'cf-workers'
			? 'const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)\nif (isMain)'
			: 'if (import.meta.main)'
	return `${guard} {
\tmain().catch((error: unknown) => {
\t\tconsole.error(error instanceof Error ? error.message : String(error))
\t\tprocess.exitCode = 1
\t})
}`
}

function readme(): string {
	return `# API gateway

The gateway is the only public API application. It serves the web origin's same-origin
\`/api/*\` alias and the canonical API origin. It forwards explicit public prefixes to private
services without changing request and response payloads. It must not import or mount service applications.

Better Auth routes stay under \`/api/auth/*\`. Domain routes are versioned under \`/api/v1/*\`.
Private services call one another directly and never route internal traffic back through this gateway.

## OpenAPI

Each domain service owns a public OpenAPI fragment. Run pnpm openapi:compose after changing a
fragment, then run pnpm openapi:check to verify the checked apps/api/openapi.json artifact.
The checked document has no deployment server. At runtime, /api/openapi.json adds exactly
one server from the explicit ${API_PUBLIC_ORIGIN} environment variable.

## Operational behavior

Every request receives one \`x-request-id\`. The gateway forwards it to the selected service,
returns it in the response, and includes it in structured gateway and service logs. Routing logs
contain only the request ID, method, path, target, outcome, status, and duration; they do not include
headers, cookies, query strings, or bodies.

\`${GATEWAY_PUBLIC_ORIGINS}\` is the comma-separated allowlist of complete web and API origins
accepted at the gateway boundary. The gateway rejects unknown request hosts and replaces caller-supplied
forwarding metadata with the approved host and scheme before calling a private service. Node SSR sets
trusted forwarding metadata with \`${GATEWAY_TRUSTED_INGRESS_SECRET}\`; keep that value private.

\`${API_CORS_ORIGINS}\` is a comma-separated list of complete browser origins allowed to call
the canonical API origin with credentials. Wildcards are rejected. Same-origin web requests use the
web alias and do not depend on CORS.

\`${GATEWAY_UPSTREAM_TIMEOUT_MS}\` sets the bounded private-service timeout in milliseconds and
defaults to 10000 on Node. Missing targets return \`503\`, transport failures return \`502\`, and
timeouts return \`504\`. Upstream responses otherwise pass through without retries, aggregation,
caching, authorization, or trusted-user headers.

## Adjacent-version rollout

Deploy database migrations, private services, the gateway, and then the web application. Treat the
rollout window as a mixed-version runtime, not as an atomic deployment. Add fields, headers, and new
\`/api/v1\` routes before using them. When a request changes, services must first accept both the
previous and new request shape; deploy callers only after that additive service change is live.
When a response changes, callers must ignore unknown additive fields and headers before services emit them.

Removing or renaming a path or method, making an optional request field or header required, or changing
status or body semantics require a coordinated rollout. So do incompatible changes to forwarded host or
protocol, request IDs, or auth cookies. Keep the previous shape until every adjacent gateway, service,
and web version has moved past it; otherwise deploy all affected components in one controlled window.

## Local development

The gateway listens on http://${HONO_GATEWAY.development.ip}:${HONO_GATEWAY.development.port}.
Run pnpm dev at the workspace root to start the web application, gateway, and services.

| Prefix | Private target |
| --- | --- |
| ${AUTH_SERVICE.publicPrefixes[0]}/* | ${AUTH_SERVICE.internalTarget} |
| ${USERS_SERVICE.publicPrefixes[0]}/* | ${USERS_SERVICE.internalTarget} |
`
}
