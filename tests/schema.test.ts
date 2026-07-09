import { describe, expect, test } from 'bun:test'
import { z } from 'zod'

import { Choices, GvKitConfig } from '../src/schema/config.js'

const baseValid = {
	configVersion: 1 as const,
	choices: {
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
}

describe('GvKitConfig schema', () => {
	test('accepts a fully valid config', () => {
		const result = GvKitConfig.safeParse(baseValid)
		expect(result.success).toBe(true)
	})

	test('defaults missing backendRuntime to promise for existing configs', () => {
		const result = GvKitConfig.parse(baseValid)
		expect(result.choices.backendRuntime).toBe('promise')
	})

	test('accepts a minimal config with empty arrays', () => {
		const minimal = {
			...baseValid,
			choices: {
				...baseValid.choices,
				monitoring: [],
				auth: [],
				aiTooling: []
			}
		}
		const result = GvKitConfig.safeParse(minimal)
		expect(result.success).toBe(true)
	})

	test('accepts apiClient="skip" when backend is "inside-frontend"', () => {
		const cfg = {
			...baseValid,
			choices: {
				...baseValid.choices,
				backend: 'inside-frontend' as const,
				apiClient: 'skip' as const
			}
		}
		const result = GvKitConfig.safeParse(cfg)
		expect(result.success).toBe(true)
	})

	test('rejects apiClient="hey-api" when backend is "inside-frontend"', () => {
		const cfg = {
			...baseValid,
			choices: {
				...baseValid.choices,
				backend: 'inside-frontend' as const,
				apiClient: 'hey-api' as const
			}
		}
		const result = GvKitConfig.safeParse(cfg)
		expect(result.success).toBe(false)
		if (!result.success) {
			const flat = JSON.stringify(result.error.issues)
			expect(flat).toContain('apiClient')
		}
	})

	test('rejects backendRuntime="effect" when backend is "inside-frontend"', () => {
		const cfg = {
			...baseValid,
			choices: {
				...baseValid.choices,
				backend: 'inside-frontend' as const,
				backendRuntime: 'effect' as const,
				apiClient: 'skip' as const
			}
		}
		const result = GvKitConfig.safeParse(cfg)
		expect(result.success).toBe(false)
		if (!result.success) expect(JSON.stringify(result.error.issues)).toContain('backendRuntime')
	})

	test('accepts emailOTP with email="resend"', () => {
		const cfg = {
			...baseValid,
			choices: {
				...baseValid.choices,
				auth: ['emailOTP' as const],
				email: 'resend' as const
			}
		}
		expect(GvKitConfig.safeParse(cfg).success).toBe(true)
	})

	test('rejects emailOTP with email="skip"', () => {
		const cfg = {
			...baseValid,
			choices: {
				...baseValid.choices,
				auth: ['emailOTP' as const],
				email: 'skip' as const
			}
		}
		const result = GvKitConfig.safeParse(cfg)
		expect(result.success).toBe(false)
		if (!result.success) {
			const flat = JSON.stringify(result.error.issues)
			expect(flat).toContain('email')
			expect(flat).toContain('emailOTP requires an email provider')
		}
	})

	test('rejects uppercase name', () => {
		const cfg = {
			...baseValid,
			choices: { ...baseValid.choices, name: 'UPPERCASE' }
		}
		expect(GvKitConfig.safeParse(cfg).success).toBe(false)
	})

	test('rejects name starting with a digit', () => {
		const cfg = {
			...baseValid,
			choices: { ...baseValid.choices, name: '1leading-digit' }
		}
		expect(GvKitConfig.safeParse(cfg).success).toBe(false)
	})

	test('rejects name with whitespace', () => {
		const cfg = {
			...baseValid,
			choices: { ...baseValid.choices, name: 'with space' }
		}
		expect(GvKitConfig.safeParse(cfg).success).toBe(false)
	})

	test('rejects missing required field', () => {
		const { configVersion: _omit, ...incomplete } = baseValid
		void _omit
		const result = GvKitConfig.safeParse(incomplete)
		expect(result.success).toBe(false)
	})

	test('rejects unknown enum values', () => {
		const cfg = {
			...baseValid,
			choices: { ...baseValid.choices, db: 'mysql' }
		}
		expect(GvKitConfig.safeParse(cfg).success).toBe(false)
	})

	test('Choices alone parses independently', () => {
		const result = Choices.safeParse(baseValid.choices)
		expect(result.success).toBe(true)
	})

	test('zod v4 is in use (sanity check)', () => {
		// z.literal exists across v3/v4; ensure z.treeifyError exists in v4
		expect(typeof (z as unknown as { treeifyError?: unknown }).treeifyError).toBe('function')
	})
})
