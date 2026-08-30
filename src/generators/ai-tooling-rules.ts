import { cloudflareProductionWorkerName } from '../lib/cloudflare-worker-name.js'
import type { FileEntry } from '../lib/files.js'
import { renderTemplate } from '../lib/template-renderer.js'
import { HONO_WORKERS_COMPAT_DATE, WORKERS_COMPAT_DATE } from '../lib/workers.js'
import type { GvKitConfig } from '../schema/config.js'
import { AUTH_SERVICE, USERS_SERVICE } from './hono-topology.js'

/**
 * Canonical source of rule bodies. Emits `.ai/rules/*.md`, the neutral
 * location consumed by every supported AI tooling integration:
 *
 * - Claude reads them via `@.ai/rules/<name>.md` imports from CLAUDE.md.
 * - opencode loads them via `instructions: [".ai/rules/*.md"]` in opencode.json.
 * - Codex receives a router AGENTS.md that points at them.
 */
export function generateAiToolingRules(cfg: GvKitConfig): FileEntry[] {
	const entries: FileEntry[] = [
		{ path: '.ai/rules/core-stack.md', content: renderCoreStackRule(cfg) },
		{ path: '.ai/rules/api-backend.md', content: renderBackendRule(cfg) },
		{ path: '.ai/rules/db-drizzle.md', content: renderDbRule(cfg) }
	]

	if (cfg.choices.email !== 'skip') entries.push({ path: '.ai/rules/email-templates.md', content: renderEmailRule(cfg) })
	if (cfg.choices.marketing === 'astro') entries.push({ path: '.ai/rules/marketing-astro.md', content: renderMarketingAstroRule() })

	const fixtureRules = renderTemplate({
		tree: 'root',
		flags: {
			auth: cfg.choices.auth.length > 0,
			insideFrontendBaseline: cfg.choices.backend === 'inside-frontend',
			insideFrontendCfBaseline:
				cfg.choices.backend === 'inside-frontend' && cfg.choices.deploy === 'cf-workers',
			cfWorkers: cfg.choices.deploy === 'cf-workers',
			hono: cfg.choices.backend === 'hono',
			i18nParaglide: cfg.choices.i18n === 'paraglide',
			apiClientHeyApi: cfg.choices.apiClient === 'hey-api'
		},
		vars: {
			__PROJECT__: cfg.choices.name,
			__CLOUDFLARE_WEB_WORKER__: cloudflareProductionWorkerName({
				project: cfg.choices.name,
				service: 'web'
			}),
			__COMPAT_DATE__:
				cfg.choices.backend === 'hono' ? HONO_WORKERS_COMPAT_DATE : WORKERS_COMPAT_DATE
		}
	})
	entries.push(...fixtureRules.filter((e) => e.path.startsWith('.ai/rules/')))

	return entries
}

function renderMarketingAstroRule(): string {
	return `# Astro marketing

\`apps/marketing\` is the public, static-first surface. It owns the homepage,
canonical metadata, robots, sitemap, and static 404. \`apps/web\` owns the
application; marketing only navigates to the explicit \`PUBLIC_APP_URL\`.

## Engineering boundary

- Keep Astro at \`output: 'static'\`. Do not add actions, API routes, runtime
  secrets, auth/session logic, database access, or application data fetching.
- Compose pages in \`.astro\`. Shared Svelte primitives render statically by
  default; add a \`client:*\` directive only around a coherent interaction.
- Import shared UI only through \`@repo/ui/*\`. The \`@lib\` alias exists solely
  so raw \`@repo/ui\` source resolves its package-internal imports.
- Import \`@repo/ui/styles\` once. Keep Tailwind classes literal and preserve
  source scanning for both marketing \`.astro\` files and package Svelte files.
- Keep optimized images under \`src/\`; use meaningful alt text, or \`alt=""\`
  for decorative images.

## Public content and URLs

- Use one descriptive H1, semantic headings, concrete copy, and destination-clear
  CTA text. Never invent metrics, customers, testimonials, compliance, or proof.
- Read canonical/site URLs from \`PUBLIC_MARKETING_URL\` and the application CTA
  from \`PUBLIC_APP_URL\`. Never derive one hostname from the other.
- With Paraglide, catalogs remain in \`packages/i18n\`. Render the base locale at
  \`/\`, non-base locales at \`/<locale>/\`, and pass locale explicitly to every
  message function during prerender.

## Monitoring and delivery

- Expose only selected \`PUBLIC_*\` analytics values. Umami is a deferred external
  script. PostHog initializes from an Astro client script, never frontmatter.
- Cloudflare and Docker serve the same \`dist/\`. Missing routes return the
  generated 404; do not add an SPA fallback. Only fingerprinted assets receive
  long immutable caching.

Run the marketing typecheck and production build before reporting completion.
Inspect the generated HTML/JS to confirm only intended islands hydrate and no
auth, database, or backend secrets reached the bundle.
`
}

