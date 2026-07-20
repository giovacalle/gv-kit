import type { FileEntry } from '../lib/files.js'
import type { GvKitConfig } from '../schema/config.js'

export function generateBackend(cfg: GvKitConfig): FileEntry[] {
	return cfg.choices.backendRuntime === 'effect'
		? generateEffectBackend(cfg)
		: generatePromiseBackend(cfg)
}

function generatePromiseBackend(cfg: GvKitConfig): FileEntry[] {
	const isHono = cfg.choices.backend === 'hono'
	const isCf = cfg.choices.deploy === 'cf-workers'
	const isSqlite = cfg.choices.db === 'sqlite'
	const hasAuth = cfg.choices.auth.length > 0

	const entries: FileEntry[] = [
		{
			path: 'packages/backend/package.json',
			content: renderPackageJson({ isHono, isCf, isSqlite, hasAuth, effectMode: false })
		},
		{ path: 'packages/backend/tsconfig.json', content: renderTsconfig({ isCf, isSqlite }) },
		{ path: 'packages/backend/src/helpers/index.ts', content: HELPERS_INDEX },
		{ path: 'packages/backend/src/helpers/index.test.ts', content: HELPERS_TEST }
	]
	const coreEntries: FileEntry[] = [
		{ path: 'packages/backend/src/core/types.ts', content: CORE_TYPES },
		{ path: 'packages/backend/src/core/data-access/users.ts', content: CORE_USERS },
		{ path: 'packages/backend/src/core/use-cases/users.ts', content: USE_CASE_USERS }
	]
	const middlewareEntries: FileEntry[] = [
		{ path: 'packages/backend/src/middleware/index.ts', content: MIDDLEWARE_INDEX },
		{ path: 'packages/backend/src/middleware/logger.ts', content: HONO_LOGGER },
		{ path: 'packages/backend/src/middleware/error-handler.ts', content: HONO_ERROR_HANDLER },
		{ path: 'packages/backend/src/middleware/auth/index.ts', content: MIDDLEWARE_AUTH_INDEX },
		{ path: 'packages/backend/src/middleware/auth/client.ts', content: HONO_AUTH_CLIENT },
		{ path: 'packages/backend/src/middleware/auth/require.ts', content: HONO_AUTH_REQUIRE }
	]

	if (hasAuth) entries.push(...coreEntries)
	if (isHono) entries.push(...middlewareEntries)

	return entries
}

function generateEffectBackend(cfg: GvKitConfig): FileEntry[] {
	const isHono = cfg.choices.backend === 'hono'
	const isCf = cfg.choices.deploy === 'cf-workers'
	const isSqlite = cfg.choices.db === 'sqlite'
	const hasAuth = cfg.choices.auth.length > 0
	const entries: FileEntry[] = [
		{
			path: 'packages/backend/package.json',
			content: renderPackageJson({ isHono, isCf, isSqlite, hasAuth, effectMode: true })
		},
		{ path: 'packages/backend/tsconfig.json', content: renderTsconfig({ isCf, isSqlite }) },
		{ path: 'packages/backend/src/effect/errors.ts', content: EFFECT_ERRORS },
		{ path: 'packages/backend/src/effect/hono.ts', content: EFFECT_HONO },
		{ path: 'packages/backend/src/effect/hono.test.ts', content: EFFECT_HONO_TEST }
	]

	if (isHono) entries.push({ path: 'packages/backend/src/hono/logger.ts', content: HONO_LOGGER })

	return entries
}

/* ------------------------------------------------------------------ */
/*  package.json                                                       */
/* ------------------------------------------------------------------ */

