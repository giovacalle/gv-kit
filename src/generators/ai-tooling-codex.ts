import type { FileEntry } from '../lib/files.js'
import type { GvKitConfig } from '../schema/config.js'

/**
 * Emits `AGENTS.md` at the repo root as a thin router that points Codex at
 * the canonical `.ai/rules/*.md` tree. Rule bodies are NOT inlined here —
 * the agent reads them on demand. This keeps AGENTS.md small (well under
 * Codex's 32 KiB cap) and removes drift between Claude/Codex/opencode views.
 */
export function generateAiToolingCodex(cfg: GvKitConfig): FileEntry[] {
	const entries: FileEntry[] = [{ path: 'AGENTS.md', content: renderAgentsMd(cfg) }]
	if (cfg.choices.marketing === 'astro')
		entries.push({
			path: '.codex/agents/astro-marketer.toml',
			content: renderAstroMarketerAgent()
		})
	return entries
}

export function renderAgentsMd(cfg: GvKitConfig): string {
	const lines: string[] = []

	lines.push(`# ${cfg.choices.name}`)
	lines.push('')
	lines.push('Type-safe full-stack monorepo. Read this before making changes.')
	lines.push('')

	lines.push('## Stack')
	lines.push('')
	lines.push(renderStackBullets(cfg))
	lines.push('')

	lines.push('## Layout')
	lines.push('')
	lines.push(renderLayoutBullets(cfg))
	lines.push('')

	lines.push('## IMPORTANT — read these before any non-trivial change')
	lines.push('')
	lines.push(
		'The full conventions live in `.ai/rules/`. You **MUST** read the relevant files before editing the corresponding area. **DO NOT skip.**'
	)
	lines.push('')
	lines.push(
		`- \`.ai/rules/core-stack.md\` — layout, request lifecycle, service-boundary policy${cfg.choices.backend === 'hono' ? ' (CRITICAL — auth-as-service)' : ''}`
	)
	lines.push(
		`- \`.ai/rules/api-backend.md\` — error pattern, runtime constraints${cfg.choices.backend === 'hono' ? ', domain layering (`packages/backend/src/core/**`)' : ''}`
	)
	lines.push('- `.ai/rules/db-drizzle.md` — schema, factory, migrations')
	lines.push(
		'- `.ai/rules/core-style.md`, `core-errors.md`, `core-dates.md`, `core-testing.md`, `core-workflow.md` — always apply'
	)
	lines.push(
		'- `.ai/rules/web-svelte.md`, `web-forms.md`, `web-tailwind.md`, `web-ui.md` — frontend conventions'
	)
	if (cfg.choices.backend === 'hono')
		lines.push(
			'- `.ai/rules/web-api.md` — same-origin browser API access and request-scoped SSR gateway transport'
		)
	if (cfg.choices.apiClient === 'hey-api')
		lines.push('- `.ai/rules/web-query.md` — TanStack Query (svelte-query) client-data conventions')
	if (cfg.choices.auth.length > 0)
		lines.push('- `.ai/rules/auth-flow.md` — passwordless login, OTP, OAuth, Turnstile')
	if (cfg.choices.deploy === 'cf-workers')
		lines.push('- `.ai/rules/deploy-cf-workers.md` — wrangler, bindings, no Node APIs')
	if (cfg.choices.email === 'resend')
		lines.push('- `.ai/rules/email-templates.md` — react-email + mailer')
	else if (cfg.choices.email === 'notifuse')
		lines.push(
			'- `.ai/rules/email-templates.md` — Notifuse RPC client, templates managed in Notifuse console'
		)
	if (cfg.choices.marketing === 'astro')
		lines.push(
			'- `.ai/rules/marketing-astro.md` — static Astro, shared UI, content, SEO, and delivery boundaries'
		)
	lines.push('')

	lines.push('## Commands')
	lines.push('')
	lines.push('- `pnpm dev` — start every app and service in watch mode')
	lines.push('- `pnpm build` — build every workspace package')
	lines.push('- `pnpm test` — run all tests')
	lines.push('- `pnpm typecheck` — TypeScript check across the workspace')
	lines.push('- `pnpm lint` — ESLint across the workspace')
	lines.push('- `pnpm format` — Prettier')
	lines.push('')
	lines.push('Run typecheck + lint before reporting a task complete.')
	lines.push('')

	if (cfg.choices.aiTooling.includes('claude')) {
		lines.push('## Workflow agents (Claude Code only)')
		lines.push('')
		lines.push(
			'Four agnostic agents live under `.claude/agents/` (markdown descriptors). They are Claude-specific. If you are running under Codex, ignore this section — read the rules above directly.'
		)
		lines.push('')
		lines.push('1. `plan` — design the change. Read-only.')
		lines.push('2. `implement` — execute a plan or a small direct change.')
		lines.push('3. `polish` — naming, dead code, duplication.')
		lines.push('4. `review` — quality + security audit. Read-only.')
		if (cfg.choices.backend === 'hono') {
			lines.push('')
			lines.push('Specialists:')
			lines.push('')
			lines.push('- `service-architect` — scaffolds a new private `services/<svc>/` Hono Worker.')
		}
		lines.push('')
	}

	return lines.join('\n')
}

function renderStackBullets(cfg: GvKitConfig): string {
	const lines: string[] = []
	lines.push('- Frontend: SvelteKit (Svelte 5, runes only)')
	if (cfg.choices.marketing === 'astro')
		lines.push('- Marketing: Astro static site (`apps/marketing`)')
	if (cfg.choices.backend === 'hono')
		lines.push('- Backend: public Hono gateway at `apps/api` with private workers under `services/`')
	else lines.push('- Backend: SvelteKit endpoints (single deploy unit)')
	lines.push(`- Database: ${databaseLabel(cfg)} via Drizzle (\`packages/db\`)`)
	if (cfg.choices.auth.length > 0)
		lines.push(`- Auth: better-auth (${cfg.choices.auth.join(', ')})`)
	if (cfg.choices.i18n === 'paraglide')
		lines.push('- i18n: Paraglide v2 (`packages/i18n` compiled package)')
	if (cfg.choices.email !== 'skip') lines.push(`- Email: ${cfg.choices.email}`)
	if (cfg.choices.monitoring.length > 0)
		lines.push(`- Analytics: ${cfg.choices.monitoring.join(', ')}`)
	if (cfg.choices.deploy !== 'skip') {
		const label = cfg.choices.deploy === 'cf-workers' ? 'Cloudflare Workers' : 'Docker'
		lines.push(`- Deploy: ${label}`)
	}
	if (cfg.choices.apiClient === 'hey-api')
		lines.push('- API client: Hey API + TanStack Query (`packages/openapi-client`)')
	return lines.join('\n')
}

function databaseLabel(cfg: GvKitConfig): string {
	if (cfg.choices.db === 'postgres') {
		return cfg.choices.deploy === 'cf-workers' ? 'PostgreSQL (Neon)' : 'PostgreSQL'
	}
	return cfg.choices.deploy === 'cf-workers' ? 'SQLite (Cloudflare D1)' : 'SQLite'
}

function renderLayoutBullets(cfg: GvKitConfig): string {
	const lines: string[] = []
	if (cfg.choices.marketing === 'astro')
		lines.push('- `apps/marketing/` — static Astro public site')
	lines.push('- `apps/web/` — SvelteKit app')
	if (cfg.choices.backend === 'hono') {
		lines.push('- `apps/api/` — public Hono API gateway')
		lines.push('- `services/<service>/` — independently deployable private Hono Workers')
	}
	lines.push('- `packages/db/` — Drizzle schema + client factory')
	lines.push('- `packages/backend/` — horizontal helpers (logger, error helpers, middleware)')
	lines.push(
		'- `packages/ui/` — shared primitives (`$lib/components/primitives/`), `cn()` helper, Tailwind theme'
	)
	if (cfg.choices.i18n === 'paraglide')
		lines.push(
			'- `packages/i18n/` — Paraglide messages + compiled runtime (`@repo/i18n/messages`, `@repo/i18n/runtime`, `@repo/i18n/server`)'
		)
	if (cfg.choices.apiClient === 'hey-api')
		lines.push('- `packages/openapi-client/` — flat client generated from the gateway contract')
	return lines.join('\n')
}

function renderAstroMarketerAgent(): string {
	return `name = "astro-marketer"
description = "Builds and reviews the static Astro marketing surface without crossing application boundaries."
developer_instructions = """
Work only on the public surface under apps/marketing and shared presentation
assets it legitimately consumes. Read .ai/rules/marketing-astro.md before
editing and follow it as the canonical contract. Keep the surface static-first,
use @repo/ui/*, hydrate only intentional interactions, and run the marketing
typecheck and production build. Refuse to move auth, backend, database, or
application behavior into marketing.
"""
`
}
