import type { FileEntry } from '../lib/files.js'
import type { GvKitConfig } from '../schema/config.js'

/**
 * Emits `AGENTS.md` at the repo root as a thin router that points Codex at
 * the canonical `.ai/rules/*.md` tree. Rule bodies are NOT inlined here —
 * the agent reads them on demand. This keeps AGENTS.md small (well under
 * Codex's 32 KiB cap) and removes drift between Claude/Codex/opencode views.
 */
export function generateAiToolingCodex(cfg: GvKitConfig): FileEntry[] {
	return [{ path: 'AGENTS.md', content: renderAgentsMd(cfg) }]
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
		lines.push('- `.ai/rules/web-api.md` — `apps/web` → `apps/api/<svc>` integration')
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
			lines.push('- `service-architect` — scaffolds a new `apps/api/<svc>/` Hono Worker.')
		}
		lines.push('')
	}

	return lines.join('\n')
}

function renderStackBullets(cfg: GvKitConfig): string {
	const lines: string[] = []
	lines.push('- Frontend: SvelteKit (Svelte 5, runes only)')
	if (cfg.choices.backend === 'hono')
		lines.push('- Backend: Hono Workers under `apps/api/<service>/`')
	else lines.push('- Backend: SvelteKit endpoints (single deploy unit)')
	lines.push(
		`- Database: ${cfg.choices.db === 'postgres' ? 'PostgreSQL' : 'SQLite'} via Drizzle (\`packages/db\`)`
	)
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

function renderLayoutBullets(cfg: GvKitConfig): string {
	const lines: string[] = []
	lines.push('- `apps/web/` — SvelteKit app')
	if (cfg.choices.backend === 'hono')
		lines.push('- `apps/api/<service>/` — independently deployable Hono Workers')
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
		lines.push('- `packages/openapi-client/` — generated TypeScript clients')
	return lines.join('\n')
}
