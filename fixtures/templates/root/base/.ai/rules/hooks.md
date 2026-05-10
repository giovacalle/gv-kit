# Git Hooks

This project uses **husky v9** for git hooks, **lint-staged** for staged-file checks, and **commitlint** with the conventional config for commit message validation.

Hooks run automatically after `pnpm install` (via the `prepare` script). No manual setup needed.

## What runs

| Stage | What happens |
|---|---|
| `pre-commit` | `pnpm lint-staged` — Prettier + ESLint on staged files only |
| `commit-msg` | `pnpm commitlint --edit "$1"` — validates the message against `@commitlint/config-conventional` |
| `pre-push` | (not configured) — by design, type-checking and tests are run manually before push |

## lint-staged config

Lives inline in the root `package.json`:

```json
"lint-staged": {
  "**/*.{ts,tsx,svelte,svelte.ts,svelte.js}": ["prettier --write", "eslint --fix"],
  "**/*.{json,css,html,md}": ["prettier --write"]
}
```

Only staged files are processed. The hook rewrites and restages them atomically.

## commitlint config

`.commitlintrc.json` extends `@commitlint/config-conventional`. Commit messages must follow:

```
<type>(<scope>): <subject>

[optional body]

[optional footer]
```

Types: `feat`, `fix`, `chore`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `revert`.

Examples:

```
feat(auth): add Google OAuth provider
fix(web): correct localized OG image path
chore(deps): bump svelte to 5.20
```

If you're doing **squash merges** on PRs, the squashed commit's message is the PR title — so apply the same convention to PR titles.

## Bypassing hooks

You CAN bypass with `--no-verify`:

```bash
git commit --no-verify -m "wip"
git push --no-verify
```

Use sparingly. The hooks exist because what you skip here lands on the team's branches anyway.

## Why no CI quality gate

There is no `.github/workflows/ci.yml`. The pre-commit hooks cover format/lint, and the deploy workflows don't gate on quality — they assume the hooks did their job. If you want a CI safety net for `--no-verify` commits, add a workflow that runs `pnpm typecheck` + `pnpm lint` on `pull_request`.

## Anti-patterns

| Don't | Do |
|---|---|
| Disable a hook in `package.json` because it's slow | Profile what's slow; usually `lint-staged` scope is too wide |
| `--no-verify` as a habit | Fix the root cause; the hook is right 99% of the time |
| Heavy work (typecheck, tests) in `pre-commit` | Keep it fast; lint-staged on staged files only |
| Custom commit-msg regex outside commitlint | Extend `@commitlint/config-conventional` via the `rules` field |
