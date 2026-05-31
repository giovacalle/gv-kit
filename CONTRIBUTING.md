# Contributing

## Setup

```bash
bun install
```

## Tests

```bash
bun test                       # full suite
bun test tests/schema.test.ts  # schema only
bun test tests/contracts/      # boundary contracts only
```

## Snapshots

`tests/pipeline.test.ts` snapshots a manifest of `<path>  <sha256>` per fixture. Snapshots live in `fixtures/__snapshots__/` and are committed.

```bash
bun run snap                   # regenerate (UPDATE_SNAPSHOTS=1 bun test tests/pipeline.test.ts)
```

When you change a generator, snapshots will fail. Run `bun run snap`, **inspect the diff** (it should match the change you made), then commit fixture(s) + snapshot(s) in the same commit.

## Fixture-driven dev

The fixtures in `fixtures/` cover the matrix corners:

- `minimal` / `inside-frontend-typical` — single SvelteKit Worker
- `hono-cf-workers-full` — full Hono stack on Cloudflare
- `hono-docker-full` — Hono in Docker containers
- `hono-skip-deploy` — Hono with no deploy artifacts

To add a fixture, drop a JSON config in `fixtures/`, run `bun run snap`, then verify it scaffolds:

```bash
bun run build
node dist/cli.js new /tmp/sandbox --yes --config fixtures/<your-fixture>.jsonc
cd /tmp/sandbox && pnpm install && pnpm typecheck
```

## Boundary policy

`apps/api/users` (and any future non-auth service) MUST NOT:

- import `@repo/backend/auth`
- read `BETTER_AUTH_SECRET` or OAuth secrets
- query the auth tables directly

Session validation goes through `/internal/session` only — CF service binding when on cf-workers, HTTP fetch via `AUTH_URL` otherwise. The pattern is enforced by `tests/contracts/users-bindings.test.ts`; new generators or templates that violate it will fail CI.

## Generator conventions

Generators live in `src/generators/` and are pure: `(cfg: GvKitConfig) => FileEntry[]`. No `fs`, no `child_process`, no `Bun.*`, no `Math.random()`. Side effects only in `src/pipeline/execute.ts`.

Wrangler config is always `wrangler.jsonc` (never `.toml`). Tailwind 4 is `@theme` only (no `tailwind.config.js`). Paraglide v2 uses `paraglideVitePlugin` (the `@inlang/paraglide-sveltekit` adapter is deprecated).

## Release

```bash
bun changeset add              # describe the change
bun changeset version          # bump + update CHANGELOG
bun run build
bun pm pack --dry-run          # verify tarball contents
npm publish --access public    # ship
```
