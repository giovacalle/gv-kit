import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { generateIntegratedDeploy } from '../../src/generators/integrated-deploy.js'
import type { Choices, GvKitConfig } from '../../src/schema/config.js'

const baseChoices: Choices = {
	name: 'demo',
	frontend: 'sveltekit',
	marketing: 'inside-web',
	backend: 'inside-frontend',
	i18n: 'skip',
	monitoring: [],
	db: 'postgres',
	apiClient: 'skip',
	auth: ['emailOTP'],
	email: 'resend',
	aiTooling: [],
	deploy: 'docker'
}

function makeCfg(overrides: Partial<Choices>): GvKitConfig {
	return {
		configVersion: 2,
		choices: { ...baseChoices, ...overrides }
	}
}

function compose(cfg: GvKitConfig): string {
	return generateIntegratedDeploy(cfg).find((entry) => entry.path === 'docker-compose.yml')!
		.content
}

describe('generateIntegratedDeploy — email provider choice', () => {
	test('resend emits only Resend credentials', () => {
		const output = compose(makeCfg({ email: 'resend' }))

		expect(output).toContain('RESEND_API_KEY')
		expect(output).not.toContain('NOTIFUSE_API_KEY')
	})

	test('notifuse emits only Notifuse credentials', () => {
		const output = compose(makeCfg({ email: 'notifuse' }))

		expect(output).toContain('NOTIFUSE_API_KEY')
		expect(output).toContain('NOTIFUSE_WORKSPACE_ID')
		expect(output).toContain('NOTIFUSE_BASE_URL')
		expect(output).not.toContain('RESEND_API_KEY')
	})

	test('skip emits no email provider credentials', () => {
		const output = compose(makeCfg({ auth: [], email: 'skip' }))

		expect(output).not.toContain('RESEND_API_KEY')
		expect(output).not.toContain('NOTIFUSE_API_KEY')
		expect(output).not.toContain('NOTIFUSE_WORKSPACE_ID')
		expect(output).not.toContain('NOTIFUSE_BASE_URL')
	})

	test('derives provider coverage from the schema with an exhaustive drift check', () => {
		const source = readFileSync(
			join(import.meta.dir, '..', '..', 'src', 'generators', 'integrated-deploy.ts'),
			'utf8'
		)

		expect(source).toContain("GvKitConfig['choices']['email']")
		expect(source).not.toMatch(/emailProvider:\s*'resend'\s*\|\s*'notifuse'/)
		expect(source).toMatch(/const _exhaustive: never = email/)
	})
})
