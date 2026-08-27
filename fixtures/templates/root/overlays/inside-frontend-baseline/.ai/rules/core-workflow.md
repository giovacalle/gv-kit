# Workflow

This project uses four core change roles:

| Role | When to use it | Access |
|---|---|---|
| `plan` | Before a non-trivial change | Read-only |
| `implement` | After a plan, or for a small direct change | Edit and write |
| `polish` | After behavior works | Edit and write |
| `review` | Before commit or merge | Read-only |

The SvelteKit application is one deployment unit. It has no stack-specific backend specialist.

## Typical flow

1. Read the relevant rules under `.ai/rules/`.
2. Plan non-obvious work.
3. Implement the smallest complete change.
4. Run typecheck and lint.
5. Review auth, payment, secret, and data-deletion changes before commit.

## Rules are the source of truth

Keep `.ai/rules/` aligned with the generated application. User choices are recorded in `.claude/stack.json` when Claude tooling is selected.

Claude descriptors live under `.claude/agents/`. Codex reads `AGENTS.md`. Opencode reads the `.ai/rules/` glob configured in `opencode.json`.
