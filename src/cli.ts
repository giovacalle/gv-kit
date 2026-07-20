import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { intro, outro } from '@clack/prompts'
import { parseJsonc } from './lib/jsonc.js'
import { collect } from './pipeline/collect.js'
import { confirm } from './pipeline/confirm.js'
import { execute } from './pipeline/execute.js'
import { buildScaffoldPlan } from './pipeline/plan.js'
import { validate } from './pipeline/validate.js'
import type { GvKitConfig } from './schema/config.js'

type ParsedArgs = {
	command: 'new' | 'help' | 'unknown'
	outDir?: string
	yes: boolean
	dryRun: boolean
	configPath?: string
	help: boolean
}

const HELP = `
gv-kit — scaffold product monorepos (Astro marketing + SvelteKit application)

Usage:
  gv-kit new <out-dir> [options]

Options:
  --yes              Skip confirmation prompts
  --dry-run          Print the plan without writing anything
  --config <path>    Read choices from a JSON or JSONC file instead of prompting
  -h, --help         Show this help

Exit codes:
  0  success
  1  usage error
  2  cancelled
  3  execution error
`.trim()

function parseArgs(argv: string[]): ParsedArgs {
	const args: ParsedArgs = {
		command: 'unknown',
		yes: false,
		dryRun: false,
		help: false
	}

	const positionals: string[] = []
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i]
		if (a === undefined) continue
		if (a === '-h' || a === '--help') {
			args.help = true
		} else if (a === '--yes') {
			args.yes = true
		} else if (a === '--dry-run') {
			args.dryRun = true
		} else if (a === '--config') {
			const next = argv[++i]
			if (next !== undefined) args.configPath = next
		} else if (a.startsWith('--')) {
			// unknown flag — fall through; keeps things forgiving for now
		} else {
			positionals.push(a)
		}
	}

	const first = positionals[0]
	if (first === 'new') {
		args.command = 'new'
		const out = positionals[1]
		if (out !== undefined) args.outDir = out
	} else if (args.help && positionals.length === 0) {
		args.command = 'help'
	} else if (positionals.length === 0 && argv.length > 0 && !args.help) {
		args.command = 'unknown'
	} else {
		args.command = 'unknown'
	}

	return args
}

async function loadFromConfig(path: string): Promise<GvKitConfig> {
	const raw = await readFile(resolve(path), 'utf-8')
	return validate(parseJsonc(raw))
}

async function runNew(args: ParsedArgs): Promise<number> {
	if (!args.outDir) {
		process.stderr.write('Error: <out-dir> is required for `new`\n\n')
		process.stderr.write(HELP + '\n')
		return 1
	}

	intro('gv-kit')

	let cfg: GvKitConfig
	if (args.configPath) {
		cfg = await loadFromConfig(args.configPath)
	} else {
		const collected = await collect()
		cfg = validate({
			configVersion: 2,
			choices: collected.choices
		})
	}

	const entries = buildScaffoldPlan(cfg)

	const proceed = await confirm(entries, { yes: args.yes, dryRun: args.dryRun })
	if (!proceed) {
		outro('Cancelled.')
		return 2
	}

	if (args.dryRun) {
		process.stdout.write('Dry run — no files written.\n')
		outro('Done.')
		return 0
	}

	try {
		await execute(resolve(args.outDir), entries)
	} catch (err) {
		process.stderr.write(
			`\nExecution failed: ${err instanceof Error ? err.message : String(err)}\n`
		)
		return 3
	}

	outro(`Scaffold complete: ${args.outDir}`)
	return 0
}

async function main(): Promise<number> {
	const argv = process.argv.slice(2)
	const args = parseArgs(argv)

	if (args.help || args.command === 'help' || argv.length === 0) {
		process.stdout.write(HELP + '\n')
		return argv.length === 0 ? 1 : 0
	}

	if (args.command === 'new') {
		return runNew(args)
	}

	process.stderr.write('Unknown command.\n\n')
	process.stderr.write(HELP + '\n')
	return 1
}

main().then((code) => process.exit(code))
