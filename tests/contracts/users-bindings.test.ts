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

describe('users-worker bindings', () => {
	for (const { file, cfg } of honoFixtures) {
		const isCf = cfg.choices.deploy === 'cf-workers'

		if (isCf) {
			test(`${file} (cf-workers) binds AUTH service and never names BETTER_AUTH_SECRET`, () => {
				const entries = runGenerators(cfg)
				const wrangler = entries.find((e) => e.path === 'apps/api/users/wrangler.jsonc')
				expect(wrangler).toBeDefined()

				const parsed = parseJsonc<{
					services?: Array<{ binding: string; service: string }>
				}>(wrangler!.content)
				const services = parsed.services ?? []
				expect(services.length).toBe(1)
				expect(services[0]!.binding).toBe('AUTH')
				expect(services[0]!.service.endsWith('-auth')).toBe(true)

				expect(wrangler!.content).not.toContain('BETTER_AUTH_SECRET')
			})
		} else {
			test(`${file} (non-cf) does NOT emit apps/api/users/wrangler.jsonc`, () => {
				const entries = runGenerators(cfg)
				const wrangler = entries.find((e) => e.path === 'apps/api/users/wrangler.jsonc')
				expect(wrangler).toBeUndefined()
			})

			test(`${file} (non-cf) users package depends on @hono/node-server and never reads BETTER_AUTH_SECRET`, () => {
				const entries = runGenerators(cfg)
				const pkg = entries.find((e) => e.path === 'apps/api/users/package.json')
				expect(pkg).toBeDefined()
				const parsed = JSON.parse(pkg!.content) as {
					dependencies: Record<string, string>
					devDependencies: Record<string, string>
				}
				expect(parsed.dependencies['@hono/node-server']).toBeDefined()
				expect(parsed.devDependencies.wrangler).toBeUndefined()

				const userSources = entries.filter((e) => e.path.startsWith('apps/api/users/src/'))
				for (const src of userSources) {
					expect(src.content).not.toContain('BETTER_AUTH_SECRET')
					// users-worker must consume the deploy-aware session adapter, never the auth factory.
					expect(src.content).not.toContain(`from '@repo/backend/auth'`)
				}
			})
		}

		test(`${file} users-worker uses the deploy-aware auth adapter on protected routes`, () => {
			const entries = runGenerators(cfg)
			const appTs = entries.find((e) => e.path === 'apps/api/users/src/app.ts')
			expect(appTs).toBeDefined()
			if (cfg.choices.backendRuntime === 'effect') {
				expect(appTs!.content).toContain('createMeRouter')
				expect(appTs!.content).not.toContain('requireAuth')
				expect(
					entries.find(
						(entry) => entry.path === 'apps/api/users/src/infrastructure/auth-client.ts'
					)
				).toBeDefined()
			} else {
				expect(appTs!.content).toContain("from '@repo/backend/middleware/auth'")
				expect(appTs!.content).toContain('requireAuth')
			}
		})

		test(`${file} users-worker does NOT emit removed auth-client / require-auth / env.ts`, () => {
			const entries = runGenerators(cfg)
			const removedPaths = [
				'apps/api/users/src/lib/auth-client.ts',
				'apps/api/users/src/middleware/require-auth.ts',
				'apps/api/users/src/env.ts'
			]
			for (const path of removedPaths) {
				const found = entries.find((e) => e.path === path)
				expect(found).toBeUndefined()
			}
		})
	}
})