function renderPackageJson({
	isHono,
	isCf,
	isSqlite: _isSqlite,
	hasAuth,
	effectMode
}: {
	isHono: boolean
	isCf: boolean
	isSqlite: boolean
	hasAuth: boolean
	effectMode: boolean
}): string {
	const exportsBlock: Record<string, string> = effectMode
		? {}
		: {
				'./helpers': './src/helpers/index.ts'
			}
	if (effectMode) {
		exportsBlock['./effect/errors'] = './src/effect/errors.ts'
		exportsBlock['./effect/hono'] = './src/effect/hono.ts'
	}
	if (hasAuth && !effectMode) {
		exportsBlock['./core/types'] = './src/core/types.ts'
		exportsBlock['./core/data-access/users'] = './src/core/data-access/users.ts'
		exportsBlock['./core/use-cases/users'] = './src/core/use-cases/users.ts'
	}
	if (isHono && effectMode) exportsBlock['./hono/logger'] = './src/hono/logger.ts'
	if (isHono && !effectMode) {
		exportsBlock['./middleware'] = './src/middleware/index.ts'
		exportsBlock['./middleware/auth'] = './src/middleware/auth/index.ts'
	}

	const dependencies: Record<string, string> = {
		'drizzle-orm': '^0.45.0',
		zod: '^4.3.0'
	}
	// users DAO + use-cases import the better-auth `user` table from `@repo/db`.
	if (hasAuth && !effectMode) dependencies['@repo/db'] = 'workspace:*'
	if (isHono) dependencies.hono = '^4.12.0'
	if (effectMode) {
		dependencies.effect = '^3.21.2'
		dependencies['hono-openapi'] = '^1.3.0'
	}

	const devDependencies: Record<string, string> = {
		'@repo/tooling-typescript': 'workspace:*',
		'@types/node': '^22.10.0',
		typescript: '~5.9.0',
		vitest: '^4.1.7'
	}
	if (effectMode) devDependencies.ajv = '^8.17.1'
	if (isCf) devDependencies['@cloudflare/workers-types'] = '^4.20251101.0'

	const pkg = {
		name: '@repo/backend',
		version: '0.0.0',
		private: true,
		type: 'module',
		exports: exportsBlock,
		scripts: {
			typecheck: 'tsc --noEmit',
			test: 'vitest run',
			lint: 'eslint .'
		},
		dependencies,
		devDependencies
	}

	return JSON.stringify(pkg, null, 2) + '\n'
}

/* ------------------------------------------------------------------ */
/*  tsconfig.json                                                      */
/* ------------------------------------------------------------------ */

function renderTsconfig({
	isCf,
	isSqlite: _isSqlite
}: {
	isCf: boolean
	isSqlite: boolean
}): string {
	// Inherit the shared compiler base from `@repo/tooling-typescript` so every
	// package agrees on strictness + module resolution. cf-workers consumers
	// pick up `@cloudflare/workers-types`; everything else picks up `node`.
	const base = isCf ? '@repo/tooling-typescript/workers.json' : '@repo/tooling-typescript/node.json'

	return `{
	"extends": "${base}",
	"compilerOptions": {
		"noEmit": true
	},
	"include": ["src/**/*"],
	"exclude": ["node_modules", "dist"]
}
`
}

/* ------------------------------------------------------------------ */
/*  src/helpers/index.ts                                               */
/* ------------------------------------------------------------------ */

const HELPERS_INDEX = `export class HttpError extends Error {
	constructor(
		public readonly status: number,
		message: string,
		public readonly code?: string
	) {
		super(message)
		this.name = 'HttpError'
	}
}

export const errors = {
	badRequest: (message = 'bad request', code?: string): HttpError =>
		new HttpError(400, message, code),
	unauthorized: (message = 'unauthorized', code?: string): HttpError =>
		new HttpError(401, message, code),
	forbidden: (message = 'forbidden', code?: string): HttpError =>
		new HttpError(403, message, code),
	notFound: (message = 'not found', code?: string): HttpError =>
		new HttpError(404, message, code),
	conflict: (message = 'conflict', code?: string): HttpError =>
		new HttpError(409, message, code),
	internal: (message = 'internal server error', code?: string): HttpError =>
		new HttpError(500, message, code)
}
`

