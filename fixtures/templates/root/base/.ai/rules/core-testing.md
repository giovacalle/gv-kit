# Testing

Test runner: **`vitest`**. Tests live in `tests/` next to the package or app they exercise (or alongside source files when convenient).

## What to test (priorities)

1. **Domain logic** — use-cases under `packages/backend/src/core/use-cases/`. Pure functions that take a DB and return data; trivial to set up.
2. **Route handlers** — hit the Hono app with `app.request('/me', { … })` and assert on the response.
3. **Boundary contracts** — when a service depends on another service binding (e.g. `AUTH`), assert that the binding name in code matches the one declared in `wrangler.jsonc`. Mismatches surface as runtime errors otherwise.

## Conventions

- `import { describe, expect, test } from 'vitest'`
- **No network in tests.**
- **No real `fs` writes.** Keep tests deterministic.
- Prefer integration tests for handlers over unit tests for trivial wiring.
