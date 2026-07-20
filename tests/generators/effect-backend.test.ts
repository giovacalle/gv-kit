import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
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

		expect(requireContent('apps/api/users/src/features/me/schema.ts')).toContain("from 'effect'")
		expect(requireContent('apps/api/users/src/features/me/route.ts')).toContain('describeRoute')
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
		expect(app).toContain(
			'makeAuthSessionService.pipe(Effect.provideService(WorkerEnvService, c.env))'
		)
		expect(app).toContain('Effect.provideServiceEffect(')
		expect(app).not.toContain('auth.api.getSession')
		expect(service).toContain('WorkerEnvService')
		expect(service).not.toContain('@repo/backend/effect/auth-session')
		expect(service).toContain('AuthSessionService')
		expect(service).toContain('resolveBetterAuthSession')
		expect(service).toContain('getAuth(env)')
		expect(service).toContain('resolvedAuth.api.getSession')
	})

	test('Effect output has no production example route or database write surface', () => {
		const forbiddenPaths = [
			'apps/api/users/src/routes/example-posts/schema.ts',
			'apps/api/users/src/routes/example-posts/route.ts',
			'apps/api/users/src/routes/example-posts/handler.ts',
			'apps/api/users/src/routes/example-posts/index.ts',
			'packages/db/src/schema/sample.ts'
		]

		for (const path of forbiddenPaths) expect(content(path)).toBeUndefined()
		expect(entries.some((entry) => entry.path.includes('effect-schema-harness'))).toBe(false)

		const generated = entries.map((entry) => `${entry.path}\n${entry.content}`).join('\n')
		expect(generated).not.toContain('/examples')
		expect(generated).not.toContain('upsertExamplePost')
		expect(generated).not.toContain('schema.posts')
		expect(generated).not.toContain("sqliteTable('posts'")
		expect(generated).not.toContain("pgTable('posts'")
		expect(requireContent('packages/db/src/schema/index.ts')).not.toContain('./sample.js')
	})

	test('runtime users OpenAPI excludes the removed production example contract', () => {
		expect(content('apps/api/users/openapi.json')).toBeUndefined()

		const contractSources = [
			requireContent('apps/api/users/src/openapi.ts'),
			requireContent('apps/api/users/src/features/me/route.ts'),
			requireContent('apps/api/users/src/features/me/schema.ts')
		].join('\n')
		expect(contractSources).not.toContain('/examples')
		expect(contractSources).not.toContain('ExamplePost')
		expect(contractSources).toContain('ErrorResponseStandard')
	})

	test('shared backend owns Effect helpers while db stays thin', () => {
		const backendPkg = pkg('packages/backend/package.json')
		expect(backendPkg.dependencies?.effect).toBeDefined()
		expect(backendPkg.exports?.['.']).toBeUndefined()
		expect(backendPkg.exports?.['./effect']).toBeUndefined()
		expect(backendPkg.exports?.['./effect/errors']).toBeDefined()
		expect(backendPkg.exports?.['./effect/hono']).toBeDefined()
		expect(backendPkg.exports?.['./effect/auth-session']).toBeUndefined()
		expect(backendPkg.exports?.['./hono']).toBeUndefined()
		expect(backendPkg.exports?.['./hono/auth']).toBeUndefined()
		expect(backendPkg.exports?.['./hono/logger']).toBeDefined()
		expect(backendPkg.exports?.['./hono/auth/client']).toBeUndefined()
		expect(backendPkg.exports?.['./hono/auth/require']).toBeUndefined()
		expect(backendPkg.exports?.['./helpers']).toBeUndefined()
		expect(content('packages/backend/src/helpers/index.ts')).toBeUndefined()
		expect(content('packages/backend/src/helpers/index.test.ts')).toBeUndefined()
		expect(content('packages/backend/src/index.ts')).toBeUndefined()
		expect(content('packages/backend/src/effect/index.ts')).toBeUndefined()
		expect(content('packages/backend/src/hono/index.ts')).toBeUndefined()
		expect(content('packages/backend/src/hono/auth/index.ts')).toBeUndefined()
		expect(content('packages/backend/src/hono/error-handler.ts')).toBeUndefined()
		expect(requireContent('packages/backend/src/effect/errors.ts')).toContain(
			'tryPromiseUnexpected'
		)
		expect(content('packages/backend/src/effect/auth-session.ts')).toBeUndefined()
		expect(content('packages/backend/src/hono/auth/client.ts')).toBeUndefined()
		expect(content('packages/backend/src/hono/auth/require.ts')).toBeUndefined()
		expect(content('packages/backend/src/core/data-access/users.ts')).toBeUndefined()
		expect(content('packages/backend/src/core/use-cases/users.ts')).toBeUndefined()

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
		expect(requireContent('packages/mailer/src/client.ts')).toContain(
			'export function createMailer'
		)
		expect(requireContent('packages/mailer/src/effect.ts')).toContain('MailerService')
	})

	test('Hey API is exact-pinned for Effect contract codegen', () => {
		const clientPkg = pkg('packages/openapi-client/package.json')
		expect(clientPkg.devDependencies?.['@hey-api/openapi-ts']).toBe('0.99.0')
		expect(clientPkg.dependencies?.['@hey-api/client-fetch']).toBeUndefined()
	})
})
