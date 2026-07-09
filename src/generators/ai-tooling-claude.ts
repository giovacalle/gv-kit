import type { FileEntry } from '../lib/files.js'
import { renderTemplate } from '../lib/template-renderer.js'
import type { GvKitConfig } from '../schema/config.js'

/**
 * Emits Claude-specific artifacts: `CLAUDE.md`, `.claude/settings.json`,
 * `.claude/stack.json`, the always-on agents under `.claude/agents/`
 * (from fixture templates), plus the conditional `service-architect` agent.
 *
 * Rule bodies are NOT emitted here — they live in `.ai/rules/*.md` (see
 * `generateAiToolingRules`). `CLAUDE.md` references them via `@imports`.
 */
export function generateAiToolingClaude(cfg: GvKitConfig): FileEntry[] {
	const entries: FileEntry[] = [
		{ path: 'CLAUDE.md', content: renderClaudeMd(cfg) },
		{ path: '.claude/settings.json', content: renderClaudeSettings() },
		{ path: '.claude/stack.json', content: renderStackManifest(cfg) }
	]

	const fixtureAgents = renderTemplate({
		tree: 'root',
		flags: {
			auth: cfg.choices.auth.length > 0,
			cfWorkers: cfg.choices.deploy === 'cf-workers',
			hono: cfg.choices.backend === 'hono',
			i18nParaglide: cfg.choices.i18n === 'paraglide'
		},
		vars: { __PROJECT__: cfg.choices.name }
	})
	entries.push(...fixtureAgents.filter((e) => e.path.startsWith('.claude/')))

	if (cfg.choices.backend === 'hono')
		entries.push({
			path: '.claude/agents/service-architect.md',
			content: renderServiceArchitectAgent(cfg)
		})

	return entries
}

/* ------------------------------------------------------------------ */
/*  Stack summary + layout                                              */
/* ------------------------------------------------------------------ */

