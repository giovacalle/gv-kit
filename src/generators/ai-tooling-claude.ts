import { cloudflareProductionWorkerName } from '../lib/cloudflare-worker-name.js'
import type { FileEntry } from '../lib/files.js'
import { renderTemplate } from '../lib/template-renderer.js'
import type { GvKitConfig } from '../schema/config.js'
import {
	AUTH_SERVICE,
	dockerServiceOrigin,
	nodeDevelopmentOrigin,
	USERS_SERVICE
} from './hono-topology.js'

/**
 * Emits Claude-specific artifacts: `.claude/settings.json`,
 * `.claude/stack.json`, the always-on agents under `.claude/agents/`
 * (from fixture templates), plus the conditional `service-architect` agent.
 *
 * No `CLAUDE.md` is emitted. `AGENTS.md` (emitted by `ai-tooling.ts`) is the
 * single canonical instructions file; Claude Code ≥ 2.1.277 reads `AGENTS.md`
 * natively when no `CLAUDE.md` exists, so a separate Claude file would only
 * be a second copy to keep in sync.
 */
export function generateAiToolingClaude(cfg: GvKitConfig): FileEntry[] {
	const entries: FileEntry[] = [
		{ path: '.claude/settings.json', content: renderClaudeSettings(cfg) },
		{ path: '.claude/stack.json', content: renderStackManifest(cfg) }
	]

	const fixtureAgents = renderTemplate({
		tree: 'root',
		flags: {
			auth: cfg.choices.auth.length > 0,
			email: cfg.choices.email !== 'skip',
			insideFrontendBaseline: cfg.choices.backend === 'inside-frontend',
			cfWorkers: cfg.choices.deploy === 'cf-workers',
			hono: cfg.choices.backend === 'hono',
			i18nParaglide: cfg.choices.i18n === 'paraglide'
		},
		vars: { __PROJECT__: cfg.choices.name }
	})
	entries.push(...fixtureAgents.filter((e) => e.path.startsWith('.claude/')))

	if (cfg.choices.backend === 'hono') {
		entries.push({
			path: '.claude/agents/service-architect.md',
			content: renderServiceArchitectAgent(cfg)
		})
	}
	if (cfg.choices.marketing === 'astro') {
		entries.push({
			path: '.claude/agents/astro-marketer.md',
			content: renderAstroMarketerAgent()
		})
	}

	return entries
}

/* ------------------------------------------------------------------ */
/*  Stack summary + layout                                              */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/*  .claude/stack.json                                                  */
/* ------------------------------------------------------------------ */

