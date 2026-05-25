import type { FileEntry } from '../lib/files.js'
import type { GvKitConfig } from '../schema/config.js'
import { generateAiToolingClaude } from './ai-tooling-claude.js'
import { generateAiToolingCodex } from './ai-tooling-codex.js'
import { generateAiToolingOpencode } from './ai-tooling-opencode.js'
import { generateAiToolingRules } from './ai-tooling-rules.js'

/**
 * AI-tooling orchestrator. `.ai/rules/*.md` is the canonical, neutral source
 * of conventions; per-tool generators emit only the tool-specific pointer or
 * config file that loads those rules.
 *
 *  - claude    → CLAUDE.md (with @.ai/rules imports) + `.claude/agents/*` + settings
 *  - codex     → AGENTS.md router pointing at `.ai/rules/*.md`
 *  - opencode  → opencode.json with `instructions: [".ai/rules/*.md"]`
 *
 * The rules file set is emitted ONCE if any tool is selected; the `plan`
 * stage de-dupes by path so even an accidental double-add would be harmless.
 */
export function generateAiTooling(cfg: GvKitConfig): FileEntry[] {
	const tools = cfg.choices.aiTooling
	if (tools.length === 0) return []

	const entries: FileEntry[] = []

	entries.push(...generateAiToolingRules(cfg))

	if (tools.includes('claude')) entries.push(...generateAiToolingClaude(cfg))
	if (tools.includes('codex')) entries.push(...generateAiToolingCodex(cfg))
	if (tools.includes('opencode')) entries.push(...generateAiToolingOpencode(cfg))

	return entries
}
