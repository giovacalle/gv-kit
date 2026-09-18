import { cloudflareProductionWorkerName } from '../../lib/cloudflare-worker-name.js'
import type { FileEntry } from '../../lib/files.js'
import { HONO_WORKERS_COMPAT_DATE } from '../../lib/workers.js'
import type { GvKitConfig } from '../../schema/config.js'
import {
	CLOUDFLARE_TYPEGEN_SCRIPT,
	CLOUDFLARE_TYPES_BOOTSTRAP_FILE,
	renderCloudflareBootstrapTypes
} from '../cloudflare-worker-types.js'
import {
	AUTH_SERVICE,
	honoPackageIdentity,
	honoServiceName,
	honoServicePath,
	nodeDevelopmentOrigin,
	USERS_SERVICE
} from '../hono-topology.js'
import { createUsersOpenApiFragment, stringifyOpenApi } from '../openapi-contract.js'

const USERS_RESOURCE_PREFIX = '/api/v1/users' satisfies (typeof USERS_SERVICE.publicPrefixes)[number]

type Runtime = 'cf-workers' | 'node'

function deriveRuntime(deploy: GvKitConfig['choices']['deploy']): Runtime {
	return deploy === 'cf-workers' ? 'cf-workers' : 'node'
}

export function generateUsersService(cfg: GvKitConfig): FileEntry[] {
	const project = cfg.choices.name
	const usesSqlite = cfg.choices.db === 'sqlite'
	const runtime = deriveRuntime(cfg.choices.deploy)
	const hasAuth = cfg.choices.auth.length > 0

	const entries: FileEntry[] = [
		{
			path: honoServicePath(USERS_SERVICE, 'package.json'),
			content: pkgJson({ project, runtime, usesSqlite })
		},
		{
			path: honoServicePath(USERS_SERVICE, 'tsconfig.json'),
			content: tsconfig(runtime)
		},
		{
			path: honoServicePath(USERS_SERVICE, 'src/routes/me/schema.ts'),
			content: meSchemaTs(hasAuth)
		},
		{
			path: honoServicePath(USERS_SERVICE, 'src/routes/me/route.ts'),
			content: meRouteTs()
		},
		{
			path: honoServicePath(USERS_SERVICE, 'src/routes/me/handler.ts'),
			content: meHandlerTs({ hasAuth, runtime, usesSqlite })
		},
		{
			path: honoServicePath(USERS_SERVICE, 'src/routes/me/index.ts'),
			content: meIndexTs()
		},
		{
			path: honoServicePath(USERS_SERVICE, 'src/openapi.ts'),
			content: openapiTs(project)
		},
		{
			path: honoServicePath(USERS_SERVICE, 'openapi.json'),
			content: stringifyOpenApi(
				createUsersOpenApiFragment({
					project,
					hasAuth,
					publicPrefixes: USERS_SERVICE.publicPrefixes
				}).document
			)
		},
		{
			path: honoServicePath(USERS_SERVICE, 'src/app.ts'),
			content: appTs()
		},
		{
			path: honoServicePath(USERS_SERVICE, 'src/index.ts'),
			content: indexTs(runtime)
		},
		{
			path: honoServicePath(USERS_SERVICE, 'README.md'),
			content: readme({ project, runtime, hasAuth })
		}
	]

	if (runtime === 'cf-workers') {
		const wrangler = wranglerJsonc({ project, usesSqlite })
		entries.push(
			{
				path: honoServicePath(USERS_SERVICE, 'wrangler.jsonc'),
				content: wrangler
			},
			{
				path: honoServicePath(USERS_SERVICE, CLOUDFLARE_TYPES_BOOTSTRAP_FILE),
				content: renderCloudflareBootstrapTypes(wrangler)
			}
		)
	} else {
		entries.push(
			{
				path: honoServicePath(USERS_SERVICE, 'env.d.ts'),
				content: envDts({ usesSqlite })
			},
			{
				path: honoServicePath(USERS_SERVICE, 'tsup.config.ts'),
				content: tsupConfig(usesSqlite)
			}
		)
	}

	return entries
}

function tsupConfig(usesSqlite: boolean): string {
	return `import { defineConfig } from 'tsup'

export default defineConfig({
	noExternal: [/^@repo\\//]${usesSqlite ? ",\n\texternal: ['@libsql/client']" : ''}
})
`
}

