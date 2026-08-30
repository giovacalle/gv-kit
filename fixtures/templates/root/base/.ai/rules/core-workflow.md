# Workflow

This project ships four agnostic core agents covering the lifecycle of any change:

| Agent | When to invoke | Tools |
|-------|----------------|-------|
| `plan` | Before a non-trivial change | Read-only |
| `implement` | After a plan, or for changes too small to plan | Edit + Write |
| `polish` | After the feature works, before review | Edit + Write |
| `review` | Before commit / merge | Read-only |

<!--@gvkit:if cfWorkers-->
Specialist agents are added when the chosen stack creates a domain that needs one (e.g. `service-architect` for private Hono Workers under `services/<service>/`; `apps/api/` remains the public gateway).
<!--@gvkit:else-->
Specialist agents are added when the chosen stack creates a domain that needs one (e.g. `service-architect` for private Hono services under `services/<service>/`; `apps/api/` remains the public gateway).
<!--@gvkit:endif-->

## Typical flow

1. User asks for a change.
2. If it spans more than one file or is non-obvious → `plan` first. Read the resulting plan; redirect if needed.
3. `implement` — executes the plan, follows the rules in `.claude/rules/`, runs typecheck + lint.
4. `polish` — naming, dead code, duplication, comment hygiene.
5. `review` — quality, security, convention adherence. Reports blockers + issues.
6. Commit.

## When to skip a step

- **Skip `plan`** for one-file changes or obvious fixes.
- **Skip `polish`** when the diff is already clean.
- **Never skip `review`** for changes touching auth, payment, secrets, or data deletion.

## Rules are the source of truth

All four agents read `.claude/rules/*.md` before acting. **Update the rules when conventions change** — agents pick up the new behavior automatically. Don't bake stack-specific knowledge into agent prompts.

## stack.json

User choices made at scaffold time are recorded at `.claude/stack.json`. Agents read it to know which rules apply, without inferring from the filesystem each time. When the stack evolves (auth added, deploy target changed), update `stack.json` to match.

## Invoking agents

Use whichever invocation your tool supports:

- **Claude Code:** `Use the @<name> agent to ...`, or via the `Task` tool with `subagent_type: '<name>'`.
- **Codex / Opencode:** reference agents by name; they live as markdown in `.claude/agents/` and as descriptions in `AGENTS.md`.

Pass enough context that the agent doesn't need to ask back: what changed, what to focus on, what scope to keep.
