# Testing

Test runner: **`vitest`**. Tests live in `tests/` next to the package or app they exercise (or alongside source files when convenient).

## What to test (priorities)

<!--@gvkit:if effectBackend-->
1. **Application workflows** — run Effect programs with fake `Layer`s for each service dependency. Keep these tests inside `apps/api/<service>/src/features/<feature>/`; do not construct Hono contexts or concrete infrastructure in workflow tests.
2. **Route adapters** — hit the assembled Hono app with `app.request('/me', { … })` and assert the declared status and JSON body for success, typed failures, validation failures, and defects.
3. **Runtime contracts** — assert reachable statuses exist in `/openapi.json`, then run the users API and `pnpm client:generate`; the normal root typecheck checks the generated consumer.
4. **Boundary contracts** — when a service depends on another service binding (e.g. `AUTH`), assert that the binding name in code matches the one declared in `wrangler.jsonc`.
<!--@gvkit:else-->
1. **Domain logic** — use-cases under `packages/backend/src/core/use-cases/`. Pure functions that take a DB and return data; trivial to set up.
2. **Route handlers** — hit the Hono app with `app.request('/me', { … })` and assert on the response.
3. **Boundary contracts** — when a service depends on another service binding (e.g. `AUTH`), assert that the binding name in code matches the one declared in `wrangler.jsonc`. Mismatches surface as runtime errors otherwise.
<!--@gvkit:endif-->

## Conventions

- `import { describe, expect, test } from 'vitest'`
- **No network in tests.**
- **No real `fs` writes.** Keep tests deterministic.
- Prefer integration tests for handlers over unit tests for trivial wiring.
