import { describe, expect, test } from 'bun:test'

import { generateEmail } from '../../src/generators/email.js'
import { generateAuthService } from '../../src/generators/services/auth.js'
import type { FileEntry } from '../../src/lib/files.js'
import type { Choices, GvKitConfig } from '../../src/schema/config.js'

const baseChoices: Choices = {
	name: 'demo',
	frontend: 'sveltekit',
	backend: 'hono',
	backendRuntime: 'effect',
	i18n: 'skip',
	monitoring: [],
	db: 'sqlite',
	apiClient: 'hey-api',
	auth: ['emailOTP'],
	email: 'resend',
	aiTooling: ['codex'],
	deploy: 'cf-workers'
}

function makeCfg(overrides: Partial<Choices> = {}): GvKitConfig {
	return { configVersion: 1, choices: { ...baseChoices, ...overrides } }
}

function content(entries: FileEntry[], path: string): string | undefined {
	return entries.find((entry) => entry.path === path)?.content
}

function requireContent(entries: FileEntry[], path: string): string {
	const value = content(entries, path)
	if (!value) throw new Error(`missing generated file: ${path}`)
	return value
}

describe('Effect mailer auth workflow generation', () => {
	test('email OTP consumes the Resend MailerService at the auth boundary', () => {
		const authEntries = generateAuthService(makeCfg())
		const mailerEntries = generateEmail(makeCfg())
		const auth = requireContent(authEntries, 'apps/api/auth/src/auth.ts')
		const workflow = requireContent(authEntries, 'apps/api/auth/src/effect/otp-mailer.ts')
		const workflowTest = requireContent(
			authEntries,
			'apps/api/auth/src/effect/otp-mailer.test.ts'
		)
		const authPkg = JSON.parse(requireContent(authEntries, 'apps/api/auth/package.json')) as {
			scripts: Record<string, string>
			devDependencies: Record<string, string>
		}

		expect(auth).toContain("import { MailerLive } from '@repo/mailer/effect'")
		expect(auth).toContain('const mailerLayer = MailerLive(env.RESEND_API_KEY)')
		expect(auth).toContain('await runOtpDelivery(')
		expect(auth).not.toContain('createMailer')
		expect(workflow).toContain('const mailer = yield* MailerService')
		expect(workflow).toContain('yield* mailer.sendTemplate')
		expect(workflow).toContain("throw new Error('OTP delivery failed')")
		expect(workflowTest).toContain('Layer.succeed(MailerService, makeMailerEffect(mailer))')
		expect(workflowTest).toContain('Effect.flip')
		expect(authPkg.scripts.test).toContain('otp-mailer.test.ts')
		expect(authPkg.devDependencies.vitest).toBeDefined()
		expect(content(mailerEntries, 'packages/mailer/src/effect.ts')).toContain('MailerService')
	})

	test('email OTP selects the Notifuse layer and provider input shape', () => {
		const cfg = makeCfg({ email: 'notifuse' })
		const authEntries = generateAuthService(cfg)
		const auth = requireContent(authEntries, 'apps/api/auth/src/auth.ts')
		const workflow = requireContent(authEntries, 'apps/api/auth/src/effect/otp-mailer.ts')

		expect(auth).toContain('apiKey: env.NOTIFUSE_API_KEY')
		expect(auth).toContain('const mailerLayer = MailerLive({')
		expect(workflow).toContain('yield* mailer.send({')
		expect(workflow).toContain("template: 'otp-login'")
	})

	test('Effect projects without email OTP keep only the plain mailer API', () => {
		const cfg = makeCfg({ auth: ['google'], email: 'resend' })
		const authEntries = generateAuthService(cfg)
		const mailerEntries = generateEmail(cfg)
		const mailerPkg = JSON.parse(requireContent(mailerEntries, 'packages/mailer/package.json')) as {
			dependencies: Record<string, string>
			exports: Record<string, unknown>
		}

		expect(content(authEntries, 'apps/api/auth/src/effect/otp-mailer.ts')).toBeUndefined()
		expect(content(authEntries, 'apps/api/auth/src/effect/otp-mailer.test.ts')).toBeUndefined()
		expect(content(mailerEntries, 'packages/mailer/src/effect.ts')).toBeUndefined()
		expect(mailerPkg.dependencies.effect).toBeUndefined()
		expect(mailerPkg.exports['./effect']).toBeUndefined()
	})

	test('Promise email OTP output keeps the plain provider workflow', () => {
		const cfg = makeCfg({ backendRuntime: 'promise' })
		const authEntries = generateAuthService(cfg)
		const mailerEntries = generateEmail(cfg)
		const auth = requireContent(authEntries, 'apps/api/auth/src/auth.ts')

		expect(auth).toContain("import { createMailer, type Locale } from '@repo/mailer'")
		expect(auth).toContain('await mailer.sendTemplate({')
		expect(auth).not.toContain('MailerLive')
		expect(content(authEntries, 'apps/api/auth/src/effect/otp-mailer.ts')).toBeUndefined()
		expect(content(mailerEntries, 'packages/mailer/src/effect.ts')).toBeUndefined()
	})
})
