# Fixtures

Fixtures live in `fixtures/` as JSON files and drive snapshot tests for the planner.

## Conventions

- One fixture per matrix corner (e.g. `minimal.json`, `full.json`, `inside-frontend.json`, `cf-workers-postgres-resend.json`).
- File name describes the combination, not the result.
- Each fixture is a complete `GvKitConfig` (passes `GvKitConfig.parse`).
- Snapshots stored under `fixtures/__snapshots__/`, committed to git.

## Workflow

1. Add or change a fixture
2. Run `bun run snap` to regenerate snapshots
3. Inspect the diff carefully — snapshots are intentional, not automatic
4. Commit fixture + snapshot together with the same message
