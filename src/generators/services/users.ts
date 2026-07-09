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
	const project = cfg.choices.name
	const usesSqlite = cfg.choices.db === 'sqlite'
	const runtime = deriveRuntime(cfg.choices.deploy)
	const hasAuth = cfg.choices.auth.length > 0
	const effectMode = cfg.choices.backendRuntime === 'effect'

	const envDeclPath = 'apps/api/users/env.d.ts'

	const entries: FileEntry[] = [
		{
			path: 'apps/api/users/package.json',
			content: pkgJson({ project, runtime, usesSqlite, effectMode })
		},
		{
			path: 'apps/api/users/tsconfig.json',
			content: tsconfig(runtime)
		},
		{
			path: envDeclPath,
			content: envDts({ runtime, usesSqlite })
		},
		{
			path: 'apps/api/users/src/routes/me/schema.ts',
			content: effectMode ? meEffectSchemaTs(hasAuth) : meSchemaTs(hasAuth)
		},
		{
			path: 'apps/api/users/src/routes/me/route.ts',
			content: effectMode ? meEffectRouteTs() : meRouteTs()
		},
		{
			path: 'apps/api/users/src/routes/me/handler.ts',
			content: effectMode
				? meEffectHandlerTs({ hasAuth, runtime, usesSqlite })
				: meHandlerTs({ hasAuth, runtime, usesSqlite })
		},
		{
			path: 'apps/api/users/src/routes/me/index.ts',
			content: effectMode ? meEffectIndexTs() : meIndexTs()
		},
		...(effectMode
			? [
					{
						path: 'apps/api/users/src/routes/example-posts/schema.ts',
						content: examplePostEffectSchemaTs()
					},
					{
						path: 'apps/api/users/src/routes/example-posts/route.ts',
						content: examplePostEffectRouteTs()
					},
					{
						path: 'apps/api/users/src/routes/example-posts/handler.ts',
						content: examplePostEffectHandlerTs({ runtime, usesSqlite })
					},
					{
						path: 'apps/api/users/src/routes/example-posts/index.ts',
						content: examplePostEffectIndexTs()
					}
				]
			: []),
		{
			path: 'apps/api/users/src/openapi.ts',
			content: effectMode ? openapiEffectTs(project) : openapiTs(project)
		},
		{
			path: 'apps/api/users/openapi.json',
			content: usersOpenApiJson(project, effectMode)
		},
		{
			path: 'apps/api/users/src/app.ts',
			content: effectMode ? appEffectTs() : appTs()
		},
		{
			path: 'apps/api/users/src/index.ts',
			content: indexTs(runtime)
		},
		{
			path: 'apps/api/users/README.md',
			content: readme(project, runtime)
		}
	]

	if (runtime === 'cf-workers') {
		entries.push({
			path: 'apps/api/users/wrangler.jsonc',
			content: wranglerJsonc({ project, usesSqlite })
		})
	}

	return entries
}