/* ------------------------------------------------------------------ */
/*  .ai/rules/core-stack.md                                            */
/* ------------------------------------------------------------------ */

export function renderCoreStackRule(cfg: GvKitConfig): string {
	if (cfg.choices.backend !== 'hono') {
		return `# Stack

This project deploys as a **single SvelteKit unit** under \`apps/web/\`.
All HTTP entry points and server-side data access stay in that unit.

## Layout

- \`apps/web/\` — SvelteKit app, contains all HTTP entry points
- \`packages/db/\` — Drizzle schema + client factory (\`createDb(env)\`)
- \`packages/backend/\` — shared backend application/core layer (data access, use cases, types, helpers, middleware)
${cfg.choices.i18n === 'paraglide' ? '- `packages/i18n/` — Paraglide messages\n' : ''}

## Request lifecycle

1. Browser hits a SvelteKit route (\`+page.server.ts\` or \`+server.ts\`).
2. Server-side handlers query \`@repo/db\` directly and use shared helpers from
   \`@repo/backend\`. There is no separate API application.
3. Responses go back through SvelteKit's response pipeline.

## Service boundary policy

Treat \`+server.ts\` files as the HTTP boundary. Keep cross-domain imports out
of unrelated route folders so future changes stay local.

- All HTTP entry points are SvelteKit handlers (\`+server.ts\` / \`+page.server.ts\`)
- \`packages/db\` is the sole DB consumer entry point
- \`packages/backend\` holds reusable data access, use cases, types, helpers, and middleware
`
	}

	return `# Stack

\`apps/api/\` is the public Hono API gateway. The web origin's \`/api/*\` alias
and canonical API origin reach the same gateway. Independently deployable private
Hono workers under \`services/\` are transport/runtime adapters. They invoke the
shared backend application/core layer in \`packages/backend/\`. Browser and SSR
code depend on the gateway contract, never on a private service's deployment address.

## Layout

- \`apps/web/\` — SvelteKit app
- \`apps/api/\` — public Hono API gateway
- \`services/<service>/\` — independently deployable private transport/runtime adapters (e.g. \`auth\`, \`users\`)
- \`packages/db/\` — Drizzle schema + client factory
- \`packages/backend/\` — shared backend application/core layer (data access, use cases, types, helpers, middleware)
${cfg.choices.i18n === 'paraglide' ? '- `packages/i18n/` — Paraglide messages\n' : ''}${cfg.choices.apiClient === 'hey-api' ? '- `packages/openapi-client/` — flat client generated from `apps/api/openapi.json`\n' : ''}

## Request lifecycle

${
	cfg.choices.auth.length > 0
		? `1. Browser requests use same-origin \`/api/*\` paths and reach the gateway. Better Auth uses
   \`/api/auth/*\`; domain operations use versioned \`/api/v1/*\` paths.`
		: `1. Browser requests use same-origin \`/api/*\` paths and reach the gateway. No public auth
   methods are mounted; domain operations use versioned \`/api/v1/*\` paths.`
}
2. SvelteKit SSR passes its request-scoped \`fetch\` ${cfg.choices.apiClient === 'hey-api' ? 'to the flat gateway client' : 'to same-origin gateway requests'}.
   On Cloudflare, \`handleFetch\` sends these requests through the web Worker's
   \`GATEWAY\` Service Binding. Node and Docker use the private gateway URL.
3. The gateway maps explicit public prefixes to private services. Private
   services call one another directly and never hairpin through the gateway.
   Web code never bypasses the gateway.

## Service boundary policy (CRITICAL)

- **The gateway owns public API ingress.** It must not import or mount a private service application.
  Private workers under \`services/\` have no browser-facing route.
- **The gateway stays thin.** It handles ingress, routing, operational middleware,
  OpenAPI delivery, and transparent forwarding. It does not import application use
  cases or orchestrate business workflows.
- **Private services stay private.** They must not gain a public route, workers.dev hostname, or preview URL.
- **Auth is a service.** Served EXCLUSIVELY by \`${AUTH_SERVICE.workspacePath}/\`. No other
  service exposes auth endpoints.${cfg.choices.auth.length === 0 ? ' With no selected provider, do not add authentication behavior.' : ''}
${
	cfg.choices.auth.length > 0
		? `- **Private session resolution uses shared middleware.** Session-aware services MUST use the existing
  \`@repo/backend/middleware/auth\` transport. This shared middleware owns the deployment-aware
  \`${AUTH_SERVICE.internalTarget}\` binding or \`${AUTH_SERVICE.transport.node.targetEnvironmentVariable}\` URL transport to the private auth service.
  Transport adapters and agents must not call the binding, URL, or \`/internal/session\`
  directly, generate a duplicate auth client, or extract a service SDK.`
		: ''
}
- **Application modules are shared.** \`packages/backend/\` is the shared backend
  application/core layer for reusable data access, use cases, types, helpers, and
  middleware. Service adapters may import any application modules they need.
- **OpenAPI ownership stays with services.** Each domain service owns a deterministic fragment.
  The gateway composes \`apps/api/openapi.json\` and serves it at \`/api/openapi.json\`. Better Auth
  stays outside that document.${cfg.choices.apiClient === 'hey-api' ? ' Hey API generates one flat client from it.' : ' No API client package is generated.'}
- **Bindings are explicit per deployable.** The web Worker binds only to the
  gateway. The gateway binds to its private services. Each private service declares
  the data and service bindings required by its runtime adapter. No shared \`env\` blob.

## Forbidden patterns

- Browser or SSR code calling \`${AUTH_SERVICE.workspacePath}/\` or \`${USERS_SERVICE.workspacePath}/\` directly
- \`${USERS_SERVICE.workspacePath}/\` configuring Better Auth or reading its secrets
- \`${USERS_SERVICE.workspacePath}/\` reading \`BETTER_AUTH_SECRET\`
${
	cfg.choices.auth.length > 0
		? '- Embedding ad hoc auth-schema queries in a transport adapter. Put reusable domain data access in `packages/backend/`; shared application modules may read `authSchema.user` for domain use cases. Resolve session, account, and verification state through the private auth boundary.'
		: '- Inventing auth-schema access while authentication is disabled. No auth schema or users use case is generated until a provider is selected.'
}
- Adding a per-service public client package or fetch wrapper
- Sending an internal service call through the gateway
- Configuring credentialed wildcard CORS; use an explicit origin allowlist
`
}

