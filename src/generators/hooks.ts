import type { FileEntry } from '../lib/files.js'
import type { GvKitConfig } from '../schema/config.js'

const PRE_COMMIT = `pnpm lint-staged
`

const COMMIT_MSG = `pnpm commitlint --edit "$1"
`

const COMMITLINT_CONFIG =
	JSON.stringify({ extends: ['@commitlint/config-conventional'] }, null, 2) + '\n'

/** Generator for git hooks (husky + lint-staged + commitlint). */
export function generateHooks(_cfg: GvKitConfig): FileEntry[] {
	return [
		{ path: '.husky/pre-commit', content: PRE_COMMIT, mode: 0o755 },
		{ path: '.husky/commit-msg', content: COMMIT_MSG, mode: 0o755 },
		{ path: '.commitlintrc.json', content: COMMITLINT_CONFIG }
	]
}
