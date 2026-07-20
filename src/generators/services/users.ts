import type { FileEntry } from '../../lib/files.js'
import type { GvKitConfig } from '../../schema/config.js'

const COMPATIBILITY_DATE = '2026-04-01'

type Runtime = 'cf-workers' | 'node'

function deriveRuntime(deploy: GvKitConfig['choices']['deploy']): Runtime {
	return deploy === 'cf-workers' ? 'cf-workers' : 'node'
}

/**
 * Emit the `apps/api/users/` service. Reaches auth state only via the
 * `/internal/session` endpoint on the auth service.
 */
export function generateUsersService(cfg: GvKitConfig): FileEntry[] {
	return cfg.choices.backendRuntime === 'effect'
		? generateEffectUsersService(cfg)
		: generatePromiseUsersService(cfg)
}

function generatePromiseUsersService(cfg: GvKitConfig): FileEntry[] {
	const project = cfg.choices.name
	const usesSqlite = cfg.choices.db === 'sqlite'
	const runtime = deriveRuntime(cfg.choices.deploy)
	const hasAuth = cfg.choices.auth.length > 0

	const entries: FileEntry[] = [
		{
			path: 'apps/api/users/package.json',
			content: promisePkgJson({ project, runtime })
		},
		{
			path: 'apps/api/users/tsconfig.json',
			content: tsconfig(runtime)
		},
		{
			path: 'apps/api/users/env.d.ts',
			content: envDts({ runtime, usesSqlite })
		},
		{
			path: 'apps/api/users/src/routes/me/schema.ts',
			content: meSchemaTs(hasAuth)
		},
		{
			path: 'apps/api/users/src/routes/me/route.ts',
			content: meRouteTs()
		},
		{
			path: 'apps/api/users/src/routes/me/handler.ts',
			content: meHandlerTs({ hasAuth, runtime, usesSqlite })
		},
		{
			path: 'apps/api/users/src/routes/me/index.ts',
			content: meIndexTs()
		},
		{
			path: 'apps/api/users/src/openapi.ts',
			content: openapiTs(project)
		},
		{
			path: 'apps/api/users/openapi.json',
			content: usersPromiseOpenApiJson(project)
		},
		{
			path: 'apps/api/users/src/app.ts',
			content: appTs()
		},
		{
			path: 'apps/api/users/src/index.ts',
			content: indexTs(runtime)
		},
		{
			path: 'apps/api/users/README.md',
			content: promiseReadme(project, runtime)
		}
	]

	if (runtime === 'cf-workers') {
		entries.push({
			path: 'apps/api/users/wrangler.jsonc',
			content: promiseWranglerJsonc({ project, usesSqlite })
		})
	}

	return entries
}

function generateEffectUsersService(cfg: GvKitConfig): FileEntry[] {
	const project = cfg.choices.name
	const usesSqlite = cfg.choices.db === 'sqlite'
	const runtime = deriveRuntime(cfg.choices.deploy)
	const hasAuth = cfg.choices.auth.length > 0

	const entries: FileEntry[] = [
		{
			path: 'apps/api/users/package.json',
			content: effectPkgJson({ project, runtime })
		},
		{ path: 'apps/api/users/tsconfig.json', content: tsconfig(runtime) },
		{ path: 'apps/api/users/env.d.ts', content: envDts({ runtime, usesSqlite }) },
		{
			path: 'apps/api/users/src/infrastructure/auth-client.ts',
			content: authClientEffectTs(runtime)
		},
		...(hasAuth
			? [
					{
						path: 'apps/api/users/src/infrastructure/database.ts',
						content: databaseEffectTs({ runtime, usesSqlite })
					}
				]
			: []),
		{
			path: 'apps/api/users/src/features/me/errors.ts',
			content: meEffectErrorsTs(hasAuth)
		},
		{
			path: 'apps/api/users/src/features/me/workflow.ts',
			content: getMeEffectTs(hasAuth)
		},
		{
			path: 'apps/api/users/src/features/me/workflow.test.ts',
			content: getMeEffectTestTs(runtime, hasAuth)
		},
		{
			path: 'apps/api/users/src/features/me/schema.ts',
			content: meEffectSchemaTs(hasAuth)
		},
		{ path: 'apps/api/users/src/features/me/route.ts', content: meEffectRouteTs() },
		{
			path: 'apps/api/users/src/features/me/handler.ts',
			content: meEffectHandlerTs(hasAuth)
		},
		{ path: 'apps/api/users/src/features/me/router.ts', content: meEffectRouterTs() },
		{ path: 'apps/api/users/src/openapi.ts', content: openapiEffectTs(project) },
		{ path: 'apps/api/users/src/app.ts', content: appEffectTs() },
		{ path: 'apps/api/users/src/index.ts', content: indexTs(runtime) },
		{ path: 'apps/api/users/README.md', content: effectReadme(project, runtime) }
	]

	if (runtime === 'cf-workers')
		entries.push({
			path: 'apps/api/users/wrangler.jsonc',
			content: effectWranglerJsonc({ project, usesSqlite })
		})

	return entries
}

function promisePkgJson({ project, runtime }: { project: string; runtime: Runtime }): string {
	return renderPkgJson({
		project,
		runtime,
		dependencies: {
			'@hono/zod-openapi': '^1.0.0',
			'@repo/backend': 'workspace:*',
			'@repo/db': 'workspace:*',
			hono: '^4.6.0',
			zod: '^4.3.0'
		},
		cfBuild: 'pnpm cf-typegen && wrangler deploy --dry-run --outdir=dist'
	})
}

