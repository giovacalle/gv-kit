# Svelte 5 and SvelteKit conventions

`apps/web/` contains the UI, server routes, and server loads for this single-unit application. Use Svelte 5 runes. Legacy `$:` statements and `export let` props are forbidden.

## State and components

- Use `$state`, `$derived`, `$effect`, `$props`, and `$bindable`.
- Keep request-specific state out of module scope.
- Put shared reactive state in a class instantiated through Svelte context.
- Check `runed` before adding a custom reactive utility.
- Import shared UI through `@repo/ui/primitives/<name>`.

## Server boundaries

SvelteKit owns every HTTP entry point. Put endpoint handlers in `+server.ts`, form actions and server loads in `+page.server.ts`, and shared server-only code under `apps/web/src/lib/server/`.

Server handlers may use `@repo/db` directly and consume the shared backend application/core layer in `packages/backend/`. That package may contain reusable data access, use cases, types, helpers, and middleware. Reusable database setup stays in `packages/db/`.

## Generated layout

- `apps/web/src/app.css` imports shared styles.
- `apps/web/src/lib/components/` holds application components.
- `apps/web/src/lib/components/seo.svelte` owns baseline metadata.
- `apps/web/src/lib/config/site.ts` holds public site configuration.
- `apps/web/src/lib/server/` holds server-only helpers.
- `apps/web/src/routes/` holds pages, loads, actions, and endpoints.
- `packages/ui/` owns shared UI primitives and styles.
<!--@gvkit:if i18nParaglide-->
- `packages/i18n/` owns messages and the compiled locale runtime.
<!--@gvkit:endif-->

## Naming

- Components use `kebab-case.svelte`.
- Context holders use `kebab-case.svelte.ts`.
- Route files follow SvelteKit's `+page.svelte`, `+page.server.ts`, `+layout.svelte`, and `+server.ts` conventions.
- Route-private components live in an `_components` directory beside their route.

## Anti-patterns

- Do not export module-level rune state.
- Do not create UI primitives under `apps/web/src/lib/components/ui/`.
- Do not put reusable database setup outside `packages/db/`.
- Do not use Node-only APIs in code that runs on Cloudflare Workers.