const HELPERS_TEST = `import { describe, expect, test } from 'vitest'

import { errors, HttpError } from './index.js'

describe('errors', () => {
	test('notFound builds a 404 HttpError', () => {
		const err = errors.notFound('user not found', 'USER_NOT_FOUND')
		expect(err).toBeInstanceOf(HttpError)
		expect(err.status).toBe(404)
		expect(err.message).toBe('user not found')
		expect(err.code).toBe('USER_NOT_FOUND')
	})

	test('each factory carries its HTTP status', () => {
		expect(errors.badRequest().status).toBe(400)
		expect(errors.unauthorized().status).toBe(401)
		expect(errors.forbidden().status).toBe(403)
		expect(errors.conflict().status).toBe(409)
		expect(errors.internal().status).toBe(500)
	})
})
`

const MIDDLEWARE_INDEX = `export { logger } from './logger.js'
export { errorHandler } from './error-handler.js'
`

const MIDDLEWARE_AUTH_INDEX = `export { getSession, type SessionLike } from './client.js'
export { requireAuth } from './require.js'
`

const EFFECT_ERRORS = `import { Data, Effect } from 'effect'

export class Unauthorized extends Data.TaggedError('Unauthorized')<{
	message: string
	code?: string
}> {}

export class UserNotFound extends Data.TaggedError('UserNotFound')<{
	message: string
	code?: string
}> {}

export class UnexpectedServiceError extends Data.TaggedError('UnexpectedServiceError')<{
	message: string
	code?: string
	cause?: unknown
}> {}

export function tryPromiseUnexpected<A>({
\ttry: run,
\tmessage,
\tcode
}: {
\ttry: () => PromiseLike<A>
\tmessage: string
\tcode?: string
}) {
\treturn Effect.tryPromise({
\t\ttry: run,
\t\tcatch: (cause) => new UnexpectedServiceError({ message, code, cause })
\t})
}
`

const EFFECT_HONO = `import { Cause, Effect, Option } from 'effect'
import type { Context } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'

export type EffectHttpResponse<Body> = {
	status: ContentfulStatusCode
	body: Body
}

export type UnexpectedEffectLog = {
	cause: Cause.Cause<unknown>
	request: {
		method: string
		path: string
		requestId?: string
	}
}

type EffectHttpOptions<A, E, SuccessBody, FailureBody> = {
	c: Context
	program: Effect.Effect<A, E, never>
	onSuccess: (value: A) => EffectHttpResponse<SuccessBody>
	onFailure: (error: E) => EffectHttpResponse<FailureBody>
	logUnexpected?: (entry: UnexpectedEffectLog) => void
}

const ValidationErrorResponse = {
	error: 'invalid request',
	message: 'request validation failed',
	tag: 'ValidationError',
	code: 'VALIDATION_ERROR'
} as const

const UnexpectedErrorResponse = {
	error: 'internal server error',
	message: 'internal server error',
	tag: 'UnexpectedFailure',
	code: 'INTERNAL_SERVER_ERROR'
} as const

export function effectValidationHook(
	result: { success: boolean },
	c: Context
): Response | undefined {
	if (!result.success) return c.json(ValidationErrorResponse, 400)
}

export async function runEffectJson<A, E, SuccessBody, FailureBody>({
	c,
	program,
	onSuccess,
	onFailure,
	logUnexpected
}: EffectHttpOptions<A, E, SuccessBody, FailureBody>): Promise<Response> {
	const exit = await Effect.runPromiseExit(program)

	if (exit._tag === 'Success') {
		const response = onSuccess(exit.value)
		return c.json(response.body, response.status)
	}

	if (!Cause.isDie(exit.cause) && !Cause.isInterrupted(exit.cause)) {
		const failure = Cause.failureOption(exit.cause)
		if (Option.isSome(failure)) {
			const response = onFailure(failure.value)
			return c.json(response.body, response.status)
		}
	}

	const requestId = c.req.header('x-request-id')
	const entry: UnexpectedEffectLog = {
		cause: exit.cause,
		request: {
			method: c.req.method,
			path: new URL(c.req.url).pathname,
			...(requestId ? { requestId } : {})
		}
	}
	if (logUnexpected) logUnexpected(entry)
	else console.error('[effect-http] unexpected cause', Cause.pretty(exit.cause), entry.request)

	return c.json(UnexpectedErrorResponse, 500)
}
`

