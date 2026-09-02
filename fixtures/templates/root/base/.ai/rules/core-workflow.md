# Workflow

<!--@gvkit:if claude-->
This project ships four Claude Code agents for the lifecycle of a change:

| Agent | When to invoke | Tools |
|-------|----------------|-------|
| `plan` | Before a non-trivial change | Read-only |
| `implement` | After a plan, or for changes too small to plan | Edit + Write |
| `polish` | After the feature works, before review | Edit + Write |
| `review` | Before commit or merge | Read-only |

<!--@gvkit:if hono-->
A Hono specialist is available to Claude Code only:

<!--@gvkit:if cfWorkers-->
- `service-architect` scaffolds private Hono Workers under `services/<service>/`. Its descriptor is `.claude/agents/service-architect.md`.
<!--@gvkit:else-->
- `service-architect` scaffolds a new private Hono service under `services/<service>/`. Its descriptor is `.claude/agents/service-architect.md`.
<!--@gvkit:endif-->

`apps/api/` remains the public gateway, and reusable application modules stay in `packages/backend/`. Other selected tooling follows the canonical rules directly and does not expose this specialist.
<!--@gvkit:else-->
The SvelteKit application is one deployment unit. It has no stack-specific backend specialist.
<!--@gvkit:endif-->
<!--@gvkit:else-->
<!--@gvkit:if hono-->
Follow the workflow below directly through the selected tooling. Before adding a private Hono service, read `.ai/rules/core-stack.md` and `.ai/rules/api-backend.md`. Keep `apps/api/` as the public gateway, private transport adapters under `services/<service>/`, and reusable application modules in `packages/backend/`.
<!--@gvkit:else-->
Follow the workflow below directly through the selected tooling. The SvelteKit application is one deployment unit and has no stack-specific backend specialist.
<!--@gvkit:endif-->
<!--@gvkit:endif-->

## Typical flow

1. Read the relevant files under `.ai/rules/`.
2. Plan non-obvious changes before editing.
3. Implement the smallest complete change, then run typecheck and lint.
4. Remove naming, duplication, dead-code, and comment problems.
5. Review quality, security, and convention adherence before commit or merge.

## When to skip a step

- Skip planning for one-file changes or obvious fixes.
- Skip polishing when the diff is already clean.
- Never skip review for changes touching auth, payment, secrets, or data deletion.

## Rules are the source of truth

Read `.ai/rules/*.md` before acting. Update the rules when conventions change instead of duplicating stack guidance in agent descriptors.

<!--@gvkit:if claude-->
## Stack manifest

User choices made at scaffold time are recorded at `.claude/stack.json`. Claude Code agents read it to know which rules apply. Keep it in sync when the stack evolves.

## Invoking Claude Code agents

Use `@<name>` or the `Task` tool with `subagent_type: '<name>'`. Agent descriptors live under `.claude/agents/`.

Pass enough context to identify the change, focus, and scope.
<!--@gvkit:endif-->
