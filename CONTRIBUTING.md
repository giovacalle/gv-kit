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

- `astro-cf-workers-full` — separate Astro/SvelteKit shape with every shared option
- `astro-docker-no-auth` — static marketing delivery through nginx
- `astro-skip-minimal` — separate shape without deployment output
- `v2-inside-web-minimal` — explicit v2 twin of the legacy `minimal` fixture
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

### Astro pairwise matrix

The Astro matrix reduces 11,520 prompt-reachable, schema-valid combinations to 35
deterministic pairwise rows. It covers the Hono and inside-frontend topologies. The
normal test suite validates every row through `GvKitConfig` and `buildScaffoldPlan`; the generated-project runner
additionally installs, tests, typechecks, lints, builds, and applies deploy-specific
gates.

```bash
bun run verify:astro-matrix -- --list
bun run verify:astro-matrix -- --entry m01
bun run verify:astro-matrix
```

The runner writes reports and per-gate logs to `.scratch/astro-scaffold-matrix/`.
Use `--output <dir>` to keep artifacts elsewhere and `--entry <id>` to shard the
same stable matrix in CI or local parallel runs. Cloudflare rows add marketing
and web Wrangler dry-runs; Docker rows validate `docker compose config` without
building images or starting containers.

## Gateway and service boundary policy

`packages/backend/` is the shared backend application/core layer for reusable data access, use cases, types, helpers, and middleware. Independently deployable packages under `services/` are transport/runtime adapters and may import the application modules they need from `@repo/backend`.

`apps/api/` is the public gateway. Keep it limited to ingress, routing, operational middleware, OpenAPI delivery, and transparent forwarding. It must not import application use cases or orchestrate business workflows. `services/users/` (and any future non-auth service) MUST NOT:

- configure Better Auth
- read `BETTER_AUTH_SECRET` or OAuth secrets
- query the auth tables directly

Services own deterministic OpenAPI fragments; the gateway composes them into `apps/api/openapi.json`, the sole input for the flat `packages/openapi-client` export. Browser calls use same-origin `/api/*`, and Cloudflare web SSR binds only to `GATEWAY`.

Session validation goes through `/internal/session` only. The deploy-aware `@repo/backend/middleware/auth` uses the direct `AUTH` Service Binding on Cloudflare and private `AUTH_URL` transport otherwise. The pattern is enforced by `tests/contracts/users-bindings.test.ts`; new generators or templates that violate it will fail CI.

## Generator conventions

Generators live in `src/generators/` and are pure: `(cfg: GvKitConfig) => FileEntry[]`. No `fs`, no `child_process`, no `Bun.*`, no `Math.random()`. Side effects only in `src/pipeline/execute.ts`.

Wrangler config is always `wrangler.jsonc` (never `.toml`). Tailwind 4 is `@theme` only (no `tailwind.config.js`). Paraglide v2 uses `paraglideVitePlugin` (the `@inlang/paraglide-sveltekit` adapter is deprecated).

Marketing templates are a separate first-class tree under `fixtures/templates/marketing/`. Run `bun run bundle:templates` after editing any template tree and commit the matching `src/generated/*-templates.ts` output. Astro config must export a plain object, and browser-only monitoring belongs in an Astro client script rather than frontmatter.

## Release

Generated-output breaks require a `major` changeset and a migration note under `docs/migrations/`. The current Hono topology migration is documented in [`docs/migrations/hono-api-gateway.md`](./docs/migrations/hono-api-gateway.md). Do not ship an automatic source rewrite for generated repositories.

```bash
bun changeset add              # describe the change
bun changeset version          # bump + update CHANGELOG
bun run build
bun pm pack --dry-run          # verify tarball contents
npm publish --access public    # ship
```
