# Pipeline

The CLI runs five stages in fixed order:

1. **collect** — interactive prompts via `@clack/prompts`, returns raw choices.
2. **validate** — parse raw input through `GvKitConfig` Zod schema; on failure, print formatted issues and exit code 1.
3. **plan** — call each generator with the validated config, concatenate results, sort by path, de-dupe.
4. **confirm** — print summary (count + top-level dirs); skipped if `--yes` or `--dry-run`.
5. **execute** — `mkdir -p outDir`, write files, `pnpm install` if root `package.json`, `pnpm run format` (non-fatal), `git init && git add -A && git commit`.

## Constraints

- Generators are PURE: `(cfg) => FileEntry[]`. No I/O, no async, no side effects.
- Side effects live ONLY in `execute`. Everything before `execute` is data.
- Cancellation at any prompt cleanly exits with code 0.
- `--dry-run` runs through `plan` and prints what would be written, then exits without `execute`.