const EFFECT_HONO_TEST = `import Ajv2020 from 'ajv/dist/2020.js'
import { Cause, Data, Effect, Schema } from 'effect'
import { Hono } from 'hono'
import { describeRoute, openAPIRouteHandler, resolver, validator } from 'hono-openapi'
import { describe, expect, test } from 'vitest'

import {
	effectValidationHook,
	runEffectJson,
	type EffectHttpResponse,
	type UnexpectedEffectLog
} from './hono.js'

const ValidationError = {
	error: 'invalid request',
	message: 'request validation failed',
	tag: 'ValidationError',
	code: 'VALIDATION_ERROR'
} as const

const ErrorResponseSchema = Schema.Struct({
	error: Schema.String,
	message: Schema.String,
	tag: Schema.String,
	code: Schema.String
})
const SuccessResponseSchema = Schema.Struct({ accepted: Schema.String })
const PathSchema = Schema.Struct({ id: Schema.Literal('valid') })
const QuerySchema = Schema.Struct({ mode: Schema.Literal('full') })
const BodySchema = Schema.Struct({ title: Schema.String })

const ErrorResponseStandard = Schema.standardSchemaV1(ErrorResponseSchema)
const SuccessResponseStandard = Schema.standardSchemaV1(SuccessResponseSchema)
const PathStandard = Schema.standardSchemaV1(PathSchema)
const QueryStandard = Schema.standardSchemaV1(QuerySchema)
const BodyStandard = Schema.standardSchemaV1(BodySchema)

class Conflict extends Data.TaggedError('Conflict')<{ message: string }> {}
class Missing extends Data.TaggedError('Missing')<{ message: string }> {}
type RouteError = Conflict | Missing

function mapRouteError(error: RouteError): EffectHttpResponse<Schema.Schema.Type<typeof ErrorResponseSchema>> {
	switch (error._tag) {
		case 'Conflict':
			return {
				status: 409,
				body: { error: error.message, message: error.message, tag: error._tag, code: 'CONFLICT' }
			}
		case 'Missing':
			return {
				status: 404,
				body: { error: error.message, message: error.message, tag: error._tag, code: 'NOT_FOUND' }
			}
	}
}

function createTestApp(logs: UnexpectedEffectLog[]) {
	const app = new Hono()
	const logUnexpected = (entry: UnexpectedEffectLog) => logs.push(entry)
	const errorResponse = (status: 400 | 404 | 409 | 500, description: string) => ({
		[status]: {
			description,
			content: { 'application/json': { schema: resolver(ErrorResponseStandard) } }
		}
	})

	app.post(
		'/validate/:id',
		validator('param', PathStandard, effectValidationHook),
		validator('query', QueryStandard, effectValidationHook),
		validator('json', BodyStandard, effectValidationHook),
		describeRoute({
			responses: {
				201: {
					description: 'Validated request',
					content: { 'application/json': { schema: resolver(SuccessResponseStandard) } }
				},
				...errorResponse(400, 'Invalid request')
			}
		}),
		(c) => c.json({ accepted: 'validated' }, 201)
	)

	app.get(
		'/expected',
		describeRoute({ responses: errorResponse(409, 'Conflict') }),
		(c) =>
			runEffectJson({
				c,
				program: Effect.fail(new Conflict({ message: 'already exists' })),
				onSuccess: () => ({ status: 200, body: { accepted: 'unused' } }),
				onFailure: mapRouteError,
				logUnexpected
			})
	)

	app.get(
		'/defect',
		describeRoute({ responses: errorResponse(500, 'Internal server error') }),
		(c) =>
			runEffectJson({
				c,
				program: Effect.die(new Error('secret defect detail')),
				onSuccess: () => ({ status: 200, body: { accepted: 'unused' } }),
				onFailure: mapRouteError,
				logUnexpected
			})
	)

	app.get(
		'/interrupt',
		describeRoute({ responses: errorResponse(500, 'Internal server error') }),
		(c) =>
			runEffectJson({
				c,
				program: Effect.interrupt,
				onSuccess: () => ({ status: 200, body: { accepted: 'unused' } }),
				onFailure: mapRouteError,
				logUnexpected
			})
	)

	app.get(
		'/accepted',
		describeRoute({
			responses: {
				202: {
					description: 'Accepted',
					content: { 'application/json': { schema: resolver(SuccessResponseStandard) } }
				},
				...errorResponse(500, 'Internal server error')
			}
		}),
		(c) =>
			runEffectJson({
				c,
				program: Effect.succeed('queued'),
				onSuccess: (value) => ({ status: 202, body: { accepted: value } }),
				onFailure: mapRouteError,
				logUnexpected
			})
	)

	app.get(
		'/openapi.json',
		openAPIRouteHandler(app, {
			documentation: { info: { title: 'Effect HTTP boundary', version: '1.0.0' } }
		})
	)

	return app
}

type OpenApiDocument = {
	paths: Record<
		string,
		Record<
			string,
			{ responses: Record<string, { content: { 'application/json': { schema: object } } }> }
		>
	>
}

async function requestJson({ app, path, init }: { app: Hono; path: string; init?: RequestInit }) {
	const response = await app.request('http://test.local' + path, init)
	return { response, body: (await response.json()) as unknown }
}

function expectDeclaredResponse({
	spec,
	path,
	method,
	status,
	body
}: {
	spec: OpenApiDocument
	path: string
	method: string
	status: number
	body: unknown
}) {
	const schema = spec.paths[path]![method]!.responses[String(status)]!.content['application/json']
		.schema
	const ajv = new Ajv2020({ strict: false })
	expect(ajv.validate(schema, body), JSON.stringify(ajv.errors)).toBe(true)
}

describe('Effect HTTP boundary', () => {
	test.each([
		{ target: 'path', path: '/validate/nope?mode=full', body: { title: 'ok' } },
		{ target: 'query', path: '/validate/valid?mode=compact', body: { title: 'ok' } },
		{ target: 'json', path: '/validate/valid?mode=full', body: { title: 42 } }
	])('maps invalid $target input to the declared response', async ({ path, body }) => {
		const logs: UnexpectedEffectLog[] = []
		const app = createTestApp(logs)
		const spec = (await (await app.request('/openapi.json')).json()) as OpenApiDocument
		const result = await requestJson({
			app,
			path,
			init: {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(body)
			}
		})

		expect(result.response.status).toBe(400)
		expect(result.body).toEqual(ValidationError)
		expectDeclaredResponse({
			spec,
			path: '/validate/{id}',
			method: 'post',
			status: 400,
			body: result.body
		})
		expect(logs).toEqual([])
	})

	test('maps an expected tagged failure through the route-owned mapper', async () => {
		const logs: UnexpectedEffectLog[] = []
		const app = createTestApp(logs)
		const spec = (await (await app.request('/openapi.json')).json()) as OpenApiDocument
		const result = await requestJson({ app, path: '/expected' })

		expect(result.response.status).toBe(409)
		expect(result.body).toEqual({
			error: 'already exists',
			message: 'already exists',
			tag: 'Conflict',
			code: 'CONFLICT'
		})
		expectDeclaredResponse({ spec, path: '/expected', method: 'get', status: 409, body: result.body })
		expect(logs).toEqual([])
	})

	test.each([
		{ kind: 'defect', path: '/defect', causeText: 'secret defect detail' },
		{ kind: 'interruption', path: '/interrupt', causeText: 'All fibers interrupted without errors' }
	])('returns a safe 500 and logs the full $kind cause', async ({ path, causeText }) => {
		const logs: UnexpectedEffectLog[] = []
		const app = createTestApp(logs)
		const spec = (await (await app.request('/openapi.json')).json()) as OpenApiDocument
		const result = await requestJson({
			app,
			path,
			init: { headers: { 'x-request-id': 'request-123' } }
		})

		expect(result.response.status).toBe(500)
		expect(result.body).toEqual({
			error: 'internal server error',
			message: 'internal server error',
			tag: 'UnexpectedFailure',
			code: 'INTERNAL_SERVER_ERROR'
		})
		expect(JSON.stringify(result.body)).not.toContain('secret defect detail')
		expectDeclaredResponse({ spec, path, method: 'get', status: 500, body: result.body })
		expect(logs).toHaveLength(1)
		expect(Cause.pretty(logs[0]!.cause)).toContain(causeText)
		expect(logs[0]!.request).toEqual({
			method: 'GET',
			path,
			requestId: 'request-123'
		})
	})

	test('uses explicit success encoding and a non-200 status', async () => {
		const logs: UnexpectedEffectLog[] = []
		const app = createTestApp(logs)
		const spec = (await (await app.request('/openapi.json')).json()) as OpenApiDocument
		const result = await requestJson({ app, path: '/accepted' })

		expect(result.response.status).toBe(202)
		expect(result.body).toEqual({ accepted: 'queued' })
		expectDeclaredResponse({ spec, path: '/accepted', method: 'get', status: 202, body: result.body })
		expect(logs).toEqual([])
	})
})
`

