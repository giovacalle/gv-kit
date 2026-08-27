import { describe, expect, test } from 'bun:test'
import { generateAiTooling } from '../../src/generators/ai-tooling.js'
import { runGenerators } from '../../src/generators/index.js'
import type { GvKitConfig } from '../../src/schema/config.js'

function makeCfg(
	aiTooling: ('claude' | 'codex' | 'opencode')[],
	overrides: Partial<GvKitConfig['choices']> = {}
): GvKitConfig {
	return {
		configVersion: 2,
		choices: {
			name: 'demo-app',
			frontend: 'sveltekit',
			marketing: 'inside-web',
			backend: 'hono',
			i18n: 'paraglide',
			monitoring: [],
			db: 'postgres',
			apiClient: 'hey-api',
			auth: ['emailOTP'],
			email: 'resend',
			aiTooling,
			deploy: 'cf-workers',
			...overrides
		}
	}
}

function paths(entries: ReturnType<typeof generateAiTooling>): string[] {
	return entries.map((e) => e.path).sort()
}

function content(entries: ReturnType<typeof generateAiTooling>, path: string): string {
	const hit = entries.find((e) => e.path === path)
	if (!hit) throw new Error(`expected entry at ${path}`)
	return hit.content
}

const AI_TOOLING_SELECTIONS = [
	['claude'],
	['codex'],
	['opencode'],
	['claude', 'codex'],
	['claude', 'opencode'],
	['codex', 'opencode'],
	['claude', 'codex', 'opencode']
] as const

const CLIENT_ONLY_GUIDANCE =
	/packages\/openapi-client|@repo\/openapi-client|usersGetMe(?:Options)?|Hey API|TanStack Query|domain-prefixed operations|flat gateway client|web-query\.md/

function markdownGuidance(entries: ReturnType<typeof runGenerators>): string {
	return entries
		.filter(({ path }) => path.endsWith('.md'))
		.map(({ content }) => content)
		.join('\n')
}

type CapabilityPathReference = {
	reference: string
	resolvedPath: string
}

