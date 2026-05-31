# gv-kit

Scaffolding CLI for full-stack Turborepo monorepos. Pick your stack, answer prompts, get a project that compiles, tests, and deploys.

## Quickstart

```bash
npx gv-kit new my-app
cd my-app
pnpm install
pnpm dev
```

## What you get

A Turborepo monorepo with:

- **`apps/web`** — SvelteKit (Svelte 5 runes, Tailwind 4) on your chosen runtime
- **`apps/api/auth`** + **`apps/api/users`** — independent Hono Workers (services container) when `backend=hono`
- **`packages/backend`** — primitives only: `core`, `auth` factory, `helpers`, plus `middleware` for hono mode
- **`packages/db`** — Drizzle (Postgres or SQLite, deploy-aware driver)
- **`packages/i18n`** — Paraglide v2 (optional)
- **`packages/openapi-client`** — Hey API per-service codegen + TanStack Query (optional)
- **`packages/mailer`** — Resend or Notifuse adapter (optional)
- **`.claude/`** + **`AGENTS.md`** — AI tooling, multi-select between Claude / Codex / Opencode

## Decision tree

| Choice | Options | Default |
|---|---|---|
| `name` | kebab-case | (required) |
| `frontend` | `sveltekit` | sveltekit |
| `backend` | `hono` (services container) / `inside-frontend` (one Worker) | hono |
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
| Node | `>=20` |
| pnpm | `@11.1.1` (pinned via `packageManager`) |
| TypeScript | `~5.9.0` |
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
| Svelte | `^5.55.0` |
| Vite | `^8.0.0` |
| `@sveltejs/vite-plugin-svelte` | `^7.0.0` |
| Tailwind | `^4.2.0` (`@theme` only, no JS config) |
| `@inlang/paraglide-js` | `^2.17.0` (no `paraglide-sveltekit`) |
| Wrangler | `^4.85.0` (always `wrangler.jsonc`) |
| Turbo | `^2.9.0` |
| Changesets | `^2.31.0` |

## Architecture

User answers prompts → choices validated by Zod → pure generators emit `FileEntry[]` → user confirms → files written + `pnpm install` + `git init`.

Pipeline stages: `collect` → `validate` → `plan` → `confirm` → `execute`. Generators are pure functions `(config) => FileEntry[]`. No I/O inside generators.

### Service boundary (when `backend=hono`)

`apps/api/auth` is the **only** Worker that:
- holds `BETTER_AUTH_SECRET` and OAuth secrets
- imports `@repo/backend/auth`
- exposes `/api/auth/*` (public) and `/internal/session` (binding-only RPC)

`apps/api/users` and any future service:
- declare a CF service binding to `<project>-auth`
- call `/internal/session` via inline ~10 LOC `auth-client.ts`
- never read auth secrets, never query the auth tables

This is a hard boundary — no `service-client` factory in `packages/backend`, no `auth/types` subpath, no shared SDK package.

### Inside-frontend mode

When `backend=inside-frontend`, the SvelteKit Worker is the only deployable surface. Auth, API routes, and the Hono app all live in `apps/web` via `+server.ts`. The same `@repo/backend/auth` factory is consumed directly. One Worker, no cross-Worker secret leakage possible.

## Commands

```bash
bun run dev               # run CLI from source
bun run build             # bundle to dist/cli.js
bun test                  # schema + plan-snapshot + contract tests
bun run snap              # regenerate snapshots (UPDATE_SNAPSHOTS=1)
bun run typecheck         # tsc --noEmit
bun run lint              # eslint
```

## Contributing

1. Add or change a fixture under `fixtures/`
2. `bun run snap` to regenerate snapshots
3. Inspect the diff carefully — snapshots are intentional
4. Commit fixture + snapshot together
5. `bun changeset add` to record the change

## License

MIT — see [LICENSE](./LICENSE).
