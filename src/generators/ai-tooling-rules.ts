import type { FileEntry } from '../lib/files.js'
import { renderTemplate } from '../lib/template-renderer.js'
import type { GvKitConfig } from '../schema/config.js'

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

	if (cfg.choices.email !== 'skip')
		entries.push({ path: '.ai/rules/email-templates.md', content: renderEmailRule(cfg) })

	const fixtureRules = renderTemplate({
		tree: 'root',
		flags: {
			auth: cfg.choices.auth.length > 0,
			cfWorkers: cfg.choices.deploy === 'cf-workers',
			effectBackend: cfg.choices.backendRuntime === 'effect',
			hono: cfg.choices.backend === 'hono',
			i18nParaglide: cfg.choices.i18n === 'paraglide',
			apiClientHeyApi: cfg.choices.apiClient === 'hey-api'
		},
		vars: { __PROJECT__: cfg.choices.name }
	})
	entries.push(...fixtureRules.filter((e) => e.path.startsWith('.ai/rules/')))

	return entries
}

/* ------------------------------------------------------------------ */
/*  .ai/rules/core-stack.md                                            */
/* ------------------------------------------------------------------ */

export function renderCoreStackRule(cfg: GvKitConfig): string {
	if (cfg.choices.backend !== 'hono')
		return `# Stack

This project deploys as a **single SvelteKit unit**. There is no \`apps/api/\`,
no service bindings, no inter-service \`fetch\`.

## Layout

- \`apps/web/\` — SvelteKit app, contains all HTTP entry points
- \`packages/db/\` — Drizzle schema + client factory (\`createDb(env)\`)
${cfg.choices.backendRuntime === 'effect' ? '- `packages/backend/` — horizontal Effect/Hono runners and logger' : '- `packages/backend/` — shared helpers (logger, error helpers, middleware)'}
${cfg.choices.i18n === 'paraglide' ? '- `packages/i18n/` — Paraglide messages\n' : ''}

## Request lifecycle

1. Browser hits a SvelteKit route (\`+page.server.ts\` or \`+server.ts\`).
2. Server-side handlers may call \`createAuth\` from \`@repo/backend/auth\` and
   query \`@repo/db\` directly. There is no separate API surface.
3. Responses go back through SvelteKit's response pipeline.

## Service boundary policy

Even without a separate \`apps/api/\`, treat \`+server.ts\` files as the
service boundary. Keep cross-domain imports out of unrelated route folders so
a future split into Hono workers stays cheap.

- All HTTP entry points are SvelteKit handlers (\`+server.ts\` / \`+page.server.ts\`)
- \`packages/db\` is the sole DB consumer entry point
- \`packages/backend\` holds horizontal helpers only — no domain logic
`

	return `# Stack

\`apps/api/\` is a CONTAINER of independently deployable Hono workers. Each
subdirectory under \`apps/api/\` is its own Worker with its own
\`wrangler.jsonc\` and bindings.

## Layout

- \`apps/web/\` — SvelteKit app
- \`apps/api/<service>/\` — independently deployable Hono workers (e.g. \`auth\`, \`users\`)
- \`packages/db/\` — Drizzle schema + client factory
${cfg.choices.backendRuntime === 'effect' ? '- `packages/backend/` — horizontal Effect/Hono runners and logger ONLY' : '- `packages/backend/` — horizontal helpers (logger, error helpers, middleware) ONLY'}
${cfg.choices.i18n === 'paraglide' ? '- `packages/i18n/` — Paraglide messages\n' : ''}${cfg.choices.apiClient === 'hey-api' ? '- `packages/openapi-client/` — generated TS clients per service\n' : ''}

## Request lifecycle

1. Browser hits the SvelteKit app (\`apps/web/\`).
2. SvelteKit calls a service via the appropriate URL/binding.
3. The service handles the request entirely on its own. Cross-service calls
   go through inline \`fetch\` (~10 LOC) or CF service bindings — never a
   shared SDK package.

## Service boundary policy (CRITICAL)

- **Auth is a service.** Served EXCLUSIVELY by \`apps/api/auth/\`. No other
  service exposes auth endpoints.
- **Inter-service calls = inline \`fetch\`.** Each consumer keeps a local
  ~10 LOC client (e.g. ${cfg.choices.backendRuntime === 'effect' ? '`apps/api/users/src/infrastructure/auth-client.ts`' : '`apps/api/users/src/lib/auth-client.ts`'}) that wraps
  \`fetch\` against the auth Worker via a CF service binding. **Do NOT extract
  a shared SDK package.**
- **No cross-service infra in \`packages/backend\`.** That package is reserved
  for truly horizontal concerns. Auth state, billing state, RBAC live with
  their owning service.
- **Bindings are explicit per service.** Each service declares its own
  \`wrangler.jsonc\` with its own bindings (D1, KV, R2, secrets, service
  bindings). No shared \`env\` blob.

## Forbidden patterns

${cfg.choices.backendRuntime === 'effect' ? '- Non-auth services importing auth implementation details' : '- `apps/api/users/` importing from `@repo/backend/auth`'}
- \`apps/api/users/\` reading \`BETTER_AUTH_SECRET\`
- Any service other than \`apps/api/auth/\` querying \`user\`, \`session\`,
  \`account\`, or \`verification\` tables directly
- Adding a \`packages/auth-client/\` or similar shared SDK
`
}

