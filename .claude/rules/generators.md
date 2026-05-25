# Generators

A generator is a pure function:

```ts
type GeneratorFn = (cfg: GvKitConfig) => FileEntry[]
```

## Rules

- **Pure.** No `Bun.write`, no `fs`, no `child_process`, no `Math.random()`. Output must be deterministic given the same config.
- **Tight scope.** One concern per generator (e.g., `tooling/eslint`, `apps/web/sveltekit`, `apps/api/auth`).
- **Idle-compilable.** When a feature flag is OFF, the generator either emits nothing or emits a stub that still typechecks at the project root.
- **Stable order.** Generators may rely on `plan` to sort and de-dupe by path.
- **No cross-service infra.** A generator for `apps/api/auth` must not touch `packages/backend`.

## Output shape

```ts
type FileEntry = {
  path: string      // POSIX, relative to outDir
  content: string   // utf-8
  mode?: number     // optional unix mode (e.g. 0o755 for scripts)
}
```
