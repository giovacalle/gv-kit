import { describe, expect, test } from 'bun:test'
import { buildContentSecurityPolicy } from '../../fixtures/templates/marketing/base/src/lib/content-security-policy.js'
import { runGenerators } from '../../src/generators/index.js'
import { generateMarketingAstro } from '../../src/generators/marketing-astro.js'
import {
	CLOUDFLARE_WORKER_NAME_LIMIT,
	cloudflareProductionWorkerName
} from '../../src/lib/cloudflare-worker-name.js'
import type { FileEntry } from '../../src/lib/files.js'
import { parseJsonc } from '../../src/lib/jsonc.js'
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
	deploy: 'skip'
}

function makeCfg(overrides: Partial<Choices> = {}): GvKitConfig {
	return { configVersion: 2, choices: { ...baseChoices, ...overrides } }
}

function findEntry(entries: FileEntry[], path: string): FileEntry | undefined {
	return entries.find((entry) => entry.path === path)
}

function content(entries: FileEntry[], path: string): string {
	const entry = findEntry(entries, path)
	if (!entry) throw new Error(`expected generated entry ${path}`)
	return entry.content
}

describe('generateMarketingAstro — shape gating', () => {
	test('inside-web emits no marketing entries', () => {
		expect(generateMarketingAstro(makeCfg({ marketing: 'inside-web' }))).toEqual([])
	})

	test('Astro shape emits the static application skeleton', () => {
		const paths = generateMarketingAstro(makeCfg()).map((entry) => entry.path)
		for (const path of [
			'apps/marketing/package.json',
			'apps/marketing/astro.config.mjs',
			'apps/marketing/tsconfig.json',
			'apps/marketing/src/layouts/base.astro',
			'apps/marketing/src/pages/index.astro',
			'apps/marketing/src/pages/404.astro',
			'apps/marketing/src/pages/robots.txt.ts'
		]) {
			expect(paths).toContain(path)
		}
		expect(paths.some((path) => path.startsWith('apps/marketing/src/pages/blog'))).toBe(false)
	})

	test('auth choices do not change marketing output', () => {
		const anonymous = generateMarketingAstro(makeCfg())
		const authenticatedApp = generateMarketingAstro(
			makeCfg({ auth: ['emailOTP', 'google'], email: 'resend' })
		)
		expect(authenticatedApp).toEqual(anonymous)
	})
})

