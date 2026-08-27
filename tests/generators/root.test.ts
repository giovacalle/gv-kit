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
		) as { scripts: Record<string, string | undefined> }
		expect(pkg.scripts.postinstall).toContain(
			'test ! -f packages/i18n/project.inlang/settings.json ||'
		)
		expect(pkg.scripts.postinstall).toContain('pnpm --filter @repo/i18n build')
		expect(pkg.scripts.postinstall).toContain(
			'test ! -f packages/openapi-client/openapi-ts.config.ts ||'
		)
		expect(pkg.scripts.postinstall).toContain('pnpm codegen')
		expect(pkg.scripts.codegen).toBe(
			'pnpm openapi:check && pnpm --filter @repo/openapi-client codegen'
		)
		expect(pkg.scripts['openapi:compose']).toContain('openapi:compose')
		expect(pkg.scripts['openapi:check']).toContain('openapi:check')
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

	test('Hono auth documents host and CORS allowlists without a public auth URL', () => {
		const entries = generateRoot(
			makeCfg({
				marketing: 'inside-web',
				auth: ['emailOTP'],
				email: 'resend',
				deploy: 'skip'
			})
		)
		const turbo = JSON.parse(content(entries, 'turbo.json')) as {
			tasks: Record<string, { dependsOn?: string[]; env?: string[] }>
		}
		expect(turbo.tasks.build?.env).toEqual(['PUBLIC_TURNSTILE_SITE_KEY'])
		expect(turbo.tasks['@demo/api-gateway#dev']?.dependsOn).toEqual(['^build'])
		expect(turbo.tasks['@demo/api-gateway#dev']?.env).toEqual([
			'API_PUBLIC_ORIGIN',
			'GATEWAY_PUBLIC_ORIGINS',
			'GATEWAY_TRUSTED_INGRESS_SECRET',
			'API_CORS_ORIGINS',
			'GATEWAY_UPSTREAM_TIMEOUT_MS',
			'AUTH_URL',
			'USERS_URL'
		])
		expect(turbo.tasks['@demo/auth-worker#dev']?.env).toEqual([
			'SQLITE_PATH',
			'BETTER_AUTH_SECRET',
			'BETTER_AUTH_ALLOWED_HOSTS',
			'AUTH_CORS_ORIGINS',
			'RESEND_API_KEY',
			'FROM_EMAIL',
			'TURNSTILE_SECRET_KEY'
		])
		expect(turbo.tasks['@demo/users-worker#dev']?.env).toEqual(['SQLITE_PATH', 'AUTH_URL'])
		expect(turbo.tasks['demo-web#dev']?.env).toEqual([
			'GATEWAY_URL',
			'GATEWAY_TRUSTED_INGRESS_SECRET',
			'PUBLIC_TURNSTILE_SITE_KEY'
		])
		const env = content(entries, '.env.example')
		expect(env).not.toContain('PUBLIC_AUTH_URL')
		expect(env).toContain('API_PUBLIC_ORIGIN=http://localhost:8786')
		expect(env).toContain(
			'BETTER_AUTH_ALLOWED_HOSTS=localhost:5173,localhost:8786,127.0.0.1:8786'
		)
		expect(env).toContain('AUTH_CORS_ORIGINS=http://localhost:5173')
		expect(env).not.toContain('<preview-web-host>')
		expect(env).toContain('PUBLIC_TURNSTILE_SITE_KEY=')
		expect(env).toContain('FROM_EMAIL=')
		expect(env).toContain('SQLITE_PATH=file:./.data/local.db')
	})

	test('Hono root commands load, validate, and prepare the generated local environment', () => {
		const entries = generateRoot(
			makeCfg({ marketing: 'inside-web', auth: ['emailOTP'], email: 'resend', deploy: 'skip' })
		)
		const pkg = JSON.parse(content(entries, 'package.json')) as {
			scripts: Record<string, string>
		}
		const local = content(entries, 'scripts/local.mjs')
		const readme = content(entries, 'README.md')

		expect(pkg.scripts.dev).toBe('node scripts/local.mjs dev')
		expect(pkg.scripts.typecheck).toBe('turbo run typecheck')
		expect(pkg.scripts['local:prepare']).toBe('node scripts/local.mjs prepare')
		expect(local).toContain("loadEnvFile(resolve('.env'))")
		expect(local).toContain('Missing .env. Run `cp .env.example .env`')
		expect(local).toContain('"API_PUBLIC_ORIGIN"')
		expect(local).toContain('"GATEWAY_PUBLIC_ORIGINS"')
		expect(local).toContain('"GATEWAY_TRUSTED_INGRESS_SECRET"')
		expect(local).toContain('"BETTER_AUTH_SECRET"')
		expect(local).toContain('"TURNSTILE_SECRET_KEY"')
		expect(local).toContain("dev: ['exec', 'turbo', 'run', 'dev'")
		expect(local).toContain("'--filter=./apps/*', '--filter=./services/*'")
		expect(local).not.toContain('typecheck')
		expect(local).not.toContain('--env-mode=loose')
		expect(readme).toContain('cp .env.example .env')
		expect(readme).toContain('pnpm local:prepare')
		expect(readme).toContain('pnpm dev')
	})

	test('non-Cloudflare Hono auth uses gateway ingress allowlists', () => {
		const cfg = makeCfg({ deploy: 'docker', auth: ['emailOTP'], email: 'resend' })
		const env = content(generateRoot(cfg), '.env.example')
		const compose = content(generateDeploy(cfg), 'docker-compose.yml')

		expect(env).not.toContain('BETTER_AUTH_URL=')
		expect(env).toContain('BETTER_AUTH_ALLOWED_HOSTS=')
		expect(compose).toContain('BETTER_AUTH_ALLOWED_HOSTS:')
		expect(compose).toContain('AUTH_CORS_ORIGINS:')
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

	test('Docker examples distinguish public ingress from private service targets', () => {
		const entries = generateRoot(makeCfg({ deploy: 'docker' }))
		const env = content(entries, '.env.example')
		expect(env).toContain('PUBLIC_APP_URL=http://localhost:3000')
		expect(env).toContain('# Browser API alias: http://localhost:3000/api/*')
		expect(env).toContain('API_PUBLIC_ORIGIN=http://api.localhost:3000')
		expect(env).toContain(
			'GATEWAY_PUBLIC_ORIGINS=http://localhost:3000,http://api.localhost:3000,http://localhost:8786,http://127.0.0.1:8786'
		)
		expect(env).toContain('GATEWAY_TRUSTED_INGRESS_SECRET=')
		expect(env).toContain('GATEWAY_URL=http://127.0.0.1:8786')
		expect(env).toContain('AUTH_URL=http://127.0.0.1:8787')
		expect(env).toContain('USERS_URL=http://127.0.0.1:8788')
		expect(env).not.toMatch(/^PUBLIC_(?:API|AUTH|USERS)_URL=/m)
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
