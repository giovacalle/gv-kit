import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { generateBackend } from '../../src/generators/backend.js'
import { generateUsersService } from '../../src/generators/services/users.js'
import { parseJsonc } from '../../src/lib/jsonc.js'
import { GvKitConfig } from '../../src/schema/config.js'

const fixture = GvKitConfig.parse(
	parseJsonc(
		readFileSync(
			join(import.meta.dir, '..', '..', 'fixtures', 'hono-effect-cf-workers-sqlite.jsonc'),
			'utf8'
		)
	)
)

const entries = [...generateBackend(fixture), ...generateUsersService(fixture)]

function content(path: string): string {
	const entry = entries.find((candidate) => candidate.path === path)
	if (!entry) throw new Error(`missing generated file: ${path}`)
	return entry.content
}

describe('Effect HTTP failure boundary generation', () => {
	test('emits a generic runner and no central error union or status switch', () => {
		const runner = content('packages/backend/src/effect/hono.ts')
		const errors = content('packages/backend/src/effect/errors.ts')

		expect(runner).toContain('EffectHttpOptions<A, E, SuccessBody, FailureBody>')
		expect(runner).toContain('onSuccess: (value: A)')
		expect(runner).toContain('onFailure: (error: E)')
		expect(runner).toContain('Cause.isDie(exit.cause)')
		expect(runner).toContain('Cause.isInterrupted(exit.cause)')
		expect(runner).toContain("console.error('[effect-http] unexpected cause'")
		expect(errors).not.toContain('type AppError')
		expect(errors).not.toContain('statusForAppError')
	})

	test('emits typed validation mapping and black-box contract tests', () => {
		const runner = content('packages/backend/src/effect/hono.ts')
		const runtimeTests = content('packages/backend/src/effect/hono.test.ts')

		expect(runner).toContain('effectValidationHook')
		expect(runner).toContain("tag: 'ValidationError'")
		expect(runtimeTests).toContain("{ target: 'path', path: '/validate/nope?mode=full'")
		expect(runtimeTests).toContain("{ target: 'query', path: '/validate/valid?mode=compact'")
		expect(runtimeTests).toContain("{ target: 'json', path: '/validate/valid?mode=full'")
		expect(runtimeTests).toContain('expectDeclaredResponse')
		expect(runtimeTests).toContain('Cause.pretty(logs[0]!.cause)')
		expect(runtimeTests).toContain("expect(result.response.status).toBe(202)")
	})

	test('maps get-me failures at the route boundary', () => {
		const handler = content('apps/api/users/src/features/me/handler.ts')

		expect(handler).toContain('function mapMeError(error: GetMeFailure)')
		expect(handler).toContain("case 'Unauthorized':")
		expect(handler).toContain("case 'Forbidden':")
		expect(handler).toContain("case 'UserNotFound':")
		expect(handler).toContain("case 'DatabaseFailure':")
		expect(handler).toContain("case 'AuthInvalidPayload':")
		expect(handler).toContain('onFailure: mapMeError')
		expect(handler).toContain('onSuccess: (value) => ({ status: 200, body: value })')
	})
})
