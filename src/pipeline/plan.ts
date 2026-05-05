import { runGenerators } from '../generators/index.js'
import type { FileEntry } from '../lib/files.js'
import type { GvKitConfig } from '../schema/config.js'

/**
 * Build the scaffold plan from a validated config:
 *  1. Run all generators
 *  2. De-dupe by path (last write wins, with a warning to stderr)
 *  3. Sort by path for stable snapshots
 */
export function buildScaffoldPlan(cfg: GvKitConfig): FileEntry[] {
	const raw = runGenerators(cfg)

	const byPath = new Map<string, FileEntry>()
	for (const entry of raw) {
		if (byPath.has(entry.path)) {
			process.stderr.write(
				`[gv-kit] warning: duplicate path "${entry.path}" — overwriting earlier entry\n`
			)
		}
		byPath.set(entry.path, entry)
	}

	return [...byPath.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}
