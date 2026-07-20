import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'

import { generateAiTooling } from '../../src/generators/ai-tooling.js'
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

const entries = generateAiTooling({
	...fixture,
	choices: { ...fixture.choices, aiTooling: ['claude', 'codex', 'opencode'] }
})
const projectEntries = runGenerators({
	...fixture,
	choices: { ...fixture.choices, aiTooling: ['claude', 'codex', 'opencode'] }
})

function requireContent(path: string, source = entries): string {
	const entry = source.find((candidate) => candidate.path === path)
	if (!entry) throw new Error(`missing generated file: ${path}`)
	return entry.content
}

describe('Effect generated agent rules', () => {
	test('teach the Hono adapter, workflow, local layer, and mailer boundaries', () => {
		const backend = requireContent('.ai/rules/api-backend.md')
		const normalized = backend.replace(/\s+/g, ' ')

		for (const marker of [
			'Hono owns routing and the HTTP adapter',
			'Effect programs own',
			'application workflows and compose typed service failures',
			'runEffectJson({ c, program, onSuccess, onFailure })',
			'Log the full Effect `Cause`',
			'runtime document is the canonical input for Hey API',
			'`AuthClient` and `Database` are concrete adapters under',
			'auth client calls `/internal/session` and Schema-decodes',
			'Better Auth translation stays inside `apps/api/auth`',
			'OTP workflow consumes',
			'`MailerService` from `@repo/mailer/effect`'
		]) expect(normalized).toContain(marker)
	})

	test('contains no Promise-only backend guidance in any generated agent markdown', () => {
		const guidance = entries
			.filter((entry) => entry.path.endsWith('.md'))
			.map((entry) => `${entry.path}\n${entry.content}`)
			.join('\n')

		for (const forbidden of [
			'HttpError',
			'@repo/backend/helpers',
			'@repo/backend/auth',
			'@repo/backend/middleware',
			'@repo/backend/hono`',
			'packages/backend/src/core',
			'logger, error helpers, middleware',
			'shared backend helpers',
			'error pattern',
			'errors.notFound',
			'apps/api/users/src/lib/auth-client.ts'
		]) expect(guidance).not.toContain(forbidden)
	})

	test('keeps shared, Codex, Claude, and OpenCode ownership guidance coherent', () => {
		const coreStack = requireContent('.ai/rules/core-stack.md')
		const coreTesting = requireContent('.ai/rules/core-testing.md')
		const agents = requireContent('AGENTS.md')
		const claude = requireContent('CLAUDE.md')
		const opencode = JSON.parse(requireContent('opencode.json')) as {
			instructions: string[]
		}
		const stackLines = coreStack.split('\n')
		const dbLine = stackLines.find((line) => line.includes('`packages/db/`'))
		const backendLine = stackLines.find((line) => line.includes('`packages/backend/`'))

		expect(dbLine?.startsWith('- ')).toBe(true)
		expect(backendLine?.startsWith('- ')).toBe(true)
		expect(backendLine).toContain('horizontal Effect/Hono runners and logger')
		expect(coreTesting).toContain('run Effect programs with fake `Layer`s')
		expect(coreTesting).toContain('`apps/api/<service>/src/features/<feature>/`')
		expect(coreTesting).toContain('`pnpm client:generate`')
		expect(requireContent('.ai/rules/core-style.md')).toContain(
			'return yield* Effect.fail(new UserNotFound('
		)
		expect(requireContent('.claude/agents/implement.md')).toContain(
			'return yield* Effect.fail(new UserNotFound('
		)
		expect(coreStack).toContain('`apps/api/users/src/infrastructure/auth-client.ts`')
		expect(agents).toContain('Hono HTTP adapters + Effect application workflows')
		expect(agents).toContain('typed HTTP mapping, runtime OpenAPI contract')
		expect(claude).toContain('Hono HTTP adapters + Effect application workflows')
		expect(claude).toContain('horizontal Effect/Hono runners and logger')
		expect(opencode.instructions).toEqual(['.ai/rules/*.md'])
	})

	test('uses one generated-base plus service-owned Env augmentation model', () => {
		const backend = requireContent('.ai/rules/api-backend.md')
		const deploy = requireContent('.ai/rules/deploy-cf-workers.md')
		const specialist = requireContent('.claude/agents/service-architect.md')
		const usersEnv = requireContent('apps/api/users/env.d.ts', projectEntries)
		const authEnv = requireContent('apps/api/auth/env.d.ts', projectEntries)

		for (const guidance of [backend, deploy, specialist]) {
			expect(guidance).toContain('worker-configuration.d.ts')
			expect(guidance).toContain('env.d.ts')
		}
		expect(backend).toContain('Each service owns a hand-edited `env.d.ts` augmentation')
		expect(deploy).toContain('service-owned augmentation')
		expect(specialist).toContain('hand-edited declaration')
		expect(usersEnv).toContain('Hand-edited Env declaration')
		expect(authEnv).toContain('interface declaration merging')
	})

	test('records the Effect runtime in the Claude stack manifest', () => {
		const manifest = JSON.parse(requireContent('.claude/stack.json')) as {
			backend: string
			backendRuntime?: string
		}

		expect(manifest.backend).toBe('hono')
		expect(manifest.backendRuntime).toBe('effect')
	})
})
