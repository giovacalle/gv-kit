import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { generateGateway } from '../../src/generators/gateway.js'
import { parseJsonc } from '../../src/lib/jsonc.js'
import { GvKitConfig } from '../../src/schema/config.js'

const fixturesDir = join(import.meta.dir, '..', '..', 'fixtures')

function generateFixture(name: string) {
	const raw = parseJsonc(readFileSync(join(fixturesDir, `${name}.jsonc`), 'utf8'))
	return generateGateway(GvKitConfig.parse(raw))
}

function content(entries: ReturnType<typeof generateGateway>, path: string): string {
	const entry = entries.find((candidate) => candidate.path === path)
	if (!entry) throw new Error(`Missing generated file: ${path}`)
	return entry.content
}

describe('generateGateway', () => {
	test('keeps apex-domain setup guidance in the Cloudflare README instead of Wrangler comments', () => {
		const entries = generateFixture('hono-cf-workers-passwordless')
		const wrangler = content(entries, 'apps/api/wrangler.jsonc')
		const readme = content(entries, 'apps/api/README.md')

		expect(wrangler).not.toContain("// Replace <domain> with the project's apex domain.")
		expect(readme).toContain(
			"Before deploying to Cloudflare, replace each `<domain>` placeholder in `wrangler.jsonc` with the project's apex domain."
		)
	})

	test('does not emit Cloudflare domain setup guidance for a Node gateway', () => {
		const entries = generateFixture('hono-skip-deploy')
		const readme = content(entries, 'apps/api/README.md')

		expect(entries.some((entry) => entry.path === 'apps/api/wrangler.jsonc')).toBe(false)
		expect(readme).not.toContain('Before deploying to Cloudflare')
	})
})
