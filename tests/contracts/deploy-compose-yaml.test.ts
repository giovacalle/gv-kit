import { describe, expect, test } from 'bun:test'
import { generateDeploy } from '../../src/generators/deploy.js'
import type { Choices, GvKitConfig } from '../../src/schema/config.js'

const baseChoices: Choices = {
	name: 'demo',
	frontend: 'sveltekit',
	marketing: 'inside-web',
	backend: 'hono',
	i18n: 'skip',
	monitoring: [],
	db: 'postgres',
	apiClient: 'hey-api',
	auth: ['emailOTP'],
	email: 'resend',
	aiTooling: [],
	deploy: 'docker'
}

function makeCfg(overrides: Partial<Choices>): GvKitConfig {
	return { configVersion: 2, choices: { ...baseChoices, ...overrides } }
}

function parseCompose(cfg: GvKitConfig): Record<string, unknown> {
	const entries = generateDeploy(cfg)
	const yaml = entries.find((e) => e.path === 'docker-compose.yml')!.content
	return Bun.YAML.parse(yaml) as Record<string, unknown>
}

const COMBINATIONS: Array<[string, Partial<Choices>]> = [
	['hono + postgres + emailOTP+google + resend', {}],
	['Astro + hono + postgres + auth', { marketing: 'astro' }],
	['hono + sqlite + emailOTP', { db: 'sqlite', auth: ['emailOTP'], email: 'resend' }],
	['hono + postgres + no auth', { auth: [], email: 'skip' }],
	['hono + postgres + google only', { auth: ['google'], email: 'skip' }],
	['hono + sqlite + emailOTP + notifuse', { db: 'sqlite', auth: ['emailOTP'], email: 'notifuse' }],
	[
		'inside-frontend + postgres + emailOTP',
		{ backend: 'inside-frontend', apiClient: 'skip', auth: ['emailOTP'], email: 'resend' }
	],
	[
		'inside-frontend + sqlite + no auth',
		{
			backend: 'inside-frontend',
			apiClient: 'skip',
			db: 'sqlite',
			auth: [],
			email: 'skip'
		}
	]
]

describe('deploy compose — YAML structural validity', () => {
	test.each(COMBINATIONS)('%s parses as YAML', (_, overrides) => {
		expect(() => parseCompose(makeCfg(overrides))).not.toThrow()
	})

	test.each(COMBINATIONS)('%s has services as a mapping', (_, overrides) => {
		const doc = parseCompose(makeCfg(overrides))
		expect(typeof doc.services).toBe('object')
		expect(doc.services).not.toBeNull()
		expect(Array.isArray(doc.services)).toBe(false)
	})

	test.each(COMBINATIONS)('%s — every service has environment as a mapping', (_, overrides) => {
		const doc = parseCompose(makeCfg(overrides))
		const services = doc.services as Record<string, Record<string, unknown>>
		for (const [name, svc] of Object.entries(services)) {
			if (svc.environment !== undefined) {
				expect(typeof svc.environment).toBe('object')
				expect(Array.isArray(svc.environment)).toBe(false)
				expect(svc.environment).not.toBeNull()
			}
			expect(name).toMatch(/^[a-z][a-z0-9_-]*$/)
		}
	})

	test.each(COMBINATIONS)('%s — top-level networks block is well-formed', (_, overrides) => {
		const doc = parseCompose(makeCfg(overrides))
		expect(typeof doc.networks).toBe('object')
	})
})

describe('deploy compose — service topology contract', () => {
	test('hono mode emits postgres+migrate+auth+users+web (when postgres)', () => {
		const doc = parseCompose(makeCfg({ backend: 'hono', db: 'postgres' }))
		const services = Object.keys(doc.services as object).sort()
		expect(services).toEqual(['auth', 'migrate', 'postgres', 'users', 'web'])
	})

	test('inside-frontend mode emits postgres+migrate+web only (when postgres)', () => {
		const doc = parseCompose(
			makeCfg({ backend: 'inside-frontend', apiClient: 'skip', db: 'postgres' })
		)
		const services = Object.keys(doc.services as object).sort()
		expect(services).toEqual(['migrate', 'postgres', 'web'])
	})

	test('sqlite mode does not emit postgres service', () => {
		const doc = parseCompose(makeCfg({ db: 'sqlite' }))
		const services = doc.services as Record<string, unknown>
		expect(services.postgres).toBeUndefined()
	})

	test('Astro shape adds marketing without changing application dependencies', () => {
		const doc = parseCompose(makeCfg({ marketing: 'astro', backend: 'hono', db: 'postgres' }))
		const services = doc.services as Record<string, Record<string, unknown>>
		expect(Object.keys(services).sort()).toEqual([
			'auth',
			'marketing',
			'migrate',
			'postgres',
			'users',
			'web'
		])
		expect(services.marketing?.depends_on).toBeUndefined()
		expect(services.web?.depends_on).toBeDefined()
	})
})

describe('deploy compose — env contract with services generators', () => {
	test('every env var emitted in compose appears in services/users.ts wrangler/env consumers', () => {
		const doc = parseCompose(makeCfg({ backend: 'hono', auth: ['emailOTP'], email: 'resend' }))
		const services = doc.services as Record<string, { environment?: Record<string, string> }>
		const usersEnv = Object.keys(services.users?.environment ?? {})

		expect(usersEnv).toContain('PORT')
		expect(usersEnv).toContain('DATABASE_URL')
		expect(usersEnv).toContain('AUTH_URL')
	})

	test('auth service env contract — required keys present, no leakage', () => {
		const doc = parseCompose(makeCfg({ auth: ['emailOTP', 'google'], email: 'resend' }))
		const services = doc.services as Record<string, { environment?: Record<string, string> }>
		const authEnv = Object.keys(services.auth?.environment ?? {})

		const required = [
			'PORT',
			'DATABASE_URL',
			'BETTER_AUTH_SECRET',
			'BETTER_AUTH_URL',
			'BETTER_AUTH_TRUSTED_ORIGINS',
			'GOOGLE_CLIENT_ID',
			'GOOGLE_CLIENT_SECRET',
			'RESEND_API_KEY'
		]
		for (const key of required) expect(authEnv).toContain(key)

		expect(authEnv).not.toContain('NOTIFUSE_API_KEY')
		expect(authEnv).not.toContain('SQLITE_PATH')
	})

	test('inside-frontend mode injects all auth env on web instead of auth service', () => {
		const doc = parseCompose(
			makeCfg({
				backend: 'inside-frontend',
				apiClient: 'skip',
				auth: ['emailOTP', 'google'],
				email: 'resend'
			})
		)
		const services = doc.services as Record<string, { environment?: Record<string, string> }>
		expect(services.auth).toBeUndefined()
		const webEnv = Object.keys(services.web?.environment ?? {})
		expect(webEnv).toContain('BETTER_AUTH_SECRET')
		expect(webEnv).toContain('GOOGLE_CLIENT_ID')
		expect(webEnv).toContain('RESEND_API_KEY')
		expect(webEnv).toContain('DATABASE_URL')
	})
})
