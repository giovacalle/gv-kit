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
