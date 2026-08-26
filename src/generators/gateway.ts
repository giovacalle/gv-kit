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

const API_PUBLIC_ORIGIN = 'API_PUBLIC_ORIGIN'

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
		{ path: 'apps/api/src/index.ts', content: indexTs(runtime) },
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
				...(runtime === 'cf-workers'
					? { types: ['node', '@cloudflare/workers-types'] }
					: {})
			},
			include: ['src/**/*', 'scripts/**/*', '*.d.ts', 'openapi.json']
		},
		null,
		2
	)}\n`
}

function appTs(): string {
	return `import { Hono } from 'hono'

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
}

const routes = [
	{ prefix: '${AUTH_SERVICE.publicPrefixes[0]}', target: '${AUTH_SERVICE.internalTarget}' },
	{ prefix: '${USERS_SERVICE.publicPrefixes[0]}', target: '${USERS_SERVICE.internalTarget}' }
] as const

function matchesPrefix(pathname: string, prefix: string): boolean {
	return pathname === prefix || pathname.startsWith(\`\${prefix}/\`)
}

function canonicalOrigin(value: string): string {
	const url = new URL(value)
	if (url.origin !== value && \`\${url.origin}/\` !== value) {
		throw new Error('${API_PUBLIC_ORIGIN} must be an HTTP origin without a path, query, or fragment')
	}
	if (url.protocol !== 'http:' && url.protocol !== 'https:') {
		throw new Error('${API_PUBLIC_ORIGIN} must use http or https')
	}
	return url.origin
}

export function createGateway(
	targets: GatewayTargets,
	options: GatewayOptions = {
		openApiDocument: { openapi: '3.0.0', info: {}, paths: {} },
		canonicalApiOrigin: 'http://localhost:${HONO_GATEWAY.development.port}'
	}
) {
	const app = new Hono()
	const serverOrigin = canonicalOrigin(options.canonicalApiOrigin)

	app.get('/api/healthz', (c) => c.text('ok'))
	app.get('/api/openapi.json', (c) =>
		c.json({ ...options.openApiDocument, servers: [{ url: serverOrigin }] })
	)
	app.all('*', async (c) => {
		const pathname = new URL(c.req.url).pathname
		const route = routes.find(({ prefix }) => matchesPrefix(pathname, prefix))
		if (!route) return c.text('not found', 404)

		const target = targets[route.target]
		if (!target) return c.text('service unavailable', 503)

		try {
			return await target.fetch(c.req.raw)
		} catch {
			return c.text('bad gateway', 502)
		}
	})

	return app
}
`
}

function indexTs(runtime: Runtime): string {
	if (runtime === 'cf-workers') {
		return `import openApiDocument from '../openapi.json' with { type: 'json' }

import { createGateway } from './app.js'

export default {
	fetch(request, env) {
		return createGateway(env, {
			openApiDocument,
			canonicalApiOrigin: env.${API_PUBLIC_ORIGIN}
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
			const forwarded = new Request(upstream, request)
			forwarded.headers.set(
				'x-forwarded-host',
				request.headers.get('x-forwarded-host') ?? request.headers.get('host') ?? incoming.host
			)
			forwarded.headers.set(
				'x-forwarded-proto',
				request.headers.get('x-forwarded-proto') ?? incoming.protocol.slice(0, -1)
			)
			return fetch(forwarded, { redirect: 'manual' })
		}
	}
}

const canonicalApiOrigin = process.env.${API_PUBLIC_ORIGIN}
if (!canonicalApiOrigin) throw new Error('${API_PUBLIC_ORIGIN} is required')

const app = createGateway(
	{
		${AUTH_SERVICE.internalTarget}: httpTarget(process.env.${AUTH_SERVICE.transport.node.targetEnvironmentVariable} ?? 'http://${AUTH_SERVICE.transport.node.hostname}:${AUTH_SERVICE.development.port}'),
		${USERS_SERVICE.internalTarget}: httpTarget(process.env.${USERS_SERVICE.transport.node.targetEnvironmentVariable} ?? 'http://${USERS_SERVICE.transport.node.hostname}:${USERS_SERVICE.development.port}')
	},
	{ openApiDocument, canonicalApiOrigin }
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
		{ "pattern": "${webHost}/api/*", "zone_name": "<domain>" }
	],
	"vars": {
		"${API_PUBLIC_ORIGIN}": "https://api.<domain>"
	},
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
	if (!isObject(value) || typeof value.in !== 'string' || typeof value.name !== 'string') {
		return undefined
	}
	const name = value.in === 'header' ? value.name.toLowerCase() : value.name
	return value.in + ':' + name
}

function resolveParameterReference(
	reference: string,
	parameterComponents: Record<string, JsonValue> | undefined,
	location: string,
	owner: string,
	seen: Set<string>
): JsonValue {
	const prefix = '#/components/parameters/'
	const encodedName = reference.startsWith(prefix) ? reference.slice(prefix.length) : ''
	if (!encodedName || encodedName.includes('/') || /~(?:[^01]|$)/.test(encodedName)) {
		throw new Error('fragment "' + owner + '" uses unsupported parameter reference "' + reference + '" at ' + location)
	}
	if (seen.has(reference)) {
		throw new Error('fragment "' + owner + '" has cyclic parameter reference "' + reference + '" at ' + location)
	}
	const name = encodedName.replaceAll('~1', '/').replaceAll('~0', '~')
	const definition = parameterComponents?.[name]
	if (definition === undefined) {
		throw new Error('fragment "' + owner + '" cannot resolve parameter reference "' + reference + '" at ' + location)
	}
	if (isObject(definition) && typeof definition.$ref === 'string') {
		return resolveParameterReference(
			definition.$ref,
			parameterComponents,
			location,
			owner,
			new Set([...seen, reference])
		)
	}
	if (!directParameterId(definition)) {
		throw new Error('fragment "' + owner + '" cannot determine parameter identity for "' + reference + '" at ' + location)
	}
	return definition
}

function parameterDescriptor(
	value: JsonValue,
	parameterComponents: Record<string, JsonValue> | undefined,
	location: string,
	owner: string
): { definition: JsonValue; identity: string | undefined } {
	const definition =
		isObject(value) && typeof value.$ref === 'string'
			? resolveParameterReference(value.$ref, parameterComponents, location, owner, new Set())
			: value
	return { definition, identity: directParameterId(definition) }
}

function rejectResponseLinks(response: JsonValue, location: string, owner: string): void {
	if (!isObject(response) || response.links === undefined) return
	throw new Error('fragment "' + owner + '" uses unsupported Link Objects at ' + location + '.links')
}

function validateParameters(
	value: JsonValue | undefined,
	location: string,
	parameterComponents: Record<string, JsonValue> | undefined,
	owner: string
): void {
	if (value === undefined) return
	if (!Array.isArray(value)) throw new Error('invalid parameters at ' + location)
	const identities = new Map<string, JsonValue>()
	for (const [index, parameter] of value.entries()) {
		const descriptor = parameterDescriptor(parameter, parameterComponents, location + '[' + index + ']', owner)
		if (!descriptor.identity) continue
		const current = identities.get(descriptor.identity)
		if (current && !sameJson(current, descriptor.definition)) {
			throw new Error('parameter collision at ' + location + '.' + descriptor.identity)
		}
		identities.set(descriptor.identity, descriptor.definition)
	}
}

function mergeParameters(
	existing: JsonValue,
	incoming: JsonValue,
	location: string,
	parameterComponents: Record<string, JsonValue> | undefined,
	owner: string
): JsonValue[] {
	if (!Array.isArray(existing) || !Array.isArray(incoming)) {
		throw new Error('parameter collision at ' + location)
	}
	const merged = structuredClone(existing)
	const identities = new Map<string, JsonValue>()
	for (const [index, parameter] of merged.entries()) {
		const descriptor = parameterDescriptor(parameter, parameterComponents, location + '[' + index + ']', owner)
		if (descriptor.identity) identities.set(descriptor.identity, descriptor.definition)
	}
	for (const [index, parameter] of incoming.entries()) {
		const descriptor = parameterDescriptor(
			parameter,
			parameterComponents,
			location + '[' + (merged.length + index) + ']',
			owner
		)
		const current = descriptor.identity ? identities.get(descriptor.identity) : undefined
		if (current && !sameJson(current, descriptor.definition)) {
			throw new Error('parameter collision at ' + location + '.' + descriptor.identity)
		}
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
		if (fragment.document.servers !== undefined) {
			throw new Error('fragment "' + fragment.owner + '" must not declare servers')
		}
		if (fragment.document.openapi !== '3.0.0') {
			throw new Error('fragment "' + fragment.owner + '" must use OpenAPI 3.0.0')
		}
		if (Object.keys(fragment.document.components?.callbacks ?? {}).length > 0) {
			throw new Error('fragment "' + fragment.owner + '" uses unsupported callbacks at components.callbacks')
		}
		if (Object.keys(fragment.document.components?.links ?? {}).length > 0) {
			throw new Error('fragment "' + fragment.owner + '" uses unsupported Link Objects at components.links')
		}
		for (const [name, response] of Object.entries(fragment.document.components?.responses ?? {})) {
			rejectResponseLinks(response, 'components.responses.' + name, fragment.owner)
		}
		for (const [group, entries] of Object.entries(fragment.document.components ?? {})) {
			const target = (components[group] ??= {})
			for (const [name, value] of Object.entries(entries)) {
				if (target[name] !== undefined && !sameJson(target[name], value)) {
					throw new Error('component collision at components.' + group + '.' + name)
				}
				if (target[name] === undefined) target[name] = structuredClone(value)
			}
		}
		for (const [path, incoming] of Object.entries(fragment.document.paths)) {
			if (!path.startsWith('/api/v1/') || path.startsWith('/api/auth/')) {
				throw new Error('fragment "' + fragment.owner + '" path "' + path + '" must use /api/v1')
			}
			const pathIdentity = path.replaceAll(/\\{[^}]+\\}/g, '{}')
			const equivalentPath = pathIdentities.get(pathIdentity)
			if (equivalentPath && equivalentPath !== path) {
				throw new Error('path collision between templates "' + equivalentPath + '" and "' + path + '"')
			}
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
			validateParameters(
				incoming.parameters,
				'paths.' + path + '.parameters',
				fragment.document.components?.parameters,
				fragment.owner
			)
			for (const [method, operation] of Object.entries(incoming)) {
				if (!methods.has(method)) continue
				if (!isObject(operation) || typeof operation.operationId !== 'string') {
					throw new Error('missing operationId at paths.' + path + '.' + method)
				}
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
				validateParameters(
					operation.parameters,
					'paths.' + path + '.' + method + '.parameters',
					fragment.document.components?.parameters,
					fragment.owner
				)
				if (isObject(operation.responses)) {
					for (const [status, response] of Object.entries(operation.responses)) {
						rejectResponseLinks(
							response,
							'paths.' + path + '.' + method + '.responses.' + status,
							fragment.owner
						)
					}
				}
				const operationId = operation.operationId
				if (!operationId.startsWith(fragment.operationIdPrefix)) {
					throw new Error('operationId "' + operationId + '" must start with "' + fragment.operationIdPrefix + '"')
				}
				const owner = operationOwners.get(operationId)
				if (owner) {
					throw new Error('duplicate operationId "' + operationId + '" in "' + owner + '" and "' + fragment.owner + '"')
				}
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
					current[field] = mergeParameters(
						existing,
						value,
						location,
						components.parameters,
						fragment.owner
					)
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
		if (checked !== rendered) {
			throw new Error('apps/api/openapi.json drifted; run pnpm openapi:compose')
		}
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

## Local development

The gateway listens on http://${HONO_GATEWAY.development.ip}:${HONO_GATEWAY.development.port}.
Run pnpm dev at the workspace root to start the web application, gateway, and services.

| Prefix | Private target |
| --- | --- |
| ${AUTH_SERVICE.publicPrefixes[0]}/* | ${AUTH_SERVICE.internalTarget} |
| ${USERS_SERVICE.publicPrefixes[0]}/* | ${USERS_SERVICE.internalTarget} |
`
}
