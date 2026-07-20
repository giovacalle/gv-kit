import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'

import { runGenerators } from '../../src/generators/index.js'
import { parseJsonc } from '../../src/lib/jsonc.js'
import type { FileEntry } from '../../src/lib/files.js'
import { GvKitConfig } from '../../src/schema/config.js'

function fixture(name: string) {
	return GvKitConfig.parse(
		parseJsonc(
			readFileSync(join(import.meta.dir, '..', '..', 'fixtures', `${name}.jsonc`), 'utf8')
		)
	)
}

const effectConfig = fixture('hono-effect-cf-workers-sqlite')
const effectEntries = runGenerators({
	...effectConfig,
	choices: {
		...effectConfig.choices,
		aiTooling: ['claude', 'codex', 'opencode']
	}
})

function requireContent(entries: FileEntry[], path: string): string {
	const entry = entries.find((candidate) => candidate.path === path)
	if (!entry) throw new Error(`missing generated file: ${path}`)
	return entry.content
}

function generatedMarkdown(entries: FileEntry[]): string {
	return entries
		.filter((entry) => entry.path.endsWith('.md'))
		.map((entry) => `${entry.path}\n${entry.content}`)
		.join('\n')
}

function compact(content: string): string {
	return content.replace(/\s+/g, ' ')
}

describe('Effect architecture documentation', () => {
	test('documents the hybrid scope, HTTP adapter, and validated contract path', () => {
		const root = compact(requireContent(effectEntries, 'README.md'))

		for (const marker of [
			'Effect mode is scoped to `backend=hono`',
			'`backend=inside-frontend`',
			'Svelte UI remains outside the Effect backend architecture',
			'Hono remains the HTTP adapter and router',
			'Effect Schema',
			'Standard Schema',
			'`hono-openapi`',
			'Every response schema is explicit',
			'Hey API generation and generated-client consumer typecheck',
			'`pnpm client:generate` against a reachable users API',
			'OpenAPI `$ref` or',
			'`components`',
			'extend the contract validation tests',
			'Build only the service layers a workflow consumes',
			'raw `Request` and execution context remain ordinary adapter values',
			'cancellation or background-work semantics justify',
			'real facsimile',
			'strict Wrangler dry-runs',
			'explicit resource teardown'
		]) expect(root).toContain(marker)
		expect(root).not.toContain(
			'builds layers from the Cloudflare `env`, service bindings, D1, the incoming request, and execution context'
		)
	})

	test('documents request-scoped service layers and the canonical runtime contract', () => {
		const users = compact(requireContent(effectEntries, 'apps/api/users/README.md'))

		for (const marker of [
			'Hono owns routing, validation, request-scoped layer construction',
			'users-local `AuthClient` and `Database`.',
			'Worker `env`',
			'`AUTH` service binding',
			'D1',
			'headers from the incoming `Request`',
			'raw request remains an adapter value',
			'`IncomingRequest` tag',
			'keep an execution context at the Hono boundary',
			'Effect `Config`',
			'Each inter-service client stays beside its consumer',
			'decodes a successful upstream payload with Effect Schema',
			'`Schema.standardSchemaV1`',
			'`hono-openapi`',
			'Routes declare response schemas explicitly',
			'runtime `/openapi.json` is the only Hey API input',
			'no OpenAPI file is materialized',
			'`OPENAPI_URL`',
			'`http://localhost:8788/openapi.json`',
			'OpenAPI `$ref` or `components` output'
		]) expect(users).toContain(marker)
		expect(users).not.toContain(
			'`AUTH` service binding, D1, the incoming `Request`, and execution context'
		)
	})

	test('keeps database primitives thin and documents both mailer APIs', () => {
		const db = compact(requireContent(effectEntries, 'packages/db/README.md'))
		const mailer = compact(requireContent(effectEntries, 'packages/mailer/README.md'))

		for (const marker of [
			'intentionally stays thin',
			'schema, migrations, and `createDb`',
			'do not depend on Effect',
			'request-specific D1 or database client',
			'local Effect',
			'`Database` layer'
		]) expect(db).toContain(marker)

		for (const marker of [
			'root `@repo/mailer` export remains the plain Promise API',
			'`createMailer(...)`',
			'`MailerService`',
			'`MailerLive`',
			'`@repo/mailer/effect`',
			'typed',
			'`MailerError` failures',
			'owning Hono service builds and provides the request-scoped layer'
		]) expect(mailer).toContain(marker)
	})

	test('records every Effect-only AFK anti-pattern in the shared agent rule', () => {
		const rule = compact(requireContent(effectEntries, '.ai/rules/api-backend.md'))

		for (const marker of [
			'No HTTP-shaped error objects or status codes inside domain use-cases',
			'Effect `HttpApi`',
			'`@hono/effect-validator`',
			'Effect Schema Standard Schema bridge and `hono-openapi`',
			'default Promise/Zod generated output',
			'`step.do`',
			'`step.sleep`',
			'`step.waitForEvent`',
			'opaque wrappers',
			'Effect `Config`',
			'request-boundary inputs with request-scoped lifetime',
			'Build only service layers the workflow consumes',
			'do not invent `IncomingRequest` or `WorkerContext` tags',
			'generated `$ref` or `components`',
			'extend the OpenAPI validation and',
			'generated-client consumer tests'
		]) expect(rule).toContain(marker)

		expect(rule).not.toContain(
			'Build request-scoped layers from the Hono context: Worker `env`, the incoming `Request`, service bindings, D1, and the execution context'
		)
	})

	test('emits no Effect architecture documentation for Promise or inside-frontend projects', () => {
		const promiseConfig = GvKitConfig.parse({
			...effectConfig,
			choices: { ...effectConfig.choices, backendRuntime: 'promise' }
		})
		const insideFrontend = fixture('inside-frontend-typical')
		const nonEffectMarkdown = [
			generatedMarkdown(runGenerators(promiseConfig)),
			generatedMarkdown(runGenerators(insideFrontend))
		].join('\n')

		for (const forbidden of [
			'Hybrid Hono + Effect architecture',
			'Hono + Effect request boundary',
			'## Effect boundary',
			'## Effect API',
			'Effect `HttpApi`',
			'`@hono/effect-validator`',
			'`@repo/mailer/effect`',
			'default Promise/Zod generated output',
			'Effect Schema Standard Schema bridge'
		]) expect(nonEffectMarkdown).not.toContain(forbidden)
	})
})