function renderStackManifest(cfg: GvKitConfig): string {
	const manifest = {
		version: 1,
		name: cfg.choices.name,
		frontend: cfg.choices.frontend,
		marketing: cfg.choices.marketing,
		...(cfg.choices.marketing === 'astro' ? { marketingApp: 'apps/marketing' } : {}),
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

function renderClaudeSettings(cfg: GvKitConfig): string {
	const privateRuntimePaths =
		cfg.choices.backend === 'hono' ? ['Read(./services/**/.dev.vars)'] : []
	const settings = {
		permissions: {
			allow: [
				'Bash(pnpm*)',
				'Bash(turbo*)',
				...(cfg.choices.deploy === 'cf-workers' ? ['Bash(wrangler*)'] : []),
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
				'Read(./apps/marketing/.env)',
				'Read(./apps/marketing/.env.*)',
				...privateRuntimePaths
			]
		}
	}
	return JSON.stringify(settings, null, 2) + '\n'
}

function renderAstroMarketerAgent(): string {
	return `---
name: astro-marketer
description: Builds and reviews the static Astro marketing surface without crossing into application, auth, API, or database behavior.
tools: Read, Glob, Grep, Bash, Edit, Write
---

# astro-marketer

Work only on the public surface under \`apps/marketing\` and shared presentation
assets it legitimately consumes. Before editing, read
\`.ai/rules/marketing-astro.md\` and follow it as the canonical contract.

Keep the surface static-first, use \`@repo/ui/*\`, hydrate only intentional
interactions, and finish with the marketing typecheck and production build.
Refuse requests that move auth, backend, database, or application behavior into
marketing; route those changes to \`apps/web\` or the owning service instead.
`
}

/* ------------------------------------------------------------------ */
/*  .claude/agents/service-architect.md (gated backend === 'hono')      */
/* ------------------------------------------------------------------ */

function renderServiceArchitectAgent(cfg: GvKitConfig): string {
	const isCfWorkers = cfg.choices.deploy === 'cf-workers'
	const privateRuntime = isCfWorkers ? 'Worker' : 'service'
	const isDocker = cfg.choices.deploy === 'docker'
	const hasAuth = cfg.choices.auth.length > 0
	const project = cfg.choices.name
	const nodeAuthOrigin = isDocker
		? dockerServiceOrigin(AUTH_SERVICE)
		: nodeDevelopmentOrigin(AUTH_SERVICE)

	const runtimeFiles = isCfWorkers
		? `   - \`wrangler.jsonc\` — the only source for bindings, non-secret environment values, and required secret names. **Never \`wrangler.toml\`.**
   - \`worker-configuration.bootstrap.d.ts\` — clean-install bindings derived from the config. \`pnpm cf-typegen\` creates Wrangler's \`worker-configuration.d.ts\` and removes the bootstrap; never hand-edit either declaration or create a separate \`env.d.ts\`.`
		: `   - \`env.d.ts\` — runtime environment declarations for the Node entry.`

	const authMandate = !hasAuth
		? ''
		: isCfWorkers
			? `4. If the service needs the current session, consume the shared auth boundary:
   - Use \`@repo/backend/middleware/auth\` for private session resolution.
   - Add a service binding in \`wrangler.jsonc\`: \`{ "binding": "${AUTH_SERVICE.internalTarget}", "service": "${cloudflareProductionWorkerName(
			{
				project,
				service: AUTH_SERVICE.transport.cfWorkers.serviceNameSuffix
			}
		)}" }\`.
   - Run \`pnpm --filter @repo/<svc> cf-typegen\` so the generated \`Env\` includes the binding.
   - Mount \`requireAuth\` from the shared middleware on protected routes. The middleware owns the deployment-aware private transport. Do not call the \`${AUTH_SERVICE.internalTarget}\` binding, \`${AUTH_SERVICE.transport.node.targetEnvironmentVariable}\`, or \`/internal/session\` directly and do not create another session transport.`
			: `4. If the service needs the current session, consume the shared auth boundary:
   - Use \`@repo/backend/middleware/auth\` for private session resolution.
   - Add \`${AUTH_SERVICE.transport.node.targetEnvironmentVariable}: string\` to \`Env\` in \`env.d.ts\` (${isDocker ? `private Compose target \`${nodeAuthOrigin}\`` : `default \`${nodeAuthOrigin}\` in local development`}).
${isDocker ? `   - Set \`services.<svc>.environment.${AUTH_SERVICE.transport.node.targetEnvironmentVariable}: ${nodeAuthOrigin}\` in \`docker-compose.yml\`.` : ''}
   - Mount \`requireAuth\` from the shared middleware on protected routes. The middleware owns the deployment-aware private transport. Do not call the \`${AUTH_SERVICE.internalTarget}\` binding, \`${AUTH_SERVICE.transport.node.targetEnvironmentVariable}\`, or \`/internal/session\` directly and do not create another session transport.`

	const cloudflareConfig = isCfWorkers
		? `## wrangler.jsonc shape

Keep private services triggerless. Do not add \`route\` or \`routes\`. Declare every binding, non-secret value, and required secret name here so \`wrangler types\` can generate \`Env\`.

\`\`\`jsonc
{
	"$schema": "node_modules/wrangler/config-schema.json",
	"name": "${project}-<svc>",
	"main": "src/index.ts",
	"tsconfig": "tsconfig.json",
	"compatibility_date": "2026-08-24",
	"compatibility_flags": ["nodejs_compat"],
	"workers_dev": false,
	"preview_urls": false,
	"services": ${hasAuth ? `[\n\t\t{ "binding": "${AUTH_SERVICE.internalTarget}", "service": "${cloudflareProductionWorkerName({ project, service: AUTH_SERVICE.transport.cfWorkers.serviceNameSuffix })}" }\n\t]` : '[]'},
	"vars": { "NON_SECRET_SETTING": "<value>" },
	"secrets": { "required": ["<SECRET_NAME>"] },
	"dev": { "ip": "127.0.0.1", "port": 8789, "host": "localhost", "inspector_port": 9231 },
	"observability": { "enabled": true }
	// + d1_databases / kv_namespaces / r2_buckets as needed
}
\`\`\`

Remove the sample \`services\`, \`vars\`, or \`secrets\` entries when the service does not need them. Set secret values with \`wrangler secret put\`, never in source or config.

Pick a UNIQUE \`dev.port\` and \`inspector_port\` per service (${AUTH_SERVICE.identity} uses ${AUTH_SERVICE.development.port}/${AUTH_SERVICE.development.inspectorPort}; ${USERS_SERVICE.identity} ${USERS_SERVICE.development.port}/${USERS_SERVICE.development.inspectorPort}).
`
		: `## env.d.ts shape

\`\`\`ts
declare global {
	interface Env {
		${hasAuth ? `${AUTH_SERVICE.transport.node.targetEnvironmentVariable}: string\n\t\t` : ''}DATABASE_URL?: string
	}
}

export {}
\`\`\`

## src/index.ts shape

${
	hasAuth
		? `The Node entry owns runtime binding injection; routes still resolve sessions only through the shared middleware.${isDocker ? ` Compose sets \`${AUTH_SERVICE.transport.node.targetEnvironmentVariable}\` to the private \`${nodeAuthOrigin}\` target.` : ''}

\`\`\`ts
const authUrl = process.env.${AUTH_SERVICE.transport.node.targetEnvironmentVariable} ?? '${nodeAuthOrigin}'
serve({
	fetch(request) {
		return app.fetch(request, { ${AUTH_SERVICE.transport.node.targetEnvironmentVariable}: authUrl })
	},
	port
})
\`\`\``
		: `\`\`\`ts
serve({ fetch: app.fetch, port })
\`\`\``
}
`

	return `---