function capabilityPathInventory(
	entries: ReturnType<typeof runGenerators>
): CapabilityPathReference[] {
	const aliases = new Map([
		['apps/api/openapi.json', 'apps/api/openapi.json'],
		['packages/openapi-client', 'packages/openapi-client'],
		['packages/openapi-client/', 'packages/openapi-client'],
		['.ai/rules/web-api.md', '.ai/rules/web-api.md'],
		['.ai/rules/web-query.md', '.ai/rules/web-query.md'],
		['hooks.server.ts', 'apps/web/src/hooks.server.ts'],
		['$lib/auth/client.ts', 'apps/web/src/lib/auth/client.ts'],
		['$lib/server/load-session.ts', 'apps/web/src/lib/server/load-session.ts']
	])
	const inventory = new Map<string, CapabilityPathReference>()
	for (const entry of entries.filter(({ path }) => path.endsWith('.md'))) {
		for (const match of entry.content.matchAll(/`([^`]+)`/g)) {
			const reference = match[1]!
			const resolvedPath = aliases.get(reference)
			if (resolvedPath) inventory.set(reference, { reference, resolvedPath })
		}
	}
	return [...inventory.values()].sort((a, b) => a.reference.localeCompare(b.reference))
}

function expectCapabilityPathsToResolve(entries: ReturnType<typeof runGenerators>): void {
	const planPaths = entries.map(({ path }) => path)
	for (const { reference, resolvedPath } of capabilityPathInventory(entries)) {
		expect(
			planPaths.some((path) => path === resolvedPath || path.startsWith(`${resolvedPath}/`)),
			reference
		).toBe(true)
	}
}

describe('generateAiTooling — decision matrix', () => {
	test('empty selection emits nothing', () => {
		const entries = generateAiTooling(makeCfg([]))
		expect(entries).toHaveLength(0)
	})

	test('[claude] emits .ai/rules + CLAUDE.md + .claude/* (no AGENTS.md, no opencode.json)', () => {
		const p = paths(generateAiTooling(makeCfg(['claude'])))
		expect(p).toContain('.ai/rules/core-stack.md')
		expect(p).toContain('.ai/rules/api-backend.md')
		expect(p).toContain('CLAUDE.md')
		expect(p).toContain('.claude/settings.json')
		expect(p).toContain('.claude/stack.json')
		expect(p).toContain('.claude/agents/service-architect.md')
		expect(p).not.toContain('AGENTS.md')
		expect(p).not.toContain('opencode.json')
	})

	test('[codex] emits .ai/rules + AGENTS.md (no CLAUDE.md, no opencode.json, no .claude/*)', () => {
		const p = paths(generateAiTooling(makeCfg(['codex'])))
		expect(p).toContain('.ai/rules/core-stack.md')
		expect(p).toContain('AGENTS.md')
		expect(p).not.toContain('CLAUDE.md')
		expect(p).not.toContain('opencode.json')
		expect(p.some((x) => x.startsWith('.claude/'))).toBe(false)
	})

	test('[opencode] emits .ai/rules + opencode.json (NO AGENTS.md, no CLAUDE.md, no .claude/*)', () => {
		const p = paths(generateAiTooling(makeCfg(['opencode'])))
		expect(p).toContain('.ai/rules/core-stack.md')
		expect(p).toContain('opencode.json')
		expect(p).not.toContain('AGENTS.md')
		expect(p).not.toContain('CLAUDE.md')
		expect(p.some((x) => x.startsWith('.claude/'))).toBe(false)
	})

	test('[claude, codex] emits both, .ai/rules only once', () => {
		const entries = generateAiTooling(makeCfg(['claude', 'codex']))
		const p = paths(entries)
		expect(p).toContain('CLAUDE.md')
		expect(p).toContain('AGENTS.md')
		expect(p).not.toContain('opencode.json')
		const rules = p.filter((x) => x === '.ai/rules/core-stack.md')
		expect(rules).toHaveLength(1)
	})

	test('[claude, opencode] emits claude + opencode (no AGENTS.md)', () => {
		const p = paths(generateAiTooling(makeCfg(['claude', 'opencode'])))
		expect(p).toContain('CLAUDE.md')
		expect(p).toContain('opencode.json')
		expect(p).not.toContain('AGENTS.md')
	})

	test('[codex, opencode] emits AGENTS.md + opencode.json (no CLAUDE.md, no .claude/*)', () => {
		const p = paths(generateAiTooling(makeCfg(['codex', 'opencode'])))
		expect(p).toContain('AGENTS.md')
		expect(p).toContain('opencode.json')
		expect(p).not.toContain('CLAUDE.md')
		expect(p.some((x) => x.startsWith('.claude/'))).toBe(false)
	})

	test('[claude, codex, opencode] emits everything, .ai/rules only once', () => {
		const entries = generateAiTooling(makeCfg(['claude', 'codex', 'opencode']))
		const p = paths(entries)
		expect(p).toContain('CLAUDE.md')
		expect(p).toContain('AGENTS.md')
		expect(p).toContain('opencode.json')
		expect(p).toContain('.claude/agents/service-architect.md')
		const rules = p.filter((x) => x === '.ai/rules/core-stack.md')
		expect(rules).toHaveLength(1)
	})
})

describe('generateAiTooling — Astro marketing guidance', () => {
	test('empty AI selection still emits nothing in Astro mode', () => {
		expect(generateAiTooling(makeCfg([], { marketing: 'astro' }))).toEqual([])
	})

	for (const selected of AI_TOOLING_SELECTIONS) {
		test(`Astro + ${selected.join('+')} emits one canonical rule and only native specialists`, () => {
			const entries = generateAiTooling(makeCfg([...selected], { marketing: 'astro' }))
			const p = paths(entries)
			expect(p.filter((path) => path === '.ai/rules/marketing-astro.md')).toHaveLength(1)

			const specialistByTool = {
				claude: '.claude/agents/astro-marketer.md',
				codex: '.codex/agents/astro-marketer.toml',
				opencode: '.opencode/agents/astro-marketer.md'
			} as const
			for (const [tool, specialist] of Object.entries(specialistByTool)) {
				expect(p.includes(specialist)).toBe((selected as readonly string[]).includes(tool))
			}
		})
	}

	test('inside-web emits neither canonical Astro rule nor specialist', () => {
		const p = paths(
			generateAiTooling(makeCfg(['claude', 'codex', 'opencode'], { marketing: 'inside-web' }))
		)
		expect(p).not.toContain('.ai/rules/marketing-astro.md')
		expect(p).not.toContain('.claude/agents/astro-marketer.md')
		expect(p).not.toContain('.codex/agents/astro-marketer.toml')
		expect(p).not.toContain('.opencode/agents/astro-marketer.md')
	})

	test('thin specialists route to the canonical rule without duplicating its body', () => {
		const entries = generateAiTooling(
			makeCfg(['claude', 'codex', 'opencode'], { marketing: 'astro' })
		)
		const rule = content(entries, '.ai/rules/marketing-astro.md')
		for (const specialist of [
			'.claude/agents/astro-marketer.md',
			'.codex/agents/astro-marketer.toml',
			'.opencode/agents/astro-marketer.md'
		]) {
			const descriptor = content(entries, specialist)
			expect(descriptor).toContain('marketing-astro.md')
			expect(descriptor).not.toContain(rule)
		}
	})

	test('Claude stack manifest records the marketing application conditionally', () => {
		const astroEntries = generateAiTooling(makeCfg(['claude'], { marketing: 'astro' }))
		const integratedEntries = generateAiTooling(makeCfg(['claude'], { marketing: 'inside-web' }))
		expect(content(astroEntries, '.claude/stack.json')).toContain('apps/marketing')
		expect(content(integratedEntries, '.claude/stack.json')).not.toContain('apps/marketing')
	})
})

describe('generated Hono gateway guidance', () => {
	for (const selected of ['claude', 'codex', 'opencode'] as const) {
		test(`${selected} guidance and permissions preserve the gateway topology`, () => {
			const entries = runGenerators(makeCfg([selected]))
			const coreRule = content(entries, '.ai/rules/core-stack.md')
			const backendRule = content(entries, '.ai/rules/api-backend.md')
			const webRule = content(entries, '.ai/rules/web-svelte.md')
			const webInstructions = content(entries, 'apps/web/CLAUDE.md')
			const guidance = entries
				.filter(
					(entry) =>
						entry.path.endsWith('.md') &&
						(entry.path === 'AGENTS.md' ||
							entry.path === 'CLAUDE.md' ||
							entry.path === 'apps/web/CLAUDE.md' ||
							entry.path.startsWith('.ai/rules/') ||
							entry.path.startsWith('.claude/agents/') ||
							entry.path.startsWith('.opencode/agents/'))
				)
				.map((entry) => entry.content)
				.join('\n')

			expect(coreRule).toContain('`apps/api/` is the public Hono API gateway')
			expect(coreRule).toContain('`services/<service>/`')
			expect(coreRule).toContain('same-origin `/api/*`')
			expect(coreRule).toContain("web origin's `/api/*` alias")
			expect(coreRule).toContain('canonical API origin')
			expect(coreRule).toContain('`/api/auth/*`')
			expect(coreRule).toContain('`/api/v1/*`')
			expect(coreRule).toContain('`apps/api/openapi.json`')
			expect(coreRule).toContain('`GATEWAY` Service Binding')
			expect(coreRule).toContain('`@repo/backend/middleware/auth` transport')
			expect(coreRule).toContain('`/internal/session`')
			expect(coreRule).toContain('`AUTH` binding')
			expect(coreRule).toContain('must not import or mount a private service application')
			expect(coreRule).toContain('never hairpin through the gateway')
			expect(coreRule).toContain('credentialed wildcard CORS')
			expect(coreRule).toContain('must not gain a public route, workers.dev hostname, or preview URL')
			expect(coreRule).not.toContain('/src/lib/auth-client.ts')
			expect(coreRule).not.toContain('Each consumer keeps a local small transport client')
			expect(backendRule).toContain('public Hono gateway lives at `apps/api/`')
			expect(backendRule).toContain('private workers live under `services/<service>/`')
			expect(backendRule).toContain('flat `@repo/openapi-client` package')
			expect(backendRule).toContain('same-origin `/api/*`')
			expect(backendRule).toContain("web Worker's `GATEWAY` Service Binding")
			expect(backendRule).toContain('Never import a service app into the gateway')
			expect(backendRule).toContain('Never send an internal service call through the gateway')
			expect(backendRule).toContain('Never combine credentials with a wildcard CORS origin')
			expect(webRule).toContain('Flat generated client for the public gateway contract')
			expect(webRule).toContain("web Worker's `GATEWAY` Service Binding")
			expect(webInstructions).toContain('`apps/api/` is the public API gateway')
			expect(webInstructions).toContain('only backend Service Binding is `GATEWAY`')
			expect(guidance).toContain('`@repo/openapi-client`')
			expect(guidance).not.toContain('apps/api/<service>')
			expect(guidance).not.toContain('apps/api/<svc>')
			expect(guidance).not.toContain('SvelteKit calls a service via the appropriate URL/binding')
			expect(guidance).not.toContain('web app talks to them over public HTTP')
			expect(guidance).not.toContain('/src/lib/auth-client.ts')

			if (selected === 'claude') {
				const settings = content(entries, '.claude/settings.json')
				expect(settings).toContain('Read(./services/**/.dev.vars)')
				expect(settings).not.toContain('Read(./apps/api/**/.dev.vars)')
			} else {
				expect(entries.some((entry) => entry.path === '.claude/settings.json')).toBe(false)
			}

			if (selected === 'codex') {
				const agents = content(entries, 'AGENTS.md')
				expect(agents).toContain('public Hono gateway at `apps/api`')
				expect(agents).toContain('`services/<service>/`')
			}
		})
	}

	for (const selected of AI_TOOLING_SELECTIONS) {
		test(`Hono without a generated client gates client guidance for ${selected.join('+')}`, () => {
			const entries = runGenerators(makeCfg([...selected], { apiClient: 'skip' }))
			const guidance = markdownGuidance(entries)

			expect(entries.some(({ path }) => path.startsWith('packages/openapi-client/'))).toBe(false)
			expect(entries.some(({ path }) => path === '.ai/rules/web-query.md')).toBe(false)
			expect(guidance).not.toMatch(CLIENT_ONLY_GUIDANCE)
			expect(guidance).toContain('`apps/api/openapi.json`')
			expect(guidance).toContain('same-origin `/api/*`')
			expect(guidance).toContain('request-scoped `fetch`')
			expect(guidance).toContain('`GATEWAY` Service Binding')
			expect(guidance).toContain('official Better Auth client')
			expectCapabilityPathsToResolve(entries)
		})
	}

	test('Hono with Hey API retains flat-client and separate auth guidance', () => {
		const entries = runGenerators(
			makeCfg(['claude', 'codex', 'opencode'], { apiClient: 'hey-api' })
		)
		const guidance = markdownGuidance(entries)
		const inventory = capabilityPathInventory(entries)

		expect(guidance).toContain('flat `@repo/openapi-client` package')
		expect(guidance).toContain('domain-prefixed operations')
		expect(guidance).toContain("request-scoped `fetch`")
		expect(guidance).toContain('official Better Auth client')
		expect(guidance).toContain('Do not send owned API operations through Better Auth')
		expect(inventory).toContainEqual({
			reference: 'packages/openapi-client/',
			resolvedPath: 'packages/openapi-client'
		})
		expect(inventory).toContainEqual({
			reference: '.ai/rules/web-query.md',
			resolvedPath: '.ai/rules/web-query.md'
		})
		expectCapabilityPathsToResolve(entries)
	})
})

