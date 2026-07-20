import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'

import { runGenerators } from '../../src/generators/index.js'
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
const entries = runGenerators(fixture)

function requireContent(path: string): string {
	const entry = entries.find((candidate) => candidate.path === path)
	if (!entry) throw new Error(`missing generated file: ${path}`)
	return entry.content
}

describe('Effect users request layers', () => {
	test('keeps auth and database adapters local to users', () => {
		const authClient = requireContent('apps/api/users/src/infrastructure/auth-client.ts')
		const database = requireContent('apps/api/users/src/infrastructure/database.ts')

		expect(authClient).toContain("Context.Tag('users/AuthClient')")
		expect(authClient).toContain('Schema.decodeUnknown')
		expect(authClient).toContain("'/internal/session'")
		expect(database).toContain("Context.Tag('users/Database')")
		expect(database).toContain('createDb')
		expect(database).toContain('DatabaseFailure')
	})

	test('composes auth, database, and branching in one Effect workflow', () => {
		const workflow = requireContent('apps/api/users/src/features/me/workflow.ts')
		const handler = requireContent('apps/api/users/src/features/me/handler.ts')

		expect(workflow).toContain('yield* AuthClient')
		expect(workflow).toContain('yield* Database')
		expect(workflow).toContain('authClient.resolve')
		expect(workflow).toContain('database.findUserById')
		expect(workflow).toContain('new UserNotFound')
		expect(handler).toContain('getMeWorkflow')
		expect(handler).toContain('makeAuthClientLayer(c.env, c.req.raw)')
		expect(handler).toContain('makeDatabaseLayer(c.env)')
		expect(handler).not.toContain('createDb')
		expect(handler).not.toContain("c.get('user')")
	})

	test('emits fake-layer and black-box failure matrix tests with declared statuses', () => {
		const tests = requireContent('apps/api/users/src/features/me/workflow.test.ts')
		const route = requireContent('apps/api/users/src/features/me/route.ts')

		for (const marker of [
			'valid session',
			'invalid success payload',
			'no session',
			'forbidden',
			'upstream failure',
			'thrown binding fetch',
			'invalid JSON',
			'database failure'
		]) expect(tests).toContain(marker)
		for (const status of [200, 401, 403, 404, 500, 502]) expect(route).toContain(`${status}:`)
	})
})
