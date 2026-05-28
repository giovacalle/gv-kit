import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { runGenerators } from '../../src/generators/index.js'
import { GvKitConfig } from '../../src/schema/config.js'
import { parseJsonc } from '../util/jsonc.js'

const fixturesDir = join(import.meta.dir, '..', '..', 'fixtures')

const honoFixtures = readdirSync(fixturesDir)
	.filter((f) => f.endsWith('.jsonc'))
	.map((f) => ({
		file: f,
		cfg: GvKitConfig.parse(parseJsonc(readFileSync(join(fixturesDir, f), 'utf8')))
	}))
	.filter((x) => x.cfg.choices.backend === 'hono')

describe('auth-worker bindings', () => {
	for (const { file, cfg } of honoFixtures) {
		const isCf = cfg.choices.deploy === 'cf-workers'

		if (isCf) {
			test(`${file} (cf-workers) declares no service bindings and references BETTER_AUTH_SECRET`, () => {
				const entries = runGenerators(cfg)
				const wrangler = entries.find((e) => e.path === 'apps/api/auth/wrangler.jsonc')
				expect(wrangler).toBeDefined()

				const parsed = parseJsonc<{ services?: unknown[] }>(wrangler!.content)
				const services = parsed.services ?? []
				expect(services.length).toBe(0)

				expect(wrangler!.content).toContain('BETTER_AUTH_SECRET')
			})
		} else {
			test(`${file} (non-cf) does NOT emit apps/api/auth/wrangler.jsonc`, () => {
				const entries = runGenerators(cfg)
				const wrangler = entries.find((e) => e.path === 'apps/api/auth/wrangler.jsonc')
				expect(wrangler).toBeUndefined()
			})

			test(`${file} (non-cf) auth package depends on @hono/node-server and reads BETTER_AUTH_SECRET from process.env`, () => {
				const entries = runGenerators(cfg)
				const pkg = entries.find((e) => e.path === 'apps/api/auth/package.json')
				expect(pkg).toBeDefined()
				const parsed = JSON.parse(pkg!.content) as {
					dependencies: Record<string, string>
					devDependencies: Record<string, string>
				}
				expect(parsed.dependencies['@hono/node-server']).toBeDefined()
				expect(parsed.devDependencies.wrangler).toBeUndefined()
				// libsql swap: `@types/bun` is no longer added when usesSqlite.
				expect(parsed.devDependencies['@types/bun']).toBeUndefined()

				const authTs = entries.find((e) => e.path === 'apps/api/auth/src/auth.ts')
				expect(authTs).toBeDefined()
				expect(authTs!.content).toContain('process.env.BETTER_AUTH_SECRET')
			})
		}
	}
})

describe('auth-worker generator (post-rewrite)', () => {
	for (const { file, cfg } of honoFixtures) {
		test(`${file} auth.ts uses drizzleAdapter and skips forbidden helpers`, () => {
			const entries = runGenerators(cfg)
			const authTs = entries.find((e) => e.path === 'apps/api/auth/src/auth.ts')
			expect(authTs).toBeDefined()
			expect(authTs!.content).toContain('database: drizzleAdapter(')
			expect(authTs!.content).not.toContain('databaseHooks(')
			expect(authTs!.content).not.toContain('secondaryStorage:')
		})

		if (cfg.choices.auth.includes('emailOTP')) {
			test(`${file} (emailOTP) wires emailOTP plugin and @repo/mailer`, () => {
				const entries = runGenerators(cfg)
				const authTs = entries.find((e) => e.path === 'apps/api/auth/src/auth.ts')!
				expect(authTs.content).toContain('emailOTP({')
				expect(authTs.content).toContain('sendVerificationOTP')

				const pkg = entries.find((e) => e.path === 'apps/api/auth/package.json')!
				const parsed = JSON.parse(pkg.content) as { dependencies: Record<string, string> }
				expect(parsed.dependencies['@repo/mailer']).toBeDefined()
			})
		}

		if (cfg.choices.auth.includes('google')) {
			test(`${file} (google) declares env-gated socialProviders`, () => {
				const entries = runGenerators(cfg)
				const authTs = entries.find((e) => e.path === 'apps/api/auth/src/auth.ts')!
				expect(authTs.content).toContain('socialProviders')
				expect(authTs.content).toContain('GOOGLE_CLIENT_ID')
				expect(authTs.content).toContain('GOOGLE_CLIENT_SECRET')
			})
		}
	}
})
