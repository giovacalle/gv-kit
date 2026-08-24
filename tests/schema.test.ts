import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { Choices, GvKitConfig } from '../src/schema/config.js'

const baseChoicesV1 = {
	name: 'my-app',
	frontend: 'sveltekit' as const,
	backend: 'hono' as const,
	i18n: 'paraglide' as const,
	monitoring: ['umami' as const, 'posthog' as const],
	db: 'postgres' as const,
	apiClient: 'hey-api' as const,
	auth: ['emailOTP' as const, 'google' as const],
	email: 'resend' as const,
	aiTooling: ['claude' as const, 'codex' as const, 'opencode' as const],
	deploy: 'cf-workers' as const
}

const baseV1 = {
	configVersion: 1 as const,
	choices: baseChoicesV1
}

const baseV2 = {
	configVersion: 2 as const,
	choices: {
		...baseChoicesV1,
		marketing: 'astro' as const
	}
}

describe('GvKitConfig schema', () => {
	test('accepts strict v2 and preserves the explicit project shape', () => {
		const result = GvKitConfig.parse(baseV2)
		expect(result.configVersion).toBe(2)
		expect(result.choices.marketing).toBe('astro')
	})

	test('migrates strict v1 to v2 inside-web', () => {
		const result = GvKitConfig.parse(baseV1)
		expect(result).toEqual({
			configVersion: 2,
			choices: {
				...baseChoicesV1,
				marketing: 'inside-web'
			}
		})
	})

	test('rejects marketing on v1 instead of silently stripping it', () => {
		const result = GvKitConfig.safeParse({
			...baseV1,
			choices: { ...baseV1.choices, marketing: 'astro' }
		})
		expect(result.success).toBe(false)
	})

	test('requires marketing on v2', () => {
		const { marketing: _marketing, ...choices } = baseV2.choices
		void _marketing
		expect(GvKitConfig.safeParse({ configVersion: 2, choices }).success).toBe(false)
	})

	test('rejects unknown top-level and choice keys in both versions', () => {
		expect(GvKitConfig.safeParse({ ...baseV1, surprise: true }).success).toBe(false)
		expect(
			GvKitConfig.safeParse({
				...baseV2,
				choices: { ...baseV2.choices, surprise: true }
			}).success
		).toBe(false)
	})

	test('rejects unknown config versions', () => {
		expect(GvKitConfig.safeParse({ ...baseV2, configVersion: 3 }).success).toBe(false)
	})

	test('accepts a minimal v2 config with empty arrays', () => {
		const result = GvKitConfig.safeParse({
			...baseV2,
			choices: { ...baseV2.choices, monitoring: [], auth: [], aiTooling: [] }
		})
		expect(result.success).toBe(true)
	})

	test('accepts apiClient="skip" without auth when backend is "inside-frontend"', () => {
		const result = GvKitConfig.safeParse({
			...baseV2,
			choices: {
				...baseV2.choices,
				backend: 'inside-frontend',
				apiClient: 'skip',
				auth: [],
				email: 'skip'
			}
		})
		expect(result.success).toBe(true)
	})

	test('rejects auth when backend is "inside-frontend"', () => {
		const result = GvKitConfig.safeParse({
			...baseV2,
			choices: { ...baseV2.choices, backend: 'inside-frontend', apiClient: 'skip' }
		})
		expect(result.success).toBe(false)
		if (!result.success) {
			const flat = JSON.stringify(result.error.issues)
			expect(flat).toContain('auth')
			expect(flat).toContain('auth requires backend')
		}
	})

	test('rejects apiClient="hey-api" when backend is "inside-frontend"', () => {
		const result = GvKitConfig.safeParse({
			...baseV2,
			choices: { ...baseV2.choices, backend: 'inside-frontend', apiClient: 'hey-api' }
		})
		expect(result.success).toBe(false)
		if (!result.success) expect(JSON.stringify(result.error.issues)).toContain('apiClient')
	})

	test('accepts emailOTP with email="resend"', () => {
		expect(
			GvKitConfig.safeParse({
				...baseV2,
				choices: { ...baseV2.choices, auth: ['emailOTP'], email: 'resend' }
			}).success
		).toBe(true)
	})

	test('rejects emailOTP with email="skip"', () => {
		const result = GvKitConfig.safeParse({
			...baseV2,
			choices: { ...baseV2.choices, auth: ['emailOTP'], email: 'skip' }
		})
		expect(result.success).toBe(false)
		if (!result.success) {
			const flat = JSON.stringify(result.error.issues)
			expect(flat).toContain('email')
			expect(flat).toContain('emailOTP requires an email provider')
		}
	})

	test.each(['UPPERCASE', '1leading-digit', 'with space'])(
		'rejects invalid project name %s',
		(name) => {
			expect(
				GvKitConfig.safeParse({
					...baseV2,
					choices: { ...baseV2.choices, name }
				}).success
			).toBe(false)
		}
	)

	test('rejects missing required top-level fields and unknown enum values', () => {
		const { configVersion: _omit, ...incomplete } = baseV2
		void _omit
		expect(GvKitConfig.safeParse(incomplete).success).toBe(false)
		expect(
			GvKitConfig.safeParse({
				...baseV2,
				choices: { ...baseV2.choices, db: 'mysql' }
			}).success
		).toBe(false)
	})

	test('Choices parses the normalized v2 choice contract independently', () => {
		expect(Choices.safeParse(baseV2.choices).success).toBe(true)
		expect(Choices.safeParse(baseChoicesV1).success).toBe(false)
	})

	test('zod v4 is in use (sanity check)', () => {
		expect(typeof (z as unknown as { treeifyError?: unknown }).treeifyError).toBe('function')
	})
})
