import type { FileEntry } from '../lib/files.js'
import type { GvKitConfig } from '../schema/config.js'

/**
 * Generator for `packages/backend/` — core types, Hono adapters, and runtime helpers.
 */
export function generateBackend(cfg: GvKitConfig): FileEntry[] {
	const isHono = cfg.choices.backend === 'hono'
	const isCf = cfg.choices.deploy === 'cf-workers'
	const isSqlite = cfg.choices.db === 'sqlite'
	const hasAuth = cfg.choices.auth.length > 0
	const effectMode = cfg.choices.backendRuntime === 'effect'

	const entries: FileEntry[] = [
		{
			path: 'packages/backend/package.json',
			content: renderPackageJson({ isHono, isCf, isSqlite, hasAuth, effectMode })
		},
		{ path: 'packages/backend/tsconfig.json', content: renderTsconfig({ isCf, isSqlite }) }
	]

	if (!effectMode) {
		entries.push(
			{ path: 'packages/backend/src/helpers/index.ts', content: HELPERS_INDEX },
			{ path: 'packages/backend/src/helpers/index.test.ts', content: HELPERS_TEST }
		)
	}

	if (effectMode) {
		entries.push(
			{ path: 'packages/backend/src/effect/errors.ts', content: EFFECT_ERRORS },
			{ path: 'packages/backend/src/effect/hono.ts', content: EFFECT_HONO },
			{ path: 'packages/backend/src/effect/auth-session.ts', content: EFFECT_AUTH_SESSION }
		)
	}

	// users DAO + use-cases require the better-auth `user` table emitted by
	// `@repo/db`, which is only present when at least one auth provider was
	// chosen. Skip these emissions otherwise so the package still typechecks.
	if (hasAuth) {
		entries.push(
			{ path: 'packages/backend/src/core/types.ts', content: CORE_TYPES },
			{
				path: 'packages/backend/src/core/data-access/users.ts',
				content: effectMode ? CORE_USERS_EFFECT : CORE_USERS
			},
			{
				path: 'packages/backend/src/core/use-cases/users.ts',
				content: effectMode ? USE_CASE_USERS_EFFECT : USE_CASE_USERS
			}
		)
	}

	if (isHono) {
		entries.push(
			{ path: 'packages/backend/src/hono/logger.ts', content: HONO_LOGGER },
			{ path: 'packages/backend/src/hono/auth/client.ts', content: HONO_AUTH_CLIENT },
			{ path: 'packages/backend/src/hono/auth/require.ts', content: HONO_AUTH_REQUIRE }
		)
		if (!effectMode) {
			entries.push({
				path: 'packages/backend/src/hono/error-handler.ts',
				content: HONO_ERROR_HANDLER
			})
		}
	}

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
	const exportsBlock: Record<string, string> = {}
	if (!effectMode) exportsBlock['./helpers'] = './src/helpers/index.ts'
	if (effectMode) {
		exportsBlock['./effect/errors'] = './src/effect/errors.ts'
		exportsBlock['./effect/hono'] = './src/effect/hono.ts'
		exportsBlock['./effect/auth-session'] = './src/effect/auth-session.ts'
	}
	if (hasAuth) {
		exportsBlock['./core/types'] = './src/core/types.ts'
		exportsBlock['./core/data-access/users'] = './src/core/data-access/users.ts'
		exportsBlock['./core/use-cases/users'] = './src/core/use-cases/users.ts'
	}
	if (isHono) {
		exportsBlock['./hono/logger'] = './src/hono/logger.ts'
		exportsBlock['./hono/auth/client'] = './src/hono/auth/client.ts'
		exportsBlock['./hono/auth/require'] = './src/hono/auth/require.ts'
		if (!effectMode) exportsBlock['./hono/error-handler'] = './src/hono/error-handler.ts'
	}

	const dependencies: Record<string, string> = {
		'drizzle-orm': '^0.45.0',
		zod: '^4.3.0'
	}
	// users DAO + use-cases import the better-auth `user` table from `@repo/db`.
	if (hasAuth) dependencies['@repo/db'] = 'workspace:*'
	if (isHono) dependencies.hono = '^4.12.0'
	if (effectMode) dependencies.effect = '^3.21.2'

	const devDependencies: Record<string, string> = {
		'@repo/tooling-typescript': 'workspace:*',
		'@types/node': '^22.10.0',
		typescript: '~5.9.0',
		vitest: '^4.1.7'
	}
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

function renderTsconfig({ isCf, isSqlite: _isSqlite }: { isCf: boolean; isSqlite: boolean }): string {
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

const EFFECT_ERRORS = `import { Data, Effect } from 'effect'
import type { ContentfulStatusCode } from 'hono/utils/http-status'

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

export type AppError = Unauthorized | UserNotFound | UnexpectedServiceError

export function statusForAppError(error: AppError): ContentfulStatusCode {
	switch (error._tag) {
		case 'Unauthorized':
			return 401
		case 'UserNotFound':
			return 404
		case 'UnexpectedServiceError':
			return 500
	}
}

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

const EFFECT_HONO = `import { Effect } from 'effect'
import type { Context } from 'hono'

import { statusForAppError, type AppError } from './errors.js'

export async function runEffectJson<A>(
	c: Context,
	program: Effect.Effect<A, AppError, never>
): Promise<Response> {
	const exit = await Effect.runPromiseExit(program)

	if (exit._tag === 'Success') return c.json(exit.value)

	const error = exit.cause._tag === 'Fail' ? exit.cause.error : undefined
	if (!error) {
		return c.json(
			{ error: 'internal server error', message: 'internal server error', tag: 'Defect' },
			500
		)
	}

	return c.json(
		{
			error: error.message,
			message: error.message,
			tag: error._tag,
			...(error.code ? { code: error.code } : {})
		},
		statusForAppError(error)
	)
}
`

const EFFECT_AUTH_SESSION = `import { Context, Effect } from 'effect'

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

/* ------------------------------------------------------------------ */
/*  src/hono/* (hono-only)                                             */
/* ------------------------------------------------------------------ */

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

const CORE_USERS_EFFECT = `import { eq } from 'drizzle-orm'
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

const USE_CASE_USERS_EFFECT = `import type { Db } from '@repo/db'
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
	if (!session)
		return c.json(
			{ error: 'unauthorized', message: 'unauthorized', tag: 'Unauthorized', code: 'UNAUTHORIZED' },
			401
		)
	c.set('user', session)
	await next()
}
`
