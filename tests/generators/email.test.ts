import { describe, expect, test } from 'bun:test'
import { generateEmail } from '../../src/generators/email.js'
import type { GvKitConfig } from '../../src/schema/config.js'

const paraglideResendConfig: GvKitConfig = {
	configVersion: 2,
	choices: {
		name: 'demo',
		frontend: 'sveltekit',
		marketing: 'astro',
		backend: 'hono',
		i18n: 'paraglide',
		monitoring: [],
		db: 'sqlite',
		apiClient: 'hey-api',
		auth: ['emailOTP'],
		email: 'resend',
		aiTooling: [],
		deploy: 'cf-workers'
	}
}

describe('generateEmail — shared i18n declarations', () => {
	test('Resend DTS builds can resolve the generated Paraglide JavaScript runtime', () => {
		const tsconfig = generateEmail(paraglideResendConfig).find(
			(entry) => entry.path === 'packages/mailer/tsconfig.json'
		)?.content
		expect(tsconfig).toBeDefined()
		expect(JSON.parse(tsconfig!)?.compilerOptions?.allowJs).toBe(true)
	})
})
