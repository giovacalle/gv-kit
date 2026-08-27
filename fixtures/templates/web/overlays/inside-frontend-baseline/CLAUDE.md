# __PROJECT__

SvelteKit application with server routes and data access in one deployment unit.

## Stack

- Framework: SvelteKit 2 and Svelte 5
- Styling: Tailwind v4 and shared primitives from `@repo/ui`
- Forms: sveltekit-superforms v2, formsnap v2, and Zod
- Errors: `AppError` and `throwAppError` on the server, `Result<T, AppError>` on the client
- Dates: `@internationalized/date`
<!--@gvkit:if deployCfWorkers-->
- Deployment: Cloudflare Workers via `@sveltejs/adapter-cloudflare`
<!--@gvkit:endif-->

## Backend boundary

`apps/web/` owns all pages, server loads, form actions, and HTTP endpoints. Shared database setup lives in `packages/db/`; shared server helpers live in `packages/backend/`.

<!--@gvkit:if deployCfWorkers-->
The web Worker's configuration is `apps/web/wrangler.jsonc`. Declare the resources used by SvelteKit handlers there and keep `apps/web/src/app.d.ts` aligned with it.
<!--@gvkit:endif-->

## Commands

```bash
pnpm install
pnpm dev
pnpm build
pnpm typecheck
pnpm lint
pnpm format
```

Read the workspace rules under `.ai/rules/` before editing.

<!--@gvkit:if i18nParaglide-->
## Internationalization

Messages live in `packages/i18n/messages/<locale>.json`. Use typed functions from `@repo/i18n/messages` and keep locale handling request-scoped in `apps/web/src/hooks.server.ts`.
<!--@gvkit:endif-->

## Constraints

- Keep shared UI under `packages/ui/` and import primitives through `@repo/ui/primitives/<name>`.
- Keep application components under `apps/web/src/lib/components/`.
- Use only `@internationalized/date` for date work.
- Do not use Node-only APIs in Cloudflare Worker code paths.