/* ------------------------------------------------------------------ */
/*  .ai/rules/api-backend.md                                           */
/* ------------------------------------------------------------------ */

export function renderBackendRule(cfg: GvKitConfig): string {
	const isCfWorkers = cfg.choices.deploy === 'cf-workers'
	const isHono = cfg.choices.backend === 'hono'
	if (cfg.choices.backendRuntime === 'effect') return renderEffectBackendRule(isCfWorkers)

	const sections: string[] = []

	sections.push(`# Backend

${
	isHono
		? `Hono workers live under \`apps/api/<service>/\`. Each service is its own
deployable Worker with its own dependencies, bindings, and runtime entry.`
		: `Backend logic lives in SvelteKit endpoints (\`+server.ts\`, \`+page.server.ts\`)
inside \`apps/web/\`. A single deployable unit.`
}`)

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

	if (isCfWorkers || isHono)
		sections.push(`## Cloudflare Workers runtime

- **No Node primitives.** No \`fs\`, no \`path\`, no \`process.env\`, no \`Buffer\`.
  Use \`Web Crypto\`, \`fetch\`, \`Response\`, \`Request\`, \`URL\`.
- **\`Env\` is generated by wrangler**, never hand-written. Run
  \`pnpm cf-typegen\` after editing \`wrangler.jsonc\`.
  Import the generated \`Env\` from \`worker-configuration.d.ts\`.
- **Wrangler config is always \`wrangler.jsonc\`** — never \`wrangler.toml\`.
- **Bindings are explicit.** D1, KV, R2, secrets, service bindings are
  declared per-service in that service's \`wrangler.jsonc\`.`)

	if (isHono)
		sections.push(`## Domain layering — \`packages/backend/src/core/\`

The domain layer is split into **data-access** and **use-cases**.

**Data access (\`core/data-access/**\`)**
- Pure drizzle. No \`throw\`, no domain errors, no HTTP concerns.
- \`null\` for "not found"; never throw.
- The \`Db\` type is concrete; no \`as any\` / \`AnyDb\` casts.
- Don't re-export \`typeof table.$inferSelect\`. Let TypeScript propagate.
- ID types (e.g. \`UserId\`) come from \`@repo/backend/core/types\` — accept them as parameters; never re-derive at the call site.

**Use cases (\`core/use-cases/**\`)**
- Coordinate one or more DAO calls; throw \`HttpError\` via \`errors.*\` from \`@repo/backend/helpers\`.
- Never reach into HTTP. No \`Request\`, \`Response\`, \`c.json\`, no \`Context\`.
- Don't import \`@repo/backend/auth\` or \`@repo/backend/middleware\` — that's a layering break.

**Both layers**
- 1–2 args → positional. 3+ → named bag.
- Inline single-statement bodies. No verbose JSDoc.`)

	sections.push(`## What NOT to do

- No \`as any\` in worker code
- No Node \`fs\`/\`path\`/\`process\`/\`Buffer\` in worker code paths${isHono ? '\n- No \\`@repo/backend/auth\\` import outside of `apps/api/auth/`' : ''}
- No hand-written \`Env\` interface — let wrangler generate it
- No \`wrangler.toml\` — \`wrangler.jsonc\` only`)

	return sections.join('\n\n') + '\n'
}

