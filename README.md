# gv-kit

Scaffolding CLI for full-stack product monorepos. Pick your project shape and stack, answer prompts, and get a project that compiles, tests, and deploys.

## Quickstart

Create a project with the default Hono backend:

```bash
npx gv-kit new my-app
cd my-app
```

For the default Hono scaffold, use the generated local setup sequence. The generated command handles target-specific database preparation.

### First run

```bash
pnpm install
cp .env.example .env
# Fill the required values in .env.
pnpm local:prepare
pnpm dev
```

### Subsequent runs

```bash
pnpm dev
```

If you select `backend=inside-frontend`, follow its generated README instead. That topology does not use `pnpm local:prepare`.

## Reproduce a generated project

Every generated project includes `project.config.jsonc`, which records its validated choices. Pass that file back to `--config` and choose a new output directory:

```bash
npx gv-kit new another-project --config path/to/project.config.jsonc
```

`--config` also continues to accept valid user-authored JSON or JSONC files under any filename.

## What you get

A Turborepo monorepo with:

- **`apps/marketing`** — static-first Astro marketing site at the apex (recommended project shape)
- **`apps/web`** — SvelteKit (Svelte 5 runes, Tailwind 4) on your chosen runtime
- **`apps/api`** — public Hono API gateway when `backend=hono`
- **`services/auth`** + **`services/users`** — independently deployable private Hono Workers
- **`packages/backend`** — shared backend application/core layer for reusable data access, use cases, types, helpers, and middleware
- **`packages/db`** — Drizzle (Postgres or SQLite, deploy-aware driver)
- **`packages/i18n`** — Paraglide v2 (optional)
- **`packages/openapi-client`** — one flat Hey API client generated from the composed gateway contract + TanStack Query (optional)
- **`packages/mailer`** — Resend or Notifuse adapter (optional)
- **`.claude/`** + **`AGENTS.md`** — AI tooling, multi-select between Claude / Codex / Opencode

## Decision tree

| Choice | Options | Default |
|---|---|---|
| `name` | kebab-case | (required) |
| `frontend` | `sveltekit` | sveltekit |
| `marketing` | `astro` (separate marketing + app) / `inside-web` (integrated) | astro |
| `backend` | `hono` (public gateway + private services) / `inside-frontend` (one Worker) | hono |
| `i18n` | `paraglide` / `skip` | skip |
| `monitoring` | multi: `umami`, `posthog` | [] |
| `db` | `postgres` / `sqlite` | sqlite |
| `apiClient` | `hey-api` / `skip` (must be `skip` if backend is `inside-frontend`) | skip |
| `auth` | multi: `emailOTP`, `google` | [] |
| `email` | `resend` / `notifuse` / `skip` | skip |
| `aiTooling` | multi: `claude`, `codex`, `opencode` | [] |
| `deploy` | `cf-workers` / `docker` / `skip` | skip |

## Stack matrix

| Layer | Pin |
|---|---|
| Node | `>=24.0.0 <25.0.0` |
| pnpm | `@11.1.1` (pinned via `packageManager`) |
| TypeScript | `~5.9.0` |
| Astro | `^7.1.1` |
| `@astrojs/svelte` | `^9.0.1` |
| `@astrojs/sitemap` | `^3.7.3` |
| Zod | `^4.3.0` (workspace `overrides`) |
| Hono | `^4.12.0` |
| `@hono/zod-openapi` | `^1.3.0` |
| Drizzle ORM | `^0.45.0` |
| `drizzle-zod` | `^0.8.3` |
| better-auth | `^1.6.0` |
| `@hey-api/openapi-ts` | `^0.97.3` |
| `@hey-api/client-fetch` | `^0.13.1` |
| `@tanstack/svelte-query` | `^6.1.33` |
| SvelteKit | `^2.58.0` |
| Svelte | `^5.56.6` |
| Vite | `^8.0.0` |
| `@sveltejs/vite-plugin-svelte` | `^7.0.0` |
| Tailwind | `^4.3.3` (`@theme` only, no JS config) |
| `@inlang/paraglide-js` | `^2.17.0` (no `paraglide-sveltekit`) |
| Wrangler | `^4.112.0` (always `wrangler.jsonc`) |
| Turbo | `^2.9.0` |
| Changesets | `^2.31.0` |

## Architecture

User answers prompts → choices validated by Zod → pure generators emit `FileEntry[]` → user confirms → files written + `pnpm install` + `git init`.

Pipeline stages: `collect` → `validate` → `plan` → `confirm` → `execute`. Generators are pure functions `(config) => FileEntry[]`. No I/O inside generators.

### Project shapes

The recommended `marketing=astro` shape keeps the public site and application separate:

```text
apps/marketing  Astro static site  https://<domain>
apps/web        SvelteKit app      https://app.<domain>
```