const _EFFECT_AUTH_SESSION = `import { Context, Effect } from 'effect'

import { tryPromiseUnexpected, Unauthorized, type UnexpectedServiceError } from './errors.js'

export type AuthSession = {
\tuserId: string
\tsessionId: string
\texpiresAt: string
}

export type AuthSessionServiceShape = {
\treadonly resolve: (headers: Headers) => Effect.Effect<AuthSession, Unauthorized | UnexpectedServiceError>
}

export class AuthSessionService extends Context.Tag('AuthSessionService')<
\tAuthSessionService,
\tAuthSessionServiceShape
>() {}

type BetterAuthSessionLike = {
\tuser: { id: string }
\tsession: { id: string; expiresAt: Date }
}

export function resolveBetterAuthSession(
\tlookup: () => PromiseLike<BetterAuthSessionLike | null>
) {
\treturn tryPromiseUnexpected({
\t\ttry: lookup,
\t\tmessage: 'failed to resolve session',
\t\tcode: 'SESSION_LOOKUP_FAILED'
\t}).pipe(
\t\tEffect.flatMap((session) =>
\t\t\tsession
\t\t\t\t? Effect.succeed({
\t\t\t\t\t\tuserId: session.user.id,
\t\t\t\t\t\tsessionId: session.session.id,
\t\t\t\t\t\texpiresAt: session.session.expiresAt.toISOString()
\t\t\t\t\t})
\t\t\t\t: Effect.fail(new Unauthorized({ message: 'unauthorized', code: 'UNAUTHORIZED' }))
\t\t)
\t)
}
`

