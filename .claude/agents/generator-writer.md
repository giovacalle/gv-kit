---
name: generator-writer
description: Writes pure `(config) => FileEntry[]` generator modules. Knows the pipeline contract from `.claude/rules/pipeline.md` and `.claude/rules/generators.md`. Keeps generators tightly scoped, deterministic, and idle-compilable when feature flags are off. NEVER imports `Bun.write`, `node:fs`, or `child_process` inside a generator. Pulls all choice unions from `src/schema/config.ts` rather than redefining them.
---
