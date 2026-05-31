# gv-kit

Scaffolding CLI for Turborepo monorepos targeting SvelteKit + Hono on Cloudflare Workers.

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
- See `.claude/rules/` for pipeline, generator, schema, fixture, service, api-client, and testing conventions

## ⚠️ Easy mistakes

Read before changing core paths.

- **Generators are PURE.** No `Bun.write`, `fs`, `child_process`, `Math.random()`, or `Date.now()` inside `src/generators/`. Side effects live ONLY in the `execute` stage of the pipeline.
- **Schema is the single source of truth** (`src/schema/config.ts`). Generators must NOT redefine choice unions locally — import from the schema.
- **Emitted templates are someone else's repo.** Never reference gv-kit-internal paths (`fixtures/`, `src/generators/`, `.plans/`) or terms (`FileEntry`, "the scaffolder", "this CLI") inside content emitted by a generator. See `.claude/rules/scaffolded-content.md`.
- **Snapshots are intentional.** When you change a generator, run `bun run snap` and *read* the diff before committing — the diff IS the change.
- **Single-line if + throw, no braces.** Project style. Multi-line bodies use braces.
- **Wrangler config is `wrangler.jsonc`, never `.toml`.**
- **Apps under `apps/api/<service>/` are independently deployable Hono workers.** Do not extract a shared SDK package between them — keep ~10 LOC `fetch` clients per consumer.
