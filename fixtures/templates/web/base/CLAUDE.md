# __PROJECT__

SvelteKit web app deployed to Cloudflare Workers.

## Stack

- **Runtime**: Cloudflare Workers via `@sveltejs/adapter-cloudflare`
- **Framework**: SvelteKit 2 + Svelte 5 (runes only)
- **Styling**: Tailwind v4 (`@tailwindcss/vite`) + shadcn-svelte primitives consumed from `@repo/ui`
- **Forms**: `sveltekit-superforms` v2 + `formsnap` v2 + Zod adapter
- **Errors**: `AppError` + `throwAppError` server-side; `neverthrow` `Result<T, AppError>` client-side
- **Dates**: `@internationalized/date` only
- **Tooling**: `pnpm` package manager, Node 24, Prettier, ESLint, TypeScript strict

## API gateway and bindings

<!--@gvkit:if honoGateway-->
`apps/api/` is the public API gateway. Private backend workers live under `services/<service>/` and never become direct web dependencies. Browser calls use same-origin `/api/*` paths.

<!--@gvkit:if apiClientHeyApi-->
The flat `@repo/openapi-client` package consumes the composed gateway contract. Server loads and actions pass SvelteKit's request-scoped `fetch` to that client.
<!--@gvkit:else-->
This workspace has no generated API client package. Server loads and actions use SvelteKit's request-scoped `fetch` for gateway requests.
<!--@gvkit:endif-->
<!--@gvkit:if honoGatewayCfWorkers-->
The web Worker's only backend Service Binding is `GATEWAY`. `handleFetch` sends same-origin SSR API requests through that binding. Do not bind web directly to auth, users, or another private service.
<!--@gvkit:else-->
`handleFetch` sends same-origin SSR API requests to the private `GATEWAY_URL`. Do not call auth, users, or another private service directly.
<!--@gvkit:endif-->
<!--@gvkit:else-->
This app owns its server endpoints. Its deployment configuration declares only the bindings those endpoints use.
<!--@gvkit:endif-->

## Commands

```bash
pnpm install                 # install workspace deps
pnpm dev                     # vite dev on http://localhost:5173
pnpm build                   # SvelteKit + Cloudflare adapter build
pnpm typecheck               # validate committed binding types + svelte-check
pnpm lint                    # prettier --check + eslint
pnpm format                  # prettier --write
pnpm deploy                  # wrangler deploy (production)
pnpm cf-typegen              # replace bootstrap types with Wrangler output after config edits
wrangler tail                # live logs from production
```

## Project conventions

Detailed rules live at the workspace root under `.claude/rules/` (not duplicated here). Web-specific rules are prefixed `web-*`; the rest are cross-cutting.

<!--@gvkit:if i18nParaglide-->
## Internationalization

This app uses Paraglide v2 via `@repo/i18n`. User-facing copy lives in `packages/i18n/messages/<locale>.json` and is consumed as typed message functions (`m.xxx()`).

- Locale resolution: cookie (`PARAGLIDE_LOCALE`) → `Accept-Language` → base locale.
- Per-request isolation: `paraglideMiddleware` in `src/hooks.server.ts` (required on Workers — module-scoped locale would otherwise leak between concurrent requests).
- Adding a string: edit every `messages/<locale>.json`, then re-run `pnpm --filter @repo/i18n build` (or keep `pnpm dev` running for watch mode).
- Locale switcher: `src/lib/components/layout/locale-switcher.svelte` calls Paraglide's `setLocale()` directly (writes the cookie client-side and reloads). No custom server route.

## What this project is NOT

- **No shared dev/prod split.** Single deployment target, demo context.
<!--@gvkit:else-->
## What this project is NOT

- **No i18n.** EN-only. All copy is hardcoded English.
- **No shared dev/prod split.** Single deployment target, demo context.
<!--@gvkit:endif-->
- **No password fields, no `/register`, no `/forgot-password`, no password reset.** Auth (when present) is passwordless: email-OTP and/or social.
- **No "built with" tech badges in user-facing copy.** The README mentions the stack; the marketing surface stays product-first.
- **No primitives under `apps/web/src/lib/components/ui/`.** Primitives live in `@repo/ui` and are imported via `@repo/ui/primitives/<name>`.
- **No Node.js APIs on server code paths** (`fs`, `path`, `node:crypto`, `process.env`). The Worker runtime doesn't ship them.
- **No date library other than `@internationalized/date`.** No `date-fns`, `dayjs`, `moment`, `luxon`.
