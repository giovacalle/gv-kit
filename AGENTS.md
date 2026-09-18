# gv-kit

Scaffolding CLI for Turborepo monorepos targeting SvelteKit + Hono on Cloudflare Workers. This is the single canonical instruction file for every AI coding tool — Codex, Opencode, and Claude Code alike (Claude Code reads AGENTS.md natively since v2.1.277).

## Architecture

User answers prompts → choices validated by Zod → pure generators emit `FileEntry[]` → user confirms → files written + `pnpm install` + `pnpm run format` + `git init`.

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
- Detailed conventions live in `.claude/rules/*.md` (plain markdown, readable by any tool): pipeline, generator, schema, fixture, service, api-client, style, comments, and testing rules

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

`packages/backend` is the shared backend application/core layer: reusable data access, use cases, types, helpers, and middleware. Deployable `services/<service>` packages are transport/runtime adapters and may import the application modules they need from `@repo/backend`.

`apps/api` is the only public Hono API application; private Workers live under `services/<service>/`, and auth is served only by `services/auth`. The web `/api/*` alias and canonical API origin reach the same gateway. Keep domain routes under `/api/v1/*` and Better Auth under `/api/auth/*`. Cloudflare web SSR uses only the `GATEWAY` Service Binding. Private session resolution uses the deploy-aware `@repo/backend/middleware/auth` transport with an explicit `AUTH` binding or private URL. The gateway composes service-defined OpenAPI fragments into `apps/api/openapi.json`, and `packages/openapi-client` exposes one flat client for that public contract. Limit the gateway to ingress, routing, operational middleware, OpenAPI delivery, and transparent forwarding. Never import application use cases or service apps into it, orchestrate business workflows there, or hairpin internal calls through it. Keep generated `.ai/rules/` aligned with this topology.

## Testing

- `bun test` for everything
- Snapshots committed to `fixtures/__snapshots__/`
- Contract tests for Cloudflare binding shapes (matches expected env)
- Always update snapshots intentionally via `bun run snap`

## ⚠️ Easy mistakes

Read before changing core paths.

- **Generators are PURE.** No `Bun.write`, `fs`, `child_process`, `Math.random()`, or `Date.now()` inside `src/generators/`. Side effects live ONLY in the `execute` stage of the pipeline.
- **Schema is the single source of truth** (`src/schema/config.ts`). Generators must NOT redefine choice unions locally — import from the schema.
- **Emitted templates are someone else's repo.** Never reference gv-kit-internal paths (`fixtures/`, `src/generators/`, `.plans/`) or terms (`FileEntry`, "the scaffolder", "this CLI") inside content emitted by a generator. See `.claude/rules/scaffolded-content.md`.
- **Snapshots are intentional.** When you change a generator, run `bun run snap` and *read* the diff before committing — the diff IS the change.
- **Single-line if + throw, no braces.** Project style. Multi-line bodies use braces.
- **Wrangler config is `wrangler.jsonc`, never `.toml`.**
