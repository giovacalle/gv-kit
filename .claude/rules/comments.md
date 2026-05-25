# Comments

Default to writing no comments. Only add one when the WHY is non-obvious: a hidden constraint, a subtle invariant, a workaround for a specific bug, behavior that would surprise a reader.

## What NOT to write

- **Reasoning essays.** "This lives here because…", "We chose this pattern because…", "Built this way to allow…" — belongs in the README, a design doc, or the commit message. Not in the code.
- **Restating the code.** `// returns the user` above `return user`. The name says it.
- **Aspirational TODOs.** "// Replace with X when Y", "// Consider adding…" — open an issue or write a real `TODO(handle): …`. Comments rot faster than tickets.
- **Self-description.** "This function builds the X", "Common Y helper". Pick a better name instead.
- **Usage examples in JSDoc.** Examples belong in the README, not in `*.ts` files.

## What to write

- **Hidden constraints.** `// must run before requireAuth (sets c.req.id)`
- **Workarounds for real bugs.** `// cf-workers don't expose Buffer; fall back to atob/btoa`
- **Non-obvious invariants.** `// rows are returned sorted by createdAt desc`

If a comment needs more than one line to explain itself, the explanation does not belong inline. Move it to:

- the package's `README.md`
- a dedicated rule under `.claude/rules/`
- the PR description that introduced the change

## Generated code

This rule applies to BOTH the generator code in this repo AND the templates the generators emit. Scaffolded projects should be lean — downstream developers shouldn't inherit our internal reasoning as comments.
