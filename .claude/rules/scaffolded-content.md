# Scaffolded Content

Every `FileEntry.content` value emitted by a generator becomes part of someone else's repo. The downstream developer who reads that code does not know it came from gv-kit and has no access to gv-kit's internals. Emitted content must be self-contained.

## Forbidden inside emitted templates

- **References to `.claude/rules/<file>.md`** unless that exact rule file is also emitted by some generator. Most rules in this repo are gv-kit-internal — never cite them from emitted content.
- **Mentions of "gv-kit", "the scaffolder", "the generator", "this CLI"** — the scaffolded project doesn't know it was scaffolded.
- **References to gv-kit-internal paths**: `fixtures/`, `tests/`, `src/generators/`, `src/pipeline/`, `src/schema/`, `.plans/`, etc.
- **References to gv-kit-internal concepts**: `FileEntry`, `GvKitConfig`, "snapshot fixtures", "the pipeline", etc.
- **Phrasing that mixes audiences**: "this rule applies to BOTH the generator code in this repo AND the templates" reads to a downstream contributor as a non-sequitur.

## Allowed (and encouraged)

- Inline the relevant guidance directly. If a service README needs to remind contributors about boundaries, write the boundary policy in the README itself.
- Cross-references between TWO emitted files are fine (both exist in the scaffolded project).
- Generic terminology: "this package", "this service", "this repo" (resolved from the downstream reader's perspective).

## Pre-flight check

Before adding any emitted content that mentions a path, file, rule, or external concept, verify the reference would resolve in the scaffolded project. Open the latest regenerated example and `grep` for the reference — if it's not there, drop it or inline the content.
