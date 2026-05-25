# API Client (Hey API + TanStack Query)

The `apiClient: 'hey-api'` choice emits `packages/openapi-client/` (Hey API
codegen) and wires `@tanstack/svelte-query` into the SvelteKit app. `'skip'`
emits nothing. Owned by `src/generators/openapi-client.ts` and the
`api-client-hey-api` overlays under `fixtures/templates/{web,root}/` (gated by the
`apiClientHeyApi` flag set in `src/generators/frontend-sveltekit.ts`).

## Non-obvious invariants — don't re-break

- **`tsConfigPath` is pinned** in the emitted `openapi-ts.config.ts`
  (`output: { path, tsConfigPath: './tsconfig.json' }`). Without it Hey API walks
  up and reads the workspace-root `tsconfig.json`, whose `extends` can't resolve
  from the root → `pnpm codegen` fails in the scaffolded repo.
- **The emitted `+layout.ts` returns `{ ...data, queryClient }`.** Spreading
  `...data` keeps the server load's `user`/`locale` alive through the universal
  load. Returning only `{ queryClient }` clobbers them and breaks every page that
  reads `data.user`.
- **`enabled: browser`** on the QueryClient defaults keeps queries off during SSR;
  the server-first path uses the plain SDK function with `event.fetch`.
- **Auth is excluded from codegen** — better-auth ships its own client. The config
  targets non-auth services only (`apps/api/users`, …). Don't feed auth's spec to
  the generator.

## Conventions

- The showcase copy is **i18n-fenced**: `m.*()` under `i18nParaglide`, English
  fallback otherwise. Its `users_*` message keys are gated on
  `apiClient === 'hey-api'` in `src/generators/i18n.ts` so `i18n`-only projects
  don't ship dead keys.
- **Generated code is not linted or formatted.** The shared ESLint config
  (`src/generators/tooling.ts`) ignores `**/openapi-client/src/*/**` + `**/*.gen.ts`;
  the root `.prettierignore` (`src/generators/root.ts`) ignores
  `**/openapi-client/src/*/`. Keep generated `*.gen.ts` out of lint/format.
- The **emitted** `web-query.md` rule documents the consumer-facing policy (client
  reads on non-auth services only; mutations stay on superforms; auth on
  better-auth). It lives in the `api-client-hey-api` root overlay — keep it in sync
  with the showcase.

## After changing the generator, overlay, or i18n keys

Run `bun run bundle:templates && bun run snap`, then read the snapshot diff — the
diff is the change.
