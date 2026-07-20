import { spawn } from 'node:child_process'
import { access, mkdir, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { buildScaffoldPlan } from '../src/pipeline/plan.js'
import {
	GvKitConfig,
	type Choices,
	type GvKitConfig as ParsedConfig
} from '../src/schema/config.js'

const AXES = {
	topology: ['hono', 'inside-frontend'],
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
export type AstroMatrixChoices = { [K in AxisName]: (typeof AXES)[K][number] }

export type AstroMatrixEntry = {
	id: string
	choices: AstroMatrixChoices
	config: ParsedConfig
}

type RawConfig = { configVersion: 2; choices: Choices }

function unsupportedBase(name: string): RawConfig {
	return {
		configVersion: 2,
		choices: {
			name,
			frontend: 'sveltekit',
			marketing: 'astro',
			backend: 'hono',
			i18n: 'skip',
			monitoring: [],
			db: 'sqlite',
			apiClient: 'skip',
			auth: [],
			email: 'skip',
			aiTooling: [],
			deploy: 'skip'
		}
	}
}

const insideHeyApi = unsupportedBase('astro-invalid-inside-hey-api')
insideHeyApi.choices.backend = 'inside-frontend'
insideHeyApi.choices.apiClient = 'hey-api'

const otpWithoutMailer = unsupportedBase('astro-invalid-otp-mailer')
otpWithoutMailer.choices.auth = ['emailOTP']

export const UNSUPPORTED_ASTRO_CASES = [
	{
		id: 'inside-frontend-hey-api',
		config: insideHeyApi,
		expected: 'apiClient must be "skip" when backend is "inside-frontend"'
	},
	{
		id: 'email-otp-without-mailer',
		config: otpWithoutMailer,
		expected: 'emailOTP requires an email provider (resend or notifuse)'
	}
] as const

const axisNames = Object.keys(AXES) as AxisName[]

function isSupported(choices: AstroMatrixChoices): boolean {
	if (choices.topology === 'inside-frontend' && choices.apiClient !== 'skip') return false
	return !choices.auth.includes('emailOTP') || choices.email !== 'skip'
}

function extendChoicesByAxis(
	rows: Array<Partial<AstroMatrixChoices>>,
	axis: AxisName
): Array<Partial<AstroMatrixChoices>> {
	return rows.flatMap((row) => AXES[axis].map((value) => ({ ...row, [axis]: value })))
}

function allSupportedChoices(): AstroMatrixChoices[] {
	let rows: Array<Partial<AstroMatrixChoices>> = [{}]
	for (const axis of axisNames) rows = extendChoicesByAxis(rows, axis)
	return (rows as AstroMatrixChoices[]).filter(isSupported)
}

function pairKeys(choices: AstroMatrixChoices): string[] {
	return axisNames.flatMap((leftAxis, left) =>
		axisNames
			.slice(left + 1)
			.map((rightAxis) => `${leftAxis}=${choices[leftAxis]}|${rightAxis}=${choices[rightAxis]}`)
	)
}

function selectPairwiseRowsCoveringAllSupportedPairs(): AstroMatrixChoices[] {
	const supportedChoices = allSupportedChoices()
	const uncovered = new Set(supportedChoices.flatMap(pairKeys))
	const selected: AstroMatrixChoices[] = []

	while (uncovered.size > 0) {
		let best: AstroMatrixChoices | undefined
		let bestScore = -1
		for (const candidate of supportedChoices) {
			const score = pairKeys(candidate).filter((pair) => uncovered.has(pair)).length
			if (score > bestScore) {
				best = candidate
				bestScore = score
			}
		}
		if (!best || bestScore <= 0) throw new Error('Unable to complete the Astro pairwise matrix')
		selected.push(best)
		for (const pair of pairKeys(best)) uncovered.delete(pair)
	}

	return selected
}

function authChoices(value: AstroMatrixChoices['auth']): Array<'emailOTP' | 'google'> {
	if (value === 'none') return []
	if (value === 'emailOTP+google') return ['emailOTP', 'google']
	return [value]
}

function monitoringChoices(value: AstroMatrixChoices['monitoring']): Array<'umami' | 'posthog'> {
	if (value === 'none') return []
	if (value === 'both') return ['umami', 'posthog']
	return [value]
}

function aiToolingChoices(
	value: AstroMatrixChoices['aiTooling']
): Array<'claude' | 'codex' | 'opencode'> {
	if (value === 'none') return []
	return value.split('+') as Array<'claude' | 'codex' | 'opencode'>
}

function toConfig(choices: AstroMatrixChoices, index: number): ParsedConfig {
	const insideFrontend = choices.topology === 'inside-frontend'
	return GvKitConfig.parse({
		configVersion: 2,
		choices: {
			name: `astro-matrix-${String(index + 1).padStart(2, '0')}`,
			frontend: 'sveltekit',
			marketing: 'astro',
			backend: insideFrontend ? 'inside-frontend' : 'hono',
			i18n: choices.i18n,
			monitoring: monitoringChoices(choices.monitoring),
			db: choices.db,
			apiClient: choices.apiClient,
			auth: authChoices(choices.auth),
			email: choices.email,
			aiTooling: aiToolingChoices(choices.aiTooling),
			deploy: choices.deploy
		}
	})
}

const supportedChoices = allSupportedChoices()

export const ASTRO_SCAFFOLD_MATRIX: AstroMatrixEntry[] =
	selectPairwiseRowsCoveringAllSupportedPairs().map((choices, index) => ({
		id: `m${String(index + 1).padStart(2, '0')}`,
		choices,
		config: toConfig(choices, index)
	}))

export const ASTRO_SUPPORTED_CARTESIAN_ROWS = supportedChoices.length

export function uncoveredSupportedPairs(entries = ASTRO_SCAFFOLD_MATRIX): string[] {
	const covered = new Set(entries.flatMap((entry) => pairKeys(entry.choices)))
	return [...new Set(supportedChoices.flatMap(pairKeys))].filter((pair) => !covered.has(pair))
}

const PNPM_VERSION = '11.1.1'
const COMMON_GATE_NAMES = ['install', 'test', 'typecheck', 'lint', 'build', 'deploy-artifacts']

export function matrixGateNames(deploy: AstroMatrixChoices['deploy']): string[] {
	if (deploy === 'docker') return [...COMMON_GATE_NAMES, 'docker-compose-config']
	if (deploy === 'cf-workers') {
		return [...COMMON_GATE_NAMES, 'marketing-wrangler-dry-run', 'web-wrangler-dry-run']
	}
	return [...COMMON_GATE_NAMES]
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
	configuration: AstroMatrixChoices
	artifactPath: string
	status: 'passed' | 'failed'
	durationMs: number
	commands: CommandResult[]
}

const matrixEnvironment = {
	PUBLIC_MARKETING_URL: 'https://marketing.example.test',
	PUBLIC_APP_URL: 'https://app.example.test',
	PUBLIC_AUTH_URL: 'https://auth.example.test/api/auth',
	PUBLIC_API_URL: 'https://api.example.test',
	PUBLIC_UMAMI_HOST: 'https://stats.example.test',
	PUBLIC_UMAMI_WEBSITE_ID: 'matrix-site',
	PUBLIC_POSTHOG_KEY: 'phc_matrix',
	PUBLIC_POSTHOG_HOST: 'https://eu.i.posthog.com',
	DATABASE_URL: 'postgres://matrix:matrix@127.0.0.1:5432/matrix',
	POSTGRES_USER: 'matrix',
	POSTGRES_PASSWORD: 'matrix',
	POSTGRES_DB: 'matrix',
	BETTER_AUTH_SECRET: 'matrix-secret-at-least-thirty-two-characters',
	GOOGLE_CLIENT_ID: 'matrix-google-client',
	GOOGLE_CLIENT_SECRET: 'matrix-google-secret',
	RESEND_API_KEY: 're_matrix',
	NOTIFUSE_API_KEY: 'matrix-notifuse-key',
	NOTIFUSE_WORKSPACE_ID: 'matrix-workspace',
	NOTIFUSE_BASE_URL: 'https://notifuse.example.test',
	TURNSTILE_SECRET_KEY: 'matrix-turnstile-secret'
} satisfies Record<string, string>

async function materialize(entry: AstroMatrixEntry, outDir: string): Promise<void> {
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
}

async function runCommand({
	command,
	args,
	cwd,
	logPath,
	binPath
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
				...matrixEnvironment
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

async function pathExists(path: string): Promise<boolean> {
	try {
		await access(path)
		return true
	} catch {
		return false
	}
}

async function verifyDeployArtifacts(
	entry: AstroMatrixEntry,
	artifactPath: string
): Promise<CommandResult> {
	const started = performance.now()
	const logPath = join(artifactPath, 'deploy-artifacts.log')
	const paths = {
		marketingWrangler: join(artifactPath, 'apps/marketing/wrangler.jsonc'),
		webWrangler: join(artifactPath, 'apps/web/wrangler.jsonc'),
		dockerfile: join(artifactPath, 'Dockerfile'),
		compose: join(artifactPath, 'docker-compose.yml')
	}
	const actual = Object.fromEntries(
		await Promise.all(
			Object.entries(paths).map(async ([key, path]) => [key, await pathExists(path)])
		)
	) as Record<keyof typeof paths, boolean>
	const expected =
		entry.choices.deploy === 'cf-workers'
			? { marketingWrangler: true, webWrangler: true, dockerfile: false, compose: false }
			: entry.choices.deploy === 'docker'
				? { marketingWrangler: false, webWrangler: false, dockerfile: true, compose: true }
				: { marketingWrangler: false, webWrangler: false, dockerfile: false, compose: false }
	const passed = Object.entries(expected).every(
		([key, value]) => actual[key as keyof typeof actual] === value
	)
	await writeFile(logPath, `${JSON.stringify({ expected, actual }, null, 2)}\n`)
	return {
		command: `assert ${entry.choices.deploy} deploy artifacts`,
		status: passed ? 'passed' : 'failed',
		durationMs: Math.round(performance.now() - started),
		logPath,
		...(passed ? {} : { exitCode: 1 })
	}
}

function commandForGate(gate: string): { command: string; args: string[] } | undefined {
	if (gate === 'install') return { command: 'corepack', args: [`pnpm@${PNPM_VERSION}`, 'install'] }
	if (['test', 'typecheck', 'lint', 'build'].includes(gate)) {
		return { command: 'corepack', args: [`pnpm@${PNPM_VERSION}`, gate] }
	}
	if (gate === 'docker-compose-config') {
		return { command: 'docker', args: ['compose', 'config', '--quiet'] }
	}
	if (gate === 'marketing-wrangler-dry-run') {
		return {
			command: 'corepack',
			args: [
				`pnpm@${PNPM_VERSION}`,
				'--dir',
				'apps/marketing',
				'exec',
				'wrangler',
				'deploy',
				'--dry-run'
			]
		}
	}
	if (gate === 'web-wrangler-dry-run') {
		return {
			command: 'corepack',
			args: [`pnpm@${PNPM_VERSION}`, '--dir', 'apps/web', 'exec', 'wrangler', 'deploy', '--dry-run']
		}
	}
	return undefined
}

async function verifyEntry(entry: AstroMatrixEntry, root: string): Promise<EntryResult> {
	const started = performance.now()
	const artifactPath = join(root, entry.id)
	await materialize(entry, artifactPath)
	await writeFile(join(artifactPath, 'matrix-configuration.json'), JSON.stringify(entry, null, 2))
	const binPath = join(root, '.bin')
	await mkdir(binPath, { recursive: true })
	await writeFile(join(binPath, 'pnpm'), `#!/bin/sh\nexec corepack pnpm@${PNPM_VERSION} "$@"\n`, {
		mode: 0o755
	})

	const commands: CommandResult[] = []
	for (const gate of matrixGateNames(entry.choices.deploy)) {
		const logPath = join(artifactPath, `${gate}.log`)
		if (commands.some((result) => result.status === 'failed')) {
			commands.push({
				command: gate,
				status: 'skipped',
				durationMs: 0,
				logPath
			})
			continue
		}
		console.log(`[astro-matrix] ${entry.id}: ${gate}`)
		if (gate === 'deploy-artifacts') {
			commands.push(await verifyDeployArtifacts(entry, artifactPath))
			continue
		}
		const invocation = commandForGate(gate)
		if (!invocation) throw new Error(`Unknown Astro matrix gate: ${gate}`)
		commands.push(
			await runCommand({
				...invocation,
				cwd: artifactPath,
				logPath,
				binPath
			})
		)
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
	return UNSUPPORTED_ASTRO_CASES.map((unsupported) => {
		const parsed = GvKitConfig.safeParse(unsupported.config)
		const messages = parsed.success ? [] : parsed.error.issues.map((issue) => issue.message)
		return {
			id: unsupported.id,
			expected: unsupported.expected,
			output: parsed.success ? 'ACCEPTED' : JSON.stringify(parsed.error.issues),
			status: !parsed.success && messages.includes(unsupported.expected) ? 'passed' : 'failed'
		}
	})
}

function markdownReport(results: EntryResult[], rejections: ReturnType<typeof rejectionEvidence>) {
	const lines = [
		'# Astro scaffold matrix report',
		'',
		`pnpm: ${PNPM_VERSION}`,
		`Pairwise matrix: ${ASTRO_SCAFFOLD_MATRIX.length} selected from ${ASTRO_SUPPORTED_CARTESIAN_ROWS} canonical prompt-reachable schema-valid Cartesian rows; ${uncoveredSupportedPairs().length} supported option pairs uncovered.`,
		`Entries executed in this run: ${results.length}. Use \`--entry <id>\` to shard the same matrix.`,
		'',
		'| Entry | Configuration | Gates | Result | Duration | Artifact |',
		'| --- | --- | --- | --- | ---: | --- |'
	]
	for (const result of results) {
		const configuration = axisNames
			.map((axis) => `${axis}=${result.configuration[axis]}`)
			.join(', ')
		const gates = result.commands
			.map((command) => `\`${command.command}\` (${command.status})`)
			.join('<br>')
		lines.push(
			`| ${result.id} | ${configuration} | ${gates} | ${result.status} | ${(result.durationMs / 1000).toFixed(1)}s | ${result.artifactPath} |`
		)
	}
	lines.push('', '## Unsupported combinations', '')
	for (const rejection of rejections) {
		lines.push(`- ${rejection.id}: ${rejection.status} — \`${rejection.output}\``)
	}
	return `${lines.join('\n')}\n`
}

function parseArgs(argv: string[]) {
	let output = resolve('.scratch/astro-scaffold-matrix')
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

async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2))
	if (args.list) {
		for (const entry of ASTRO_SCAFFOLD_MATRIX) {
			console.log(`${entry.id}\t${JSON.stringify(entry.choices)}`)
		}
		return
	}
	const entries = args.entry
		? ASTRO_SCAFFOLD_MATRIX.filter((entry) => entry.id === args.entry)
		: ASTRO_SCAFFOLD_MATRIX
	if (entries.length === 0) throw new Error(`Unknown matrix entry: ${args.entry}`)
	if (uncoveredSupportedPairs().length > 0) {
		throw new Error('Astro matrix has uncovered supported pairs')
	}

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
					supportedCartesianRows: ASTRO_SUPPORTED_CARTESIAN_ROWS,
					pairwiseEntries: ASTRO_SCAFFOLD_MATRIX.length,
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

	if (rejections.some((rejection) => rejection.status === 'failed')) {
		throw new Error('Unsupported Astro combination accepted')
	}
	const failures = results.filter((result) => result.status === 'failed')
	if (failures.length > 0) {
		throw new Error(`Astro matrix failed: ${failures.map((failure) => failure.id).join(', ')}`)
	}
	console.log(
		`[astro-matrix] ${results.length} entries passed; report: ${join(args.output, 'report.md')}`
	)
}

function reportFailure(error: unknown): void {
	console.error(error instanceof Error ? error.message : String(error))
	process.exitCode = 1
}

if (import.meta.main) main().catch(reportFailure)
