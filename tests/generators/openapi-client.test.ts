import { describe, expect, test } from 'bun:test'

import { generateOpenapiClient } from '../../src/generators/openapi-client.js'
import type { FileEntry } from '../../src/lib/files.js'
import type { Choices, GvKitConfig } from '../../src/schema/config.js'

const baseChoices: Choices = {
	name: 'demo',
	frontend: 'sveltekit',
	backend: 'hono',
	i18n: 'skip',
	monitoring: [],
	db: 'sqlite',
	apiClient: 'hey-api',
	auth: [],
	email: 'skip',
	aiTooling: ['claude'],
	deploy: 'cf-workers'
}

function makeCfg(overrides: Partial<Choices>): GvKitConfig {
	return { configVersion: 1, choices: { ...baseChoices, ...overrides } }
}

const find = (entries: FileEntry[], path: string) => entries.find((e) => e.path === path)

describe('generateOpenapiClient', () => {
	test('emits the package when apiClient=hey-api', () => {
		const paths = generateOpenapiClient(makeCfg({})).map((e) => e.path)
		expect(paths).toContain('packages/openapi-client/package.json')
		expect(paths).toContain('packages/openapi-client/openapi-ts.config.ts')
		expect(paths).toContain('packages/openapi-client/src/users/index.ts')
	})

	test('emits nothing when apiClient=skip', () => {
		expect(generateOpenapiClient(makeCfg({ apiClient: 'skip' }))).toEqual([])
	})

	test('config targets the users spec + svelte-query plugin and excludes auth', () => {
		const config = find(
			generateOpenapiClient(makeCfg({})),
			'packages/openapi-client/openapi-ts.config.ts'
		)!
		expect(config.content).toContain('@hey-api/openapi-ts')
		expect(config.content).toContain('apps/api/users/openapi.json')
		expect(config.content).toContain('@tanstack/svelte-query')
		expect(config.content).toContain('auth deliberately omitted')
		expect(config.content).toContain('tsConfigPath')
	})

	test('package.json declares hey-api + tanstack deps and the codegen script', () => {
		const pkg = JSON.parse(
			find(generateOpenapiClient(makeCfg({})), 'packages/openapi-client/package.json')!.content
		) as {
			name: string
			scripts: Record<string, string>
			dependencies: Record<string, string>
			devDependencies: Record<string, string>
		}
		expect(pkg.name).toBe('@repo/openapi-client')
		expect(pkg.scripts.codegen).toBe('openapi-ts')
		expect(pkg.dependencies['@tanstack/svelte-query']).toBeDefined()
		expect(pkg.dependencies['@hey-api/client-fetch']).toBeDefined()
		expect(pkg.devDependencies['@hey-api/openapi-ts']).toBeDefined()
	})
})
