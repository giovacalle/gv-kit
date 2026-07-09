import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { runGenerators } from '../../src/generators/index.js'
import { parseJsonc } from '../../src/lib/jsonc.js'
import { GvKitConfig } from '../../src/schema/config.js'

const fixture = GvKitConfig.parse(
	parseJsonc(
		readFileSync(
			join(import.meta.dir, '..', '..', 'fixtures', 'hono-effect-cf-workers-sqlite.jsonc'),
			'utf8'
		)
	)
)

const entries = runGenerators(fixture)

function content(path: string): string | undefined {
	const hit = entries.find((e) => e.path === path)
	return hit?.content
}

function requireContent(path: string): string {
	const hit = content(path)
	if (!hit) throw new Error(`missing generated file: ${path}`)
	return hit
}

function pkg(path: string): {
	scripts?: Record<string, string>
	dependencies?: Record<string, string>
	devDependencies?: Record<string, string>
	exports?: Record<string, unknown>
} {
	return JSON.parse(requireContent(path))
}

describe('Effect backend runtime generation', () => {
	test('users service uses Effect Schema + hono-openapi, not @hono/zod-openapi', () => {
		const usersPkg = pkg('apps/api/users/package.json')
		expect(usersPkg.dependencies?.effect).toBeDefined()
		expect(usersPkg.dependencies?.['hono-openapi']).toBeDefined()
		expect(usersPkg.dependencies?.['@hono/standard-validator']).toBeDefined()
		expect(usersPkg.dependencies?.['@hono/zod-openapi']).toBeUndefined()
		expect(usersPkg.dependencies?.['drizzle-orm']).toBeDefined()
		expect(usersPkg.dependencies?.zod).toBeUndefined()
		expect(usersPkg.scripts?.build).toContain('wrangler deploy --dry-run --strict')

		expect(requireContent('apps/api/users/src/routes/me/schema.ts')).toContain("from 'effect'")
		expect(requireContent('apps/api/users/src/routes/me/route.ts')).toContain('describeRoute')
		expect(requireContent('apps/api/users/src/openapi.ts')).toContain('openAPIRouteHandler')
	})

	test('auth internal session route also leaves the zod-openapi pipeline in Effect mode', () => {
		const authPkg = pkg('apps/api/auth/package.json')
		expect(authPkg.dependencies?.effect).toBeDefined()
		expect(authPkg.dependencies?.['hono-openapi']).toBeDefined()
		expect(authPkg.dependencies?.['@hono/zod-openapi']).toBeUndefined()
		expect(authPkg.dependencies?.zod).toBeUndefined()
		expect(authPkg.scripts?.build).toContain('wrangler deploy --dry-run --strict')

		expect(requireContent('apps/api/auth/src/openapi.ts')).toContain('Schema.standardSchemaV1')
		expect(requireContent('apps/api/auth/src/app.ts')).toContain('runEffectJson')
		expect(requireContent('apps/api/auth/src/app.ts')).toContain("'x-captcha-response'")
	})

	test('auth internal session is routed through Effect services instead of inline Better Auth calls', () => {
		const app = requireContent('apps/api/auth/src/app.ts')
		const service = requireContent('apps/api/auth/src/effect/auth-session.ts')

		expect(app).toContain('yield* AuthSessionService')
		expect(app).toContain('makeAuthSessionService.pipe(Effect.provideService(WorkerEnvService, c.env))')
		expect(app).toContain('Effect.provideServiceEffect(')
		expect(app).not.toContain('auth.api.getSession')
		expect(service).toContain('WorkerEnvService')
		expect(service).toContain('@repo/backend/effect/auth-session')
		expect(service).toContain('resolveBetterAuthSession')
		expect(service).toContain('getAuth(env)')
		expect(service).toContain('resolvedAuth.api.getSession')
	})

	test('Effect users service exposes a real example route for params, query, body, and DB I/O', () => {
		expect(requireContent('apps/api/users/src/app.ts')).toContain("app.route('/examples', examplePostsRouter)")
		expect(requireContent('apps/api/users/src/routes/example-posts/schema.ts')).toContain(
			'ExamplePostParamSchema'
		)
		expect(requireContent('apps/api/users/src/routes/example-posts/schema.ts')).toContain('ExamplePostQuery')
		expect(requireContent('apps/api/users/src/routes/example-posts/schema.ts')).toContain('ExamplePostBody')
		expect(requireContent('apps/api/users/src/routes/example-posts/route.ts')).toContain("validator('param'")
		expect(requireContent('apps/api/users/src/routes/example-posts/route.ts')).toContain("validator('query'")
		expect(requireContent('apps/api/users/src/routes/example-posts/route.ts')).toContain("validator('json'")
		expect(requireContent('apps/api/users/src/routes/example-posts/handler.ts')).toContain(
			'.insert(schema.posts)'
		)
		expect(requireContent('apps/api/users/src/routes/example-posts/handler.ts')).toContain(
			'.from(schema.posts)'
		)
	})

	test('static users OpenAPI bootstrap includes the Effect contract used by Hey API', () => {
		const spec = JSON.parse(requireContent('apps/api/users/openapi.json')) as {
			openapi: string
			paths: Record<string, Record<string, unknown>>
			components: { schemas: Record<string, unknown> }
		}

		expect(spec.openapi).toBe('3.1.0')
		expect(spec.paths['/examples/posts/{id}']?.post).toBeDefined()
		expect(JSON.stringify(spec.paths['/examples/posts/{id}'])).toContain('requestBody')
		expect(JSON.stringify(spec.paths['/examples/posts/{id}'])).toContain('includeBody')
		expect(JSON.stringify(spec.paths['/examples/posts/{id}'])).toContain('ExamplePostBody')
		expect(JSON.stringify(spec.paths['/api/me']?.get)).toContain('ErrorResponse')
		expect(spec.components.schemas.ExamplePostBody).toBeDefined()
		expect(spec.components.schemas.ExamplePost).toBeDefined()
		expect(spec.components.schemas.ErrorResponse).toBeDefined()
	})

	test('shared backend owns Effect helpers while db stays thin', () => {
		const backendPkg = pkg('packages/backend/package.json')
		expect(backendPkg.dependencies?.effect).toBeDefined()
		expect(backendPkg.exports?.['.']).toBeUndefined()
		expect(backendPkg.exports?.['./effect']).toBeUndefined()
		expect(backendPkg.exports?.['./effect/errors']).toBeDefined()
		expect(backendPkg.exports?.['./effect/hono']).toBeDefined()
		expect(backendPkg.exports?.['./effect/auth-session']).toBeDefined()
		expect(backendPkg.exports?.['./hono']).toBeUndefined()
		expect(backendPkg.exports?.['./hono/auth']).toBeUndefined()
		expect(backendPkg.exports?.['./hono/logger']).toBeDefined()
		expect(backendPkg.exports?.['./hono/auth/client']).toBeDefined()
		expect(backendPkg.exports?.['./hono/auth/require']).toBeDefined()
		expect(backendPkg.exports?.['./helpers']).toBeUndefined()
		expect(content('packages/backend/src/helpers/index.ts')).toBeUndefined()
		expect(content('packages/backend/src/helpers/index.test.ts')).toBeUndefined()
		expect(content('packages/backend/src/index.ts')).toBeUndefined()
		expect(content('packages/backend/src/effect/index.ts')).toBeUndefined()
		expect(content('packages/backend/src/hono/index.ts')).toBeUndefined()
		expect(content('packages/backend/src/hono/auth/index.ts')).toBeUndefined()
		expect(content('packages/backend/src/hono/error-handler.ts')).toBeUndefined()
		expect(requireContent('packages/backend/src/effect/errors.ts')).toContain('tryPromiseUnexpected')
		expect(requireContent('packages/backend/src/effect/auth-session.ts')).toContain('AuthSessionService')
		expect(requireContent('packages/backend/src/effect/auth-session.ts')).toContain(
			'resolveBetterAuthSession'
		)
		expect(requireContent('packages/backend/src/core/data-access/users.ts')).toContain(
			'tryPromiseUnexpected'
		)
		expect(requireContent('packages/backend/src/core/use-cases/users.ts')).not.toContain(
			'Effect.tryPromise'
		)
		expect(requireContent('packages/backend/src/core/use-cases/users.ts')).toContain(
			'return findUserById(db, userId).pipe'
		)

		const dbPkg = pkg('packages/db/package.json')
		expect(dbPkg.dependencies?.effect).toBeUndefined()
		expect(dbPkg.devDependencies?.effect).toBeUndefined()

		for (const src of entries.filter((e) => e.path.endsWith('.ts'))) {
			expect(src.content).not.toMatch(/from ['"]@repo\/backend\/effect['"]/)
			expect(src.content).not.toMatch(/import\(['"]@repo\/backend\/effect['"]\)/)
			expect(src.content).not.toMatch(/from ['"]@repo\/backend\/hono['"]/)
			expect(src.content).not.toMatch(/from ['"]@repo\/backend\/hono\/auth['"]/)
		}
	})

	test('mailer keeps plain API and adds an Effect subpath wrapper', () => {
		const mailerPkg = pkg('packages/mailer/package.json')
		expect(mailerPkg.dependencies?.effect).toBeDefined()
		expect(mailerPkg.exports?.['./effect']).toBeDefined()
		expect(requireContent('packages/mailer/src/client.ts')).toContain('export function createMailer')
		expect(requireContent('packages/mailer/src/effect.ts')).toContain('MailerService')
	})

	test('Hey API is exact-pinned for Effect contract codegen', () => {
		const clientPkg = pkg('packages/openapi-client/package.json')
		expect(clientPkg.devDependencies?.['@hey-api/openapi-ts']).toBe('0.99.0')
		expect(clientPkg.dependencies?.['@hey-api/client-fetch']).toBeUndefined()
	})
})