/* ------------------------------------------------------------------ */
/*  .ai/rules/api-backend.md                                           */
/* ------------------------------------------------------------------ */

export function renderBackendRule(cfg: GvKitConfig): string {
	const isCfWorkers = cfg.choices.deploy === 'cf-workers'
	const isHono = cfg.choices.backend === 'hono'
	const gatewayConsumer =
		cfg.choices.apiClient === 'hey-api'
			? `- Browser code imports operations from the flat \`@repo/openapi-client\` package
  and uses same-origin \`/api/*\` paths.
- SvelteKit server code passes request-scoped \`fetch\` to that client.`
			: `- This workspace has no generated API client package. Browser code uses same-origin
  \`/api/*\` paths, and SvelteKit server code uses request-scoped \`fetch\`.`

	const sections: string[] = []

	sections.push(`# Backend

${
	isHono
		? `The public Hono gateway lives at \`apps/api/\`. The shared backend
application/core layer lives at \`packages/backend/\`. Independently deployable
transport/runtime adapters live under \`services/<service>/\`, each with its own
dependencies, bindings, and runtime entry. They may import the application modules
they need from \`@repo/backend\`.`
		: `Backend logic lives in SvelteKit endpoints (\`+server.ts\`, \`+page.server.ts\`)
inside \`apps/web/\`. A single deployable unit.`
}`)

	if (isHono) {
		sections.push(`## Gateway boundary

- \`apps/api/\` owns every public API route. Private workers live under
  \`services/<service>/\` and are not browser or web dependencies.
${gatewayConsumer} On Cloudflare, the web Worker's \`GATEWAY\` Service Binding carries SSR requests.
  Node and Docker use the private gateway URL.
- Only the gateway calls private services for public API work. A private service
  calls another private service directly for an internal domain flow.
- Keep the gateway limited to ingress, routing, operational middleware, OpenAPI
  delivery, and transparent forwarding. It does not import application use cases
  or orchestrate business workflows.
- Never import a service app into the gateway. Forward requests through the
  explicit target transport instead.
- Never send an internal service call through the gateway. Use a direct private
  binding or private URL.${cfg.choices.auth.length > 0 ? ' For private session resolution, use `@repo/backend/middleware/auth`; that shared middleware owns the direct transport.' : ''}
- Never combine credentials with a wildcard CORS origin. Use an explicit origin
  allowlist and reject unknown origins.`)
	}

	sections.push(`## Errors: \`HttpError\` + factory

All HTTP errors flow through a single \`HttpError\` class plus a small factory
exported from \`@repo/backend/helpers\`:

\`\`\`ts
import { errors } from '@repo/backend/helpers'

throw errors.notFound('user not found')
throw errors.badRequest('Invalid email')
throw errors.unauthorized()
\`\`\`

Handlers catch \`HttpError\` once at the boundary and serialize. **Never throw
plain \`Error\` from a handler** — always go through the factory so the response
shape stays consistent.`)

	if (isCfWorkers || isHono) {
		const envGuidance = isHono
			? `- **\`Env\` is generated from Wrangler config**, never hand-written. Clean scaffolds use
  \`worker-configuration.bootstrap.d.ts\`; run \`pnpm cf-typegen\` to replace it with
  Wrangler's \`worker-configuration.d.ts\`, and rerun after editing \`wrangler.jsonc\`.`
			: `- Keep the \`App.Platform.env\` declaration in \`apps/web/src/app.d.ts\`
  aligned with \`apps/web/wrangler.jsonc\`.`
		sections.push(`## Cloudflare Workers runtime

- **No Node primitives.** No \`fs\`, no \`path\`, no \`process.env\`, no \`Buffer\`.
  Use \`Web Crypto\`, \`fetch\`, \`Response\`, \`Request\`, \`URL\`.
${envGuidance}
- **Wrangler config is always \`wrangler.jsonc\`** — never \`wrangler.toml\`.
${
	isHono
		? `- **Bindings are explicit.** D1, KV, R2, secrets, and inter-Worker bindings are
  declared per deployable in its own \`wrangler.jsonc\`.`
		: `- **Bindings are explicit.** D1, KV, R2, and secrets used by SvelteKit endpoints are
  declared in \`apps/web/wrangler.jsonc\`.`
}`)
	}

	if (isHono) {
		sections.push(`## Domain layering — \`packages/backend/src/core/\`

The shared backend application/core layer is split into **data-access** and **use-cases**.

**Data access (\`core/data-access/**\`)**
- Pure drizzle. No \`throw\`, no domain errors, no HTTP concerns.
- \`null\` for "not found"; never throw.
- The \`Db\` type is concrete; no \`as any\` / \`AnyDb\` casts.
- Don't re-export \`typeof table.$inferSelect\`. Let TypeScript propagate.
- ID types (e.g. \`UserId\`) come from \`@repo/backend/core/types\` — accept them as parameters; never re-derive at the call site.

**Use cases (\`core/use-cases/**\`)**
- Coordinate one or more DAO calls; throw \`HttpError\` via \`errors.*\` from \`@repo/backend/helpers\`.
- Never reach into HTTP. No \`Request\`, \`Response\`, \`c.json\`, no \`Context\`.
- Don't import transport middleware into core use cases — that's a layering break.

**Both layers**
- 1–2 args → positional. 3+ → named bag.
- Inline single-statement bodies. No verbose JSDoc.`)
	}

	sections.push(`## What NOT to do

- No \`as any\` in worker code
- No Node \`fs\`/\`path\`/\`process\`/\`Buffer\` in worker code paths${isHono && cfg.choices.auth.length > 0 ? '\n- No Better Auth configuration outside of `' + AUTH_SERVICE.workspacePath + '/src/auth.ts`' : ''}${isHono && cfg.choices.auth.length === 0 ? '\n- No public auth methods while no authentication provider is selected' : ''}
- No hand-written \`Env\` interface — let wrangler generate it
- No \`wrangler.toml\` — \`wrangler.jsonc\` only`)

	return sections.join('\n\n') + '\n'
}