const HONO_LOGGER = `import type { MiddlewareHandler } from 'hono'

export function logger(): MiddlewareHandler {
	return async (c, next) => {
		const start = Date.now()
		await next()
		const ms = Date.now() - start
		const { method } = c.req
		const path = new URL(c.req.url).pathname
		console.log(\`\${method} \${path} \${c.res.status} \${ms}ms\`)
	}
}
`

const HONO_ERROR_HANDLER = `import type { MiddlewareHandler } from 'hono'

import { HttpError } from '../helpers/index.js'

export function errorHandler(): MiddlewareHandler {
	return async (c, next) => {
		try {
			await next()
		} catch (err) {
			if (err instanceof HttpError) {
				return c.json(
					{ error: err.message, ...(err.code ? { code: err.code } : {}) },
					err.status as 400 | 401 | 403 | 404 | 409 | 500
				)
			}
			console.error('[errorHandler] unhandled error:', err)
			return c.json({ error: 'internal server error' }, 500)
		}
	}
}
`

/* ------------------------------------------------------------------ */
/*  src/core/types.ts                                                  */
/*  src/core/data-access/users.ts                                      */
/*  src/core/use-cases/users.ts                                        */
/* ------------------------------------------------------------------ */

const CORE_TYPES = `import { authSchema } from '@repo/db'

export type UserId = (typeof authSchema.user.$inferSelect)['id']
`

