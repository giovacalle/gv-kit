import { describe, expect, test } from 'bun:test'

import { generateUi } from '../../src/generators/ui.js'
import type { FileEntry } from '../../src/lib/files.js'
import type { Choices, GvKitConfig } from '../../src/schema/config.js'

type Auth = Choices['auth']

const baseChoices: Choices = {
	name: 'demo',
	frontend: 'sveltekit',
	backend: 'hono',
	i18n: 'skip',
	monitoring: [],
	db: 'sqlite',
	apiClient: 'hey-api',
	auth: [],
	email: 'skip',
	aiTooling: ['claude'],
	deploy: 'cf-workers'
}

function makeCfg(overrides: Partial<Choices>): GvKitConfig {
	return {
		configVersion: 1,
		choices: { ...baseChoices, ...overrides }
	}
}

function findEntry(entries: FileEntry[], path: string): FileEntry | undefined {
	return entries.find((e) => e.path === path)
}

describe('generateUi — base primitives', () => {
	const entries = generateUi(makeCfg({}))

	test.each([
		'button',
		'input',
		'label',
		'card',
		'badge',
		'separator',
		'skeleton',
		'dialog',
		'alert-dialog',
		'sheet',
		'dropdown-menu',
		'popover',
		'tooltip',
		'form',
		'sonner',
		'tabs',
		'avatar'
	])('packages/ui/src/lib/components/primitives/%s/index.ts is present', (name) => {
		const entry = findEntry(entries, `packages/ui/src/lib/components/primitives/${name}/index.ts`)
		expect(entry).toBeDefined()
	})

	test('mode-toggle composite is emitted', () => {
		const indexEntry = findEntry(
			entries,
			'packages/ui/src/lib/components/mode-toggle/index.ts'
		)
		const componentEntry = findEntry(
			entries,
			'packages/ui/src/lib/components/mode-toggle/mode-toggle.svelte'
		)
		expect(indexEntry).toBeDefined()
		expect(componentEntry).toBeDefined()
	})

	test('packages/ui/components.json exists with new-york style', () => {
		const entry = findEntry(entries, 'packages/ui/components.json')
		expect(entry).toBeDefined()
		const parsed = JSON.parse(entry!.content) as { style: string; aliases: { ui: string } }
		expect(parsed.style).toBe('new-york')
		expect(parsed.aliases.ui).toContain('primitives')
	})
})

describe('generateUi — input-otp gating', () => {
	test('input-otp NOT present without emailOTP', () => {
		const entries = generateUi(makeCfg({ auth: [], email: 'skip' }))
		expect(
			findEntry(entries, 'packages/ui/src/lib/components/primitives/input-otp/index.ts')
		).toBeUndefined()
	})

	test('input-otp NOT present with google-only auth', () => {
		const entries = generateUi(makeCfg({ auth: ['google'] }))
		expect(
			findEntry(entries, 'packages/ui/src/lib/components/primitives/input-otp/index.ts')
		).toBeUndefined()
	})

	test('input-otp present with emailOTP', () => {
		const entries = generateUi(makeCfg({ auth: ['emailOTP'], email: 'resend' }))
		expect(
			findEntry(entries, 'packages/ui/src/lib/components/primitives/input-otp/index.ts')
		).toBeDefined()
	})

	test('input-otp present with emailOTP + google', () => {
		const entries = generateUi(
			makeCfg({ auth: ['emailOTP', 'google'], email: 'resend' })
		)
		expect(
			findEntry(entries, 'packages/ui/src/lib/components/primitives/input-otp/index.ts')
		).toBeDefined()
	})
})

describe('generateUi — design tokens', () => {
	const entries = generateUi(makeCfg({}))
	const css = findEntry(entries, 'packages/ui/src/lib/styles/app.css')!

	test('app.css uses OKLCH tokens', () => {
		expect(css.content).toContain('oklch(')
	})

	test('app.css declares the primary violet hue (around 285-290)', () => {
		expect(css.content).toMatch(/--primary:\s*oklch\([^)]*28[59]\)/)
	})

	test('app.css declares --shadow-glow', () => {
		expect(css.content).toContain('--shadow-glow')
	})

	test('app.css has a .dark variant block', () => {
		expect(css.content).toContain('.dark')
	})
})

describe('generateUi — boundary regression', () => {
	const AUTH_VARIANTS: Auth[] = [[], ['emailOTP'], ['google'], ['emailOTP', 'google']]

	test('all UI files live under packages/ui/', () => {
		for (const auth of AUTH_VARIANTS) {
			const email = auth.includes('emailOTP') ? 'resend' : 'skip'
			const entries = generateUi(makeCfg({ auth, email }))
			for (const e of entries) {
				expect(e.path.startsWith('packages/ui/')).toBe(true)
			}
		}
	})

	test('NO entry path is under apps/web/', () => {
		for (const auth of AUTH_VARIANTS) {
			const email = auth.includes('emailOTP') ? 'resend' : 'skip'
			const entries = generateUi(makeCfg({ auth, email }))
			for (const e of entries) {
				expect(e.path.startsWith('apps/web/')).toBe(false)
			}
		}
	})

	test('no fence directives leak into any UI file', () => {
		for (const auth of AUTH_VARIANTS) {
			const email = auth.includes('emailOTP') ? 'resend' : 'skip'
			const entries = generateUi(makeCfg({ auth, email }))
			for (const e of entries) {
				expect(e.content).not.toContain('@gvkit:if')
				expect(e.content).not.toContain('@gvkit:endif')
				expect(e.content).not.toContain('@gvkit:strip-without')
			}
		}
	})
})
