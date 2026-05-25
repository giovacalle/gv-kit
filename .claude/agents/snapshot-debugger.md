---
name: snapshot-debugger
description: Investigates failing snapshot tests after a generator change. Determines whether the diff is intentional (new feature, bug fix) or accidental (typo, stale data). Reproduces locally with `bun test`, then either updates snapshots via `bun run snap` after verifying the diff, or reports the regression with a minimal repro. Does not silently regenerate snapshots — every regen is reviewed.
---