const CORE_USERS = `import { eq } from 'drizzle-orm'
import { authSchema, type Db } from '@repo/db'

import type { UserId } from '../types.js'

export async function findUserById(db: Db, id: UserId) {
	const rows = await db.select().from(authSchema.user).where(eq(authSchema.user.id, id)).limit(1)
	return rows[0] ?? null
}
`

const _CORE_USERS_EFFECT = `import { eq } from 'drizzle-orm'
import { authSchema, type Db } from '@repo/db'

import { tryPromiseUnexpected } from '../../effect/errors.js'
import type { UserId } from '../types.js'

export function findUserById(db: Db, id: UserId) {
	return tryPromiseUnexpected({
		try: async () => {
			const rows = await db.select().from(authSchema.user).where(eq(authSchema.user.id, id)).limit(1)
			return rows[0] ?? null
		},
		message: 'failed to load user',
		code: 'USER_LOOKUP_FAILED'
	})
}
`

const USE_CASE_USERS = `import type { Db } from '@repo/db'

import { errors } from '../../helpers/index.js'
import { findUserById } from '../data-access/users.js'
import type { UserId } from '../types.js'

export async function getMeUseCase(db: Db, userId: UserId) {
	const row = await findUserById(db, userId)
	if (!row) throw errors.notFound('user not found')
	return row
}
`

const _USE_CASE_USERS_EFFECT = `import type { Db } from '@repo/db'
import { Effect } from 'effect'

import { UserNotFound } from '../../effect/errors.js'
import { findUserById } from '../data-access/users.js'
import type { UserId } from '../types.js'

export function getMeUseCase(db: Db, userId: UserId) {
	return findUserById(db, userId).pipe(
		Effect.flatMap((row) =>
			row
				? Effect.succeed(row)
				: Effect.fail(new UserNotFound({ message: 'user not found', code: 'USER_NOT_FOUND' }))
		)
	)
}
`

/* ------------------------------------------------------------------ */
/*  src/hono/auth/* (hono-only)                                        */
/* ------------------------------------------------------------------ */

const HONO_AUTH_CLIENT = `export type SessionLike = {
	userId: string
	sessionId: string
	expiresAt: string
}

type AuthEnv = {
	AUTH?: { fetch: (req: Request) => Promise<Response> }
	AUTH_URL?: string
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function getSession<TBindings extends Record<string, any>>(
	env: TBindings,
	request: Request
): Promise<SessionLike | null> {
	const headers = new Headers()
	const cookie = request.headers.get('cookie')
	if (cookie) headers.set('cookie', cookie)
	const authorization = request.headers.get('authorization')
	if (authorization) headers.set('authorization', authorization)

	const path = '/internal/session'
	const e = env as unknown as AuthEnv

	let res: Response
	if ('AUTH' in env && e.AUTH) {
		res = await e.AUTH.fetch(new Request(\`https://internal\${path}\`, { headers }))
	} else {
		const base = e.AUTH_URL
		if (!base) return null
		res = await fetch(\`\${base}\${path}\`, { headers })
	}

	if (!res.ok) return null
	return (await res.json()) as SessionLike
}
`

const HONO_AUTH_REQUIRE = `import type { MiddlewareHandler } from 'hono'

import { getSession, type SessionLike } from './client.js'

export const requireAuth: MiddlewareHandler<{
	Bindings: Record<string, unknown>
	Variables: { user: SessionLike }
}> = async (c, next) => {
	const session = await getSession(c.env, c.req.raw)
	if (!session) return c.json({ error: 'unauthorized' }, 401)
	c.set('user', session)
	await next()
}
`

const _HONO_AUTH_REQUIRE_EFFECT = `import type { MiddlewareHandler } from 'hono'

import { getSession, type SessionLike } from './client.js'

export const requireAuth: MiddlewareHandler<{
	Bindings: Record<string, unknown>
	Variables: { user: SessionLike }
}> = async (c, next) => {
	const session = await getSession(c.env, c.req.raw)
	if (!session) return c.json(
			{ error: 'unauthorized', message: 'unauthorized', tag: 'Unauthorized', code: 'UNAUTHORIZED' },
			401
		)
	c.set('user', session)
	await next()
}
`