function pkgJson({
	project,
	runtime,
	usesSqlite: _usesSqlite,
	effectMode
}: {
	project: string
	runtime: Runtime
	usesSqlite: boolean
	effectMode: boolean
}): string {
	const dependencies: Record<string, string> = effectMode
		? {
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
			}
		: {
				'@hono/zod-openapi': '^1.0.0',
				'@repo/backend': 'workspace:*',
				'@repo/db': 'workspace:*',
				hono: '^4.6.0',
				zod: '^4.3.0'
			}
	const devDependencies: Record<string, string> = {
		'@repo/tooling-typescript': 'workspace:*',
		typescript: '~5.9.0'
	}
	const scripts: Record<string, string> = {
		typecheck: 'tsc --noEmit',
		lint: 'eslint .'
	}

	if (runtime === 'cf-workers') {
		devDependencies.wrangler = '^4.0.0'
		devDependencies['@cloudflare/workers-types'] = '^4.20251101.0'
		devDependencies['@types/node'] = '^22.10.0'
		scripts['cf-typegen'] = 'wrangler types'
		scripts.dev = 'pnpm cf-typegen && wrangler dev'
		scripts.build = 'pnpm cf-typegen && wrangler deploy --dry-run --strict --outdir=dist'
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
		scripts.build = 'tsup src/index.ts --format esm --target=node20 --outdir dist'
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

function wranglerJsonc({ project, usesSqlite }: { project: string; usesSqlite: boolean }): string {
	const dbBlock = usesSqlite
		? `,
	"d1_databases": [
		{
			"binding": "DB",
			"database_name": "${project}-db",
			"database_id": "<run: wrangler d1 create ${project}-db>",
			"migrations_dir": "../../../packages/db/migrations"
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
	if (hasAuth) {
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
	}

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
	responses: {
		200: {
			description: 'Authenticated user',
			content: { 'application/json': { schema: resolver(UserResponseStandard) } }
		},
		401: {
			description: 'No active session',
			content: { 'application/json': { schema: resolver(ErrorResponseStandard) } }
		},
		404: {
			description: 'User not found',
			content: { 'application/json': { schema: resolver(ErrorResponseStandard) } }
		},
		500: {
			description: 'Unhandled service failure',
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
	import type { SessionLike } from '@repo/backend/hono/auth/client'

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
	import type { SessionLike } from '@repo/backend/hono/auth/client'
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

function meEffectHandlerTs({
	hasAuth,
	runtime,
	usesSqlite
}: {
	hasAuth: boolean
	runtime: Runtime
	usesSqlite: boolean
}): string {
	if (!hasAuth) {
		return `import { Effect } from 'effect'
import { runEffectJson } from '@repo/backend/effect/hono'
	import type { SessionLike } from '@repo/backend/hono/auth/client'
import type { Context } from 'hono'

type MeContext = Context<{ Bindings: Env; Variables: { user: SessionLike } }>

export const meHandler = (c: MeContext) => {
	const session = c.get('user')
	return runEffectJson(
		c,
		Effect.succeed({
			id: session.userId,
			sessionId: session.sessionId,
			expiresAt: session.expiresAt
		})
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

	return `import { runEffectJson } from '@repo/backend/effect/hono'
import { getMeUseCase } from '@repo/backend/core/use-cases/users'
	import type { SessionLike } from '@repo/backend/hono/auth/client'
import { createDb } from '@repo/db/client'
import type { Context } from 'hono'

type MeContext = Context<{ Bindings: Env; Variables: { user: SessionLike } }>

export const meHandler = (c: MeContext) => {
	const session = c.get('user')
	const db = ${dbConstruction}
	return runEffectJson(c, getMeUseCase(db, session.userId))
}
`
}

function meIndexTs(): string {
	return `import { OpenAPIHono } from '@hono/zod-openapi'
	import type { SessionLike } from '@repo/backend/hono/auth/client'

import { meHandler } from './handler.js'
import { meRoute } from './route.js'

export const meRouter = new OpenAPIHono<{
	Bindings: Env
	Variables: { user: SessionLike }
}>().openapi(meRoute, meHandler)
`
}

function meEffectIndexTs(): string {
	return `import type { SessionLike } from '@repo/backend/hono/auth/client'
import { Hono } from 'hono'

import { meHandler } from './handler.js'
import { meRoute } from './route.js'

export const meRouter = new Hono<{
	Bindings: Env
	Variables: { user: SessionLike }
}>().get('/me', meRoute, meHandler)
`
}

function examplePostEffectSchemaTs(): string {
	return `import { Schema } from 'effect'

export const ExamplePostParamSchema = Schema.Struct({
	id: Schema.String
})

export const ExamplePostQuerySchema = Schema.Struct({
	includeBody: Schema.optional(Schema.Literal('true', 'false'))
})

export const ExamplePostBodySchema = Schema.Struct({
	title: Schema.String,
	body: Schema.String,
	summary: Schema.optionalWith(Schema.NullOr(Schema.String), { exact: true }),
	occurredAt: Schema.String
})

export const ExamplePostResponseSchema = Schema.Struct({
	id: Schema.String,
	title: Schema.String,
	body: Schema.optional(Schema.String),
	summary: Schema.NullOr(Schema.String),
	occurredAt: Schema.String,
	createdAt: Schema.String
})

export const ErrorResponseSchema = Schema.Struct({
	error: Schema.String,
	message: Schema.String,
	code: Schema.optional(Schema.String),
	tag: Schema.optional(Schema.String)
})

export const ExamplePostParamStandard = Schema.standardSchemaV1(ExamplePostParamSchema)
export const ExamplePostQueryStandard = Schema.standardSchemaV1(ExamplePostQuerySchema)
export const ExamplePostBodyStandard = Schema.standardSchemaV1(ExamplePostBodySchema)
export const ExamplePostResponseStandard = Schema.standardSchemaV1(ExamplePostResponseSchema)
export const ErrorResponseStandard = Schema.standardSchemaV1(ErrorResponseSchema)
`
}

function examplePostEffectRouteTs(): string {
	return `import { describeRoute, resolver, validator } from 'hono-openapi'

import {
	ErrorResponseStandard,
	ExamplePostBodyStandard,
	ExamplePostParamStandard,
	ExamplePostQueryStandard,
	ExamplePostResponseStandard
} from './schema.js'

export const examplePostRoute = [
	validator('param', ExamplePostParamStandard),
	validator('query', ExamplePostQueryStandard),
	validator('json', ExamplePostBodyStandard),
	describeRoute({
		operationId: 'upsertExamplePost',
		tags: ['examples'],
		summary: 'Upsert an example post',
		responses: {
			200: {
				description: 'Stored example post',
				content: { 'application/json': { schema: resolver(ExamplePostResponseStandard) } }
			},
			400: {
				description: 'Invalid input',
				content: { 'application/json': { schema: resolver(ErrorResponseStandard) } }
			},
			500: {
				description: 'Unhandled service failure',
				content: { 'application/json': { schema: resolver(ErrorResponseStandard) } }
			}
		}
	})
] as const
`
}

function examplePostEffectHandlerTs({
	runtime,
	usesSqlite
}: {
	runtime: Runtime
	usesSqlite: boolean
}): string {
	const dbConstruction =
		runtime === 'cf-workers'
			? usesSqlite
				? 'createDb({ DB: c.env.DB })'
				: 'createDb({ HYPERDRIVE: c.env.HYPERDRIVE, DATABASE_URL: c.env.DATABASE_URL })'
			: usesSqlite
				? `createDb({ url: process.env.SQLITE_PATH ?? 'file:./local.db' })`
				: `createDb({ DATABASE_URL: process.env.DATABASE_URL ?? '' })`

	return `import { eq } from 'drizzle-orm'
import type { Context } from 'hono'

import { tryPromiseUnexpected } from '@repo/backend/effect/errors'
import { runEffectJson } from '@repo/backend/effect/hono'
import { createDb } from '@repo/db/client'
import { schema } from '@repo/db'

type ExamplePostContext = Context<{ Bindings: Env }>
type ExamplePostValidatedRequest = {
	valid(target: 'param'): { id: string }
	valid(target: 'query'): { includeBody?: 'true' | 'false' }
	valid(target: 'json'): {
		title: string
		body: string
		summary?: string | null
		occurredAt: string
	}
}

export const examplePostHandler = (c: ExamplePostContext) => {
	const db = ${dbConstruction}
	const req = c.req as typeof c.req & ExamplePostValidatedRequest
	const params = req.valid('param')
	const query = req.valid('query')
	const input = req.valid('json')

	const program = tryPromiseUnexpected({
		try: async () => {
			await db
				.insert(schema.posts)
				.values({ id: params.id, title: input.title, body: input.body })
				.onConflictDoUpdate({
					target: schema.posts.id,
					set: { title: input.title, body: input.body }
				})

			const rows = await db
				.select()
				.from(schema.posts)
				.where(eq(schema.posts.id, params.id))
				.limit(1)

			const row = rows[0]
			if (!row) throw new Error('post was not stored')

			return {
				id: row.id,
				title: row.title,
				...(query.includeBody === 'true' ? { body: row.body } : {}),
				summary: input.summary ?? null,
				occurredAt: input.occurredAt,
				createdAt: row.createdAt.toISOString()
			}
		},
		message: 'failed to store example post',
		code: 'EXAMPLE_POST_WRITE_FAILED'
	})

	return runEffectJson(c, program)
}
`
}

function examplePostEffectIndexTs(): string {
	return `import { Hono } from 'hono'

import { examplePostHandler } from './handler.js'
import { examplePostRoute } from './route.js'

export const examplePostsRouter = new Hono<{ Bindings: Env }>().post(
	'/posts/:id',
	...examplePostRoute,
	examplePostHandler
)
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
				security: [],
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

function usersOpenApiJson(project: string, effectMode: boolean): string {
	if (!effectMode) return usersPromiseOpenApiJson(project)

	return `{
  "openapi": "3.1.0",
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
      },
      "ErrorResponse": {
        "type": "object",
        "properties": {
          "error": {
            "type": "string"
          },
          "message": {
            "type": "string"
          },
          "code": {
            "type": "string"
          },
          "tag": {
            "type": "string"
          }
        },
        "required": [
          "error",
          "message"
        ]
      },
      "ExamplePostBody": {
        "type": "object",
        "properties": {
          "title": {
            "type": "string"
          },
          "body": {
            "type": "string"
          },
          "summary": {
            "anyOf": [
              {
                "type": "string"
              },
              {
                "type": "null"
              }
            ]
          },
          "occurredAt": {
            "type": "string"
          }
        },
        "required": [
          "title",
          "body",
          "occurredAt"
        ]
      },
      "ExamplePost": {
        "type": "object",
        "properties": {
          "id": {
            "type": "string"
          },
          "title": {
            "type": "string"
          },
          "body": {
            "type": "string"
          },
          "summary": {
            "anyOf": [
              {
                "type": "string"
              },
              {
                "type": "null"
              }
            ]
          },
          "occurredAt": {
            "type": "string"
          },
          "createdAt": {
            "type": "string"
          }
        },
        "required": [
          "id",
          "title",
          "summary",
          "occurredAt",
          "createdAt"
        ]
      }
    },
    "parameters": {}
  },
  "paths": {
    "/examples/posts/{id}": {
      "post": {
        "operationId": "upsertExamplePost",
        "tags": [
          "examples"
        ],
        "summary": "Upsert an example post",
        "parameters": [
          {
            "name": "id",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          },
          {
            "name": "includeBody",
            "in": "query",
            "required": false,
            "schema": {
              "enum": [
                "true",
                "false"
              ],
              "type": "string"
            }
          }
        ],
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "$ref": "#/components/schemas/ExamplePostBody"
              }
            }
          }
        },
        "responses": {
          "200": {
            "description": "Stored example post",
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/ExamplePost"
                }
              }
            }
          },
          "400": {
            "description": "Invalid input",
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/ErrorResponse"
                }
              }
            }
          },
          "500": {
            "description": "Unhandled service failure",
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/ErrorResponse"
                }
              }
            }
          }
        }
      }
    },
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
            "description": "No active session",
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/ErrorResponse"
                }
              }
            }
          },
          "404": {
            "description": "User not found",
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/ErrorResponse"
                }
              }
            }
          },
          "500": {
            "description": "Unhandled service failure",
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/ErrorResponse"
                }
              }
            }
          }
        }
      }
    }
  }
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
import { errorHandler } from '@repo/backend/hono/error-handler'
import { logger } from '@repo/backend/hono/logger'
import type { SessionLike } from '@repo/backend/hono/auth/client'
import { requireAuth } from '@repo/backend/hono/auth/require'

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
import type { SessionLike } from '@repo/backend/hono/auth/client'
import { requireAuth } from '@repo/backend/hono/auth/require'
import { Hono } from 'hono'