describe('generateAiTooling — content gating', () => {
	test('AGENTS.md does NOT mention .claude/agents when claude is not selected', () => {
		const entries = generateAiTooling(makeCfg(['codex']))
		const agents = content(entries, 'AGENTS.md')
		expect(agents).not.toContain('.claude/agents/')
		expect(agents).not.toContain('.claude/settings.json')
	})

	test('AGENTS.md mentions Claude agents section when claude is also selected', () => {
		const entries = generateAiTooling(makeCfg(['claude', 'codex']))
		const agents = content(entries, 'AGENTS.md')
		expect(agents).toContain('.claude/agents/')
	})

	test('AGENTS.md stays well under Codex 32 KiB cap (router pattern)', () => {
		const entries = generateAiTooling(makeCfg(['claude', 'codex', 'opencode']))
		const agents = content(entries, 'AGENTS.md')
		const bytes = Buffer.byteLength(agents, 'utf8')
		expect(bytes).toBeLessThanOrEqual(5 * 1024)
	})

	test('AGENTS.md is a router, not an inlined dump (no rule bodies)', () => {
		const entries = generateAiTooling(makeCfg(['codex']))
		const agents = content(entries, 'AGENTS.md')
		expect(agents).toContain('.ai/rules/core-stack.md')
		expect(agents).toContain('MUST')
		expect(agents).not.toContain('## Errors: `HttpError`')
		expect(agents).not.toContain('## Schema location')
	})

	test('CLAUDE.md uses @.ai/rules imports', () => {
		const entries = generateAiTooling(makeCfg(['claude']))
		const claude = content(entries, 'CLAUDE.md')
		expect(claude).toContain('@.ai/rules/core-stack.md')
		expect(claude).toContain('@.ai/rules/api-backend.md')
		expect(claude).toContain('@.ai/rules/db-drizzle.md')
	})

	test('opencode.json points at .ai/rules glob', () => {
		const entries = generateAiTooling(makeCfg(['opencode']))
		const cfg = JSON.parse(content(entries, 'opencode.json'))
		expect(cfg.instructions).toEqual(['.ai/rules/*.md'])
	})

	test('no .claude/rules/ path is ever emitted', () => {
		for (const combo of [
			['claude'],
			['codex'],
			['opencode'],
			['claude', 'codex'],
			['claude', 'opencode'],
			['codex', 'opencode'],
			['claude', 'codex', 'opencode']
		] as const) {
			const p = paths(generateAiTooling(makeCfg([...combo])))
			expect(p.some((x) => x.startsWith('.claude/rules/'))).toBe(false)
		}
	})

	test('cf-workers database rules name Neon for postgres and D1 for sqlite', () => {
		const postgresEntries = generateAiTooling(makeCfg(['codex'], { db: 'postgres' }))
		const postgresDbRule = content(postgresEntries, '.ai/rules/db-drizzle.md')
		const postgresAgents = content(postgresEntries, 'AGENTS.md')
		expect(postgresDbRule).toContain('Neon Postgres')
		expect(postgresDbRule).toContain('Neon branch connection string')
		expect(postgresAgents).toContain('PostgreSQL (Neon)')

		const sqliteEntries = generateAiTooling(makeCfg(['codex'], { db: 'sqlite' }))
		const sqliteDbRule = content(sqliteEntries, '.ai/rules/db-drizzle.md')
		const sqliteAgents = content(sqliteEntries, 'AGENTS.md')
		expect(sqliteDbRule).toContain('SQLite via Cloudflare D1')
		expect(sqliteAgents).toContain('SQLite (Cloudflare D1)')
	})

	test('cf-workers guidance stays aligned with the generated Worker baseline', () => {
		const entries = generateAiTooling(makeCfg(['codex']))
		const deployRule = content(entries, '.ai/rules/deploy-cf-workers.md')
		expect(deployRule).toContain('"compatibility_date": "2026-08-24"')
		expect(deployRule).toContain('"compatibility_flags": ["nodejs_compat"]')
		expect(deployRule).not.toContain('nodejs_als')
	})
})