function renderStackSummary(cfg: GvKitConfig): string {
	const lines: string[] = []
	lines.push('- Frontend: SvelteKit (Svelte 5, runes)')
	if (cfg.choices.backend === 'hono')
		lines.push('- Backend: Hono workers under `apps/api/<service>/`')
	else lines.push('- Backend: SvelteKit endpoints (single deploy unit)')
	lines.push(`- Database: ${databaseLabel(cfg)} via Drizzle (\`packages/db\`)`)
	if (cfg.choices.auth.length > 0)
		lines.push(`- Auth: better-auth (${cfg.choices.auth.join(', ')})`)
	if (cfg.choices.i18n === 'paraglide') lines.push('- i18n: Paraglide v2')
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

function renderLayoutTree(cfg: GvKitConfig): string {
	const lines: string[] = []
	lines.push('- `apps/web/` — SvelteKit app')
	if (cfg.choices.backend === 'hono')
		lines.push('- `apps/api/<service>/` — independently deployable Hono workers')
	lines.push('- `packages/db/` — Drizzle schema + client factory')
	lines.push('- `packages/backend/` — shared backend helpers (logger, error helpers, middleware)')
	if (cfg.choices.i18n === 'paraglide')
		lines.push(
			'- `packages/i18n/` — Paraglide messages + compiled runtime (`@repo/i18n/messages`, `@repo/i18n/runtime`, `@repo/i18n/server`)'
		)
	if (cfg.choices.apiClient === 'hey-api')
		lines.push('- `packages/openapi-client/` — generated TypeScript clients per service')
	return lines.join('\n')
}

/* ------------------------------------------------------------------ */
/*  CLAUDE.md — lean orientation, @imports the .ai/rules tree           */
/* ------------------------------------------------------------------ */

function renderClaudeMd(cfg: GvKitConfig): string {
	const specialists: string[] = []
	if (cfg.choices.backend === 'hono')
		specialists.push('- `service-architect` — scaffolds a new `apps/api/<svc>/` Hono Worker')

	const specialistsBlock =
		specialists.length > 0
			? `\nSpecialists (added when the stack creates a domain that needs one):\n\n${specialists.join('\n')}\n`
			: ''

	const ruleImports: string[] = [
		'@.ai/rules/core-stack.md',
		'@.ai/rules/api-backend.md',
		'@.ai/rules/db-drizzle.md',
		'@.ai/rules/core-style.md',
		'@.ai/rules/core-errors.md',
		'@.ai/rules/core-dates.md',
		'@.ai/rules/core-testing.md',
		'@.ai/rules/core-workflow.md',
		'@.ai/rules/web-svelte.md',
		'@.ai/rules/web-forms.md',
		'@.ai/rules/web-tailwind.md',
		'@.ai/rules/web-ui.md'
	]

	if (cfg.choices.backend === 'hono') ruleImports.push('@.ai/rules/web-api.md')
	if (cfg.choices.auth.length > 0) ruleImports.push('@.ai/rules/auth-flow.md')
	if (cfg.choices.deploy === 'cf-workers') ruleImports.push('@.ai/rules/deploy-cf-workers.md')
	if (cfg.choices.email !== 'skip') ruleImports.push('@.ai/rules/email-templates.md')
	if (cfg.choices.apiClient === 'hey-api') ruleImports.push('@.ai/rules/web-query.md')

	const importsBlock = ruleImports.join('\n')

	return `# ${cfg.choices.name}

Type-safe full-stack monorepo.

## Stack

${renderStackSummary(cfg)}

## Layout

${renderLayoutTree(cfg)}

## Workflow

Four agnostic agents live under \`.claude/agents/\`. Use them as the lifecycle of any change:

1. \`plan\` — design the change. Read-only. Surfaces trade-offs.
2. \`implement\` — execute a plan or a small direct change.
3. \`polish\` — naming, dead code, duplication.
4. \`review\` — quality + security audit. Read-only.
${specialistsBlock}
See \`.ai/rules/core-workflow.md\` for the full flow and when to skip steps.

## Rules

All conventions live in \`.ai/rules/\`. The imports below load them into context at session start:

${importsBlock}

## Stack manifest

User choices are recorded at \`.claude/stack.json\`. Agents read it to know which rules apply without inferring from the filesystem. Keep it in sync when the stack evolves.

## Common commands

| Command | What it does |
|---------|--------------|
| \`pnpm dev\` | Start every app and service in watch mode |
| \`pnpm build\` | Build every workspace package |
| \`pnpm test\` | Run all tests |
| \`pnpm typecheck\` | TypeScript check across the workspace |
| \`pnpm lint\` | ESLint across the workspace |
| \`pnpm format\` | Format with Prettier |

## Conventions

- All output (code, comments, commits, docs) in English
- TypeScript pinned via \`tsconfig.base.json\`
- Wrangler config is always \`wrangler.jsonc\` — never \`wrangler.toml\`
- Tailwind 4: theme via CSS \`@theme\` directive only (no \`tailwind.config.js\`)
`
}

/* ------------------------------------------------------------------ */
/*  .claude/stack.json                                                  */
/* ------------------------------------------------------------------ */

function renderStackManifest(cfg: GvKitConfig): string {
	const manifest = {
		version: 1,
		name: cfg.choices.name,
		frontend: cfg.choices.frontend,
		backend: cfg.choices.backend,
		db: cfg.choices.db,
		auth: cfg.choices.auth,
		deploy: cfg.choices.deploy,
		email: cfg.choices.email,
		i18n: cfg.choices.i18n,
		apiClient: cfg.choices.apiClient,
		monitoring: cfg.choices.monitoring
	}
	return JSON.stringify(manifest, null, 2) + '\n'
}

/* ------------------------------------------------------------------ */
/*  .claude/settings.json                                               */
/* ------------------------------------------------------------------ */

function renderClaudeSettings(): string {
	const settings = {
		permissions: {
			allow: [
				'Bash(pnpm*)',
				'Bash(turbo*)',
				'Bash(wrangler*)',
				'Bash(git status)',
				'Bash(git diff*)',
				'Bash(git log*)',
				'Bash(git add*)',
				'Bash(git commit*)',
				'Bash(ls*)'
			],
			deny: [
				'Read(./.env)',
				'Read(./.env.*)',
				'Read(./apps/web/.dev.vars)',
				'Read(./apps/api/**/.dev.vars)'
			]
		}
	}
	return JSON.stringify(settings, null, 2) + '\n'
}

/* ------------------------------------------------------------------ */
/*  .claude/agents/service-architect.md (gated backend === 'hono')      */
/* ------------------------------------------------------------------ */

function renderServiceArchitectAgent(cfg: GvKitConfig): string {
	const isCfWorkers = cfg.choices.deploy === 'cf-workers'
	const project = cfg.choices.name

	return `---
name: service-architect
description: Scaffolds a new \`apps/api/<svc>/\` Hono Worker with its own wrangler.jsonc, bindings, and Env. Use when adding a NEW domain service. Strict on the service-boundary policy — refuses cross-service shortcuts.
tools: Read, Glob, Grep, Bash, Edit, Write
---

# service-architect

You scaffold a NEW service under \`apps/api/<svc>/\`. Each service is its own deployable Hono Worker with its own \`wrangler.jsonc\`, its own bindings, and its own \`Env\`.

## Mandate

When asked to add service \`<svc>\` (e.g. \`billing\`, \`notifications\`, \`assets\`):

1. Create \`apps/api/<svc>/\` with:
   - \`package.json\` — \`@repo/<svc>\` (private workspace package).
   - \`wrangler.jsonc\` — \`name: "${project}-<svc>"\`, explicit bindings only. **Never \`wrangler.toml\`.**
   - \`env.d.ts\` — hand-edited declaration that augments the wrangler-emitted \`worker-configuration.d.ts\`.
   - \`tsconfig.json\` — extends the workspace base.
   - \`src/index.ts\` — runtime entry. CF: \`export default { fetch: app.fetch }\`. Node: \`serve({ fetch: app.fetch, port })\`.
   - \`src/app.ts\` — Hono app wiring (routes, middleware).
   - \`src/routes/\` — one file per resource.

2. DB access via \`createDb(env)\` from \`@repo/db\`. No raw drivers.
3. Errors via \`errors.*\` from \`@repo/backend/helpers\` (\`errors.notFound\`, \`errors.badRequest\`, …). Catch \`HttpError\` once at the boundary.
4. If the service needs the current session, consume the auth boundary:
${
	isCfWorkers
		? `   - Add a service binding in \`wrangler.jsonc\`: \`{ "binding": "AUTH", "service": "${project}-auth" }\`.
   - Add \`AUTH: Fetcher\` to \`Env\` in \`env.d.ts\`.
   - Call it via \`env.AUTH.fetch(new Request('https://internal/internal/session', { headers: { cookie } }))\`.`
		: `   - Add \`AUTH_URL: string\` to \`Env\` in \`env.d.ts\` (default \`http://127.0.0.1:8787\` in dev).
   - Call \`fetch(\\\`\${env.AUTH_URL}/internal/session\\\`, { headers: { cookie } })\`.`
}
   - Or use the existing Hono auth adapter: \`@repo/backend/hono/auth/require\` (it does exactly this against the binding/URL).

## Hard constraints (REFUSE)

- **REFUSE \`wrangler.toml\`.** \`wrangler.jsonc\` only.
- **REFUSE to import \`@repo/backend/auth\` from any service other than \`apps/api/auth/\`.** That import path is reserved for the auth Worker's own bootstrap.
- **REFUSE to add cross-service domain logic to \`packages/backend/\`.** That package is for horizontal helpers only (logger, error helpers, generic middleware). Auth state, billing state, RBAC live with their owning service.
- **REFUSE to query \`user\`, \`session\`, \`account\`, \`verification\` from a non-auth service.** Read session via the auth boundary.
- **REFUSE to extract a shared service-client SDK** (\`packages/<svc>-client/\`). Each consumer keeps its own ~10 LOC inline client. Duplication is the feature.
- **REFUSE to share a \`Fetcher\`/\`Env\` between services.** Each \`apps/api/<svc>/\` declares its own.

## wrangler.jsonc shape

\`\`\`jsonc
{
	"$schema": "node_modules/wrangler/config-schema.json",
	"name": "${project}-<svc>",
	"main": "src/index.ts",
	"compatibility_date": "2026-04-01",
	"compatibility_flags": ["nodejs_compat"],
	"dev": { "ip": "127.0.0.1", "port": 8789, "host": "localhost", "inspector_port": 9231 },
	"services": [
		{ "binding": "AUTH", "service": "${project}-auth" }
	],
	"observability": { "enabled": true }
	// + d1_databases / kv_namespaces / r2_buckets as needed
}
\`\`\`

Pick a UNIQUE \`dev.port\` and \`inspector_port\` per service (auth uses 8787/9229; users 8788/9230).

## env.d.ts shape

\`\`\`ts
declare global {
	interface Env {
${isCfWorkers ? '\t\tAUTH: Fetcher\n\t\tDB: D1Database // or DATABASE_URL: string for Neon Postgres' : '\t\tAUTH_URL: string\n\t\tDATABASE_URL?: string'}
	}
}

export {}
\`\`\`

## Process

1. Pick \`<svc>\`. Confirm what it owns and which boundaries it consumes.
2. Scaffold the file tree.
3. Pick unique \`dev.port\` / \`inspector_port\` (verify against existing services).
4. ${isCfWorkers ? 'Run `pnpm --filter @repo/<svc> cf-typegen` to generate `worker-configuration.d.ts`.' : 'Verify `env.d.ts` types against the runtime entry.'}
5. Run \`pnpm typecheck\` and \`pnpm lint\` from the repo root.
6. Report: paths created, ports assigned, bindings declared.
`
}

function databaseLabel(cfg: GvKitConfig): string {
	if (cfg.choices.db === 'postgres') {
		return cfg.choices.deploy === 'cf-workers' ? 'PostgreSQL (Neon)' : 'PostgreSQL'
	}
	return cfg.choices.deploy === 'cf-workers' ? 'SQLite (Cloudflare D1)' : 'SQLite'
}
