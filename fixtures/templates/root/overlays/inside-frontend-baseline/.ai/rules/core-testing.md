# Testing

Test runner: `vitest`.

## Priorities

1. Test server routes and load functions under `apps/web/src/routes/` at their SvelteKit boundary.
2. Test shared helpers in `packages/backend/` through their public exports.
3. Test database behavior through `packages/db/` rather than copying setup into application tests.
4. Test components by user-visible behavior.

## Conventions

- Import `describe`, `expect`, and `test` from `vitest`.
- Do not use the network in tests.
- Do not write to the real filesystem.
- Prefer integration tests for route behavior over tests of trivial wiring.
