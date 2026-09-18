import type { FileEntry } from '../lib/files.js'
import type { GvKitConfig } from '../schema/config.js'
import { generateAiToolingClaude } from './ai-tooling-claude.js'
import { generateAiToolingCodex, renderAgentsMd } from './ai-tooling-codex.js'
import { generateAiToolingOpencode } from './ai-tooling-opencode.js'
import { generateAiToolingRules } from './ai-tooling-rules.js'

/**
 * AI-tooling orchestrator. `AGENTS.md` is the canonical root instructions file
 * (emitted once whenever any tool is selected) and `.ai/rules/*.md` is the
 * canonical, neutral source of conventions. Per-tool generators emit only the
 * tool-specific pointer or config file that loads those rules.
 *
 *  - canonical → AGENTS.md (stack, layout, rules index, commands, conventions)
 *  - claude    → `.claude/settings.json` + `.claude/*` agents (no CLAUDE.md —
 *                Claude Code ≥ 2.1.277 reads AGENTS.md natively)
 *  - codex     → `.codex/*` extras (AGENTS.md itself is already canonical)
 *  - opencode  → opencode.json with `instructions: [".ai/rules/*.md"]`
 *
 * The rules file set is emitted ONCE if any tool is selected; the `plan`
 * stage de-dupes by path so even an accidental double-add would be harmless.
 */
export function generateAiTooling(cfg: GvKitConfig): FileEntry[] {
	const tools = cfg.choices.aiTooling
	if (tools.length === 0) return []

	const entries: FileEntry[] = [...generateAiToolingRules(cfg)]

	entries.push({ path: 'AGENTS.md', content: renderAgentsMd(cfg) })

	if (tools.includes('claude')) entries.push(...generateAiToolingClaude(cfg))
	if (tools.includes('codex')) entries.push(...generateAiToolingCodex(cfg))
	if (tools.includes('opencode')) entries.push(...generateAiToolingOpencode(cfg))

	return entries
}