name: service-architect
description: Scaffolds a new private \`services/<svc>/\` Hono ${privateRuntime}. Use when adding a NEW domain service. Strict on the service-boundary policy and refuses cross-service shortcuts.
tools: Read, Glob, Grep, Bash, Edit, Write
---

# service-architect

You scaffold a NEW private service under \`services/<svc>/\`. Each service is an independently deployable ${isCfWorkers ? 'Worker ' : ''}transport/runtime adapter that may import the application modules it needs from the shared backend application/core layer at \`packages/backend/\`. The public gateway stays at \`apps/api/\` and owns every external API route.

## Mandate

When asked to add service \`<svc>\` (e.g. \`billing\`, \`notifications\`, \`assets\`):

1. Create \`services/<svc>/\` with:
   - \`package.json\` — \`@repo/<svc>\` (private workspace package).${isCfWorkers ? ' Copy the existing `cf-typegen` bootstrap-replacement script and run it after config changes or before deploy.' : ''}
${runtimeFiles}
   - \`tsconfig.json\` — extends the workspace base.
   - \`src/index.ts\` — runtime entry. ${isCfWorkers ? 'Use `export default { fetch: app.fetch }`.' : hasAuth ? `Use the request-aware \`serve\` adapter shown below so \`${AUTH_SERVICE.transport.node.targetEnvironmentVariable}\` reaches Hono's runtime environment.` : 'Use `serve({ fetch: app.fetch, port })`.'}
   - \`src/app.ts\` — Hono transport wiring (routes, middleware).
   - \`src/routes/\` — one file per resource. Keep handlers thin and invoke reusable application modules from \`@repo/backend\`.

2. Put reusable data access, use cases, types, helpers, and middleware in \`packages/backend/\`. Service adapters may pass a DB created with \`createDb(env)\` from \`@repo/db\` into those modules. No raw drivers.
3. Errors via \`errors.*\` from \`@repo/backend/helpers\` (\`errors.notFound\`, \`errors.badRequest\`, …). Catch \`HttpError\` once at the boundary.
${authMandate}

## Hard constraints (REFUSE)

- **REFUSE to add a public route to a private service.** The gateway owns public API ingress.
- **REFUSE to import or mount a private service application in the gateway.** Update the explicit prefix-to-target map and transport instead.
- **REFUSE internal calls through the gateway.** Private services call one another through direct bindings or private URLs.
- **REFUSE credentialed wildcard CORS.** Use an explicit origin allowlist and reject unknown origins.
${isCfWorkers ? '- **REFUSE `wrangler.toml`, public private-service triggers, and hand-written Cloudflare `Env` declarations.** Keep `workers_dev: false`, `preview_urls: false`, no routes, and use `wrangler.jsonc` plus `pnpm cf-typegen` as the source of truth.' : ''}
${hasAuth ? `- **REFUSE to configure Better Auth outside \`${AUTH_SERVICE.workspacePath}/src/auth.ts\`.** The auth service owns Better Auth configuration and secrets.` : '- **REFUSE to add authentication behavior while no provider is selected.** Select a provider before adding auth schemas, routes, or session handling.'}
- **REFUSE to put reusable application logic in a transport adapter.** Put shared data access, use cases, types, helpers, and middleware in \`packages/backend/\`, then import the required modules from the service.
${hasAuth ? '- **REFUSE ad hoc auth-schema queries in a transport adapter.** Put reusable domain data access in `packages/backend/`; shared application modules may read `authSchema.user` for domain use cases. Resolve session, account, and verification state through the auth boundary.' : '- **REFUSE to invent auth-schema access while authentication is disabled.** No auth schema or users use case is generated until a provider is selected.'}
- **REFUSE to extract a shared service-client SDK** (\`packages/<svc>-client/\`).${hasAuth ? ' Use the existing deploy-aware middleware for the auth boundary; add a service-local private transport only for a different boundary that needs one.' : ' Add a service-local private transport only when a generated boundary needs one.'}
- **REFUSE to share binding or environment declarations between services.** Each \`services/<svc>/\` owns its runtime configuration.

${cloudflareConfig}
## Process

1. Pick \`<svc>\`. Confirm what it owns, its public prefixes at the gateway, and which private boundaries it consumes.
2. Scaffold the file tree.
3. ${isCfWorkers ? 'Pick unique `dev.port` and `inspector_port`, then run `pnpm --filter @repo/<svc> cf-typegen`.' : 'Verify `env.d.ts` types against the runtime entry.'}
4. Update the gateway's explicit prefix map and OpenAPI composition inputs for public operations.
5. Run \`pnpm typecheck\` and \`pnpm lint\` from the repo root.
6. Report paths created, ports assigned, and bindings declared.
`
}