describe('generateMarketingAstro — static and shared UI contract', () => {
	test('uses a plain static Astro config with Svelte, sitemap, Tailwind, and canonical site', () => {
		const astroConfig = content(
			generateMarketingAstro(makeCfg()),
			'apps/marketing/astro.config.mjs'
		)
		expect(astroConfig).toContain("output: 'static'")
		expect(astroConfig).toContain('PUBLIC_MARKETING_URL')
		expect(astroConfig).toContain('svelte()')
		expect(astroConfig).toContain('sitemap(')
		expect(astroConfig).toContain('tailwindcss()')
		expect(astroConfig).not.toMatch(/defineConfig\s*\(\s*\(/)
	})

	test('imports public UI paths and mirrors @lib only as resolver configuration', () => {
		const entries = generateMarketingAstro(makeCfg())
		const home = content(entries, 'apps/marketing/src/components/marketing-home.astro')
		const tsconfig = content(entries, 'apps/marketing/tsconfig.json')
		const astroConfig = content(entries, 'apps/marketing/astro.config.mjs')
		expect(home).toContain('@repo/ui/')
		expect(tsconfig).toContain('../../packages/ui/src/lib')
		expect(astroConfig).toContain('../../packages/ui/src/lib')
		for (const entry of entries.filter((entry) => entry.path.match(/\.(astro|ts|js|svelte)$/))) {
			expect(entry.content, entry.path).not.toMatch(/from\s+['"]@lib(?:\/|['"])/)
		}
	})

	test('loads shared styles/fonts once and scans Astro plus raw Svelte sources', () => {
		const entries = generateMarketingAstro(makeCfg())
		const css = content(entries, 'apps/marketing/src/styles/app.css')
		expect(css).toContain('@repo/ui/styles')
		expect(css).toContain('@fontsource-variable/geist')
		expect(css).toContain('packages/ui/src')
		expect(css).toContain("@source '../**/*.{astro")
	})

	test('uses PUBLIC_APP_URL for the CTA and contains no app/backend/auth secrets', () => {
		const entries = generateMarketingAstro(makeCfg())
		const all = entries.map((entry) => entry.content).join('\n')
		expect(all).toContain('PUBLIC_APP_URL')
		for (const forbidden of [
			'BETTER_AUTH_SECRET',
			'DATABASE_URL',
			'GOOGLE_CLIENT_SECRET',
			'@repo/backend',
			'@repo/db',
			'$app/'
		]) {
			expect(all).not.toContain(forbidden)
		}
	})
})

describe('generateMarketingAstro — option overlays', () => {
	test('bounds the route-backed marketing Worker without renaming its package or preview', () => {
		const project = `a${'b'.repeat(254)}`
		const entries = generateMarketingAstro(
			makeCfg({
				name: project,
				deploy: 'cf-workers',
				backend: 'inside-frontend',
				apiClient: 'skip'
			})
		)
		const wrangler = parseJsonc<{
			name: string
			workers_dev?: boolean
			routes: Array<{ pattern: string; custom_domain: boolean }>
		}>(content(entries, 'apps/marketing/wrangler.jsonc'))
		const packageJson = JSON.parse(content(entries, 'apps/marketing/package.json')) as {
			name: string
			scripts: Record<string, string>
		}

		expect(wrangler.workers_dev).toBeUndefined()
		expect(wrangler.routes).toEqual([{ pattern: '<domain>', custom_domain: true }])
		expect(wrangler.name).toBe(cloudflareProductionWorkerName({ project, service: 'marketing' }))
		expect(wrangler.name.length).toBeLessThanOrEqual(CLOUDFLARE_WORKER_NAME_LIMIT)
		expect(packageJson.name).toBe(`${project}-marketing`)
		expect(packageJson.scripts['deploy:staging']).toContain(
			`--name ${project}-marketing-$STAGING_ALIAS`
		)

		const legacyProject = 'a'.repeat(100)
		const legacyWrangler = parseJsonc<{ name: string }>(
			content(
				generateMarketingAstro(
					makeCfg({
						name: legacyProject,
						deploy: 'cf-workers',
						backend: 'inside-frontend',
						apiClient: 'skip'
					})
				),
				'apps/marketing/wrangler.jsonc'
			)
		)
		expect(legacyWrangler.name).toBe(`${legacyProject}-marketing`)

		const exactProject = 'a'.repeat(CLOUDFLARE_WORKER_NAME_LIMIT - '-marketing'.length)
		const oneOverProject = `${exactProject}a`
		const exactWrangler = parseJsonc<{ name: string }>(
			content(
				generateMarketingAstro(
					makeCfg({
						name: exactProject,
						deploy: 'cf-workers',
						backend: 'inside-frontend',
						apiClient: 'skip'
					})
				),
				'apps/marketing/wrangler.jsonc'
			)
		)
		const oneOverWrangler = parseJsonc<{ name: string }>(
			content(
				generateMarketingAstro(
					makeCfg({
						name: oneOverProject,
						deploy: 'cf-workers',
						backend: 'inside-frontend',
						apiClient: 'skip'
					})
				),
				'apps/marketing/wrangler.jsonc'
			)
		)
		expect(exactWrangler.name).toBe(`${exactProject}-marketing`)
		expect(oneOverWrangler.name).toHaveLength(CLOUDFLARE_WORKER_NAME_LIMIT)
		expect(oneOverWrangler.name).not.toBe(`${oneOverProject}-marketing`)
	})

	test('Paraglide adds localized static route without copying catalogs', () => {
		const entries = generateMarketingAstro(makeCfg({ i18n: 'paraglide' }))
		expect(findEntry(entries, 'apps/marketing/src/pages/[locale]/index.astro')).toBeDefined()
		expect(
			entries.some((entry) => entry.path.match(/apps\/marketing\/.*messages\/.*\.json$/))
		).toBe(false)
		const all = entries.map((entry) => entry.content).join('\n')
		expect(all).toContain('@repo/i18n/messages')
		expect(all).toContain('@repo/i18n/runtime')
	})

	test('Cloudflare deploy emits an assets-only Wrangler config only for that target', () => {
		const cf = generateMarketingAstro(makeCfg({ deploy: 'cf-workers' }))
		const docker = generateMarketingAstro(makeCfg({ deploy: 'docker' }))
		const skip = generateMarketingAstro(makeCfg({ deploy: 'skip' }))
		const wrangler = content(cf, 'apps/marketing/wrangler.jsonc')
		expect(wrangler).toContain('"directory": "./dist/"')
		expect(wrangler).toContain('"not_found_handling": "404-page"')
		expect(wrangler).not.toContain('"main"')
		expect(findEntry(docker, 'apps/marketing/wrangler.jsonc')).toBeUndefined()
		expect(findEntry(skip, 'apps/marketing/wrangler.jsonc')).toBeUndefined()
	})

	test('selected monitoring is emitted once and skipped otherwise', () => {
		const none = runGenerators(makeCfg({ monitoring: [] }))
		const both = runGenerators(makeCfg({ monitoring: ['umami', 'posthog'] }))
		const noneMarketing = none.filter((entry) => entry.path.startsWith('apps/marketing/'))
		const bothMarketing = both.filter((entry) => entry.path.startsWith('apps/marketing/'))
		expect(noneMarketing.map((entry) => entry.content).join('\n')).not.toContain('posthog-js')
		expect(bothMarketing.map((entry) => entry.content).join('\n')).toContain('posthog-js')
		expect(bothMarketing.map((entry) => entry.content).join('\n')).toContain('PUBLIC_UMAMI_')
	})

	test('delivery CSP keeps framing protection and permits islands plus selected origins', () => {
		for (const deploy of ['cf-workers', 'docker'] as const) {
			const entries = generateMarketingAstro(makeCfg({ deploy, monitoring: ['umami', 'posthog'] }))
			const layout = content(entries, 'apps/marketing/src/layouts/base.astro')
			const policy = content(entries, 'apps/marketing/src/lib/content-security-policy.ts')
			expect(layout).toContain('http-equiv="Content-Security-Policy"')
			expect(policy).toContain("script-src 'self' 'unsafe-inline'")
			expect(layout).toContain('buildContentSecurityPolicy')
			expect(layout).toContain('PUBLIC_UMAMI_HOST')
			expect(layout).toContain('PUBLIC_POSTHOG_HOST')
			const delivery = content(
				entries,
				deploy === 'cf-workers' ? 'apps/marketing/public/_headers' : 'apps/marketing/nginx.conf'
			)
			expect(delivery).toContain("frame-ancestors 'none'")
			expect(delivery).not.toContain("default-src 'self'")
		}
	})

	test('PostHog CSP scopes Cloud and self-hosted runtime policies independently', () => {
		const cloud = buildContentSecurityPolicy({
			posthogHost: 'https://eu.i.posthog.com',
			posthogKey: 'phc_test'
		})
		expect(cloud).toContain(
			"script-src 'self' 'unsafe-inline' https://*.posthog.com https://eu.i.posthog.com"
		)
		expect(cloud).toContain("connect-src 'self' https://*.posthog.com https://eu.i.posthog.com")
		expect(cloud).toContain("worker-src 'self' blob: data:")

		const selfHosted = buildContentSecurityPolicy({
			posthogHost: 'https://posthog.internal.example',
			posthogKey: 'phc_test'
		})
		expect(selfHosted).toContain(
			"script-src 'self' 'unsafe-inline' https://posthog.internal.example"
		)
		expect(selfHosted).toContain("connect-src 'self' https://posthog.internal.example")
		expect(selfHosted).not.toContain('https://*.posthog.com')
		expect(selfHosted).toContain("worker-src 'self' blob: data:")
	})

	test('no template fences or unresolved gv-kit placeholders survive', () => {
		const entries = generateMarketingAstro(
			makeCfg({
				i18n: 'paraglide',
				monitoring: ['umami', 'posthog'],
				deploy: 'cf-workers'
			})
		)
		for (const entry of entries) {
			expect(entry.content, entry.path).not.toContain('@gvkit:')
			expect(entry.content, entry.path).not.toMatch(/__[A-Z0-9_]+__/)
		}
	})
})
