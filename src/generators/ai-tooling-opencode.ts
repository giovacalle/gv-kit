import type { FileEntry } from '../lib/files.js'
import type { GvKitConfig } from '../schema/config.js'

/**
 * Emits `opencode.json` at the repo root. opencode's `instructions` field
 * supports globs, so we point it at the canonical `.ai/rules/*.md` tree
 * shared with Claude. No AGENTS.md is emitted from this generator — when
 * `codex` is also selected the codex generator owns AGENTS.md.
 */
export function generateAiToolingOpencode(_cfg: GvKitConfig): FileEntry[] {
	return [{ path: 'opencode.json', content: renderOpencodeConfig() }]
}

function renderOpencodeConfig(): string {
	const config = {
		$schema: 'https://opencode.ai/config.json',
		instructions: ['.ai/rules/*.md']
	}
	return JSON.stringify(config, null, 2) + '\n'
}
