import { describe, expect, test } from 'bun:test'
import { generateDeploy } from '../../src/generators/deploy.js'
import { generateRoot } from '../../src/generators/root.js'
import { generateTooling } from '../../src/generators/tooling.js'
import type { FileEntry } from '../../src/lib/files.js'
import type { Choices, GvKitConfig } from '../../src/schema/config.js'

const baseChoices: Choices = {
	name: 'demo',
	frontend: 'sveltekit',
	marketing: 'astro',
	backend: 'hono',
	i18n: 'skip',
	monitoring: [],
	db: 'sqlite',
	apiClient: 'hey-api',
	auth: [],
	email: 'skip',
	aiTooling: [],
	deploy: 'cf-workers'
}

function makeCfg(overrides: Partial<Choices> = {}): GvKitConfig {
	return { configVersion: 2, choices: { ...baseChoices, ...overrides } }
}

function content(entries: FileEntry[], path: string): string {
	const hit = entries.find((entry) => entry.path === path)
	if (!hit) throw new Error(`expected generated entry ${path}`)
	return hit.content
}

describe('generateRoot — Astro project shape', () => {
	test('generated workspace pins Node 24 and formats Astro files', () => {
		const pkg = JSON.parse(content(generateRoot(makeCfg()), 'package.json')) as {
			engines: { node: string }
			scripts: { format: string }
			'lint-staged': Record<string, string[]>
		}
		expect(pkg.engines.node).toBe('>=24.0.0 <25.0.0')
		expect(pkg.scripts.format).toContain('astro')
		expect(Object.keys(pkg['lint-staged']).some((glob) => glob.includes('astro'))).toBe(true)
	})

	test('postinstall prepares selected generated packages before workspace checks', () => {
		const pkg = JSON.parse(
			content(generateRoot(makeCfg({ i18n: 'paraglide', apiClient: 'hey-api' })), 'package.json')
		) as { scripts: { postinstall?: string } }
		expect(pkg.scripts.postinstall).toContain(
			'test ! -f packages/i18n/project.inlang/settings.json ||'
		)
		expect(pkg.scripts.postinstall).toContain('pnpm --filter @repo/i18n build')
		expect(pkg.scripts.postinstall).toContain(
			'test ! -f packages/openapi-client/openapi-ts.config.ts ||'
		)
		expect(pkg.scripts.postinstall).toContain('pnpm --filter @repo/openapi-client codegen')
	})

	test('Turbo forwards complete public origins and selected monitoring to static builds', () => {
		const turbo = JSON.parse(
			content(generateRoot(makeCfg({ monitoring: ['umami', 'posthog'] })), 'turbo.json')
		) as {
			tasks: { build: { env?: string[] } }
		}
		expect(turbo.tasks.build.env).toEqual(
			expect.arrayContaining([
				'PUBLIC_MARKETING_URL',
				'PUBLIC_APP_URL',
				'PUBLIC_UMAMI_HOST',
				'PUBLIC_UMAMI_WEBSITE_ID',
				'PUBLIC_POSTHOG_KEY',
				'PUBLIC_POSTHOG_HOST'
			])
		)
	})

	test('auth public variables are forwarded to builds and documented without secret values', () => {
		const entries = generateRoot(
			makeCfg({ marketing: 'inside-web', auth: ['emailOTP'], email: 'resend' })
		)
		const turbo = JSON.parse(content(entries, 'turbo.json')) as {
			tasks: { build: { env?: string[] } }
		}
		expect(turbo.tasks.build.env).toEqual([
			'PUBLIC_AUTH_URL',
			'PUBLIC_TURNSTILE_SITE_KEY'
		])
		const env = content(entries, '.env.example')
		expect(env).toContain('PUBLIC_AUTH_URL=http://localhost:5173')
		expect(env).toContain('PUBLIC_TURNSTILE_SITE_KEY=')
		expect(env).toContain('FROM_EMAIL=')
	})

	test('non-Cloudflare Hono auth variables use the auth-service origin', () => {
		const cfg = makeCfg({ deploy: 'docker', auth: ['emailOTP'], email: 'resend' })
		const env = content(generateRoot(cfg), '.env.example')
		const compose = content(generateDeploy(cfg), 'docker-compose.yml')

		expect(env).toContain('BETTER_AUTH_URL=http://localhost:8787')
		expect(env).not.toContain('BETTER_AUTH_URL=http://localhost:5173')
		expect(compose).toContain('BETTER_AUTH_URL: ${BETTER_AUTH_URL:-http://localhost:8787}')
	})

	test('PostHog example uses the EU ingestion host forwarded by Docker builds', () => {
		const env = content(generateRoot(makeCfg({ monitoring: ['posthog'] })), '.env.example')
		expect(env).toContain('PUBLIC_POSTHOG_HOST=https://eu.i.posthog.com')
		expect(env).not.toContain('PUBLIC_POSTHOG_HOST=https://eu.posthog.com')
	})

	test('Astro shape documents and scaffolds local public origins', () => {
		const entries = generateRoot(makeCfg())
		const env = content(entries, '.env.example')
		const readme = content(entries, 'README.md')
		expect(env).toContain('PUBLIC_MARKETING_URL=http://localhost:4321')
		expect(env).toContain('PUBLIC_APP_URL=http://localhost:5173')
		expect(readme).toContain('apps/marketing')
		expect(readme).toContain('https://app.example.com')
	})

	test('Docker examples use the Compose app origin instead of the dev-server port', () => {
		const entries = generateRoot(makeCfg({ deploy: 'docker' }))
		expect(content(entries, '.env.example')).toContain('PUBLIC_APP_URL=http://localhost:3000')
		expect(content(entries, 'README.md')).toContain('PUBLIC_APP_URL=http://localhost:3000')
	})

	test('inside-web does not invent a marketing app or public-origin pair', () => {
		const entries = generateRoot(makeCfg({ marketing: 'inside-web' }))
		expect(content(entries, '.env.example')).not.toContain('PUBLIC_MARKETING_URL')
		expect(content(entries, 'README.md')).not.toContain('apps/marketing')
	})
})

describe('generateTooling — Astro formatting', () => {
	test('shared Prettier config installs and registers the Astro plugin', () => {
		const entries = generateTooling(makeCfg())
		const pkg = JSON.parse(content(entries, 'packages/tooling/prettier-config/package.json')) as {
			dependencies: Record<string, string>
		}
		const config = content(entries, 'packages/tooling/prettier-config/index.js')
		expect(pkg.dependencies['prettier-plugin-astro']).toBe('^0.14.1')
		expect(config).toContain("require.resolve('prettier-plugin-astro')")
		expect(config).toContain("files: '*.astro'")
	})

	test('shared TypeScript tooling uses Node 24 ambient types', () => {
		const pkg = JSON.parse(
			content(generateTooling(makeCfg()), 'packages/tooling/typescript-config/package.json')
		) as { dependencies: Record<string, string> }
		expect(pkg.dependencies['@types/node']).toBe('^24.0.0')
	})

	test('shared ESLint tooling ignores generated application build output', () => {
		const config = content(generateTooling(makeCfg()), 'packages/tooling/eslint-config/index.js')
		expect(config).toContain("'**/build/**'")
	})
})