import { mountOpenApi } from './openapi.js'
import { examplePostsRouter } from './routes/example-posts/index.js'
import { meRouter } from './routes/me/index.js'

export const app = new Hono<{
	Bindings: Env
	Variables: { user: SessionLike }
}>()

app.use('*', logger())

app.get('/healthz', (c) => c.text('ok'))

app.route('/examples', examplePostsRouter)

// /api/* requires a valid session.
app.use('/api/*', requireAuth)

app.route('/api', meRouter)

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

const port = Number(process.env.PORT ?? 8788)
serve({ fetch: app.fetch, port })
console.log(\`users listening on http://127.0.0.1:\${port}\`)
`
}

function readme(project: string, runtime: Runtime): string {
	const bindingDoc =
		runtime === 'cf-workers'
			? `Session validation is delegated to the auth Worker via:

\`\`\`
services: [{ binding: "AUTH", service: "${project}-auth" }]
\`\`\`

The Hono adapter in \`@repo/backend/hono/auth/require\` calls \`/internal/session\`
on that binding. **Do not extract auth state into this service.**`
			: `Session validation is delegated to the auth service via HTTP using the
\`AUTH_URL\` environment variable (defaults to \`http://127.0.0.1:8787\` in
dev). The Hono adapter in \`@repo/backend/hono/auth/require\` calls
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
