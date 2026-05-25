# Testing

Test runner: `bun test`. Test files live alongside `src/` in `tests/`.

## Layers

1. **Schema tests** — `tests/schema.test.ts` exercises Zod accept/reject paths.
2. **Generator tests** — pure-function tests, one file per generator.
3. **Plan snapshot tests** — fixtures in `fixtures/`, snapshots in `fixtures/__snapshots__/`.
4. **Contract tests** — verify Cloudflare bindings shape (D1, KV, R2 names match expectations).

## Conventions

- `import { describe, expect, test } from 'bun:test'`
- Snapshots committed; updates require `bun run snap` and a deliberate review.
- No network in tests. No real `fs` writes — generators are pure, tests assert on returned `FileEntry[]`.
- Fail loudly for missing fixtures rather than auto-creating.
