import type { FileEntry } from '../lib/files.js'
import type { GvKitConfig } from '../schema/config.js'

/**
 * Emits `opencode.json` at the repo root. opencode's `instructions` field
 * supports globs, so we point it at the canonical `.ai/rules/*.md` tree
 * shared with Claude. No AGENTS.md is emitted from this generator — when
 * `codex` is also selected the codex generator owns AGENTS.md.
 */
export function generateAiToolingOpencode(cfg: GvKitConfig): FileEntry[] {
	const entries: FileEntry[] = [{ path: 'opencode.json', content: renderOpencodeConfig() }]
	if (cfg.choices.marketing === 'astro')
		entries.push({
			path: '.opencode/agents/astro-marketer.md',
			content: renderAstroMarketerAgent()
		})
	return entries
}

function renderAstroMarketerAgent(): string {
	return `---
description: Builds and reviews the static Astro marketing surface without crossing application boundaries.
mode: subagent
tools:
  read: true
  grep: true
  glob: true
  bash: true
  edit: true
  write: true
---

Work only on the public surface under \`apps/marketing\` and shared presentation
assets it legitimately consumes. Read \`.ai/rules/marketing-astro.md\` before
editing and follow it as the canonical contract. Keep the surface static-first,
use \`@repo/ui/*\`, hydrate only intentional interactions, and run the marketing
typecheck and production build. Refuse to move auth, backend, database, or
application behavior into marketing.
`
}

function renderOpencodeConfig(): string {
	const config = {
		$schema: 'https://opencode.ai/config.json',
		instructions: ['.ai/rules/*.md']
	}
	return JSON.stringify(config, null, 2) + '\n'
}
