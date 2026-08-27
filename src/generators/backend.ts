import type { FileEntry } from '../lib/files.js'
import type { GvKitConfig } from '../schema/config.js'
import { AUTH_SERVICE } from './hono-topology.js'

/**
 * Generator for the shared backend application/core layer in `packages/backend/`.
 */
export function generateBackend(cfg: GvKitConfig): FileEntry[] {
	const isHono = cfg.choices.backend === 'hono'
	const isCf = cfg.choices.deploy === 'cf-workers'
	const isSqlite = cfg.choices.db === 'sqlite'
	const hasAuth = cfg.choices.auth.length > 0

	const entries: FileEntry[] = [
		{
			path: 'packages/backend/package.json',
			content: renderPackageJson({ isHono, isCf, isSqlite, hasAuth })
		},
		{ path: 'packages/backend/tsconfig.json', content: renderTsconfig({ isCf, isSqlite }) },
		{ path: 'packages/backend/src/helpers/index.ts', content: HELPERS_INDEX },
		{ path: 'packages/backend/src/helpers/index.test.ts', content: HELPERS_TEST }
	]

	// users DAO + use-cases require the better-auth `user` table emitted by
	// `@repo/db`, which is only present when at least one auth provider was
	// chosen. Skip these emissions otherwise so the package still typechecks.
	if (hasAuth) {
		entries.push(
			{ path: 'packages/backend/src/core/types.ts', content: CORE_TYPES },
			{ path: 'packages/backend/src/core/data-access/users.ts', content: CORE_USERS },
			{ path: 'packages/backend/src/core/use-cases/users.ts', content: USE_CASE_USERS }
		)
	}

	if (isHono) {
		entries.push(
			{ path: 'packages/backend/src/middleware/index.ts', content: MIDDLEWARE_INDEX },
			{ path: 'packages/backend/src/middleware/logger.ts', content: MIDDLEWARE_LOGGER },
			{
				path: 'packages/backend/src/middleware/error-handler.ts',
				content: MIDDLEWARE_ERROR_HANDLER
			},
			{ path: 'packages/backend/src/middleware/auth/index.ts', content: MIDDLEWARE_AUTH_INDEX },
			{ path: 'packages/backend/src/middleware/auth/client.ts', content: MIDDLEWARE_AUTH_CLIENT },
			{ path: 'packages/backend/src/middleware/auth/require.ts', content: MIDDLEWARE_AUTH_REQUIRE }
		)
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
	hasAuth
}: {
	isHono: boolean
	isCf: boolean
	isSqlite: boolean
	hasAuth: boolean
}): string {
	const exportsBlock: Record<string, string> = {
		'./helpers': './src/helpers/index.ts'
	}
	if (hasAuth) {
		exportsBlock['./core/types'] = './src/core/types.ts'
		exportsBlock['./core/data-access/users'] = './src/core/data-access/users.ts'
		exportsBlock['./core/use-cases/users'] = './src/core/use-cases/users.ts'
	}
	if (isHono) {
		exportsBlock['./middleware'] = './src/middleware/index.ts'
		exportsBlock['./middleware/auth'] = './src/middleware/auth/index.ts'
	}

	const dependencies: Record<string, string> = {
		'drizzle-orm': '^0.45.0',
		zod: '^4.3.0'
	}
	// users DAO + use-cases import the better-auth `user` table from `@repo/db`.
	if (hasAuth) dependencies['@repo/db'] = 'workspace:*'
	if (isHono) dependencies.hono = '^4.12.0'

	const devDependencies: Record<string, string> = {
		'@repo/tooling-typescript': 'workspace:*',
		'@types/node': '^24.0.0',
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

/* ------------------------------------------------------------------ */
/*  src/middleware/* (hono-only)                                       */
/* ------------------------------------------------------------------ */

const MIDDLEWARE_INDEX = `export { logger } from './logger.js'
export { errorHandler } from './error-handler.js'
`

const MIDDLEWARE_LOGGER = `import type { MiddlewareHandler } from 'hono'

const REQUEST_ID_HEADER = 'x-request-id'
const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/

function requestId(value: string | undefined): string {
	return value && REQUEST_ID_PATTERN.test(value) ? value : crypto.randomUUID()
}

export function logger(
	service: string,
	writeLog: (line: string) => void = (line) => console.log(line)
): MiddlewareHandler {
	return async (c, next) => {
		const id = requestId(c.req.header(REQUEST_ID_HEADER))
		const startedAt = Date.now()
		c.header(REQUEST_ID_HEADER, id)
		await next()
		c.header(REQUEST_ID_HEADER, id)
		writeLog(
			JSON.stringify({
				event: 'service_request_completed',
				requestId: id,
				service,
				method: c.req.method,
				path: new URL(c.req.url).pathname,
				status: c.res.status,
				durationMs: Date.now() - startedAt
			})
		)
	}
}
`

const MIDDLEWARE_ERROR_HANDLER = `import type { MiddlewareHandler } from 'hono'

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

/* ------------------------------------------------------------------ */
/*  src/middleware/auth/* (hono-only)                                  */
/* ------------------------------------------------------------------ */

const MIDDLEWARE_AUTH_CLIENT = `export type SessionLike = {
	userId: string
	sessionId: string
	expiresAt: string
}

type AuthEnv = {
	${AUTH_SERVICE.internalTarget}?: { fetch: (req: Request) => Promise<Response> }
	${AUTH_SERVICE.transport.node.targetEnvironmentVariable}?: string
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
	const requestId = request.headers.get('x-request-id')
	if (requestId) headers.set('x-request-id', requestId)
	const forwardedHost = request.headers.get('x-forwarded-host') ?? new URL(request.url).host
	headers.set('x-forwarded-host', forwardedHost)
	const forwardedProto =
		request.headers.get('x-forwarded-proto') ?? new URL(request.url).protocol.slice(0, -1)
	headers.set('x-forwarded-proto', forwardedProto)

	const path = '/internal/session'
	const e = env as unknown as AuthEnv

	let res: Response
	if ('${AUTH_SERVICE.internalTarget}' in env && e.${AUTH_SERVICE.internalTarget}) res = await e.${AUTH_SERVICE.internalTarget}.fetch(new Request(\`https://internal\${path}\`, { headers }))
	else {
		const base = e.${AUTH_SERVICE.transport.node.targetEnvironmentVariable}
		if (!base) return null
		res = await fetch(\`\${base}\${path}\`, { headers })
	}

	if (!res.ok) return null
	return (await res.json()) as SessionLike
}
`

const MIDDLEWARE_AUTH_REQUIRE = `import type { MiddlewareHandler } from 'hono'

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

const MIDDLEWARE_AUTH_INDEX = `export { getSession, type SessionLike } from './client.js'
export { requireAuth } from './require.js'
`
