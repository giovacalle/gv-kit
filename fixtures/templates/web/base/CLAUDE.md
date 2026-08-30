# __PROJECT__

<!--@gvkit:if deployCfWorkers-->
SvelteKit web app deployed to Cloudflare Workers.
<!--@gvkit:else-->
<!--@gvkit:if honoGatewayDocker-->
SvelteKit web app running on Node.js behind Nginx.
<!--@gvkit:else-->
SvelteKit web app running locally on Node.js.
<!--@gvkit:endif-->
<!--@gvkit:endif-->

## Stack

<!--@gvkit:if deployCfWorkers-->
- **Runtime**: Cloudflare Workers via `@sveltejs/adapter-cloudflare`
<!--@gvkit:else-->
- **Runtime**: Node.js via `@sveltejs/adapter-node`
<!--@gvkit:endif-->
- **Framework**: SvelteKit 2 + Svelte 5 (runes only)
- **Styling**: Tailwind v4 (`@tailwindcss/vite`) + shadcn-svelte primitives consumed from `@repo/ui`
- **Forms**: `sveltekit-superforms` v2 + `formsnap` v2 + Zod adapter
- **Errors**: `AppError` + `throwAppError` server-side; `neverthrow` `Result<T, AppError>` client-side
- **Dates**: `@internationalized/date` only
- **Tooling**: `pnpm` package manager, Node 24, Prettier, ESLint, TypeScript strict

## API gateway and bindings

<!--@gvkit:if honoGateway-->
`apps/api/` is the public API gateway. Private backend services live under `services/<service>/` and never become direct web dependencies. Browser calls use same-origin `/api` and `/api/*` paths.

<!--@gvkit:if apiClientHeyApi-->
The flat `@repo/openapi-client` package consumes the composed gateway contract. Server loads and actions pass SvelteKit's request-scoped `fetch` to that client.
<!--@gvkit:else-->
This workspace has no generated API client package. Server loads and actions use SvelteKit's request-scoped `fetch` for gateway requests.
<!--@gvkit:endif-->
<!--@gvkit:if honoGatewayCfWorkers-->
The web Worker's only backend Service Binding is `GATEWAY`. Browser API ingress uses the web origin's more-specific Cloudflare routes and reaches the gateway without executing a SvelteKit `Handle`. `handleFetch` sends only same-origin SSR API requests through the binding. Do not bind web directly to auth, users, or another private service.
<!--@gvkit:else-->
<!--@gvkit:if honoGatewayDocker-->
Nginx routes `/api` and `/api/*` from the public ingress on http://localhost:3000 directly to the gateway. `handleFetch` sends same-origin SSR API requests through the private `GATEWAY_URL`. Do not call auth, users, or another private service directly.
<!--@gvkit:else-->
Vite proxies `/api` and `/api/*` from http://localhost:5173 directly to the gateway during local development. `handleFetch` sends same-origin SSR API requests through the private `GATEWAY_URL`. Do not call auth, users, or another private service directly.
<!--@gvkit:endif-->
<!--@gvkit:endif-->
<!--@gvkit:else-->
This app owns its server endpoints. Its deployment configuration declares only the bindings those endpoints use.
<!--@gvkit:endif-->

## Commands

```bash
pnpm install                 # install workspace deps
<!--@gvkit:if honoGatewayDocker-->
pnpm dev                     # Vite development server on http://localhost:3000
<!--@gvkit:else-->
pnpm dev                     # Vite development server on http://localhost:5173
<!--@gvkit:endif-->
pnpm build                   # SvelteKit production build
pnpm typecheck               # SvelteKit and TypeScript checks
pnpm lint                    # ESLint
pnpm format                  # Prettier write
<!--@gvkit:if deployCfWorkers-->
pnpm deploy:production       # Wrangler production deploy
pnpm cf-typegen              # replace bootstrap types with Wrangler output after config edits
pnpm exec wrangler tail      # live production logs
<!--@gvkit:endif-->
```

## Project conventions

<!--@gvkit:if aiRules-->
Detailed rules live at the workspace root under `.ai/rules/` (not duplicated here). Web-specific rules are prefixed `web-*`; the rest are cross-cutting.
<!--@gvkit:else-->
Follow the workspace root guidance and the conventions in this file.
<!--@gvkit:endif-->

<!--@gvkit:if i18nParaglide-->
## Internationalization

This app uses Paraglide v2 via `@repo/i18n`. User-facing copy lives in `packages/i18n/messages/<locale>.json` and is consumed as typed message functions (`m.xxx()`).

- Locale resolution: cookie (`PARAGLIDE_LOCALE`) → `Accept-Language` → base locale.
- Per-request isolation: `paraglideMiddleware` in `src/hooks.server.ts` prevents module-scoped locale state from leaking between concurrent requests.
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
<!--@gvkit:if deployCfWorkers-->
- **No Node.js APIs on server code paths** (`fs`, `path`, `node:crypto`, `process.env`). The Worker runtime doesn't ship them.
<!--@gvkit:endif-->
- **No date library other than `@internationalized/date`.** No `date-fns`, `dayjs`, `moment`, `luxon`.