Astro owns the homepage, canonical metadata, robots, localized sitemap, and 404. Its CTA reads the complete build-time `PUBLIC_APP_URL`; it does not inspect auth or derive a hostname. When app auth is selected, anonymous visits to the SvelteKit root go to `/login` and authenticated visits go to `/me`.

The `marketing=inside-web` shape retains the previous single-SvelteKit topology, with its public page and application together at the apex. Existing v1 configs migrate to this shape. New configs are strict v2, so older CLIs cannot silently ignore the topology choice.

Astro remains static-first on both supported deploy targets: Workers Static Assets serves `dist/` directly, while Docker serves the same output from an unprivileged nginx runtime. Local defaults are marketing on `http://localhost:4321` and the app on `http://localhost:5173` (or `:3000` under Compose).

### Gateway and service boundary (when `backend=hono`)

`packages/backend/` is the shared backend application/core layer for reusable data access, use cases, types, helpers, and middleware. Independently deployable packages under `services/` are transport/runtime adapters and may import the application modules they need from `@repo/backend`.

Better Auth configuration and secrets stay private to `services/auth/`. `packages/backend/` owns reusable data access and use cases, including the generated users data access that reads `authSchema.user` for domain use cases. `services/users/` invokes that shared users use case as a transport/runtime adapter; it does not gain access to Better Auth secrets or permission to embed ad hoc database queries.

`apps/api/` is the only public Hono API application. It handles ingress, routing, operational middleware, OpenAPI delivery, and transparent forwarding. It does not import application use cases or orchestrate business workflows. Both ingress paths reach it without changing paths:

- the web origin's same-origin `/api/*` alias for browser traffic
- the canonical API origin for integrations and independent clients

Better Auth stays at `/api/auth/*`. Domain routes are versioned under `/api/v1/*`. Gateway liveness and the composed runtime contract stay at `/api/healthz` and `/api/openapi.json`.

SvelteKit SSR uses a request-scoped gateway transport. Cloudflare uses the web Worker's `GATEWAY` Service Binding. Node and Docker use private `GATEWAY_URL`. SSR never calls auth or a domain service directly.

`services/auth/` is the **only** Worker that:
- holds `BETTER_AUTH_SECRET` and OAuth secrets
- configures Better Auth directly in `services/auth/src/auth.ts`
- owns `/api/auth/*` and the private `/internal/session` endpoint

`services/users/` and any future domain service:
- have no public production route
- declare only required private bindings, such as `AUTH` for session resolution
- use the deploy-aware `@repo/backend/middleware/auth` transport for `/internal/session`
- never configure Better Auth, read auth secrets, or embed ad hoc database queries in the transport adapter
- own deterministic OpenAPI fragments consumed by gateway composition

Each domain service owns a deterministic OpenAPI fragment. The gateway composes those fragments into `apps/api/openapi.json`, the only Hey API input. Browser domain calls import flat operations from `@repo/openapi-client` and use same-origin `/api` and `/api/*`. Better Auth keeps its own client.

Private services call one another directly through Service Bindings or private URLs. They never route internal calls back through the gateway. Cloudflare private services have no route, workers.dev hostname, or production preview URL. Docker private services have no host ports. Local direct ports are loopback-only debugging tools.

Deployments run preview-ingress validation, database migration, private services, gateway, then web. Cloudflare Hono previews use PR-scoped hosts under `CLOUDFLARE_PREVIEW_WEB_DOMAIN` and `CLOUDFLARE_PREVIEW_API_DOMAIN`. Shared proxied wildcard DNS records must already exist in `CLOUDFLARE_PREVIEW_ZONE_NAME`; the workflow verifies them before provisioning. The gateway owns the canonical API route plus the more-specific web `/api` and `/api/*` routes, while the web Worker owns the less-specific web route. Cleanup deletes PR Workers and their routes without deleting shared wildcard DNS.

### Inside-frontend mode

When `backend=inside-frontend`, the SvelteKit application is the only deployable unit and server endpoints live under `apps/web`. Authentication choices are Hono-only, so this topology emits neither `services/auth` nor private auth transport guidance.

## Commands

```bash
bun run dev               # run CLI from source
bun run build             # bundle to dist/cli.js
bun test                  # schema + plan-snapshot + contract tests
bun run snap              # regenerate snapshots (UPDATE_SNAPSHOTS=1)
bun run typecheck         # tsc --noEmit
bun run lint              # eslint
```

## Hono migration

Existing generated Hono repositories require manual changes for this breaking topology. See [the Hono API gateway migration guide](./docs/migrations/hono-api-gateway.md). No automatic source migration is provided.

## Contributing

1. Add or change a fixture under `fixtures/`
2. `bun run snap` to regenerate snapshots
3. Inspect the diff carefully — snapshots are intentional
4. Commit fixture + snapshot together
5. `bun changeset add` to record the change

## License

MIT — see [LICENSE](./LICENSE).
