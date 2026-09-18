import { describe, expect, test } from 'bun:test'
import { generateFrontendSveltekit } from '../../src/generators/frontend-sveltekit.js'
import { generateI18n } from '../../src/generators/i18n.js'
import type { FileEntry } from '../../src/lib/files.js'
import { GvKitConfig, type Choices } from '../../src/schema/config.js'

function makeCfg(overrides: Partial<Choices> = {}): GvKitConfig {
	return GvKitConfig.parse({
		configVersion: 2,
		choices: {
			name: 'localized-client',
			frontend: 'sveltekit',
			marketing: 'inside-web',
			backend: 'hono',
			i18n: 'paraglide',
			monitoring: [],
			db: 'sqlite',
			apiClient: 'hey-api',
			auth: [],
			email: 'skip',
			aiTooling: [],
			deploy: 'skip',
			...overrides
		}
	})
}

function content(entries: FileEntry[], path: string): string {
	const entry = entries.find((candidate) => candidate.path === path)
	if (!entry) throw new Error(`Missing generated file: ${path}`)
	return entry.content
}

describe('generated current-user label localization', () => {
	test('the nonlocalized client keeps the English ID fallback without message dependencies', () => {
		const cfg = makeCfg({ i18n: 'skip' })
		const page = content(generateFrontendSveltekit(cfg), 'apps/web/src/routes/users/+page.svelte')

		expect(generateI18n(cfg)).toEqual([])
		expect(page).toContain('<dt class="text-muted-foreground">ID</dt>')
		expect(page).not.toContain('@repo/i18n/messages')
		expect(page).not.toMatch(/\bm\.\w+\(/)
		expect(page).not.toContain('@gvkit:')
	})

	test.each<Choices['backend']>(['hono', 'inside-frontend'])(
		'%s without the generated client omits the page and the ID key in both catalogs',
		(backend) => {
			const cfg = makeCfg({ backend, apiClient: 'skip' })
			const catalogs = generateI18n(cfg)

			expect(generateFrontendSveltekit(cfg).some(({ path }) => path === 'apps/web/src/routes/users/+page.svelte')).toBe(false)
			for (const locale of ['en', 'it']) {
				const messages = JSON.parse(content(catalogs, `packages/i18n/messages/${locale}.json`))
				expect(messages).not.toHaveProperty('users_id_label')
			}
		}
	)

	test('the localized ID message reference resolves in both client-gated catalogs', () => {
		const cfg = makeCfg()
		const catalogs = generateI18n(cfg)
		const page = content(generateFrontendSveltekit(cfg), 'apps/web/src/routes/users/+page.svelte')
		const reference = page.match(/<dt[^>]*>\{m\.(\w+)\(\)\}<\/dt>/)?.[1]

		expect(reference).toBe('users_id_label')
		expect(page).toContain("import * as m from '@repo/i18n/messages'")
		expect(page).not.toContain('>ID</dt>')
		for (const locale of ['en', 'it']) {
			const messages: Record<string, string> = JSON.parse(content(catalogs, `packages/i18n/messages/${locale}.json`))
			expect(messages[reference!]).toBe('ID')
		}
	})
})
