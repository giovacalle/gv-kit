import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'

import { runGenerators } from '../../src/generators/index.js'
import { parseJsonc } from '../../src/lib/jsonc.js'
import { GvKitConfig } from '../../src/schema/config.js'

const effectFixture = GvKitConfig.parse(
	parseJsonc(
		readFileSync(
			join(import.meta.dir, '..', '..', 'fixtures', 'hono-effect-cf-workers-sqlite.jsonc'),
			'utf8'
		)
	)
)

function generated(overrides: Partial<typeof effectFixture.choices> = {}) {
	return runGenerators({
		...effectFixture,
		choices: { ...effectFixture.choices, ...overrides }
	})
}

function requireContent(entries: ReturnType<typeof generated>, path: string): string {
	const entry = entries.find((candidate) => candidate.path === path)
	if (!entry) throw new Error(`missing generated file: ${path}`)
	return entry.content
}

function packageJson(entries: ReturnType<typeof generated>, path: string) {
	return JSON.parse(requireContent(entries, path)) as {
		scripts: Record<string, string>
		dependencies?: Record<string, string>
		devDependencies?: Record<string, string>
	}
}

describe('Effect canonical runtime OpenAPI workflow', () => {
	test('serves the runtime document without materializing a contract file', () => {
		const entries = generated()
		const paths = entries.map((entry) => entry.path)
		const config = requireContent(entries, 'packages/openapi-client/openapi-ts.config.ts')

		expect(paths).not.toContain('apps/api/users/openapi.json')
		expect(paths).not.toContain('apps/api/users/src/openapi-dump.ts')
		expect(paths).not.toContain('apps/api/users/src/openapi-lint.ts')
		expect(paths).not.toContain('apps/api/users/src/openapi.test.ts')
		expect(config).toContain('process.env.OPENAPI_URL')
		expect(config).toContain("'http://localhost:8788/openapi.json'")
		expect(config).toContain('input: openApiUrl')
		expect(config).not.toContain('app.request(')
		expect(config).not.toContain("input: '../../apps/api/users/openapi.json'")
	})

	test('marks only the authenticated operation as secured', () => {
		const entries = generated()
		const route = requireContent(entries, 'apps/api/users/src/features/me/route.ts')
		const openapi = requireContent(entries, 'apps/api/users/src/openapi.ts')

		expect(route).toContain("security: [{ sessionCookie: [] }]")
		expect(openapi).toContain('securitySchemes')
		expect(openapi).toContain('sessionCookie')
		expect(openapi).not.toContain('security: []')
	})

	test('keeps URL codegen explicit and typechecks a real consumer normally', () => {
		const entries = generated()
		const root = packageJson(entries, 'package.json')
		const users = packageJson(entries, 'apps/api/users/package.json')
		const client = packageJson(entries, 'packages/openapi-client/package.json')
		const web = packageJson(entries, 'apps/web/package.json')
		const config = requireContent(entries, 'packages/openapi-client/openapi-ts.config.ts')
		const consumer = requireContent(entries, 'packages/openapi-client/src/contract-consumer.ts')
		const usersPage = requireContent(entries, 'apps/web/src/routes/users/+page.svelte')
		const clientTsconfig = JSON.parse(
			requireContent(entries, 'packages/openapi-client/tsconfig.json')
		) as { compilerOptions?: { lib?: string[] } }

		expect(root.scripts['client:generate']).toBe('pnpm --filter @repo/openapi-client codegen')
		expect(root.scripts['contract:verify']).toBeUndefined()
		expect(root.scripts.postinstall).not.toContain('client:generate')
		expect(users.scripts['openapi:dump']).toBeUndefined()
		expect(users.scripts['openapi:lint']).toBeUndefined()
		expect(users.scripts.test).toBe('vitest run')
		expect(users.devDependencies?.['@apidevtools/swagger-parser']).toBeUndefined()
		expect(client.devDependencies?.['@apidevtools/swagger-parser']).toBeUndefined()
		expect(client.devDependencies?.['@types/node']).toBe('^22.10.0')
		expect(config).toContain('process.env.OPENAPI_URL')
		expect(client.scripts.typecheck).toBe('tsc --noEmit')
		expect(client.dependencies?.['@tanstack/svelte-query']).toBe('^5.74.2')
		expect(web.dependencies?.['@tanstack/svelte-query']).toBe('^5.74.2')
		expect(clientTsconfig.compilerOptions?.lib).toEqual(['ES2022', 'DOM', 'DOM.Iterable'])
		expect(consumer).toContain('getUsersMeOptions')
		expect(usersPage).toContain('createQuery(getUsersMeOptions())')
		expect(usersPage).toContain('$profile.data')
	})

	test('does not add client bootstrap lifecycle when apiClient=skip', () => {
		const entries = generated({ apiClient: 'skip' })
		const root = packageJson(entries, 'package.json')

		expect(entries.some((entry) => entry.path.startsWith('packages/openapi-client/'))).toBe(false)
		expect(root.scripts['client:generate']).toBeUndefined()
		expect(root.scripts['contract:verify']).toBeUndefined()
	})
})