/* ------------------------------------------------------------------ */
/*  .ai/rules/db-drizzle.md                                            */
/* ------------------------------------------------------------------ */

export function renderDbRule(cfg: GvKitConfig): string {
	const isCfWorkers = cfg.choices.deploy === 'cf-workers'
	const isPostgres = cfg.choices.db === 'postgres'

	const driverDescription = isPostgres
		? isCfWorkers
			? 'Neon Postgres (`postgres.js` + `drizzle-orm/postgres-js`)'
			: 'PostgreSQL via `postgres.js` + `drizzle-orm/postgres-js`'
		: isCfWorkers
			? 'SQLite via Cloudflare D1 (`drizzle-orm/d1`)'
			: 'Local SQLite via `better-sqlite3` + `drizzle-orm/better-sqlite3`'

	const migrationCmds =
		isCfWorkers && !isPostgres
			? `## Migration safety (Cloudflare D1)

\`drizzle-kit\` only emits SQL — \`wrangler\` applies migrations:

\`\`\`bash
pnpm --filter @repo/db drizzle-kit generate       # 1. emit SQL into migrations/
wrangler d1 migrations apply <database> --local   # 2. apply to local D1
wrangler d1 migrations apply <database> --remote  # 3. apply to remote D1
\`\`\`

Each step is reviewable in isolation. Do NOT skip the \`generate\` step.`
			: isCfWorkers && isPostgres
				? `## Migration safety (Neon Postgres)

\`\`\`bash
pnpm --filter @repo/db drizzle-kit generate   # 1. emit SQL
DATABASE_URL=<neon-url> pnpm --filter @repo/db db:migrate:production
\`\`\`

Production uses the production Neon connection string. PR previews should use a
Neon branch connection string and must never run against production.`
				: `## Migration safety

\`\`\`bash
pnpm --filter @repo/db drizzle-kit generate   # 1. emit SQL
pnpm --filter @repo/db migrate                # 2. apply
\`\`\`

Generate first, review the diff, then apply. Never apply without reviewing.`

	return `# Database

This project uses **${driverDescription}**.

\`packages/db/\` is the only entry point — schema, migrations, and the
\`createDb(env)\` factory live there. The factory is **deploy-aware**:
the same import gives you the right driver for the runtime.

## Schema location

\`packages/db/src/schema/\`:

- \`sample.ts\` — example table to extend or replace
${cfg.choices.auth.length > 0 ? '- `auth.ts` — better-auth tables (`user`, `session`, `account`, `verification`)\n' : ''}
Each new domain gets its own file under \`schema/\`, re-exported from
\`schema/index.ts\`.

## Conventions

- IDs: \`text('id').primaryKey()\` (matches better-auth)
- Timestamps: ${isPostgres ? '`timestamp({ withTimezone: true })`' : "`integer({ mode: 'timestamp' })`"}
- Foreign keys: \`.references(() => table.id, { onDelete: 'cascade' })\` is the default
- Drizzle-zod schemas (\`createInsertSchema\`, \`createSelectSchema\`) live next to the table they describe

${migrationCmds}

## Boundary

- \`packages/db\` does NOT contain application business logic
- ${
		cfg.choices.backend === 'hono'
			? cfg.choices.auth.length > 0
				? `Better Auth configuration and secrets stay private to \`${AUTH_SERVICE.workspacePath}/\`. Reusable data access and use cases belong in \`packages/backend/\`, including the generated users data access that reads \`authSchema.user\` for domain use cases. Service adapters invoke shared application modules instead of embedding ad hoc database queries. Private session resolution must use \`@repo/backend/middleware/auth\`; that middleware owns the deployment-aware auth transport.`
				: 'No authentication schema is generated without a selected provider. Reusable data access and use cases belong in `packages/backend/`, and service adapters invoke those modules instead of embedding ad hoc queries.'
			: 'SvelteKit server handlers in `apps/web/` use the public `@repo/db` entry point directly.'
	}
