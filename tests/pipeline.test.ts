import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { parseJsonc } from '../src/lib/jsonc.js'
import { buildScaffoldPlan } from '../src/pipeline/plan.js'
import { GvKitConfig } from '../src/schema/config.js'

const fixturesDir = join(import.meta.dir, '..', 'fixtures')
const snapshotsDir = join(fixturesDir, '__snapshots__')

const fixtures = readdirSync(fixturesDir)
	.filter((f) => f.endsWith('.jsonc'))
	.sort()

describe('plan snapshots', () => {
	for (const file of fixtures) {
		test(file, () => {
			const raw = parseJsonc(readFileSync(join(fixturesDir, file), 'utf8'))
			const cfg = GvKitConfig.parse(raw)
			const entries = buildScaffoldPlan(cfg)

			const manifest = entries
				.map((e) => `${e.path}  ${hash(e.content)}`)
				.sort()
				.join('\n')

			const snapshotPath = join(snapshotsDir, file.replace(/\.jsonc$/, '.txt'))
			if (process.env.UPDATE_SNAPSHOTS) {
				mkdirSync(dirname(snapshotPath), { recursive: true })
				writeFileSync(snapshotPath, manifest + '\n')
				return
			}
			if (!existsSync(snapshotPath)) {
				mkdirSync(dirname(snapshotPath), { recursive: true })
				writeFileSync(snapshotPath, manifest + '\n')
				return
			}
			const expected = readFileSync(snapshotPath, 'utf8').trimEnd()
			expect(manifest).toBe(expected)
		})
	}
})

describe('config migration compatibility', () => {
	test('legacy v1 and explicit v2 inside-web produce identical plans', () => {
		const legacy = GvKitConfig.parse(
			parseJsonc(readFileSync(join(fixturesDir, 'minimal.jsonc'), 'utf8'))
		)
		const explicit = GvKitConfig.parse(
			parseJsonc(readFileSync(join(fixturesDir, 'v2-inside-web-minimal.jsonc'), 'utf8'))
		)

		expect(legacy).toEqual(explicit)
		expect(buildScaffoldPlan(legacy)).toEqual(buildScaffoldPlan(explicit))
		expect(
			buildScaffoldPlan(legacy).some((entry) => entry.path.startsWith('apps/marketing/'))
		).toBe(false)
	})
})

function hash(s: string): string {
	return new Bun.CryptoHasher('sha256').update(s).digest('hex').slice(0, 16)
}
