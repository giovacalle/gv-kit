import { describe, expect, test } from 'bun:test'
import { generateAiTooling } from '../../src/generators/ai-tooling.js'
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
	const subsets = [
		['claude'],
		['codex'],
		['opencode'],
		['claude', 'codex'],
		['claude', 'opencode'],
		['codex', 'opencode'],
		['claude', 'codex', 'opencode']
	] as const

	test('empty AI selection still emits nothing in Astro mode', () => {
		expect(generateAiTooling(makeCfg([], { marketing: 'astro' }))).toEqual([])
	})

	for (const selected of subsets) {
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
		expect(deployRule).toContain('"compatibility_date": "2026-07-20"')
		expect(deployRule).toContain('"compatibility_flags": ["nodejs_compat"]')
		expect(deployRule).not.toContain('nodejs_als')
	})
})
