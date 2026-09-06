# gv-kit

Scaffolding CLI for Turborepo monorepos targeting SvelteKit + Hono on Cloudflare Workers. Primary AI tooling reference for Codex, Opencode, and other non-Claude AI assistants.

## Architecture

User answers prompts → choices validated by Zod → pure generators emit `FileEntry[]` → user confirms → files written + `pnpm install` + `git init`.

Pipeline stages: `collect` → `validate` → `plan` → `confirm` → `execute`. Generators are pure functions `(config) => FileEntry[]`. No I/O inside generators.

## Layout

- `src/cli.ts` — argv parsing, orchestrates the pipeline
- `src/schema/` — Zod schemas (single source of truth)
- `src/pipeline/` — collect, validate, plan, confirm, execute
- `src/generators/` — pure generator functions
- `src/lib/` — shared types (`FileEntry`) and utilities
- `tests/` — `bun test` suites
- `fixtures/` — JSON config fixtures + snapshots

## Commands

| Command | Use |
|---|---|
| `bun run dev` | Run CLI from source |
| `bun test` | Run all tests |
| `bun run snap` | Update snapshots |
| `bun run typecheck` | TypeScript check |
| `bun run lint` | ESLint |
| `bun run build` | Build to `dist/cli.js` |

## Conventions

- All output (code/comments/commits/docs) in English
- TypeScript pinned to `~5.9.0`; Zod `^4.3.0` with workspace override
- Wrangler config is always `wrangler.jsonc` — never `wrangler.toml`
- Read files before editing in batch
- After cleanup/refactor: run `grep -ri <pattern>` to catch residue
- Snapshot regen is an explicit step on every generator change

## Pipeline rules (summary)

1. `collect` uses `@clack/prompts`; cancellation triggers clean `process.exit(0)`
2. `validate` parses raw input via Zod schemas — NO ad-hoc checks elsewhere
3. `plan` calls each generator and concatenates the resulting `FileEntry[]`, sorted by path
4. `confirm` prints summary; bypassed by `--yes` and `--dry-run`
5. `execute` writes files, runs `pnpm install` if a root `package.json` exists, then `git init`

## Generator rules (summary)

- Signature: `(cfg: GvKitConfig) => FileEntry[]`
- Pure — no `Bun.write`, no `child_process`, no `fs`
- Tightly scoped — one feature per generator
- Idle-compilable — output must be a valid program even when feature flags are off

## Service architecture

`packages/backend` is the shared backend application/core layer. It may contain reusable data access, use cases, types, helpers, and middleware. Deployable `services/<service>` packages are transport/runtime adapters and may import the application modules they need from `@repo/backend`.

`apps/api` is the only public Hono API application. The web origin's `/api/*` alias and canonical API origin reach the same gateway. Better Auth stays under `/api/auth/*`; domain routes use `/api/v1/*`. Private workers live under `services/<service>`; auth is served only by `services/auth`. The gateway handles ingress, routing, operational middleware, OpenAPI delivery, and transparent forwarding. It does not import application use cases or orchestrate business workflows. The gateway composes service-defined OpenAPI fragments into `apps/api/openapi.json`, and `packages/openapi-client` exposes one flat client for that public contract. Browser traffic stays same-origin; web SSR uses only the `GATEWAY` Service Binding on Cloudflare. Private services resolve sessions through the deploy-aware `@repo/backend/middleware/auth` transport and explicit private bindings such as `AUTH`. Never import a service app into the gateway or route internal calls back through it. Keep generated `.ai/rules/` aligned with this topology.

## Testing

- `bun test` for everything
- Snapshots committed to `fixtures/__snapshots__/`
- Contract tests for Cloudflare binding shapes (matches expected env)
- Always update snapshots intentionally via `bun run snap`
