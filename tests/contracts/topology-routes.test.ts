import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { runGenerators } from '../../src/generators/index.js'
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
type Wrangler = { routes?: Route[] }

function patterns(content: string): string[] {
	const parsed = parseJsonc<Wrangler>(content)
	return (parsed.routes ?? []).map((r) => r.pattern)
}

describe('topology routes (hono + cf-workers)', () => {
	for (const { file, cfg } of honoCfFixtures) {
		test(`${file} auth route is on auth.api.<domain>`, () => {
			const entries = runGenerators(cfg)
			const auth = entries.find((e) => e.path === 'apps/api/auth/wrangler.jsonc')
			expect(auth).toBeDefined()
			const ps = patterns(auth!.content)
			expect(ps.length).toBeGreaterThan(0)
			expect(ps.every((p) => p.includes('auth.api.'))).toBe(true)
		})

		test(`${file} users route is on api.<domain> (not auth.api.)`, () => {
			const entries = runGenerators(cfg)
			const users = entries.find((e) => e.path === 'apps/api/users/wrangler.jsonc')
			expect(users).toBeDefined()
			const ps = patterns(users!.content)
			expect(ps.length).toBeGreaterThan(0)
			for (const p of ps) {
				expect(p).toContain('api.')
				expect(p).not.toContain('auth.api.')
			}
		})

		test(`${file} web route is the apex (does not include api.)`, () => {
			const entries = runGenerators(cfg)
			const web = entries.find((e) => e.path === 'apps/web/wrangler.jsonc')
			expect(web).toBeDefined()
			const ps = patterns(web!.content)
			expect(ps.length).toBeGreaterThan(0)
			for (const p of ps) {
				expect(p).not.toContain('api.')
			}
		})
	}
})