function renderEffectBackendRule(isCfWorkers: boolean): string {
	const cloudflareSection = isCfWorkers
		? `## Cloudflare request layers

- Treat Worker \`env\`, the incoming \`Request\`, service bindings, D1, and the
  execution context as request-boundary inputs with request-scoped lifetime.
- Build only service layers the workflow consumes, such as \`AuthClient\` and
  \`Database\`. Keep raw \`Request\` and execution-context values in the Hono
  adapter until cancellation or background-work semantics justify a service;
  do not invent \`IncomingRequest\` or \`WorkerContext\` tags just to wrap them.
- Keep bindings visible at this adapter boundary. Do not route D1, R2, KV,
  service bindings, or the execution context through Effect \`Config\`.
- Wrangler generates \`worker-configuration.d.ts\`; never edit that file.
  Each service owns a hand-edited \`env.d.ts\` augmentation for its local
  bindings and secrets. After changing \`wrangler.jsonc\` or \`env.d.ts\`, run
  \`pnpm cf-typegen\` and keep the two declarations compatible. Never replace
  \`wrangler.jsonc\` with TOML.`
		: `## Request layers

Build only service layers the workflow consumes from request-boundary inputs.
Keep raw request/runtime values and concrete clients at the Hono adapter rather
than inventing wrapper tags or capturing them inside application workflows.`

	return `# Backend: Hono + Effect

Each \`apps/api/<service>/\` directory is an independently deployable Hono
service. Hono owns routing and the HTTP adapter: request validation, layer
construction, response serialization, and status codes. Effect programs own
application workflows and compose typed service failures. Do not put Hono
\`Context\`, \`Request\`, \`Response\`, or HTTP status codes inside workflows.
This runtime is scoped to \`backend=hono\`; \`backend=inside-frontend\` remains
Promise/Zod. Svelte UI code is outside this backend architecture unless a
separate frontend runtime is explicitly adopted.

## HTTP failure boundary

- Model expected failures as typed Effect errors.
- Map those errors to declared JSON responses in each route with
  \`runEffectJson({ c, program, onSuccess, onFailure })\`; the shared runner is generic
  and does not own a central status switch.
- Use \`effectValidationHook\` for validator failures so runtime responses match
  the declared error schema.
- Treat defects and interruptions as unexpected. Log the full Effect \`Cause\`
  server-side, return only the generic declared JSON error, and never expose
  causes, stack traces, provider responses, or secrets to clients.

## Runtime OpenAPI is the client contract

Effect Schema is the backend boundary schema. Bridge it with
\`Schema.standardSchemaV1\`, register validators and explicit responses with
\`hono-openapi\`, and expose the assembled Hono app through \`/openapi.json\`.
That runtime document is the canonical input for Hey API; do not maintain a
second handwritten client contract. After changing a route or schema, run
the users API and then \`pnpm client:generate\`. It reads \`OPENAPI_URL\`, which
defaults to \`http://localhost:8788/openapi.json\`; use a reachable staging URL
when appropriate. Do not materialize a second OpenAPI file.
- Response schemas are explicit and must remain Hey
  API compatible. Before adding an Effect Schema shape that could break
  generated \`$ref\` or \`components\`, extend the OpenAPI validation and
  generated-client consumer tests.

## Service-local workflows and layers

- In the users service, the \`me\` route contract, handler, workflow, and tests
  live together under \`apps/api/users/src/features/me/\`. \`AuthClient\` and
  \`Database\` are concrete adapters under \`src/infrastructure/\`. The Hono
  handler builds their request layers from \`c.env\` and \`c.req.raw\`, then
  provides them to the workflow.
- Keep every inter-service client local to its consumer. The users-local auth
  client calls \`/internal/session\` and Schema-decodes successful payloads
  before application logic sees them.
- Better Auth translation stays inside \`apps/api/auth\` through its local
  \`AuthSessionService\`; do not move auth state or translation into a shared
  backend package.
- When email OTP is enabled, the auth-owned OTP workflow consumes
  \`MailerService\` from \`@repo/mailer/effect\`. The Better Auth adapter provides
  \`MailerLive\`, logs typed delivery failures safely, and exposes only its
  generic boundary error. Provider construction remains in \`packages/mailer\`.
- \`packages/backend\` contains horizontal Effect/Hono helpers only. Domain
  clients, database workflows, auth translation, and mailer workflows stay
  with the service that owns or consumes them.

${cloudflareSection}

## What not to do

- No \`as any\` in worker code.
- No Node \`fs\`/\`path\`/\`process\`/\`Buffer\` in worker code paths.
- No shared cross-service auth client or domain infrastructure package.
- No concrete database or auth client captured inside an Effect workflow.
- No central error-to-status mapping in \`packages/backend\`.
- No HTTP-shaped error objects or status codes inside domain use-cases.
- Do not replace the Hono adapter with Effect \`HttpApi\` or add a parallel
  Effect HTTP contract.
- Do not mix \`@hono/effect-validator\` into documented routes; use the Effect
  Schema Standard Schema bridge and \`hono-openapi\` path above.
- Do not change the default Promise/Zod generated output while working on
  Effect mode.
- In Cloudflare Workflows, keep \`step.do\`, \`step.sleep\`, and
  \`step.waitForEvent\` as visible durable boundaries. Run Effect inside each
  step; do not hide the Workflow model behind opaque wrappers.
`
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

${cfg.choices.backendRuntime === 'effect' ? '' : '- `sample.ts` — example table to extend or replace'}
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

- \`packages/db\` does NOT contain auth business logic
- ${cfg.choices.backend === 'hono' ? 'Only `apps/api/auth/` queries the auth tables. Other services that need session data go through `/internal/session`.' : 'Auth tables are queried by the auth handler in `apps/web/`. Other route handlers should use the resolved session from `locals`.'}
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

\`apps/api/auth\` resolves the locale from request headers via
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
