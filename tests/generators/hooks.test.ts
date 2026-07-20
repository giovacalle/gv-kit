import { describe, expect, test } from 'bun:test'

import { generateHooks } from '../../src/generators/hooks.js'
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
	deploy: 'cf-workers'
}

function makeCfg(overrides: Partial<Choices> = {}): GvKitConfig {
	return { configVersion: 2, choices: { ...baseChoices, ...overrides } }
}

describe('generateHooks', () => {
	test('emits .husky/pre-commit, .husky/commit-msg, .commitlintrc.json', () => {
		const entries = generateHooks(makeCfg())
		const paths = entries.map((e) => e.path).sort()
		expect(paths).toEqual(['.commitlintrc.json', '.husky/commit-msg', '.husky/pre-commit'])
	})

	test('hook scripts are emitted with executable mode 0o755', () => {
		const entries = generateHooks(makeCfg())
		const preCommit = entries.find((e) => e.path === '.husky/pre-commit')!
		const commitMsg = entries.find((e) => e.path === '.husky/commit-msg')!
		expect(preCommit.mode).toBe(0o755)
		expect(commitMsg.mode).toBe(0o755)
	})

	test('pre-commit invokes lint-staged', () => {
		const entries = generateHooks(makeCfg())
		const preCommit = entries.find((e) => e.path === '.husky/pre-commit')!
		expect(preCommit.content).toContain('pnpm lint-staged')
	})

	test('commit-msg invokes commitlint', () => {
		const entries = generateHooks(makeCfg())
		const commitMsg = entries.find((e) => e.path === '.husky/commit-msg')!
		expect(commitMsg.content).toContain('commitlint')
		expect(commitMsg.content).toContain('--edit')
	})

	test('commitlintrc extends @commitlint/config-conventional', () => {
		const entries = generateHooks(makeCfg())
		const config = entries.find((e) => e.path === '.commitlintrc.json')!
		const parsed = JSON.parse(config.content) as { extends: string[] }
		expect(parsed.extends).toContain('@commitlint/config-conventional')
	})
})