function pkgJson({
	project,
	runtime,
	usesSqlite
}: {
	project: string
	runtime: Runtime
	usesSqlite: boolean
}): string {
	const dependencies: Record<string, string> = {
		'@hono/zod-openapi': '^1.0.0',
		'@repo/backend': 'workspace:*',
		'@repo/db': 'workspace:*',
		hono: '^4.6.0',
		zod: '^4.3.0'
	}
	if (runtime === 'node' && usesSqlite) dependencies['@libsql/client'] = '^0.14.0'

	const devDependencies: Record<string, string> = {
		'@repo/tooling-typescript': 'workspace:*',
		typescript: '~5.9.0'
	}
	const scripts: Record<string, string> = {
		typecheck: 'tsc --noEmit',
		lint: 'eslint .'
	}

	if (runtime === 'cf-workers') {
		devDependencies.wrangler = '^4.125.0'
		devDependencies['@cloudflare/workers-types'] = '^5.20260825.1'
		devDependencies['@types/node'] = '^24.0.0'
		scripts['cf-typegen'] = CLOUDFLARE_TYPEGEN_SCRIPT
		scripts.dev = 'pnpm cf-typegen && wrangler dev --persist-to ../../.wrangler/state'
		scripts.build = 'wrangler deploy --dry-run --outdir=dist'
		scripts.deploy = 'pnpm cf-typegen && wrangler deploy'
		scripts['deploy:production'] = 'pnpm cf-typegen && wrangler deploy'
		scripts['deploy:staging'] = usesSqlite
			? 'pnpm cf-typegen && test -n "$STAGING_ALIAS" && wrangler deploy --config "${STAGING_WRANGLER_CONFIG:-wrangler.jsonc}"'
			: 'pnpm cf-typegen && test -n "$STAGING_ALIAS" && test -n "$STAGING_SECRETS_FILE" && wrangler deploy --config "${STAGING_WRANGLER_CONFIG:-wrangler.jsonc}" --secrets-file "$STAGING_SECRETS_FILE"'
		scripts.typecheck = 'tsc --noEmit'
	} else {
		dependencies['@hono/node-server'] = '^1.13.0'
		devDependencies.tsup = '^8.3.0'
		devDependencies.tsx = '^4.19.0'
		devDependencies['@types/node'] = '^24.0.0'
		scripts.dev = 'tsx watch src/index.ts'
		scripts.build = 'tsup src/index.ts --format esm --target=node24 --out-dir dist'
		scripts.start = 'node dist/index.js'
	}

	return (
		JSON.stringify(
			{
				name: honoPackageIdentity(project, USERS_SERVICE),
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
		) + '\n'
	)
}

function tsconfig(runtime: Runtime): string {
	const base =
		runtime === 'cf-workers'
			? '@repo/tooling-typescript/workers.json'
			: '@repo/tooling-typescript/node.json'

	return (
		JSON.stringify(
			{
				extends: base,
				compilerOptions: {
					noEmit: true
				},
				include: ['src/**/*', '*.d.ts']
			},
			null,
			2
		) + '\n'
	)
}

function wranglerJsonc({ project, usesSqlite }: { project: string; usesSqlite: boolean }): string {
	const dbBlock = usesSqlite
		? `,
	"d1_databases": [
		{
			"binding": "DB",
			"database_name": "${project}-db",
			"database_id": "<run: wrangler d1 create ${project}-db>"
		}
	]`
		: `,
	"secrets": { "required": ["DATABASE_URL"] }`

	return `{
	"$schema": "node_modules/wrangler/config-schema.json",
	"name": "${cloudflareProductionWorkerName({
		project,
		service: USERS_SERVICE.transport.cfWorkers.serviceNameSuffix
	})}",
	"main": "src/index.ts",
	"tsconfig": "tsconfig.json",
	"compatibility_date": "${HONO_WORKERS_COMPAT_DATE}",
	"compatibility_flags": ["nodejs_compat"],
	"workers_dev": false,
	"preview_urls": false,
	"dev": {
		"ip": "${USERS_SERVICE.development.ip}",
		"port": ${USERS_SERVICE.development.port},
		"host": "${USERS_SERVICE.development.hostname}",
		"inspector_port": ${USERS_SERVICE.development.inspectorPort}
	},
	"services": [
		{ "binding": "${AUTH_SERVICE.internalTarget}", "service": "${cloudflareProductionWorkerName({
			project,
			service: AUTH_SERVICE.transport.cfWorkers.serviceNameSuffix
		})}" }
	],
	"observability": { "enabled": true }${dbBlock}
}
`
}

function envDts({ usesSqlite }: { usesSqlite: boolean }): string {
	const nodeDb = usesSqlite ? '\t\tSQLITE_PATH?: string' : '\t\tDATABASE_URL?: string'

	return `// OpenAPIHono needs ambient Env types even though Node reads these values from process.env.
declare global {
	interface Env {
		${AUTH_SERVICE.transport.node.targetEnvironmentVariable}: string
${nodeDb}
	}
}

export {}
`
}

function meSchemaTs(hasAuth: boolean): string {
	if (hasAuth) {
		return `import { z } from '@hono/zod-openapi'

export const UserResponse = z
	.object({
		id: z.string(),
		name: z.string(),
		email: z.email(),
		emailVerified: z.boolean(),
		image: z.string().nullable().optional(),
		createdAt: z.union([z.string(), z.date()]),
		updatedAt: z.union([z.string(), z.date()])
	})
	.openapi('User')

export type UserResponse = z.infer<typeof UserResponse>
`
	}

	return `import { z } from '@hono/zod-openapi'

export const UserResponse = z
	.object({
		id: z.string(),
		sessionId: z.string(),
		expiresAt: z.string()
	})
	.openapi('User')

export type UserResponse = z.infer<typeof UserResponse>
`
}

function meRouteTs(): string {
	return `import { createRoute } from '@hono/zod-openapi'

import { UserResponse } from './schema.js'

export const meRoute = createRoute({
	method: 'get',
	path: '/me',
	operationId: 'usersGetMe',
	tags: ['users'],
	summary: 'Return the authenticated user',
	responses: {
		200: {
			description: 'Authenticated user',
			content: { 'application/json': { schema: UserResponse } }
		},
		401: { description: 'No active session' }
	}
})
`
}

function meHandlerTs({
	hasAuth,
	runtime,
	usesSqlite
}: {
	hasAuth: boolean
	runtime: Runtime
	usesSqlite: boolean
}): string {
	if (!hasAuth) {
		return `import type { RouteHandler } from '@hono/zod-openapi'
import type { SessionLike } from '@repo/backend/middleware/auth'

import type { meRoute } from './route.js'

export const meHandler: RouteHandler<
	typeof meRoute,
	{ Bindings: Env; Variables: { user: SessionLike } }
> = async (c) => {
	const session = c.get('user')
	return c.json(
		{ id: session.userId, sessionId: session.sessionId, expiresAt: session.expiresAt },
		200
	)
}
`
	}

	const dbConstruction =
		runtime === 'cf-workers'
			? usesSqlite
				? 'createDb({ DB: c.env.DB })'
				: 'createDb({ DATABASE_URL: c.env.DATABASE_URL })'
			: usesSqlite
				? `createDb({ url: process.env.SQLITE_PATH ?? 'file:./local.db' })`
				: `createDb({ DATABASE_URL: process.env.DATABASE_URL ?? '' })`

	return `import type { RouteHandler } from '@hono/zod-openapi'
import { getMeUseCase } from '@repo/backend/core/use-cases/users'
import type { SessionLike } from '@repo/backend/middleware/auth'
import { createDb } from '@repo/db/client'

import type { meRoute } from './route.js'

export const meHandler: RouteHandler<
	typeof meRoute,
	{ Bindings: Env; Variables: { user: SessionLike } }
> = async (c) => {
	const session = c.get('user')
	const db = ${dbConstruction}
	const me = await getMeUseCase(db, session.userId)
	return c.json(me, 200)
}
`
}

function meIndexTs(): string {
	return `import { OpenAPIHono } from '@hono/zod-openapi'
import type { SessionLike } from '@repo/backend/middleware/auth'

import { meHandler } from './handler.js'
import { meRoute } from './route.js'

export const meRouter = new OpenAPIHono<{
	Bindings: Env
	Variables: { user: SessionLike }
}>().openapi(meRoute, meHandler)
`
}

function openapiTs(project: string): string {
	return `import type { OpenAPIHono } from '@hono/zod-openapi'
import type { Env as HonoEnv } from 'hono'

export function mountOpenApi<E extends HonoEnv>(app: OpenAPIHono<E>): void {
	app.doc('/openapi.json', {
		openapi: '3.0.0',
		info: { title: '${honoServiceName(project, USERS_SERVICE)}', version: '0.0.0' }
	})
}
`
}

function appTs(): string {
	return `import { OpenAPIHono } from '@hono/zod-openapi'
import { errorHandler, logger } from '@repo/backend/middleware'
import { requireAuth, type SessionLike } from '@repo/backend/middleware/auth'

import { mountOpenApi } from './openapi.js'
import { meRouter } from './routes/me/index.js'

export const app = new OpenAPIHono<{
	Bindings: Env
	Variables: { user: SessionLike }
}>()

app.use('*', logger('users'))
app.use('*', errorHandler())

app.get('/healthz', (c) => c.text('ok'))

app.use('${USERS_RESOURCE_PREFIX}/*', requireAuth)

app.route('${USERS_RESOURCE_PREFIX}', meRouter)

mountOpenApi(app)
`
}

function indexTs(runtime: Runtime): string {
	if (runtime === 'cf-workers') {
		return `import { app } from './app.js'

export default {
	fetch: app.fetch
} satisfies ExportedHandler<Env>
`
	}

	return `import { serve } from '@hono/node-server'

import { app } from './app.js'

const authUrl = process.env.${AUTH_SERVICE.transport.node.targetEnvironmentVariable} ?? '${nodeDevelopmentOrigin(AUTH_SERVICE)}'
const hostname = process.env.HOST ?? '${USERS_SERVICE.development.ip}'
const port = Number(process.env.PORT ?? ${USERS_SERVICE.development.port})
serve({
	fetch(request) {
		return app.fetch(request, { ${AUTH_SERVICE.transport.node.targetEnvironmentVariable}: authUrl })
	},
	port,
	hostname
})
console.log(\`${USERS_SERVICE.identity} listening on http://\${hostname}:\${port}\`)
`
}

function readme({
	project,
	runtime,
	hasAuth
}: {
	project: string
	runtime: Runtime
	hasAuth: boolean
}): string {
	const bindingDoc = !hasAuth
		? ''
		: runtime === 'cf-workers'
			? `Session validation is delegated to the auth Worker via:

\`\`\`
services: [{ binding: "${AUTH_SERVICE.internalTarget}", service: "${cloudflareProductionWorkerName({
					project,
					service: AUTH_SERVICE.transport.cfWorkers.serviceNameSuffix
				})}" }]
\`\`\`

The middleware in \`@repo/backend/middleware/auth\` calls \`/internal/session\`
on that binding. **Do not extract auth state into this service.**`
			: `Session validation is delegated to the auth service via HTTP using the
\`${AUTH_SERVICE.transport.node.targetEnvironmentVariable}\` environment variable (defaults to \`${nodeDevelopmentOrigin(AUTH_SERVICE)}\` in
dev). The middleware in \`@repo/backend/middleware/auth\` calls
\`/internal/session\` on that URL. **Do not extract auth state into this
service.**`

	const dev = !hasAuth
		? runtime === 'cf-workers'
			? `## Local dev

\`\`\`bash
pnpm dev
\`\`\``
			: `## Local dev

\`\`\`bash
pnpm dev
\`\`\`

The server listens on \`http://127.0.0.1:\${PORT ?? ${USERS_SERVICE.development.port}}\`.`
		: runtime === 'cf-workers'
			? `## Local dev

\`\`\`bash
# Terminal 1
cd ../auth && pnpm dev

# Terminal 2
${AUTH_SERVICE.transport.node.targetEnvironmentVariable}=http://localhost:${AUTH_SERVICE.development.port} pnpm dev
\`\`\`

In production, the \`${AUTH_SERVICE.internalTarget}\` service binding is used and \`${AUTH_SERVICE.transport.node.targetEnvironmentVariable}\` is unset.`
			: `## Local dev

\`\`\`bash
# Terminal 1
cd ../auth && pnpm dev

# Terminal 2
pnpm dev
\`\`\`

The server listens on \`http://127.0.0.1:\${PORT ?? ${USERS_SERVICE.development.port}}\` and reaches the
auth service via \`${AUTH_SERVICE.transport.node.targetEnvironmentVariable}\` (defaults to \`${nodeDevelopmentOrigin(AUTH_SERVICE)}\`).`
	const ownershipBoundary = hasAuth
		? `Better Auth configuration and secrets stay private to \`${AUTH_SERVICE.workspacePath}/\`. \`packages/backend/\` owns reusable data access and use cases, including the generated users data access that reads \`authSchema.user\` for domain use cases. \`${USERS_SERVICE.workspacePath}/\` invokes that shared users use case as a transport/runtime adapter through \`@repo/backend/core/use-cases/users\`.`
		: `Authentication is disabled, so no auth schema or shared users use case is generated. Keep future reusable data access in \`packages/backend/\` instead of this transport/runtime adapter.`

	return `# ${honoServiceName(project, USERS_SERVICE)}

This private service for user-facing resources is a transport/runtime adapter. It is reachable externally only through the gateway. Do not add a direct route, public hostname, or browser-facing service URL.

${ownershipBoundary}

## Boundary

This service adapter MUST NOT:

- Configure Better Auth
- Read \`BETTER_AUTH_SECRET\` or any OAuth secret
- Embed ad hoc database queries; add reusable domain data access to \`packages/backend/\`${
		hasAuth
			? '\n- Resolve session, account, or verification state from the database instead of the private auth transport'
			: ''
	}

${bindingDoc}${bindingDoc ? '\n\n' : ''}${dev}

## Routes and OpenAPI ownership

| Route | Reachability | Description |
| --- | --- | --- |${
		hasAuth
			? `\n| \`GET ${USERS_RESOURCE_PREFIX}/me\` | gateway-forwarded | Returns the current session |`
			: ''
	}
| \`GET /openapi.json\` | private diagnostics | Runtime view of the service contract |

The checked \`openapi.json\` file is a composition input owned by this service. The gateway
composes it into \`apps/api/openapi.json\`, which is the only document used for the public client.
`
}
