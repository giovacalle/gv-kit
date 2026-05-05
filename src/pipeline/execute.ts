import { chmod, mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { runOrThrow } from '../lib/exec.js'
import type { FileEntry } from '../lib/files.js'

/**
 * Materialize a plan to disk.
 *
 *  1. mkdir -p outDir
 *  2. Write each FileEntry, creating parent directories as needed
 *  3. If outDir/package.json was emitted, run `pnpm install` there
 *  4. `pnpm run format` so the initial commit lands already formatted
 *  5. `git init && git add -A && git commit -m "chore: scaffold"`
 */
export async function execute(outDir: string, entries: FileEntry[]): Promise<void> {
	await mkdir(outDir, { recursive: true })

	for (const entry of entries) {
		const fullPath = join(outDir, entry.path)
		const parent = dirname(fullPath)
		try {
			await mkdir(parent, { recursive: true })
			await writeFile(fullPath, entry.content, 'utf8')
			if (entry.mode !== undefined) {
				await chmod(fullPath, entry.mode)
			}
		} catch (err) {
			throw new Error(
				`Failed to write ${entry.path}: ${err instanceof Error ? err.message : String(err)}`
			)
		}
	}

	const hasPackageJson = entries.some((e) => e.path === 'package.json')
	if (hasPackageJson) {
		try {
			await runOrThrow('pnpm', ['install'], outDir, 'pnpm install')
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err)
			if (msg.includes('ENOENT') || msg.includes('not found') || msg.includes('spawn pnpm'))
				throw new Error(
					`pnpm is not installed or not on PATH. Enable it with \`corepack enable\` (Node 16+) or install it from https://pnpm.io/installation.\n\nOriginal error: ${msg}`
				)
			// pnpm 10+ exits non-zero under non-TTY spawn when build scripts are
			// flagged via ERR_PNPM_IGNORED_BUILDS, even when entries are in the
			// pnpm.onlyBuiltDependencies allowlist. The install itself succeeded —
			// degrade to a warning and continue.
			if (msg.includes('ERR_PNPM_IGNORED_BUILDS')) {
				console.warn(
					'\nNote: pnpm flagged some build scripts as ignored. Run `pnpm approve-builds --all` inside the new project to acknowledge them.\n'
				)
			} else {
				throw err
			}
		}

		// Format after install (prettier + plugins are now present) and before the
		// initial commit, so the scaffold lands already formatted and fence-stripping
		// whitespace artifacts are cleaned up. Non-fatal: a format failure shouldn't
		// block the user from getting their project.
		try {
			await runOrThrow('pnpm', ['run', 'format'], outDir, 'pnpm run format')
		} catch {
			console.warn('\nNote: could not auto-format the scaffold. Run `pnpm format` once inside it.\n')
		}
	}

	await runOrThrow('git', ['init'], outDir, 'git init')
	await runOrThrow('git', ['add', '-A'], outDir, 'git add')
	await runOrThrow('git', ['commit', '-m', 'chore: scaffold'], outDir, 'git commit')
}
