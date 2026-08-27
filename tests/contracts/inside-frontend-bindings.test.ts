import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { runGenerators } from '../../src/generators/index.js'
import { GvKitConfig } from '../../src/schema/config.js'
import { parseJsonc } from '../util/jsonc.js'

const fixturesDir = join(import.meta.dir, '..', '..', 'fixtures')

const insideFixtures = readdirSync(fixturesDir)
	.filter((f) => f.endsWith('.jsonc'))
	.map((f) => ({
		file: f,
		cfg: GvKitConfig.parse(parseJsonc(readFileSync(join(fixturesDir, f), 'utf8')))
	}))
	.filter((x) => x.cfg.choices.backend === 'inside-frontend')

const integratedGuidancePlans = (['skip', 'resend', 'notifuse'] as const).flatMap((email) =>
	[
		{ label: 'local', deploy: 'skip' },
		{ label: 'Docker', deploy: 'docker' },
		{ label: 'Cloudflare', deploy: 'cf-workers' }
	].map(({ label, deploy }) => ({
		label: `${label} with ${email}`,
		deploy,
		entries: runGenerators(
			GvKitConfig.parse({
				configVersion: 2,
				choices: {
					name: `integrated-${deploy}-${email}`,
					frontend: 'sveltekit',
					marketing: 'inside-web',
					backend: 'inside-frontend',
					i18n: 'paraglide',
					monitoring: [],
					db: deploy === 'cf-workers' ? 'sqlite' : 'postgres',
					apiClient: 'skip',
					auth: [],
					email,
					aiTooling: ['claude', 'codex', 'opencode'],
					deploy
				}
			})
		)
	}))
)

const integratedArchitecturePaths = [
	'.ai/rules/',
	'.claude/agents/',
	'.claude/stack.json',
	'apps/web/',
	'packages/backend/',
	'packages/db/',
	'packages/i18n/'
]

function generatedGuidance(entries: ReturnType<typeof runGenerators>): string {
	return entries
		.filter(({ path }) => path.endsWith('.md') || path === '.claude/settings.json')
		.map(({ content }) => content)
		.join('\n')
}

describe('inside-frontend topology', () => {
	for (const { label, deploy, entries } of integratedGuidancePlans) {
		test(`${label} guidance resolves integrated architecture paths without split-backend instructions`, () => {
			const guidance = generatedGuidance(entries)
			const planPaths = entries.map(({ path }) => path)

			expect(guidance).not.toMatch(
				/apps\/api|private[- ]service|service binding|AUTH.{0,30}binding|binding.{0,30}AUTH|gateway|public HTTP/i
			)
			for (const reference of integratedArchitecturePaths) {
				expect(guidance, reference).toContain(`\`${reference}\``)
				expect(
					planPaths.some((path) => path === reference || path.startsWith(reference)),
					reference
				).toBe(true)
			}

			for (const reference of ['apps/web/wrangler.jsonc', 'apps/web/src/app.d.ts']) {
				if (deploy === 'cf-workers') {
					expect(guidance, reference).toContain(`\`${reference}\``)
					expect(planPaths, reference).toContain(reference)
				} else {
					expect(guidance, reference).not.toContain(`\`${reference}\``)
				}
			}
		})
	}
	test('Umami retains the pre-gateway placeholder contract', () => {
		const fixture = insideFixtures.find(({ cfg }) => cfg.choices.monitoring.includes('umami'))
		if (!fixture) throw new Error('inside-frontend Umami fixture is missing')
		const appHtml = runGenerators(fixture.cfg).find(
			(entry) => entry.path === 'apps/web/src/app.html'
		)
		if (!appHtml) throw new Error('generated web app template is missing')

		expect(appHtml.content).toContain('src="https://umami.example.com/script.js"')
		expect(appHtml.content).toContain('data-website-id="__UMAMI_WEBSITE_ID__"')
		expect(appHtml.content).not.toContain('PUBLIC_UMAMI_')
	})

	for (const email of ['resend', 'notifuse'] as const) {
		test(`Astro plus Cloudflare plus ${email} emits topology-correct shared output`, () => {
			const cfg = GvKitConfig.parse({
				configVersion: 2,
				choices: {
					name: 'demo',
					frontend: 'sveltekit',
					marketing: 'astro',
					backend: 'inside-frontend',
					i18n: 'skip',
					monitoring: [],
					db: 'sqlite',
					apiClient: 'skip',
					auth: [],
					email,
					aiTooling: [],
					deploy: 'cf-workers'
				}
			})
			const entries = runGenerators(cfg)
			const marketingPackage = entries.find(
				(entry) => entry.path === 'apps/marketing/package.json'
			)
			const mailerReadme = entries.find(
				(entry) => entry.path === 'packages/mailer/README.md'
			)
			if (!marketingPackage) throw new Error('generated marketing package is missing')
			if (!mailerReadme) throw new Error('generated mailer README is missing')

			const scripts = (JSON.parse(marketingPackage.content) as { scripts: Record<string, string> })
				.scripts
			expect(scripts['deploy:staging']).toBe(
				'test -n "$STAGING_ALIAS" && wrangler deploy --config "${STAGING_WRANGLER_CONFIG:-wrangler.jsonc}" --name demo-marketing-$STAGING_ALIAS'
			)
			expect(mailerReadme.content).not.toContain('apps/api/auth')
			expect(mailerReadme.content).not.toContain('services/auth')
		})
	}

	for (const { file, cfg } of insideFixtures) {
		test(`${file} emits no apps/api/* paths`, () => {
			const entries = runGenerators(cfg)
			const apiPaths = entries.filter((e) => e.path.startsWith('apps/api/'))
			expect(apiPaths).toEqual([])
		})

		const expectsWebWrangler = cfg.choices.deploy === 'cf-workers'
		test(
			`${file} ${
				expectsWebWrangler ? 'emits' : 'does NOT emit'
			} apps/web/wrangler.jsonc`,
			() => {
				const entries = runGenerators(cfg)
				const webWrangler = entries.find((e) => e.path === 'apps/web/wrangler.jsonc')

				if (expectsWebWrangler) {
					expect(webWrangler).toBeDefined()
					if (cfg.choices.auth.length > 0) {
						expect(webWrangler!.content).toContain('BETTER_AUTH_SECRET')
					}
				} else {
					expect(webWrangler).toBeUndefined()
				}
			}
		)
	}
})