`
}

/* ------------------------------------------------------------------ */
/*  .ai/rules/email-templates.md                                       */
/* ------------------------------------------------------------------ */

export function renderEmailRule(cfg: GvKitConfig): string {
	if (cfg.choices.email === 'notifuse') return renderNotifuseEmailRule(cfg)
	return renderResendEmailRule(cfg)
}

function renderNotifuseEmailRule(cfg: GvKitConfig): string {
	const usesOtp = cfg.choices.auth.includes('emailOTP')

	const otpBlock = usesOtp
		? `## OTP template

Sign-in verification codes use the \`otp-login\` notification:

\`\`\`ts
await mailer.send({
	to: user.email,
	template: 'otp-login',
	data: { code: '123456', expiry_minutes: 10 }
})
\`\`\`

The MJML body in Notifuse should reference \`{{ code }}\` and
\`{{ expiry_minutes }}\`. Keep variable names snake_case to match Notifuse's
overall API style.

`
		: ''

	const localeBlock = usesOtp
		? `## Locale

Pass \`language\` on \`to\` (e.g. \`to: { email, language: 'it' }\`) — Notifuse
uses \`contact.language\` to pick the right localized template variant when
the notification has multiple languages configured. If the workspace only
has English templates, the field is harmless.

\`${AUTH_SERVICE.workspacePath}\` resolves the locale from request headers via
\`pickLocale(...)\` and forwards it through \`to.language\`.

`
		: `## Locale

Pass \`language\` on \`to\` (e.g. \`to: { email, language: 'it' }\`) when the
Notifuse workspace has multiple localized template variants.

`

	return `# Email

Templates are authored and stored **inside Notifuse**, not in this repo.
The Notifuse console (\`Transactional notifications\`) owns the template ID,
the channel routing, the MJML body, and the Liquid variables. The
\`@repo/mailer\` package is a thin RPC client over \`POST /api/transactional.send\`
on the self-hosted instance — it knows about IDs and \`data\`, never about HTML.

## Sending mail

\`\`\`ts
import { createMailer } from '@repo/mailer'

const mailer = createMailer({
	apiKey: env.NOTIFUSE_API_KEY,
	workspaceId: env.NOTIFUSE_WORKSPACE_ID,
	baseUrl: env.NOTIFUSE_BASE_URL
})

await mailer.send({
	to: { email: 'ada@example.com', language: 'en' },
	template: 'welcome',
	data: { name: 'Ada' }
})
\`\`\`

\`template\` is the **transactional notification ID** configured in Notifuse.
\`data\` is the bag of Liquid variables the template references. \`to\` accepts
either a \`Contact\` object or a bare email string (shorthand for \`{ email }\`).

${otpBlock}${localeBlock}## Adding a new template

1. In the Notifuse console open \`Transactional notifications\` and create a
   new entry. Pick an ID (kebab-case, stable — it's what the code passes as
   \`template\`).
2. Add an \`email\` channel template. Author the MJML/Liquid body; reference
   the variables your code will pass in \`data\` as \`{{ var_name }}\`.
3. Test from the console with \`Send test\` before wiring it into code.
4. Add the call site:

\`\`\`ts
await mailer.send({
	to: recipient.email,
	template: 'my-new-notification',
	data: { ...vars }
})
\`\`\`

No code or migration changes are needed — adding a template is a console-only
operation.

## Constraints

- \`data\` keys must match what the Liquid template references. There is no
  compile-time check; a typo silently renders an empty value.
- \`from\` address and \`from_name\` defaults are set per-workspace inside
  Notifuse. Override per-send via \`email_options.from_name\` if you need a
  campaign-specific identity.
- The mailer always sends through the \`email\` channel only. If a
  transactional notification needs to fan out to SMS or push, pass an
  explicit \`channels\` array on the call site (extend the client first).
- Sends are idempotent when an \`external_id\` is provided — re-using the same
  ID is a no-op. Use this for retries from queues or workers.
`
}

