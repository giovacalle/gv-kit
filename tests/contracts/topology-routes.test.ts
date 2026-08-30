import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { runGenerators } from '../../src/generators/index.js'
import { cloudflareProductionWorkerName } from '../../src/lib/cloudflare-worker-name.js'
import { GvKitConfig } from '../../src/schema/config.js'
import { parseJsonc } from '../util/jsonc.js'

const fixturesDir = join(import.meta.dir, '..', '..', 'fixtures')

const honoCfFixtures = readdirSync(fixturesDir)
	.filter((f) => f.endsWith('.jsonc'))
	.map((f) => ({
		file: f,
		cfg: GvKitConfig.parse(parseJsonc(readFileSync(join(fixturesDir, f), 'utf8')))
	}))
	.filter((x) => x.cfg.choices.backend === 'hono' && x.cfg.choices.deploy === 'cf-workers')

type Route = { pattern: string; custom_domain?: boolean }
type Wrangler = { routes?: Route[]; services?: { binding: string; service: string }[] }

function patterns(content: string): string[] {
	const parsed = parseJsonc<Wrangler>(content)
	return (parsed.routes ?? []).map((r) => r.pattern)
}

describe('topology routes (hono + cf-workers)', () => {
	for (const { file, cfg } of honoCfFixtures) {
		test(`${file} keeps services private and gives web a gateway binding`, () => {
			const entries = runGenerators(cfg)
			const auth = entries.find((e) => e.path === 'services/auth/wrangler.jsonc')
			const users = entries.find((e) => e.path === 'services/users/wrangler.jsonc')
			const web = entries.find((e) => e.path === 'apps/web/wrangler.jsonc')
			expect(auth).toBeDefined()
			expect(users).toBeDefined()
			expect(web).toBeDefined()
			expect(patterns(auth!.content)).toEqual([])
			expect(patterns(users!.content)).toEqual([])
			const parsedWeb = parseJsonc<Wrangler>(web!.content)
			expect(parsedWeb.services).toContainEqual({
				binding: 'GATEWAY',
				service: cloudflareProductionWorkerName({ project: cfg.choices.name, service: 'api' })
			})
		})

		test(`${file} gateway binds both private services`, () => {
			const entries = runGenerators(cfg)
			const gateway = entries.find((e) => e.path === 'apps/api/wrangler.jsonc')
			expect(gateway).toBeDefined()
			const services = parseJsonc<Wrangler>(gateway!.content).services
			expect(services).toContainEqual({
				binding: 'AUTH',
				service: cloudflareProductionWorkerName({ project: cfg.choices.name, service: 'auth' })
			})
			expect(services).toContainEqual({
				binding: 'USERS',
				service: cloudflareProductionWorkerName({ project: cfg.choices.name, service: 'users' })
			})
		})

		test(`${file} web route matches the selected project shape`, () => {
			const entries = runGenerators(cfg)
			const web = entries.find((e) => e.path === 'apps/web/wrangler.jsonc')
			expect(web).toBeDefined()
			const ps = patterns(web!.content)
			expect(ps.length).toBeGreaterThan(0)
			for (const p of ps) {
				expect(p).not.toContain('api.')
				if (cfg.choices.marketing === 'astro') expect(p).toBe('app.<domain>')
				else expect(p).toBe('<domain>')
			}
		})

		test(`${file} marketing owns the apex only in the Astro shape`, () => {
			const entries = runGenerators(cfg)
			const marketing = entries.find((e) => e.path === 'apps/marketing/wrangler.jsonc')
			if (cfg.choices.marketing === 'inside-web') {
				expect(marketing).toBeUndefined()
				return
			}
			expect(marketing).toBeDefined()
			expect(patterns(marketing!.content)).toEqual(['<domain>'])
		})
	}
})