function effectPkgJson({ project, runtime }: { project: string; runtime: Runtime }): string {
	return renderPkgJson({
		project,
		runtime,
		dependencies: {
			'@hono/standard-validator': '^0.2.2',
			'@repo/backend': 'workspace:*',
			'@repo/db': 'workspace:*',
			'@standard-community/standard-json': '^0.3.5',
			'@standard-community/standard-openapi': '^0.2.9',
			'@types/json-schema': '^7.0.15',
			'drizzle-orm': '^0.45.0',
			effect: '^3.21.2',
			hono: '^4.12.0',
			'hono-openapi': '^1.3.0',
			'openapi-types': '^12.1.3'
		},
		cfBuild: 'pnpm cf-typegen && wrangler deploy --dry-run --strict --outdir=dist',
		nodeBuild: 'tsup src/index.ts --format esm --target=node20 --out-dir dist',
		extraScripts: {
			test: 'vitest run'
		},
		extraDevDependencies: {
			vitest: '^4.1.7'
		}
	})
}

function renderPkgJson({
	project,
	runtime,
	dependencies,
	cfBuild,
	nodeBuild = 'tsup src/index.ts --format esm --target=node20 --outdir dist',
	extraScripts = {},
	extraDevDependencies = {}
}: {
	project: string
	runtime: Runtime
	dependencies: Record<string, string>
	cfBuild: string
	nodeBuild?: string
	extraScripts?: Record<string, string>
	extraDevDependencies?: Record<string, string>
}): string {
	const devDependencies: Record<string, string> = {
		'@repo/tooling-typescript': 'workspace:*',
		typescript: '~5.9.0',
		...extraDevDependencies
	}
	const scripts: Record<string, string> = {
		typecheck: 'tsc --noEmit',
		lint: 'eslint .',
		...extraScripts
	}

	if (runtime === 'cf-workers') {
		devDependencies.wrangler = '^4.0.0'
		devDependencies['@cloudflare/workers-types'] = '^4.20251101.0'
		devDependencies['@types/node'] = '^22.10.0'
		scripts['cf-typegen'] = 'wrangler types'
		scripts.dev = 'pnpm cf-typegen && wrangler dev'
		scripts.build = cfBuild
		scripts.deploy = 'pnpm cf-typegen && wrangler deploy'
		scripts['deploy:production'] = 'pnpm cf-typegen && wrangler deploy'
		scripts['deploy:staging'] =
			`pnpm cf-typegen && test -n "$STAGING_ALIAS" && wrangler deploy --config "\${STAGING_WRANGLER_CONFIG:-wrangler.jsonc}" --name ${project}-users-$STAGING_ALIAS`
		scripts.typecheck = 'pnpm cf-typegen && tsc --noEmit'
	} else {
		dependencies['@hono/node-server'] = '^1.13.0'
		devDependencies.tsup = '^8.3.0'
		devDependencies.tsx = '^4.19.0'
		devDependencies['@types/node'] = '^22.10.0'
		scripts.dev = 'tsx watch src/index.ts'
		scripts.build = nodeBuild
		scripts.start = 'node dist/index.js'
	}

	return (
		JSON.stringify(
			{
				name: `@${project}/users-worker`,
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

function promiseWranglerJsonc({
	project,
	usesSqlite
}: {
	project: string
	usesSqlite: boolean
}): string {
	return renderWranglerJsonc({ project, usesSqlite, migrationsLine: '' })
}

function effectWranglerJsonc({
	project,
	usesSqlite
}: {
	project: string
	usesSqlite: boolean
}): string {
	return renderWranglerJsonc({
		project,
		usesSqlite,
		migrationsLine: ',\n\t\t\t"migrations_dir": "../../../packages/db/migrations"'
	})
}

function renderWranglerJsonc({
	project,
	usesSqlite,
	migrationsLine
}: {
	project: string
	usesSqlite: boolean
	migrationsLine: string
}): string {
	const dbBlock = usesSqlite
		? `,
	"d1_databases": [
		{
			"binding": "DB",
			"database_name": "${project}-db",
			"database_id": "<run: wrangler d1 create ${project}-db>"${migrationsLine}
		}
	]`
		: `,
	"vars": {}`

	return `{
	"$schema": "node_modules/wrangler/config-schema.json",
	"name": "${project}-users",
	"main": "src/index.ts",
	"compatibility_date": "${COMPATIBILITY_DATE}",
	"compatibility_flags": ["nodejs_compat"],
	"routes": [
		{ "pattern": "api.<domain>", "custom_domain": true }
	],
	"dev": {
		"ip": "127.0.0.1",
		"port": 8788,
		"host": "localhost",
		"inspector_port": 9230
	},
	"services": [
		{ "binding": "AUTH", "service": "${project}-auth" }
	],
	"observability": { "enabled": true }${dbBlock}
}
`
}

function envDts({ runtime, usesSqlite }: { runtime: Runtime; usesSqlite: boolean }): string {
	if (runtime === 'cf-workers') {
		const dbBinding = usesSqlite
			? '\t\tDB: D1Database'
			: '\t\tDATABASE_URL: string\n\t\tHYPERDRIVE?: Hyperdrive'

		return `// Hand-edited Env declaration; merges with wrangler-generated worker-configuration.d.ts.
declare global {
	interface Env {
		AUTH: Fetcher
${dbBinding}
	}
}

export {}
`
	}

	const nodeDb = usesSqlite ? '\t\tSQLITE_PATH?: string' : '\t\tDATABASE_URL?: string'

	return `// Hand-edited Env declaration; merges with wrangler-generated worker-configuration.d.ts.
declare global {
	interface Env {
		AUTH_URL: string
${nodeDb}
	}
}

export {}
`
}

function authClientEffectTs(runtime: Runtime): string {
	const request =
		runtime === 'cf-workers'
			? `const binding = env.AUTH
\tif (!binding) return Effect.fail(
\t\t\tnew AuthTransportFailure({
\t\t\t\tmessage: 'auth binding unavailable',
\t\t\t\tcode: 'AUTH_BINDING_UNAVAILABLE'
\t\t\t})
\t\t)
\treturn Effect.tryPromise({
\t\ttry: () => binding.fetch(new Request('https://internal' + path, { headers })),
\t\tcatch: (cause) =>
\t\t\tnew AuthTransportFailure({
\t\t\t\tmessage: 'auth transport failed',
\t\t\t\tcode: 'AUTH_TRANSPORT_FAILED',
\t\t\t\tcause
\t\t\t})
\t})`
			: `const base = env.AUTH_URL || process.env.AUTH_URL
\tif (!base) return Effect.fail(
\t\t\tnew AuthTransportFailure({
\t\t\t\tmessage: 'auth service URL unavailable',
\t\t\t\tcode: 'AUTH_URL_UNAVAILABLE'
\t\t\t})
\t\t)
\treturn Effect.tryPromise({
\t\ttry: () => fetch(base + path, { headers }),
\t\tcatch: (cause) =>
\t\t\tnew AuthTransportFailure({
\t\t\t\tmessage: 'auth transport failed',
\t\t\t\tcode: 'AUTH_TRANSPORT_FAILED',
\t\t\t\tcause
\t\t\t})
\t})`

	return `import { Context, Data, Effect, Layer, Schema } from 'effect'

type FailureFields = { message: string; code: string; cause?: unknown }

export class Unauthorized extends Data.TaggedError('Unauthorized')<FailureFields> {}
export class Forbidden extends Data.TaggedError('Forbidden')<FailureFields> {}
export class AuthUpstreamFailure extends Data.TaggedError('AuthUpstreamFailure')<FailureFields> {}
export class AuthTransportFailure extends Data.TaggedError('AuthTransportFailure')<FailureFields> {}
export class AuthMalformedJson extends Data.TaggedError('AuthMalformedJson')<FailureFields> {}
export class AuthInvalidPayload extends Data.TaggedError('AuthInvalidPayload')<FailureFields> {}

export type AuthClientFailure =
\t| Unauthorized
\t| Forbidden
\t| AuthUpstreamFailure
\t| AuthTransportFailure
\t| AuthMalformedJson
\t| AuthInvalidPayload

export const AuthSessionSchema = Schema.Struct({
\tuserId: Schema.String,
\tsessionId: Schema.String,
\texpiresAt: Schema.String
})

export type AuthSession = Schema.Schema.Type<typeof AuthSessionSchema>

export type AuthClientShape = {
\treadonly resolve: Effect.Effect<AuthSession, AuthClientFailure>
}

export class AuthClient extends Context.Tag('users/AuthClient')<AuthClient, AuthClientShape>() {}

function requestSession(env: Env, request: Request) {
\tconst headers = new Headers()
\tfor (const name of ['cookie', 'authorization']) {
\t\tconst value = request.headers.get(name)
\t\tif (value) headers.set(name, value)
\t}
\tconst path = '/internal/session'
\t${request}
}

function decodeSuccess(response: Response) {
\treturn Effect.tryPromise({
\t\ttry: () => response.text(),
\t\tcatch: (cause) =>
\t\t\tnew AuthTransportFailure({
\t\t\t\tmessage: 'failed to read auth response',
\t\t\t\tcode: 'AUTH_RESPONSE_READ_FAILED',
\t\t\t\tcause
\t\t\t})
\t}).pipe(
\t\tEffect.flatMap((text) =>
\t\t\tEffect.try({
\t\t\t\ttry: () => JSON.parse(text) as unknown,
\t\t\t\tcatch: (cause) =>
\t\t\t\t\tnew AuthMalformedJson({
\t\t\t\t\t\tmessage: 'auth response was not valid JSON',
\t\t\t\t\t\tcode: 'AUTH_MALFORMED_JSON',
\t\t\t\t\t\tcause
\t\t\t\t\t})
\t\t\t})
\t\t),
\t\tEffect.flatMap((payload) =>
\t\t\tSchema.decodeUnknown(AuthSessionSchema)(payload).pipe(
\t\t\t\tEffect.mapError(
\t\t\t\t\t(cause) =>
\t\t\t\t\t\tnew AuthInvalidPayload({
\t\t\t\t\t\t\tmessage: 'auth response did not match the session contract',
\t\t\t\t\t\t\tcode: 'AUTH_INVALID_PAYLOAD',
\t\t\t\t\t\t\tcause
\t\t\t\t\t\t})
\t\t\t\t)
\t\t\t)
\t\t)
\t)
}

function resolveSession(
\tenv: Env,
\trequest: Request
): Effect.Effect<AuthSession, AuthClientFailure> {
\treturn Effect.gen(function* () {
\t\tconst response = yield* requestSession(env, request)
\t\tif (response.status === 401) return yield* Effect.fail(
\t\t\t\tnew Unauthorized({ message: 'unauthorized', code: 'AUTH_UNAUTHORIZED' })
\t\t\t)
\t\tif (response.status === 403) return yield* Effect.fail(
\t\t\t\tnew Forbidden({ message: 'forbidden', code: 'AUTH_FORBIDDEN' })
\t\t\t)
\t\tif (!response.ok) return yield* Effect.fail(
\t\t\t\tnew AuthUpstreamFailure({
\t\t\t\t\tmessage: 'auth service failed',
\t\t\t\t\tcode: 'AUTH_UPSTREAM_FAILURE'
\t\t\t\t})
\t\t\t)
\t\treturn yield* decodeSuccess(response)
\t})
}

export function makeAuthClientLayer(env: Env, request: Request) {
\treturn Layer.succeed(AuthClient, { resolve: resolveSession(env, request) })
}
`
}

function databaseEffectTs({
	runtime,
	usesSqlite
}: {
	runtime: Runtime
	usesSqlite: boolean
}): string {
	const envParameter = runtime === 'cf-workers' ? 'env: Env' : '_env: Env'
	const dbConstruction =
		runtime === 'cf-workers'
			? usesSqlite
				? 'createDb({ DB: env.DB })'
				: 'createDb({ HYPERDRIVE: env.HYPERDRIVE, DATABASE_URL: env.DATABASE_URL })'
			: usesSqlite
				? `createDb({ url: process.env.SQLITE_PATH ?? 'file:./local.db' })`
				: `createDb({ DATABASE_URL: process.env.DATABASE_URL ?? '' })`

	return `import { authSchema } from '@repo/db'
import { createDb } from '@repo/db/client'
import { eq } from 'drizzle-orm'
import { Context, Data, Effect, Layer } from 'effect'

type FailureFields = { message: string; code: string; cause?: unknown }

export class DatabaseFailure extends Data.TaggedError('DatabaseFailure')<FailureFields> {}

export type DatabaseUser = typeof authSchema.user.$inferSelect

export type DatabaseShape = {
\treadonly findUserById: (
\t\tuserId: string
\t) => Effect.Effect<DatabaseUser | null, DatabaseFailure>
}

export class Database extends Context.Tag('users/Database')<Database, DatabaseShape>() {}

export function makeDatabaseLayer(${envParameter}) {
\treturn Layer.succeed(Database, {
\t\tfindUserById: (userId) =>
\t\t\tEffect.tryPromise({
\t\t\t\ttry: async () => {
\t\t\t\t\tconst db = ${dbConstruction}
\t\t\t\t\tconst rows = await db
\t\t\t\t\t\t.select()
\t\t\t\t\t\t.from(authSchema.user)
\t\t\t\t\t\t.where(eq(authSchema.user.id, userId))
\t\t\t\t\t\t.limit(1)
\t\t\t\t\treturn rows[0] ?? null
\t\t\t\t},
\t\t\t\tcatch: (cause) =>
\t\t\t\t\tnew DatabaseFailure({
\t\t\t\t\t\tmessage: 'failed to load user',
\t\t\t\t\t\tcode: 'DATABASE_USER_LOOKUP_FAILED',
\t\t\t\t\t\tcause
\t\t\t\t\t})
\t\t\t})
\t})
}
`
}

function meEffectErrorsTs(hasAuth: boolean): string {
	if (!hasAuth)
		return `import type { AuthClientFailure } from '../../infrastructure/auth-client.js'

export type GetMeFailure = AuthClientFailure
`

	return `import { Data } from 'effect'

import type { AuthClientFailure } from '../../infrastructure/auth-client.js'
import type { DatabaseFailure } from '../../infrastructure/database.js'

type FailureFields = { message: string; code: string; cause?: unknown }

export class UserNotFound extends Data.TaggedError('UserNotFound')<FailureFields> {}

export type GetMeFailure = AuthClientFailure | DatabaseFailure | UserNotFound
`
}

function getMeEffectTs(hasAuth: boolean): string {
	const domain = hasAuth
		? `const database = yield* Database
\tconst session = yield* authClient.resolve
\tconst user = yield* database.findUserById(session.userId)
\tif (!user) return yield* new UserNotFound({ message: 'user not found', code: 'USER_NOT_FOUND' })
\treturn {
\t\t...user,
\t\tcreatedAt: user.createdAt.toISOString(),
\t\tupdatedAt: user.updatedAt.toISOString()
\t}`
		: `const session = yield* authClient.resolve
\treturn { id: session.userId, sessionId: session.sessionId, expiresAt: session.expiresAt }`
	const databaseImport = hasAuth
		? `import { Database } from '../../infrastructure/database.js'\n`
		: ''
	const errorImport = hasAuth ? `import { UserNotFound } from './errors.js'\n` : ''

	return `import { Effect } from 'effect'

import { AuthClient } from '../../infrastructure/auth-client.js'
${databaseImport}${errorImport}
export const getMeWorkflow = Effect.gen(function* () {
\tconst authClient = yield* AuthClient
\t${domain}
})
`
}

function getMeEffectTestTs(runtime: Runtime, hasAuth: boolean): string {
	const envFactory =
		runtime === 'cf-workers'
			? `return { AUTH: { fetch: fetcher } } as unknown as Env`
			: `vi.spyOn(globalThis, 'fetch').mockImplementation(fetcher as typeof fetch)
\treturn { AUTH_URL: 'https://auth.test' } as Env`
	const workflowExpectation = hasAuth
		? `expect(result).toEqual({
\t\t\t...user,
\t\t\tcreatedAt: '2026-01-01T00:00:00.000Z',
\t\t\tupdatedAt: '2026-01-02T00:00:00.000Z'
\t\t})`
		: `expect(result).toEqual({
\t\t\tid: session.userId,
\t\t\tsessionId: session.sessionId,
\t\t\texpiresAt: session.expiresAt
\t\t})`
	const persistenceTests = hasAuth
		? `
\ttest('database failure returns typed declared JSON', async () => {
\t\tconst error = new DatabaseFailure({
\t\t\tmessage: 'failed to load user',
\t\t\tcode: 'DATABASE_USER_LOOKUP_FAILED'
\t\t})
\t\tconst result = await requestMe({
\t\t\tfetcher: async () => jsonResponse(session),
\t\t\tdatabase: Effect.fail(error)
\t\t})
\t\texpect(result.response.status).toBe(500)
\t\texpect(result.body).toEqual({
\t\t\terror: error.message,
\t\t\tmessage: error.message,
\t\t\ttag: error._tag,
\t\t\tcode: error.code
\t\t})
\t})

\ttest('missing database user returns declared 404', async () => {
\t\tconst result = await requestMe({
\t\t\tfetcher: async () => jsonResponse(session),
\t\t\tdatabase: Effect.succeed(null)
\t\t})
\t\texpect(result.response.status).toBe(404)
\t\texpect(result.body.tag).toBe('UserNotFound')
\t})`
		: ''

	const testSource = `import { Effect, Layer } from 'effect'
import { afterEach, describe, expect, test, vi } from 'vitest'

import { createApp } from '../../app.js'
import {
\tAuthInvalidPayload,
\tAuthMalformedJson,
\tAuthTransportFailure,
\tAuthUpstreamFailure,
\tForbidden,
\tUnauthorized,
\tAuthClient,
\ttype AuthSession
} from '../../infrastructure/auth-client.js'
import {
\tDatabase,
\tDatabaseFailure,
\ttype DatabaseUser
} from '../../infrastructure/database.js'
import { getMeWorkflow } from './workflow.js'

const session: AuthSession = {
\tuserId: 'user-1',
\tsessionId: 'session-1',
\texpiresAt: '2030-01-01T00:00:00.000Z'
}

const user: DatabaseUser = {
\tid: 'user-1',
\tname: 'Ada',
\temail: 'ada@example.com',
\temailVerified: true,
\timage: null,
\tcreatedAt: new Date('2026-01-01T00:00:00.000Z'),
\tupdatedAt: new Date('2026-01-02T00:00:00.000Z')
}

function authLayer(result: Effect.Effect<AuthSession, never>) {
\treturn Layer.succeed(AuthClient, { resolve: result })
}

function databaseLayer(
\tresult: Effect.Effect<DatabaseUser | null, DatabaseFailure>
) {
\treturn Layer.succeed(Database, { findUserById: () => result })
}

type AuthFetch = (request: Request) => Promise<Response>

function requestEnv(fetcher: AuthFetch): Env {
\t${envFactory}
}

function jsonResponse(body: unknown, status = 200) {
\treturn new Response(JSON.stringify(body), {
\t\tstatus,
\t\theaders: { 'content-type': 'application/json' }
\t})
}

async function requestMe({
\tfetcher,
\tdatabase = Effect.succeed(user)
}: {
\tfetcher: AuthFetch
\tdatabase?: Effect.Effect<DatabaseUser | null, DatabaseFailure>
}) {
\tconst app = createApp({ makeDatabaseLayer: () => databaseLayer(database) })
\tconst response = await app.request(
\t\t'/api/me',
\t\t{ headers: { cookie: 'better-auth.session_token=test' } },
\t\trequestEnv(fetcher)
\t)
\tconst body = (await response.json()) as Record<string, unknown>
\tconst document = (await (await app.request('/openapi.json')).json()) as {
\t\tpaths: { '/api/me': { get: { responses: Record<string, unknown> } } }
\t}
\texpect(document.paths['/api/me'].get.responses[String(response.status)]).toBeDefined()
\texpect(response.headers.get('content-type')).toContain('application/json')
\treturn { response, body }
}

afterEach(() => vi.restoreAllMocks())

describe('getMeWorkflow', () => {
\ttest('depends on fake AuthClient and Database layers, not Hono values', async () => {
\t\tconst result = await Effect.runPromise(
\t\t\tgetMeWorkflow.pipe(
\t\t\t\tEffect.provide(
\t\t\t\t\tLayer.merge(authLayer(Effect.succeed(session)), databaseLayer(Effect.succeed(user)))
\t\t\t\t)
\t\t\t)
\t\t)

\t\t${workflowExpectation}
\t})
})

describe('users auth binding failure matrix', () => {
\ttest('valid session returns declared valid 200', async () => {
\t\tconst result = await requestMe({ fetcher: async () => jsonResponse(session) })
\t\texpect(result.response.status).toBe(200)
\t\texpect(result.body.id).toBe('user-1')
\t})

\ttest.each([
\t\t{
\t\t\tname: 'malformed 200 (invalid success payload)',
\t\t\tfetcher: async () => jsonResponse({ ...session, userId: 42 }),
\t\t\tstatus: 502,
\t\t\terror: new AuthInvalidPayload({
\t\t\t\tmessage: 'auth response did not match the session contract',
\t\t\t\tcode: 'AUTH_INVALID_PAYLOAD'
\t\t\t})
\t\t},
\t\t{
\t\t\tname: 'no session',
\t\t\tfetcher: async () => jsonResponse({ error: 'unauthorized' }, 401),
\t\t\tstatus: 401,
\t\t\terror: new Unauthorized({ message: 'unauthorized', code: 'AUTH_UNAUTHORIZED' })
\t\t},
\t\t{
\t\t\tname: 'forbidden',
\t\t\tfetcher: async () => jsonResponse({ error: 'forbidden' }, 403),
\t\t\tstatus: 403,
\t\t\terror: new Forbidden({ message: 'forbidden', code: 'AUTH_FORBIDDEN' })
\t\t},
\t\t{
\t\t\tname: 'upstream failure',
\t\t\tfetcher: async () => jsonResponse({ error: 'boom' }, 500),
\t\t\tstatus: 502,
\t\t\terror: new AuthUpstreamFailure({
\t\t\t\tmessage: 'auth service failed',
\t\t\t\tcode: 'AUTH_UPSTREAM_FAILURE'
\t\t\t})
\t\t},
\t\t{
\t\t\tname: 'thrown binding fetch',
\t\t\tfetcher: async () => {
\t\t\t\tthrow new Error('binding unavailable')
\t\t\t},
\t\t\tstatus: 502,
\t\t\terror: new AuthTransportFailure({
\t\t\t\tmessage: 'auth transport failed',
\t\t\t\tcode: 'AUTH_TRANSPORT_FAILED'
\t\t\t})
\t\t},
\t\t{
\t\t\tname: 'invalid JSON',
\t\t\tfetcher: async () => new Response('{', { status: 200 }),
\t\t\tstatus: 502,
\t\t\terror: new AuthMalformedJson({
\t\t\t\tmessage: 'auth response was not valid JSON',
\t\t\t\tcode: 'AUTH_MALFORMED_JSON'
\t\t\t})
\t\t}
\t])('$name returns typed declared JSON', async ({ fetcher, status, error }) => {
\t\tconst result = await requestMe({ fetcher })
\t\texpect(result.response.status).toBe(status)
\t\texpect(result.body).toEqual({
\t\t\terror: error.message,
\t\t\tmessage: error.message,
\t\t\ttag: error._tag,
\t\t\tcode: error.code
\t\t})
\t})

${persistenceTests}
})
`
	if (hasAuth) return testSource
	return testSource
		.replace(
			`import {
\tDatabase,
\tDatabaseFailure,
\ttype DatabaseUser
} from '../../infrastructure/database.js'\n`,
			''
		)
		.replace(
			`\nconst user: DatabaseUser = {
\tid: 'user-1',
\tname: 'Ada',
\temail: 'ada@example.com',
\temailVerified: true,
\timage: null,
\tcreatedAt: new Date('2026-01-01T00:00:00.000Z'),
\tupdatedAt: new Date('2026-01-02T00:00:00.000Z')
}\n`,
			''
		)
		.replace(
			`\nfunction databaseLayer(
\tresult: Effect.Effect<DatabaseUser | null, DatabaseFailure>
) {
\treturn Layer.succeed(Database, { findUserById: () => result })
}\n`,
			''
		)
		.replace(
			`async function requestMe({
\tfetcher,
\tdatabase = Effect.succeed(user)
}: {
\tfetcher: AuthFetch
\tdatabase?: Effect.Effect<DatabaseUser | null, DatabaseFailure>
}) {
\tconst app = createApp({ makeDatabaseLayer: () => databaseLayer(database) })`,
			`async function requestMe({ fetcher }: { fetcher: AuthFetch }) {
\tconst app = createApp()`
		)
		.replace(
			"test('depends on fake AuthClient and Database layers, not Hono values'",
			"test('depends on a fake AuthClient layer, not Hono values'"
		)
		.replace(
			`Effect.provide(
\t\t\t\t\tLayer.merge(authLayer(Effect.succeed(session)), databaseLayer(Effect.succeed(user)))
\t\t\t\t)`,
			'Effect.provide(authLayer(Effect.succeed(session)))'
		)
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

function meEffectSchemaTs(hasAuth: boolean): string {
	if (hasAuth)
		return `import { Schema } from 'effect'

const IsoDateLike = Schema.String

export const UserResponseSchema = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	email: Schema.String,
	emailVerified: Schema.Boolean,
	image: Schema.optional(Schema.NullOr(Schema.String)),
	createdAt: IsoDateLike,
	updatedAt: IsoDateLike
})

export const ErrorResponseSchema = Schema.Struct({
	error: Schema.String,
	message: Schema.String,
	code: Schema.optional(Schema.String),
	tag: Schema.optional(Schema.String)
})

export type UserResponse = Schema.Schema.Type<typeof UserResponseSchema>

export const UserResponseStandard = Schema.standardSchemaV1(UserResponseSchema)
export const ErrorResponseStandard = Schema.standardSchemaV1(ErrorResponseSchema)
`

	return `import { Schema } from 'effect'

export const UserResponseSchema = Schema.Struct({
	id: Schema.String,
	sessionId: Schema.String,
	expiresAt: Schema.String
})

export const ErrorResponseSchema = Schema.Struct({
	error: Schema.String,
	message: Schema.String,
	code: Schema.optional(Schema.String),
	tag: Schema.optional(Schema.String)
})

export type UserResponse = Schema.Schema.Type<typeof UserResponseSchema>

export const UserResponseStandard = Schema.standardSchemaV1(UserResponseSchema)
export const ErrorResponseStandard = Schema.standardSchemaV1(ErrorResponseSchema)
`
}

function meRouteTs(): string {
	return `import { createRoute } from '@hono/zod-openapi'

import { UserResponse } from './schema.js'

export const meRoute = createRoute({
	method: 'get',
	path: '/me',
	operationId: 'getUsersMe',
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

function meEffectRouteTs(): string {
	return `import { describeRoute, resolver } from 'hono-openapi'

import { ErrorResponseStandard, UserResponseStandard } from './schema.js'

export const meRoute = describeRoute({
	operationId: 'getUsersMe',
	tags: ['users'],
	summary: 'Return the authenticated user',
	security: [{ sessionCookie: [] }],
	responses: {
		200: {
			description: 'Authenticated user',
			content: { 'application/json': { schema: resolver(UserResponseStandard) } }
		},
		401: {
			description: 'No active session',
			content: { 'application/json': { schema: resolver(ErrorResponseStandard) } }
		},
		403: {
			description: 'Authenticated caller is forbidden',
			content: { 'application/json': { schema: resolver(ErrorResponseStandard) } }
		},
		404: {
			description: 'User not found',
			content: { 'application/json': { schema: resolver(ErrorResponseStandard) } }
		},
		500: {
			description: 'Database failure',
			content: { 'application/json': { schema: resolver(ErrorResponseStandard) } }
		},
		502: {
			description: 'Auth service boundary failure',
			content: { 'application/json': { schema: resolver(ErrorResponseStandard) } }
		}
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
				: 'createDb({ HYPERDRIVE: c.env.HYPERDRIVE, DATABASE_URL: c.env.DATABASE_URL })'
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

function meEffectHandlerTs(hasAuth: boolean): string {
	const handler = `import { type EffectHttpResponse, runEffectJson } from '@repo/backend/effect/hono'
import { Effect, Layer } from 'effect'
import type { Context } from 'hono'

import { makeAuthClientLayer } from '../../infrastructure/auth-client.js'
import { makeDatabaseLayer } from '../../infrastructure/database.js'
import type { GetMeFailure } from './errors.js'
import { getMeWorkflow } from './workflow.js'

type MeContext = Context<{ Bindings: Env }>
type ErrorResponse = { error: string; message: string; tag: string; code?: string }

export type MeLayerFactories = {
\tmakeAuthClientLayer: typeof makeAuthClientLayer
\tmakeDatabaseLayer: typeof makeDatabaseLayer
}

function errorResponse(error: GetMeFailure): ErrorResponse {
	return { error: error.message, message: error.message, tag: error._tag, code: error.code }
}

function mapMeError(error: GetMeFailure): EffectHttpResponse<ErrorResponse> {
	switch (error._tag) {
		case 'Unauthorized':
			return { status: 401, body: errorResponse(error) }
		case 'Forbidden':
			return { status: 403, body: errorResponse(error) }
		case 'UserNotFound':
			return { status: 404, body: errorResponse(error) }
		case 'DatabaseFailure':
			return { status: 500, body: errorResponse(error) }
		case 'AuthUpstreamFailure':
		case 'AuthTransportFailure':
		case 'AuthMalformedJson':
		case 'AuthInvalidPayload':
			return { status: 502, body: errorResponse(error) }
	}
}

export function makeMeHandler(factories: Partial<MeLayerFactories> = {}) {
	return (c: MeContext) => {
		const authLayer = factories.makeAuthClientLayer
			? factories.makeAuthClientLayer(c.env, c.req.raw)
			: makeAuthClientLayer(c.env, c.req.raw)
		const databaseLayer = factories.makeDatabaseLayer
			? factories.makeDatabaseLayer(c.env)
			: makeDatabaseLayer(c.env)
		const program = getMeWorkflow.pipe(
			Effect.provide(Layer.merge(authLayer, databaseLayer))
		)
		return runEffectJson({
			c,
			program,
			onSuccess: (value) => ({ status: 200, body: value }),
			onFailure: mapMeError
		})
	}
}

export const meHandler = makeMeHandler()
`
	if (hasAuth) return handler
	return handler
		.replace("import { Effect, Layer } from 'effect'", "import { Effect } from 'effect'")
		.replace("import { makeDatabaseLayer } from '../../infrastructure/database.js'\n", '')
		.replace('\n\tmakeDatabaseLayer: typeof makeDatabaseLayer', '')
		.replace("\n\t\tcase 'UserNotFound':\n\t\t\treturn { status: 404, body: errorResponse(error) }", '')
		.replace("\n\t\tcase 'DatabaseFailure':\n\t\t\treturn { status: 500, body: errorResponse(error) }", '')
		.replace(
			`\n\t\tconst databaseLayer = factories.makeDatabaseLayer
\t\t\t? factories.makeDatabaseLayer(c.env)
\t\t\t: makeDatabaseLayer(c.env)`,
			''
		)
		.replace('Effect.provide(Layer.merge(authLayer, databaseLayer))', 'Effect.provide(authLayer)')
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

function meEffectRouterTs(): string {
	return `import { Hono } from 'hono'

import { makeMeHandler, type MeLayerFactories } from './handler.js'
import { meRoute } from './route.js'

export function createMeRouter(factories: Partial<MeLayerFactories> = {}) {
	return new Hono<{ Bindings: Env }>().get('/me', meRoute, makeMeHandler(factories))
}
`
}

function openapiTs(project: string): string {
	return `import type { OpenAPIHono } from '@hono/zod-openapi'
import type { Env as HonoEnv } from 'hono'

export function mountOpenApi<E extends HonoEnv>(app: OpenAPIHono<E>): void {
	app.doc('/openapi.json', {
		openapi: '3.0.0',
		info: { title: '${project}-users', version: '0.0.0' }
	})
}
`
}

function openapiEffectTs(project: string): string {
	return `import type { Env as HonoEnv, Hono } from 'hono'
import { openAPIRouteHandler } from 'hono-openapi'

export function mountOpenApi<E extends HonoEnv>(app: Hono<E>): void {
	app.get(
		'/openapi.json',
		openAPIRouteHandler(app, {
			documentation: {
				servers: [{ url: 'https://api.example.com' }],
				components: {
					securitySchemes: {
						sessionCookie: {
							type: 'apiKey',
							in: 'cookie',
							name: 'better-auth.session_token'
						}
					}
				},
				info: {
					title: '${project}-users',
					version: '0.0.0',
					description: 'OpenAPI generated from Hono routes using Effect Schema',
					license: { name: 'MIT', identifier: 'MIT' }
				}
			}
		})
	)
}
`
}

function usersPromiseOpenApiJson(project: string): string {
	return `{
  "openapi": "3.0.0",
  "info": {
    "title": "${project}-users",
    "version": "0.0.0",
    "description": "Example spec so codegen works out of the box. Regenerate from the live service when routes change."
  },
  "components": {
    "schemas": {
      "User": {
        "type": "object",
        "properties": {
          "id": {
            "type": "string"
          },
          "name": {
            "type": "string"
          },
          "email": {
            "type": "string",
            "format": "email"
          },
          "emailVerified": {
            "type": "boolean"
          },
          "image": {
            "type": "string",
            "nullable": true
          },
          "createdAt": {
            "anyOf": [
              {
                "type": "string"
              },
              {
                "type": "string",
                "format": "date-time"
              }
            ]
          },
          "updatedAt": {
            "anyOf": [
              {
                "type": "string"
              },
              {
                "type": "string",
                "format": "date-time"
              }
            ]
          }
        },
        "required": [
          "id",
          "name",
          "email",
          "emailVerified",
          "createdAt",
          "updatedAt"
        ]
      }
    },
    "parameters": {}
  },
  "paths": {
    "/api/me": {
      "get": {
        "operationId": "getUsersMe",
        "tags": [
          "users"
        ],
        "summary": "Return the authenticated user",
        "responses": {
          "200": {
            "description": "Authenticated user",
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/User"
                }
              }
            }
          },
          "401": {
            "description": "No active session"
          }
        }
      }
    }
  }
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

app.use('*', logger())
app.use('*', errorHandler())

app.get('/healthz', (c) => c.text('ok'))

// /api/* requires a valid session.
app.use('/api/*', requireAuth)

app.route('/api', meRouter)

mountOpenApi(app)
`
}

function appEffectTs(): string {
	return `import { logger } from '@repo/backend/hono/logger'
import { Hono } from 'hono'

import type { MeLayerFactories } from './features/me/handler.js'
import { createMeRouter } from './features/me/router.js'
import { mountOpenApi } from './openapi.js'

export function createApp(factories: Partial<MeLayerFactories> = {}) {
	const app = new Hono<{ Bindings: Env }>()

	app.use('*', logger())

	app.get('/healthz', (c) => c.text('ok'))

	app.route('/api', createMeRouter(factories))

	mountOpenApi(app)
	return app
}

export const app = createApp()
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

const port = Number(process.env.PORT ?? 8788)
serve({ fetch: app.fetch, port })
console.log(\`users listening on http://127.0.0.1:\${port}\`)
`
}

function promiseReadme(project: string, runtime: Runtime): string {
	return renderReadme({
		project,
		runtime,
		authBoundary: 'The middleware in `@repo/backend/middleware/auth`'
	})
}

function effectReadme(project: string, runtime: Runtime): string {
	return (
		renderReadme({
			project,
			runtime,
			authBoundary: 'The users-local `src/infrastructure/auth-client.ts` adapter'
		}) + EFFECT_USERS_README
	)
}

const EFFECT_USERS_README = `
## Hono + Effect request boundary

Hono owns routing, validation, request-scoped layer construction, response
serialization, and HTTP status codes. Each vertical slice under
\`src/features/\` owns its route contract, handler, workflow, and typed failures;
workflows must not receive Hono contexts or HTTP-shaped errors. Concrete
service adapters stay under \`src/infrastructure/\`.

For each Hono request, the handler constructs only the service layers the
workflow consumes: users-local \`AuthClient\` and \`Database\`. Their factories
use the Worker \`env\`, the \`AUTH\` service binding, D1, and headers from the
incoming \`Request\`. The raw request remains an adapter value; do not invent an
\`IncomingRequest\` tag just to wrap it. Likewise, keep an execution context at
the Hono boundary until cancellation or background-work semantics require a
real service. Do not hide bindings in Effect \`Config\` or capture concrete
clients inside a workflow. Each inter-service client stays beside its consumer
and decodes a successful upstream payload with Effect Schema before application
logic uses it.

## Runtime API contract

Effect Schema crosses \`Schema.standardSchemaV1\` into Standard Schema
validation and \`hono-openapi\`. Routes declare response schemas explicitly;
the assembled runtime \`/openapi.json\` is the only Hey API input. After a
route or schema change, start this service and run \`pnpm client:generate\`.
Hey API reads \`OPENAPI_URL\`, defaulting to the local route at
\`http://localhost:8788/openapi.json\`; no OpenAPI file is materialized. The
normal root typecheck verifies the generated consumer. Extend these checks
before adding Effect Schema shapes that could change OpenAPI \`$ref\` or
\`components\` output.
`

function renderReadme({
	project,
	runtime,
	authBoundary
}: {
	project: string
	runtime: Runtime
	authBoundary: string
}): string {
	const bindingDoc =
		runtime === 'cf-workers'
			? `Session validation is delegated to the auth Worker via:

\`\`\`
services: [{ binding: "AUTH", service: "${project}-auth" }]
\`\`\`

${authBoundary} calls \`/internal/session\`
on that binding. **Do not extract auth state into this service.**`
			: `Session validation is delegated to the auth service via HTTP using the
\`AUTH_URL\` environment variable (defaults to \`http://127.0.0.1:8787\` in
dev). ${authBoundary} calls
\`/internal/session\` on that URL. **Do not extract auth state into this
service.**`

	const dev =
		runtime === 'cf-workers'
			? `## Local dev

\`\`\`bash
# Terminal 1
cd ../auth && pnpm dev

# Terminal 2
AUTH_URL=http://localhost:8787 pnpm dev
\`\`\`

In production, the \`AUTH\` service binding is used and \`AUTH_URL\` is unset.`
			: `## Local dev

\`\`\`bash
# Terminal 1
cd ../auth && pnpm dev

# Terminal 2
pnpm dev
\`\`\`

The server listens on \`http://127.0.0.1:\${PORT ?? 8788}\` and reaches the
auth service via \`AUTH_URL\` (defaults to \`http://127.0.0.1:8787\`).`

	return `# ${project}-users

Application service for user-facing resources. **Does not own auth state.**

## Boundary

This service MUST NOT:

- Import \`@repo/backend/auth\`
- Read \`BETTER_AUTH_SECRET\` or any OAuth secret
- Query auth tables (\`account\`, \`session\`, \`verification\`, etc.) directly

${bindingDoc}

${dev}

## Routes

| Route          | Auth     | Description                  |
|----------------|----------|------------------------------|
| \`GET /api/me\`  | required | Returns the current session  |
| \`GET /openapi.json\` | public | OpenAPI spec for clients     |
`
}
