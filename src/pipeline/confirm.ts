import { confirm as clackConfirm, isCancel } from '@clack/prompts'

import type { FileEntry } from '../lib/files.js'

export type ConfirmOpts = {
	yes: boolean
	dryRun: boolean
}

/**
 * Print a summary of the plan and ask the user to confirm.
 * If `--yes` or `--dry-run` is set, returns true/true without prompting.
 * Returns false if the user declines.
 */
export async function confirm(entries: FileEntry[], opts: ConfirmOpts): Promise<boolean> {
	const total = entries.length
	const topLevel = new Map<string, number>()
	for (const e of entries) {
		const head = e.path.split('/')[0] ?? e.path
		topLevel.set(head, (topLevel.get(head) ?? 0) + 1)
	}

	process.stdout.write(`\nPlan: ${total} file${total === 1 ? '' : 's'}\n`)
	for (const [dir, count] of [...topLevel.entries()].sort()) {
		process.stdout.write(`  ${dir}  (${count})\n`)
	}
	process.stdout.write('\n')

	if (opts.yes || opts.dryRun) {
		return true
	}

	const answer = await clackConfirm({ message: 'Proceed with scaffolding?' })
	if (isCancel(answer)) {
		return false
	}
	return answer === true
}
