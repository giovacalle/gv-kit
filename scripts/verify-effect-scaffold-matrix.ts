import { spawn } from 'node:child_process'
import { access, mkdir, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { buildScaffoldPlan } from '../src/pipeline/plan.js'
import { GvKitConfig, type GvKitConfig as ParsedConfig } from '../src/schema/config.js'

const PNPM_VERSION = '11.1.1'

const AXES = {
	deploy: ['cf-workers', 'docker', 'skip'],
	db: ['sqlite', 'postgres'],
	auth: ['none', 'google', 'emailOTP', 'emailOTP+google'],
	apiClient: ['hey-api', 'skip'],
	i18n: ['paraglide', 'skip'],
	email: ['resend', 'notifuse', 'skip'],
	monitoring: ['none', 'umami', 'posthog', 'both'],
	aiTooling: [
		'none',
		'claude',
		'codex',
		'opencode',
		'claude+codex',
		'claude+opencode',
		'codex+opencode',
		'claude+codex+opencode'
	]
} as const

type AxisName = keyof typeof AXES
type MatrixChoices = { [K in AxisName]: (typeof AXES)[K][number] }

export type EffectMatrixEntry = {
	id: string
	choices: MatrixChoices
	config: ParsedConfig
}

export const UNSUPPORTED_EFFECT_CASES = [
	{
		id: 'inside-frontend-effect',
		mutate: (raw: RawConfig) => {
			raw.choices.backend = 'inside-frontend'
		},
		expected: 'backendRuntime="effect" requires backend="hono"'
	},
	{
		id: 'inside-frontend-hey-api-effect',
		mutate: (raw: RawConfig) => {
			raw.choices.backend = 'inside-frontend'
			raw.choices.apiClient = 'hey-api'
		},
		expected: 'apiClient must be "skip" when backend is "inside-frontend"'
	},
	{
		id: 'email-otp-without-mailer',
		mutate: (raw: RawConfig) => {
			raw.choices.auth = ['emailOTP']
			raw.choices.email = 'skip'
		},
		expected: 'emailOTP requires an email provider (resend or notifuse)'
	}
] as const

type RawConfig = {
	configVersion: 1
	choices: {
		name: string
		frontend: 'sveltekit'
		backend: 'hono' | 'inside-frontend'
		backendRuntime?: 'promise' | 'effect'
		i18n: 'paraglide' | 'skip'
		monitoring: Array<'umami' | 'posthog'>
		db: 'postgres' | 'sqlite'
		apiClient: 'hey-api' | 'skip'
		auth: Array<'emailOTP' | 'google'>
		email: 'resend' | 'notifuse' | 'skip'
		aiTooling: Array<'claude' | 'codex' | 'opencode'>
		deploy: 'cf-workers' | 'docker' | 'skip'
	}
}

const axisNames = Object.keys(AXES) as AxisName[]

function isSupported(choices: MatrixChoices): boolean {
	return !choices.auth.includes('emailOTP') || choices.email !== 'skip'
}

function extendChoicesByAxis(
	rows: Array<Partial<MatrixChoices>>,
	axis: AxisName
): Array<Partial<MatrixChoices>> {
	return rows.flatMap((row) => AXES[axis].map((value) => ({ ...row, [axis]: value })))
}

function allSupportedChoices(): MatrixChoices[] {
	let rows: Array<Partial<MatrixChoices>> = [{}]
	for (const axis of axisNames) rows = extendChoicesByAxis(rows, axis)
	return (rows as MatrixChoices[]).filter(isSupported)
}

function pairKeys(choices: MatrixChoices): string[] {
	return axisNames.flatMap((leftAxis, left) =>
		axisNames
			.slice(left + 1)
			.map((rightAxis) => `${leftAxis}=${choices[leftAxis]}|${rightAxis}=${choices[rightAxis]}`)
	)
}

function selectPairwiseRowsCoveringAllSupportedPairs(): MatrixChoices[] {
	const supportedChoices = allSupportedChoices()
	const uncovered = new Set(supportedChoices.flatMap(pairKeys))
	const selected: MatrixChoices[] = []

	while (uncovered.size > 0) {
		let best: MatrixChoices | undefined
		let bestScore = -1
		for (const candidate of supportedChoices) {
			const score = pairKeys(candidate).filter((pair) => uncovered.has(pair)).length
			if (score > bestScore) {
				best = candidate
				bestScore = score
			}
		}
		if (!best || bestScore <= 0) throw new Error('Unable to complete the Effect pairwise matrix')
		selected.push(best)
		for (const pair of pairKeys(best)) uncovered.delete(pair)
	}

	return selected
}

function authChoices(value: MatrixChoices['auth']): Array<'emailOTP' | 'google'> {
	if (value === 'none') return []
	if (value === 'emailOTP+google') return ['emailOTP', 'google']
	return [value]
}

function monitoringChoices(value: MatrixChoices['monitoring']): Array<'umami' | 'posthog'> {
	if (value === 'none') return []
	if (value === 'both') return ['umami', 'posthog']
	return [value]
}

function aiToolingChoices(
	value: MatrixChoices['aiTooling']
): Array<'claude' | 'codex' | 'opencode'> {
	if (value === 'none') return []
	return value.split('+') as Array<'claude' | 'codex' | 'opencode'>
}

function toRawConfig(choices: MatrixChoices, index: number): RawConfig {
	return {
		configVersion: 1,
		choices: {
			name: `effect-matrix-${String(index + 1).padStart(2, '0')}`,
			frontend: 'sveltekit',
			backend: 'hono',
			backendRuntime: 'effect',
			i18n: choices.i18n,
			monitoring: monitoringChoices(choices.monitoring),
			db: choices.db,
			apiClient: choices.apiClient,
			auth: authChoices(choices.auth),
			email: choices.email,
			aiTooling: aiToolingChoices(choices.aiTooling),
			deploy: choices.deploy
		}
	}
}

export const EFFECT_SCAFFOLD_MATRIX: EffectMatrixEntry[] =
	selectPairwiseRowsCoveringAllSupportedPairs().map((choices, index) => {
		const id = `m${String(index + 1).padStart(2, '0')}`
		return { id, choices, config: GvKitConfig.parse(toRawConfig(choices, index)) }
	})

export const EFFECT_SUPPORTED_CARTESIAN_ROWS = allSupportedChoices().length

export function uncoveredSupportedPairs(entries = EFFECT_SCAFFOLD_MATRIX): string[] {
	const covered = new Set(entries.flatMap((entry) => pairKeys(entry.choices)))
	return [...new Set(allSupportedChoices().flatMap(pairKeys))].filter((pair) => !covered.has(pair))
}

type CommandResult = {
	command: string
	status: 'passed' | 'failed' | 'skipped'
	durationMs: number
	logPath: string
	exitCode?: number
}

type EntryResult = {
	id: string
	configuration: MatrixChoices
	artifactPath: string
	status: 'passed' | 'failed'
	durationMs: number
	commands: CommandResult[]
}

async function materialize(entry: EffectMatrixEntry, outDir: string): Promise<void> {
	await rm(outDir, { recursive: true, force: true })
	await mkdir(outDir, { recursive: true })
	for (const file of buildScaffoldPlan(entry.config)) {
		const target = join(outDir, file.path)
		await mkdir(resolve(target, '..'), { recursive: true })
		await writeFile(target, file.content, { encoding: 'utf8', mode: file.mode })
	}
}

type RunCommandOptions = {
	command: string
	args: string[]
	cwd: string
	logPath: string
	binPath: string
	environment?: Record<string, string>
}

async function runCommand({
	command,
	args,
	cwd,
	logPath,
	binPath,
	environment = {}
}: RunCommandOptions): Promise<CommandResult> {
	const started = performance.now()
	const result = await new Promise<{ exitCode: number; output: string }>((done, reject) => {
		const child = spawn(command, args, {
			cwd,
			env: {
				...process.env,
				CI: '1',
				TURBO_FORCE: 'true',
				PATH: `${binPath}:${process.env.PATH ?? ''}`,
				...environment
			},
			stdio: ['ignore', 'pipe', 'pipe']
		})
		let output = ''
		child.stdout.on('data', (chunk) => (output += chunk.toString()))
		child.stderr.on('data', (chunk) => (output += chunk.toString()))
		child.on('error', reject)
		child.on('close', (code) => done({ exitCode: code ?? 1, output }))
	})
	await writeFile(logPath, `$ ${command} ${args.join(' ')}\n\n${result.output}`)
	return {
		command: `${command} ${args.join(' ')}`,
		status: result.exitCode === 0 ? 'passed' : 'failed',
		durationMs: Math.round(performance.now() - started),
		logPath,
		exitCode: result.exitCode
	}
}

async function startUsersApi({
	cwd,
	binPath,
	logPath
}: {
	cwd: string
	binPath: string
	logPath: string
}): Promise<{ result: CommandResult; stop: () => Promise<void> }> {
	const started = performance.now()
	const command = 'corepack pnpm@11.1.1 --filter ./apps/api/users dev'
	const url = 'http://127.0.0.1:8788/openapi.json'
	const child = spawn(
		'corepack',
		['pnpm@11.1.1', '--filter', './apps/api/users', 'dev'],
		{
			cwd,
			detached: true,
			env: {
				...process.env,
				CI: '1',
				PATH: `${binPath}:${process.env.PATH ?? ''}`
			},
			stdio: ['ignore', 'pipe', 'pipe']
		}
	)
	let output = ''
	let spawnError: Error | undefined
	let stopped = false
	child.stdout.on('data', (chunk) => (output += chunk.toString()))
	child.stderr.on('data', (chunk) => (output += chunk.toString()))
	child.on('error', (error) => (spawnError = error))

	const stop = async () => {
		if (stopped) return
		stopped = true
		if (child.exitCode === null && child.pid) {
			try {
				process.kill(-child.pid, 'SIGTERM')
			} catch {
				child.kill('SIGTERM')
			}
			await delay(500)
			if (child.exitCode === null) {
				try {
					process.kill(-child.pid, 'SIGKILL')
				} catch {
					child.kill('SIGKILL')
				}
			}
		}
		await writeFile(logPath, `$ ${command}\n\n${output}`)
	}

	const deadline = Date.now() + 30_000
	let ready = false
	while (!spawnError && child.exitCode === null && Date.now() < deadline) {
		try {
			const response = await fetch(url)
			if (response.ok) {
				ready = true
				break
			}
		} catch {
			// The server is still starting.
		}
		await delay(250)
	}

	const result: CommandResult = {
		command,
		status: ready ? 'passed' : 'failed',
		durationMs: Math.round(performance.now() - started),
		logPath,
		...(ready ? {} : { exitCode: child.exitCode ?? 1 })
	}
	if (!ready) await stop()
	return { result, stop }
}

async function verifyArtifact(path: string, logPath: string): Promise<CommandResult> {
	const started = performance.now()
	try {
		await access(path)
		await writeFile(logPath, `Verified generated artifact: ${path}\n`)
		return {
			command: `assert generated artifact ${path}`,
			status: 'passed',
			durationMs: Math.round(performance.now() - started),
			logPath
		}
	} catch (error) {
		await writeFile(logPath, `Missing generated artifact: ${path}\n${String(error)}\n`)
		return {
			command: `assert generated artifact ${path}`,
			status: 'failed',
			durationMs: Math.round(performance.now() - started),
			logPath
		}
	}
}

async function verifyParaglideDeclarations(artifactPath: string): Promise<CommandResult> {
	return verifyArtifact(
		join(artifactPath, 'packages/i18n/src/paraglide/runtime.d.ts'),
		join(artifactPath, 'i18n-declarations.log')
	)
}

async function verifyEntry(entry: EffectMatrixEntry, root: string): Promise<EntryResult> {
	const started = performance.now()
	const artifactPath = join(root, entry.id)
	await materialize(entry, artifactPath)
	await writeFile(join(artifactPath, 'matrix-configuration.json'), JSON.stringify(entry, null, 2))
	const binPath = join(root, '.bin')
	await mkdir(binPath, { recursive: true })
	await writeFile(join(binPath, 'pnpm'), '#!/bin/sh\nexec corepack pnpm@11.1.1 "$@"\n', {
		mode: 0o755
	})

	const commands: CommandResult[] = []
	const verifiesContract = entry.config.choices.apiClient === 'hey-api'
	const gates: Array<{ label: string; args: string[] }> = [
		{ label: 'install', args: ['pnpm@11.1.1', 'install'] },
		{ label: 'test', args: ['pnpm@11.1.1', 'test'] },
		...(verifiesContract
			? [{ label: 'client-generate', args: ['pnpm@11.1.1', 'client:generate'] }]
			: []),
		{ label: 'typecheck', args: ['pnpm@11.1.1', 'typecheck'] },
		{ label: 'lint', args: ['pnpm@11.1.1', 'lint'] },
		{ label: 'build', args: ['pnpm@11.1.1', 'build'] }
	]
	const mailerRebuildGate = {
		label: 'mailer-rebuild',
		args: ['pnpm@11.1.1', '--filter', '@repo/mailer', 'build']
	}
	const rebuildsMailer =
		entry.config.choices.i18n === 'paraglide' && entry.config.choices.email === 'resend'
	if (rebuildsMailer) gates.push(mailerRebuildGate)

	for (const gate of gates) {
		if (commands.some((result) => result.status === 'failed')) {
			commands.push({
				command: `corepack ${gate.args.join(' ')}`,
				status: 'skipped',
				durationMs: 0,
				logPath: join(artifactPath, `${gate.label}.log`)
			})
			continue
		}
		console.log(`[effect-matrix] ${entry.id}: ${gate.label}`)
		if (gate.label === 'client-generate') {
			const server = await startUsersApi({
				cwd: artifactPath,
				binPath,
				logPath: join(artifactPath, 'users-api.log')
			})
			commands.push(server.result)
			try {
				if (server.result.status === 'passed') {
					commands.push(
						await runCommand({
							command: 'corepack',
							args: gate.args,
							cwd: artifactPath,
							logPath: join(artifactPath, `${gate.label}.log`),
							binPath,
							environment: { OPENAPI_URL: 'http://127.0.0.1:8788/openapi.json' }
						})
					)
				}
			} finally {
				await server.stop()
			}
			continue
		}
		commands.push(
			await runCommand({
				command: 'corepack',
				args: gate.args,
				cwd: artifactPath,
				logPath: join(artifactPath, `${gate.label}.log`),
				binPath
			})
		)
		const builtParaglide =
			gate.label === 'build' &&
			commands.at(-1)?.status === 'passed' &&
			entry.config.choices.i18n === 'paraglide'
		if (builtParaglide) commands.push(await verifyParaglideDeclarations(artifactPath))
	}

	return {
		id: entry.id,
		configuration: entry.choices,
		artifactPath,
		status: commands.every((command) => command.status === 'passed') ? 'passed' : 'failed',
		durationMs: Math.round(performance.now() - started),
		commands
	}
}

function rejectionEvidence() {
	return UNSUPPORTED_EFFECT_CASES.map((unsupported, index) => {
		const raw = toRawConfig(
			{
				deploy: 'cf-workers',
				db: 'sqlite',
				auth: 'none',
				apiClient: 'skip',
				i18n: 'skip',
				email: 'resend',
				monitoring: 'none',
				aiTooling: 'none'
			},
			index
		)
		unsupported.mutate(raw)
		const parsed = GvKitConfig.safeParse(raw)
		const messages = parsed.success ? [] : parsed.error.issues.map((issue) => issue.message)
		const output = parsed.success ? 'ACCEPTED' : JSON.stringify(parsed.error.issues)
		return {
			id: unsupported.id,
			expected: unsupported.expected,
			output,
			status: !parsed.success && messages.includes(unsupported.expected) ? 'passed' : 'failed'
		}
	})
}

function markdownReport(results: EntryResult[], rejections: ReturnType<typeof rejectionEvidence>) {
	const supportedCartesianRows = EFFECT_SUPPORTED_CARTESIAN_ROWS
	const lines = [
		'# Effect scaffold matrix report',
		'',
		`pnpm: ${PNPM_VERSION}`,
		`Pairwise matrix: ${EFFECT_SCAFFOLD_MATRIX.length} selected from ${supportedCartesianRows} canonical prompt-reachable schema-valid Cartesian rows; ${supportedCartesianRows - EFFECT_SCAFFOLD_MATRIX.length} exhaustive rows skipped by the allowed pairwise substitute; ${uncoveredSupportedPairs().length} supported option pairs uncovered.`,
		'Canonical multiselect values cover every monitoring subset (none, Umami, PostHog, both) and every Claude/Codex/OpenCode subset. Reordered or duplicate array encodings accepted by the schema are not separate prompt-reachable choices and are not enumerated as distinct rows.',
		`Entries executed in this run: ${results.length}. Use \`--entry <id>\` to shard the same matrix in CI.`,
		'',
		'| Entry | Configuration | Commands | Result | Duration | Artifact |',
		'| --- | --- | --- | --- | ---: | --- |'
	]
	for (const result of results) {
		const configuration = axisNames
			.map((axis) => `${axis}=${result.configuration[axis]}`)
			.join(', ')
		const commands = result.commands
			.map(
				(command) =>
					`\`${command.command}\` (${command.status}, ${(command.durationMs / 1000).toFixed(1)}s)`
			)
			.join('<br>')
		lines.push(
			`| ${result.id} | ${configuration} | ${commands} | ${result.status} | ${(result.durationMs / 1000).toFixed(1)}s | ${result.artifactPath} |`
		)
	}
	lines.push('', '## Unsupported combinations', '')
	for (const rejection of rejections) lines.push(`- ${rejection.id}: ${rejection.status} — \`${rejection.output}\``)
	return `${lines.join('\n')}\n`
}

function parseArgs(argv: string[]) {
	let output = resolve('.scratch/effect-scaffold-matrix')
	let entry: string | undefined
	let list = false
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index]
		if (arg === '--output') output = resolve(argv[++index] ?? output)
		else if (arg === '--entry') entry = argv[++index]
		else if (arg === '--list') list = true
		else throw new Error(`Unknown argument: ${arg}`)
	}
	return { output, entry, list }
}

