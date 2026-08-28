import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
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
			test(`${file} (cf-workers) declares exact bindings without a package-local environment`, () => {
				const entries = runGenerators(cfg)
				const wrangler = entries.find((e) => e.path === 'services/auth/wrangler.jsonc')
				expect(wrangler).toBeDefined()

				const parsed = parseJsonc<{
					services?: unknown[]
					secrets?: { required?: string[] }
					d1_databases?: unknown[]
					vars?: Record<string, string>
				}>(wrangler!.content)
				expect(parsed.services ?? []).toEqual([])
				const expected = cfg.choices.auth.length > 0 ? ['BETTER_AUTH_SECRET'] : []
				if (cfg.choices.auth.length > 0 && cfg.choices.db === 'postgres') expected.push('DATABASE_URL')
				if (cfg.choices.auth.includes('google')) expected.push('GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET')
				if (cfg.choices.auth.includes('emailOTP')) {
					expected.push('TURNSTILE_SECRET_KEY')
					if (cfg.choices.email === 'resend') expected.push('RESEND_API_KEY', 'FROM_EMAIL')
					if (cfg.choices.email === 'notifuse') expected.push('NOTIFUSE_API_KEY', 'NOTIFUSE_WORKSPACE_ID', 'NOTIFUSE_BASE_URL')
				}
				expect(parsed.secrets?.required ?? []).toEqual(expected)
				const authPackage = JSON.parse(
					entries.find((e) => e.path === 'services/auth/package.json')!.content
				) as { scripts: Record<string, string> }
				if (cfg.choices.auth.length === 0) {
					expect(parsed.d1_databases).toBeUndefined()
					expect(parsed.vars).toBeUndefined()
					expect(authPackage.scripts['deploy:staging']).not.toContain('STAGING_SECRETS_FILE')
					const staging = entries.find(
						(e) => e.path === '.github/workflows/deploy-staging.yml'
					)!.content
					expect(staging).not.toContain('BETTER_AUTH_SECRET')
					expect(staging).not.toContain('preview_secrets.outputs.auth_file')
				} else expect(authPackage.scripts['deploy:staging']).toContain('STAGING_SECRETS_FILE')

				expect(entries.find((e) => e.path === 'services/auth/.dev.vars')).toBeUndefined()
			})
		} else {
			test(`${file} (non-cf) does NOT emit services/auth/wrangler.jsonc`, () => {
				const entries = runGenerators(cfg)
				const wrangler = entries.find((e) => e.path === 'services/auth/wrangler.jsonc')
				expect(wrangler).toBeUndefined()
			})

			test(`${file} (non-cf) auth package uses only selected-provider credentials`, () => {
				const entries = runGenerators(cfg)
				const pkg = entries.find((e) => e.path === 'services/auth/package.json')
				expect(pkg).toBeDefined()
				const parsed = JSON.parse(pkg!.content) as {
					dependencies: Record<string, string>
					devDependencies: Record<string, string>
				}
				expect(parsed.dependencies['@hono/node-server']).toBeDefined()
				expect(parsed.devDependencies.wrangler).toBeUndefined()
				expect(parsed.devDependencies['@types/bun']).toBeUndefined()

				const authTs = entries.find((e) => e.path === 'services/auth/src/auth.ts')
				if (cfg.choices.auth.length > 0) {
					expect(parsed.dependencies['better-auth']).toBeDefined()
					expect(authTs?.content).toContain('process.env.BETTER_AUTH_SECRET')
				} else {
					expect(parsed.dependencies['better-auth']).toBeUndefined()
					expect(parsed.dependencies['@repo/db']).toBeUndefined()
					expect(authTs).toBeUndefined()
				}
			})
		}
	}
})

describe('auth-worker generator (post-rewrite)', () => {
	for (const { file, cfg } of honoFixtures) {
		if (cfg.choices.auth.length === 0) {
			test(`${file} exposes only health and private unauthenticated-session transport`, () => {
				const entries = runGenerators(cfg)
				const app = entries.find((e) => e.path === 'services/auth/src/app.ts')!.content
				expect(app).toContain("app.get('/healthz'")
				expect(app).toContain("return c.json({ error: 'unauthorized' }, 401)")
				expect(app).not.toContain('/api/auth')
				expect(entries.some((e) => e.path === 'services/auth/src/auth.ts')).toBe(false)
			})
			continue
		}

		test(`${file} allows the generated CAPTCHA request header`, () => {
			const entries = runGenerators(cfg)
			const app = entries.find((e) => e.path === 'services/auth/src/app.ts')
			expect(app?.content).toContain("'x-captcha-response'")
		})

		test(`${file} auth.ts uses drizzleAdapter and skips forbidden helpers`, () => {
			const entries = runGenerators(cfg)
			const authTs = entries.find((e) => e.path === 'services/auth/src/auth.ts')
			expect(authTs).toBeDefined()
			expect(authTs!.content).toContain('database: drizzleAdapter(')
			expect(authTs!.content).not.toContain('databaseHooks(')
			expect(authTs!.content).not.toContain('secondaryStorage:')
		})

		test(`${file} auth guidance separates Better Auth ownership from shared user reads`, () => {
			const entries = runGenerators(cfg)
			const readme = entries.find((e) => e.path === 'services/auth/README.md')!.content

			expect(readme).toContain('Better Auth configuration and secrets stay private to this service')
			expect(readme).toContain('`packages/backend/` owns reusable data access and use cases')
			expect(readme).toContain('`authSchema.user`')
			expect(readme).not.toContain('sole owner of authentication state and secrets')
			expect(readme).not.toMatch(/Owns the auth tables|queried only by the auth service/i)
		})

		if (cfg.choices.auth.includes('emailOTP')) {
			test(`${file} (emailOTP) wires emailOTP plugin and @repo/mailer`, () => {
				const entries = runGenerators(cfg)
				const authTs = entries.find((e) => e.path === 'services/auth/src/auth.ts')!
				expect(authTs.content).toContain('emailOTP({')
				expect(authTs.content).toContain('sendVerificationOTP')

				const pkg = entries.find((e) => e.path === 'services/auth/package.json')!
				const parsed = JSON.parse(pkg.content) as { dependencies: Record<string, string> }
				expect(parsed.dependencies['@repo/mailer']).toBeDefined()
			})
		}

		if (cfg.choices.auth.includes('google')) {
			test(`${file} (google) declares env-gated socialProviders`, () => {
				const entries = runGenerators(cfg)
				const authTs = entries.find((e) => e.path === 'services/auth/src/auth.ts')!
				expect(authTs.content).toContain('socialProviders')
				expect(authTs.content).toContain('GOOGLE_CLIENT_ID')
				expect(authTs.content).toContain('GOOGLE_CLIENT_SECRET')
			})
		}
	}
})
