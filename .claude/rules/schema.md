# Schema

Single source of truth: `src/schema/config.ts`. Every choice the CLI exposes is declared here.

## Rules

- **Zod v4.** Use `z.object`, `z.enum`, `z.literal`, `z.array`, `z.string().regex`. For cross-field gating use `.superRefine`.
- **No duplication.** Generators must NOT redefine choice unions locally. Import from `src/schema/config.ts`.
- **Refine, don't pre-validate.** If a combination is invalid (e.g. `apiClient='hey-api'` with `backend='inside-frontend'`), express it in `.superRefine` with a clear `path` for error reporting.
- **Errors are user-facing.** Messages should explain what is wrong AND what the user can do about it.
- **Versioned.** `configVersion: 1` literal. When the schema changes incompatibly, bump and add a migration.