function formatMatrixEntry(entry: EffectMatrixEntry): string {
	return `${entry.id}\t${JSON.stringify(entry.choices)}`
}

async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2))
	if (args.list) {
		for (const entry of EFFECT_SCAFFOLD_MATRIX) console.log(formatMatrixEntry(entry))
		return
	}
	const entries = args.entry
		? EFFECT_SCAFFOLD_MATRIX.filter((entry) => entry.id === args.entry)
		: EFFECT_SCAFFOLD_MATRIX
	if (entries.length === 0) throw new Error(`Unknown matrix entry: ${args.entry}`)
	const hasUncoveredPairs = uncoveredSupportedPairs().length > 0
	if (hasUncoveredPairs) throw new Error('Effect matrix has uncovered supported pairs')

	await mkdir(args.output, { recursive: true })
	const rejections = rejectionEvidence()
	await writeFile(
		join(args.output, 'unsupported-rejections.json'),
		JSON.stringify(rejections, null, 2)
	)
	const results: EntryResult[] = []
	for (const entry of entries) {
		results.push(await verifyEntry(entry, args.output))
		await writeFile(
			join(args.output, 'report.json'),
			JSON.stringify(
				{
					pnpmVersion: PNPM_VERSION,
					supportedCartesianRows: EFFECT_SUPPORTED_CARTESIAN_ROWS,
					pairwiseEntries: EFFECT_SCAFFOLD_MATRIX.length,
					skippedByPairwiseSubstitute:
						EFFECT_SUPPORTED_CARTESIAN_ROWS - EFFECT_SCAFFOLD_MATRIX.length,
					uncoveredSupportedPairs: uncoveredSupportedPairs(),
					results,
					rejections
				},
				null,
				2
			)
		)
		await writeFile(join(args.output, 'report.md'), markdownReport(results, rejections))
	}

	const hasFailedRejection = rejections.some((rejection) => rejection.status === 'failed')
	if (hasFailedRejection) throw new Error('Unsupported Effect combination accepted')
	const failures = results.filter((result) => result.status === 'failed')
	const failedEntryIds = failures.map((failure) => failure.id).join(', ')
	if (failures.length > 0) throw new Error(`Effect matrix failed: ${failedEntryIds}`)
	console.log(
		`[effect-matrix] ${results.length} entries passed; report: ${join(args.output, 'report.md')}`
	)
}

function reportFailure(error: unknown): void {
	console.error(error instanceof Error ? error.message : String(error))
	process.exitCode = 1
}

if (import.meta.main) main().catch(reportFailure)
