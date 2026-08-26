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

describe('inside-frontend topology', () => {
	for (const email of ['resend', 'notifuse'] as const) {
		test(`Astro plus Cloudflare plus ${email} retains pre-gateway shared output`, () => {
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
			expect(mailerReadme.content).toContain('consumers (e.g. `apps/api/auth`)')
			expect(mailerReadme.content).not.toContain('consumers (e.g. `services/auth`)')
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