function renderResendEmailRule(cfg: GvKitConfig): string {
	const usesParaglide = cfg.choices.i18n === 'paraglide'
	const usesOtp = cfg.choices.auth.includes('emailOTP')

	const localeBlock = usesParaglide
		? `## Locale flow

Templates take a \`locale\` prop (typed as \`Locale\` from \`@repo/i18n/runtime\`) and call \`m.<key>({}, { locale })\` to translate. Pass the recipient's locale explicitly — do NOT rely on \`setLocale()\` because the mailer often runs outside a request context (queue consumers, scheduled jobs).

\`\`\`ts
await mailer.sendTemplate({
	from: 'noreply@example.com',
	to: 'ada@example.com',
	template: 'welcome',
	data: { name: 'Ada', locale: 'it' }
})
\`\`\`
`
		: `## Locale

i18n is not wired in this project. Templates use static strings; \`Locale\` is fixed to \`'en'\` for type-shape consistency.
`

	const otpBlock = usesOtp
		? `## OTP template

Sign-in verification codes use \`otp-login.tsx\`:

\`\`\`ts
await mailer.sendTemplate({
	from: 'noreply@example.com',
	to: user.email,
	template: 'otp',
	data: { code: '123456', expiryMinutes: 10${usesParaglide ? `, locale: user.locale` : ''} }
})
\`\`\`
`
		: ''

	return `# Email

Templates live in \`packages/mailer/src/templates/<name>.tsx\` (react-email v6 unified imports). Every template is wrapped by a shared \`_shared/Layout.tsx\` that provides the Tailwind context, container, and a logo placeholder.

Provider in this project: **resend**.

## Anatomy of a template

Each template module exports two things:

\`\`\`tsx
// templates/welcome.tsx
export type WelcomeProps = BaseTemplateProps & { name: string }

export default function WelcomeEmail(props: WelcomeProps) {
	return <Layout preview="…">…</Layout>
}

export const subject = (props: WelcomeProps): string => \`Welcome, \${props.name}\`
\`\`\`

The \`subject\` export is either a function \`(props) => string\` or a literal \`string\`. \`renderTemplate\` returns \`{ html, text, subject }\` — all three come from the template, no separate metadata file.

## Sending mail

Bind the env once with \`createMailer\` and use \`mailer.sendTemplate\` for the common case — it composes \`renderTemplate\` and \`send\` and types \`data\` based on the chosen \`template\`:

\`\`\`ts
import { createMailer } from '@repo/mailer'

const mailer = createMailer(apiKey)

await mailer.sendTemplate({
	from: 'noreply@example.com',
	to: 'ada@example.com',
	template: 'welcome',
	data: { name: 'Ada'${usesParaglide ? `, locale: 'en'` : ''} }
	// subject?: 'Override the template subject' (optional)
})
\`\`\`

The template's \`subject\` is used unless \`subject\` is explicitly passed.

For low-level needs (custom transport, batching, multipart attachments) drop down to \`mailer.send\` + \`renderTemplate\` directly.

${localeBlock}${otpBlock}
## Adding a new template

1. Create \`templates/<name>.tsx\`. Use \`Layout\` for the chrome.
2. Export \`default\` (the component) and \`const subject\` (string or function).
3. Add an entry to \`templates/index.ts\` registry: \`{ Body: <Mod>.default, subject: <Mod>.subject }\`.
4. \`mailer.sendTemplate\` automatically narrows the new template's \`data\` shape — no extra wiring.

## Constraints

- NO Node primitives in template files (mailer runs on Workers too). Use \`fetch\`, \`Web Crypto\`, plain JSX.
- Tailwind classes only (no inline \`style={…}\`). \`<Tailwind>\` wrapper in \`Layout\` handles inlining at render time.
- For images, use \`<Img src="…" alt="…" />\` from \`react-email\` with absolute URLs (mail clients won't resolve relative paths). The brand-logo slot in \`Layout\` is currently a placeholder — replace with your hosted logo URL.
`
}
