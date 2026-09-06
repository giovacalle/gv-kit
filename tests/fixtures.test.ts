import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { runGenerators } from '../src/generators/index.js'
import { parseJsonc } from '../src/lib/jsonc.js'
import { buildScaffoldPlan } from '../src/pipeline/plan.js'
import { GvKitConfig } from '../src/schema/config.js'

const fixturesDir = join(import.meta.dir, '..', 'fixtures')
const fixtureNames = readdirSync(fixturesDir)
	.filter((name) => name.endsWith('.jsonc'))
	.sort()
const generatedConfigPath = 'project.config.jsonc'
const forbiddenScaffolderTerms = /\bgv-kit\b|\bthe scaffolder\b|\bthe generator\b|\bthis CLI\b/i

function loadFixture(name: string) {
	return GvKitConfig.parse(parseJsonc(readFileSync(join(fixturesDir, name), 'utf8')))
}

describe('generated fixture inventories', () => {
	test('remain downstream-facing and replayable', () => {
		for (const fixtureName of fixtureNames) {
			const originalConfig = loadFixture(fixtureName)
			const entries = buildScaffoldPlan(originalConfig)
			const generatedConfigs = entries.filter(({ path }) => path === generatedConfigPath)

			expect(generatedConfigs, fixtureName).toHaveLength(1)
			for (const entry of entries) {
				expect(`${entry.path}\n${entry.content}`, `${fixtureName}:${entry.path}`).not.toMatch(
					forbiddenScaffolderTerms
				)
			}

			const replayedConfig = GvKitConfig.parse(parseJsonc(generatedConfigs[0]!.content))
			expect(replayedConfig, fixtureName).toEqual(originalConfig)
			expect(runGenerators(replayedConfig), fixtureName).toEqual(runGenerators(originalConfig))
		}
	}, 20_000)

	test('the CLI accepts the canonical generated config without transformation', async () => {
		const sourceConfig = loadFixture('hono-skip-auth-emailotp.jsonc')
		const generatedConfig = buildScaffoldPlan(sourceConfig).find(
			({ path }) => path === generatedConfigPath
		)
		const configFixturePath = join(import.meta.dir, 'fixtures', generatedConfigPath)

		expect(generatedConfig?.content).toBe(readFileSync(configFixturePath, 'utf8'))

		const cli = Bun.spawn(
			[
				process.execPath,
				join(import.meta.dir, '..', 'src', 'cli.ts'),
				'new',
				'replayed-project',
				'--dry-run',
				'--config',
				configFixturePath
			],
			{
				cwd: join(import.meta.dir, '..'),
				stdout: 'pipe',
				stderr: 'pipe'
			}
		)
		const [exitCode, stdout, stderr] = await Promise.all([
			cli.exited,
			new Response(cli.stdout).text(),
			new Response(cli.stderr).text()
		])

		expect(stderr).toBe('')
		expect(exitCode).toBe(0)
		expect(stdout).toContain('project.config.jsonc  (1)')
		expect(stdout).toContain('Dry run — no files written.')
	})
})
