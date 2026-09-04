import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { access, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { parseJsonc } from '../src/lib/jsonc.js'
import { buildScaffoldPlan } from '../src/pipeline/plan.js'
import { GvKitConfig, type GvKitConfig as ParsedConfig } from '../src/schema/config.js'
import {
	assertPermittedWranglerInvocation,
	evidencePath,
	readCommandEvidence,
	redactArtifactText,
	unsafeArtifactFindings,
	writeSanitizedArtifact,
	type VerificationCommandEvidence
} from './gateway-verification-evidence.js'

const PNPM_VERSION = '11.1.1'
const MATERIAL_CARTESIAN_ROWS = 90
const PRIMARY_REFERENCES = [
	'https://developers.cloudflare.com/workers/best-practices/workers-best-practices/',
	'https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/',
	'https://developers.cloudflare.com/workers/wrangler/commands/',
	'https://developers.cloudflare.com/workers/wrangler/configuration/',
	'https://developers.cloudflare.com/workers/configuration/routing/routes/',
	'https://developers.cloudflare.com/workers/configuration/routing/custom-domains/'
] as const

export type GatewayMatrixEntry = {
	id: string
	fixture: string
	topology: 'hono' | 'inside-frontend'
	deploy: 'cf-workers' | 'docker' | 'skip'
	db: 'postgres' | 'sqlite'
	auth: 'auth' | 'no-auth'
	marketing: 'astro' | 'inside-web'
	apiClient: 'hey-api' | 'skip'
	configVersion: 1 | 2
	highestSeam: 'cloudflare-preview' | 'docker-runtime' | 'local-runtime' | 'generated-workspace'
	coverage: string[]
}

export const GATEWAY_SCAFFOLD_MATRIX: GatewayMatrixEntry[] = [
	{
		id: 'gcf01-auth-postgres-astro-v2',
		fixture: 'astro-cf-workers-full',
		topology: 'hono',
		deploy: 'cf-workers',
		db: 'postgres',
		auth: 'auth',
		marketing: 'astro',
		apiClient: 'hey-api',
		configVersion: 2,
		highestSeam: 'cloudflare-preview',
		coverage: ['Cloudflare auth topology', 'Astro Worker', 'PostgreSQL preview isolation']
	},
	{
		id: 'gcf02-no-auth-postgres-inside-web-v1',
		fixture: 'cf-workers-no-auth-postgres',
		topology: 'hono',
		deploy: 'cf-workers',
		db: 'postgres',
		auth: 'no-auth',
		marketing: 'inside-web',
		apiClient: 'hey-api',
		configVersion: 1,
		highestSeam: 'cloudflare-preview',
		coverage: ['Cloudflare no-auth topology', 'legacy v1 migration', 'inside-web marketing']
	},
	{
		id: 'gcf03-auth-sqlite-inside-web-v1',
		fixture: 'hono-cf-workers-passwordless',
		topology: 'hono',
		deploy: 'cf-workers',
		db: 'sqlite',
		auth: 'auth',
		marketing: 'inside-web',
		apiClient: 'hey-api',
		configVersion: 1,
		highestSeam: 'cloudflare-preview',
		coverage: ['Cloudflare D1 bindings', 'D1 preview isolation', 'D1 cleanup target']
	},
	{
		id: 'gdk01-auth-sqlite-inside-web-v1',
		fixture: 'hono-docker-sqlite-auth',
		topology: 'hono',
		deploy: 'docker',
		db: 'sqlite',
		auth: 'auth',
		marketing: 'inside-web',
		apiClient: 'hey-api',
		configVersion: 1,
		highestSeam: 'docker-runtime',
		coverage: ['Compose runtime', 'private service ports', 'dual-ingress auth and SSR']
	},
	{
		id: 'gdk02-no-auth-sqlite-astro-no-client-v2',
		fixture: 'hono-docker-no-client',
		topology: 'hono',
		deploy: 'docker',
		db: 'sqlite',
		auth: 'no-auth',
		marketing: 'astro',
		apiClient: 'skip',
		configVersion: 2,
		highestSeam: 'docker-runtime',
		coverage: [
			'Compose no-auth runtime',
			'Astro static output',
			'composed OpenAPI without a generated client'
		]
	},
	{
		id: 'glc01-auth-sqlite-inside-web-v1',
		fixture: 'hono-skip-auth-emailotp',
		topology: 'hono',
		deploy: 'skip',
		db: 'sqlite',
		auth: 'auth',
		marketing: 'inside-web',
		apiClient: 'hey-api',
		configVersion: 1,
		highestSeam: 'local-runtime',
		coverage: ['local dual ingress', 'host-only auth cookies', 'CORS and SSR transport']
	},
	{
		id: 'gif01-cloudflare-postgres-inside-web',
		fixture: 'inside-frontend-typical',
		topology: 'inside-frontend',
		deploy: 'cf-workers',
		db: 'postgres',
		auth: 'no-auth',
		marketing: 'inside-web',
		apiClient: 'skip',
		configVersion: 1,
		highestSeam: 'generated-workspace',
		coverage: ['non-Hono Cloudflare boundary', 'legacy v1 normalization', 'API client skip']
	},
	{
		id: 'gif02-docker-sqlite-inside-web',
		fixture: 'inside-frontend-docker-sqlite',
		topology: 'inside-frontend',
		deploy: 'docker',
		db: 'sqlite',
		auth: 'no-auth',
		marketing: 'inside-web',
		apiClient: 'skip',
		configVersion: 1,
		highestSeam: 'generated-workspace',
		coverage: ['non-Hono Docker boundary', 'legacy v1 normalization', 'API client skip']
	},
	{
		id: 'gif03-local-sqlite-astro',
		fixture: 'astro-skip-minimal',
		topology: 'inside-frontend',
		deploy: 'skip',
		db: 'sqlite',
		auth: 'no-auth',
		marketing: 'astro',
		apiClient: 'skip',
		configVersion: 2,
		highestSeam: 'generated-workspace',
		coverage: ['non-Hono local boundary', 'Astro with API client skip']
	}
]

export const COVERAGE_RATIONALE = [
	`The material gateway model has ${MATERIAL_CARTESIAN_ROWS} supported rows after grouping auth providers into auth/no-auth, normalizing v1 marketing to inside-web, and applying the inside-frontend auth/client constraints.`,
	'The committed matrix is a representative reduction, not a claim of full pairwise prompt coverage.',
	'Every deployment target runs both Hono and inside-frontend output. Required interaction checks cover Hono Cloudflare with both PostgreSQL/Neon and SQLite/D1, plus auth runtime seams, Astro, Hey API, and v1/v2 migration.',
	'Cloudflare cases use production and preview topology checks plus correctly positioned `wrangler deploy --dry-run` commands. No remote command is allowed.',
	'Both Docker topologies run Compose end to end: one proves auth and the other proves the no-auth transport, Astro ingress, and API-client-skip shape.',
	'The selected local Hono case runs dual-ingress, auth, CORS, cookie, SSR, known-prefix, unknown-prefix, health, and OpenAPI HTTP checks.',
	'All Hey API entries independently compose twice, reject drift, restore the document, generate the flat client, and typecheck its browser and SSR consumers.',
	'One Hono row skips Hey API while retaining composed OpenAPI and proving that client-only packages, scripts, imports, exports, and guidance are absent.',
	'The three inside-frontend entries cover Cloudflare, Docker, and skip while snapshot equality and negative topology assertions prove the gateway change did not enter non-Hono output.'
] as const

export function uncoveredMaterialValues(entries = GATEWAY_SCAFFOLD_MATRIX): string[] {
	const expected = {
		topology: ['hono', 'inside-frontend'],
		deploy: ['cf-workers', 'docker', 'skip'],
		db: ['postgres', 'sqlite'],
		auth: ['auth', 'no-auth'],
		marketing: ['astro', 'inside-web'],
		apiClient: ['hey-api', 'skip'],
		configVersion: [1, 2]
	} as const
	return Object.entries(expected).flatMap(([axis, values]) =>
		values
			.filter(
				(value) => !entries.some((entry) => entry[axis as keyof GatewayMatrixEntry] === value)
			)
			.map((value) => `${axis}=${value}`)
	)
}

const REQUIRED_MATERIAL_INTERACTIONS = [
	...(['cf-workers', 'docker', 'skip'] as const).flatMap((deploy) =>
		(['hono', 'inside-frontend'] as const).map((topology) => ({
			name: `${topology}/${deploy}`,
			matches: (entry: GatewayMatrixEntry) => entry.topology === topology && entry.deploy === deploy
		}))
	),
	{
		name: 'hono/cf-workers/postgres/cloudflare-preview',
		matches: (entry: GatewayMatrixEntry) =>
			entry.topology === 'hono' &&
			entry.deploy === 'cf-workers' &&
			entry.db === 'postgres' &&
			entry.highestSeam === 'cloudflare-preview'
	},
	{
		name: 'hono/cf-workers/sqlite/cloudflare-preview',
		matches: (entry: GatewayMatrixEntry) =>
			entry.topology === 'hono' &&
			entry.deploy === 'cf-workers' &&
			entry.db === 'sqlite' &&
			entry.highestSeam === 'cloudflare-preview'
	},
	{
		name: 'hono/docker/auth/docker-runtime',
		matches: (entry: GatewayMatrixEntry) =>
			entry.topology === 'hono' &&
			entry.deploy === 'docker' &&
			entry.auth === 'auth' &&
			entry.highestSeam === 'docker-runtime'
	},
	{
		name: 'hono/skip/auth/local-runtime',
		matches: (entry: GatewayMatrixEntry) =>
			entry.topology === 'hono' &&
			entry.deploy === 'skip' &&
			entry.auth === 'auth' &&
			entry.highestSeam === 'local-runtime'
	},
	{
		name: 'hono/cf-workers/astro',
		matches: (entry: GatewayMatrixEntry) =>
			entry.topology === 'hono' && entry.deploy === 'cf-workers' && entry.marketing === 'astro'
	},
	{
		name: 'hono/hey-api',
		matches: (entry: GatewayMatrixEntry) =>
			entry.topology === 'hono' && entry.apiClient === 'hey-api'
	},
	{
		name: 'hono/api-client-skip',
		matches: (entry: GatewayMatrixEntry) => entry.topology === 'hono' && entry.apiClient === 'skip'
	},
	{
		name: 'inside-frontend/api-client-skip',
		matches: (entry: GatewayMatrixEntry) =>
			entry.topology === 'inside-frontend' && entry.apiClient === 'skip'
	}
] as const

export function uncoveredMaterialInteractions(entries = GATEWAY_SCAFFOLD_MATRIX): string[] {
	return REQUIRED_MATERIAL_INTERACTIONS.filter(
		(interaction) => !entries.some(interaction.matches)
	).map(({ name }) => name)
}

type CommandEvidence = VerificationCommandEvidence

type AssertionEvidence = {
	name: string
	outcome: 'passed' | 'failed'
	durationMs: number
	details: unknown
}

type EntryEvidence = {
	id: string
	configuration: Omit<GatewayMatrixEntry, 'coverage'>
	coverage: string[]
	artifactPath: string
	retainedArtifacts: string[]
	outcome: 'passed' | 'failed'
	durationMs: number
	commands: CommandEvidence[]
	assertions: AssertionEvidence[]
}

type RunOptions = {
	name: string
	program: string
	args: string[]
	cwd: string
	logPath: string
	displayCommand?: string
	expectedExitCode?: number
	expectedOutput?: RegExp
	env?: Record<string, string>
}
type PnpmArgumentsOptions = {
	pnpmCommand: string
	pnpmCommandArguments?: string[]
	workspaceDirectory?: string
}

const verificationEnvironment = {
	CI: '1',
	TURBO_FORCE: 'true',
	WRANGLER_SEND_METRICS: 'false',
	PUBLIC_MARKETING_URL: 'https://marketing.example.test',
	PUBLIC_APP_URL: 'https://app.example.test',
	PUBLIC_TURNSTILE_SITE_KEY: '1x00000000000000000000AA',
	DATABASE_URL: 'postgres://matrix:matrix@127.0.0.1:5432/matrix',
	POSTGRES_USER: 'matrix',
	POSTGRES_PASSWORD: 'matrix',
	POSTGRES_DB: 'matrix',
	BETTER_AUTH_SECRET: 'matrix-only-secret-at-least-thirty-two-characters',
	BETTER_AUTH_ALLOWED_HOSTS: 'localhost:3000,localhost:5173,api.localhost:8786',
	AUTH_CORS_ORIGINS: 'http://localhost:3000,http://localhost:5173,http://api.localhost:8786',
	GATEWAY_TRUSTED_INGRESS_SECRET: 'matrix-only-gateway-ingress-secret',
	GOOGLE_CLIENT_ID: 'matrix-google-client',
	GOOGLE_CLIENT_SECRET: 'matrix-google-secret',
	RESEND_API_KEY: 're_matrix',
	FROM_EMAIL: 'verify@example.test',
	NOTIFUSE_API_KEY: 'matrix-notifuse-key',
	NOTIFUSE_WORKSPACE_ID: 'matrix-workspace',
	NOTIFUSE_BASE_URL: 'https://notifuse.example.test',
	TURNSTILE_SECRET_KEY: '1x0000000000000000000000000000000AA'
} satisfies Record<string, string>

async function runCommand(options: RunOptions): Promise<CommandEvidence> {
	const started = performance.now()
	await mkdir(dirname(options.logPath), { recursive: true })
	let output = ''
	let exitCode = 1
	try {
		assertPermittedWranglerInvocation(options.args)
		exitCode = await new Promise<number>((done, reject) => {
			const child = spawn(options.program, options.args, {
				cwd: options.cwd,
				env: {
					...process.env,
					...verificationEnvironment,
					PATH: `${join(options.cwd, '.verify-bin')}:${process.env.PATH ?? ''}`,
					...options.env
				},
				stdio: ['ignore', 'pipe', 'pipe']
			})
			child.stdout.on('data', (chunk) => (output += chunk.toString()))
			child.stderr.on('data', (chunk) => (output += chunk.toString()))
			child.on('error', reject)
			child.on('close', (code) => done(code ?? 1))
		})
	} catch (error) {
		output += `\n${error instanceof Error ? error.stack : String(error)}\n`
	}
	const command = redactArtifactText(
		options.displayCommand ?? `${options.program} ${options.args.join(' ')}`,
		[options.cwd]
	)
	await writeSanitizedArtifact({
		path: options.logPath,
		content: `$ ${command}\n\n${output}`,
		roots: [options.cwd]
	})
	const expectedExitCode = options.expectedExitCode ?? 0
	const passed =
		exitCode === expectedExitCode &&
		(options.expectedOutput === undefined || options.expectedOutput.test(output))
	return {
		name: options.name,
		command,
		outcome: passed ? 'passed' : 'failed',
		durationMs: Math.round(performance.now() - started),
		logPath: evidencePath(options.cwd, options.logPath),
		exitCode
	}
}

async function assertion(name: string, check: () => Promise<unknown>): Promise<AssertionEvidence> {
	const started = performance.now()
	try {
		return {
			name,
			outcome: 'passed',
			durationMs: Math.round(performance.now() - started),
			details: await check()
		}
	} catch (error) {
		return {
			name,
			outcome: 'failed',
			durationMs: Math.round(performance.now() - started),
			details: error instanceof Error ? error.message : String(error)
		}
	}
}

async function exists(path: string): Promise<boolean> {
	return access(path).then(
		() => true,
		() => false
	)
}

async function loadConfig(
	entry: GatewayMatrixEntry
): Promise<{ parsed: ParsedConfig; rawVersion: 1 | 2 }> {
	const raw = parseJsonc(await readFile(resolve('fixtures', `${entry.fixture}.jsonc`), 'utf8')) as {
		configVersion: 1 | 2
	}
	return { parsed: GvKitConfig.parse(raw), rawVersion: raw.configVersion }
}

async function materialize(entry: GatewayMatrixEntry, project: string): Promise<void> {
	const { parsed, rawVersion } = await loadConfig(entry)
	if (rawVersion !== entry.configVersion) throw new Error(`${entry.id} fixture version drifted`)
	await rm(project, { recursive: true, force: true })
	await mkdir(project, { recursive: true })
	for (const file of buildScaffoldPlan(parsed)) {
		const target = join(project, file.path)
		await mkdir(dirname(target), { recursive: true })
		await writeFile(target, file.content, { encoding: 'utf8', mode: file.mode })
	}
	await writeFile(join(project, 'matrix-configuration.json'), `${JSON.stringify(entry, null, 2)}\n`)
	await mkdir(join(project, '.verify-bin'), { recursive: true })
	await writeFile(
		join(project, '.verify-bin/pnpm'),
		`#!/bin/sh\nexec corepack pnpm@${PNPM_VERSION} "$@"\n`,
		{ mode: 0o755 }
	)
}

function pnpmArgs({
	pnpmCommand,
	pnpmCommandArguments = [],
	workspaceDirectory
}: PnpmArgumentsOptions): string[] {
	return [
		`pnpm@${PNPM_VERSION}`,
		...(workspaceDirectory ? ['--dir', workspaceDirectory] : []),
		pnpmCommand,
		...pnpmCommandArguments
	]
}

async function runSpecializedSeam({
	entry,
	entryRoot,
	logPath
}: {
	entry: GatewayMatrixEntry
	entryRoot: string
	logPath: string
}): Promise<
	{ command: CommandEvidence; nestedCommands: CommandEvidence[]; project: string } | undefined
> {
	const common = ['--fixture', entry.fixture, '--output', entryRoot]
	let script: string | undefined
	if (entry.highestSeam === 'cloudflare-preview') script = 'scripts/verify-gateway-cloudflare.ts'
	else if (entry.highestSeam === 'docker-runtime') script = 'scripts/verify-gateway-docker.ts'
	else if (entry.highestSeam === 'local-runtime') script = 'scripts/verify-gateway-local.ts'
	if (!script) return undefined
	const command = await runCommand({
		name: entry.highestSeam,
		program: process.execPath,
		args: ['run', script, ...common],
		cwd: resolve('.'),
		logPath,
		displayCommand: `bun run ${script} ${common.join(' ')}`
	})
	const project = join(entryRoot, entry.fixture)
	const nestedCommands = await readCommandEvidence(project).catch(() => [])
	if (command.outcome === 'passed' && nestedCommands.length === 0) throw new Error(`${entry.id} specialized seam produced no command evidence`)
	return { command, nestedCommands, project }
}

const REQUIRED_WORKSPACE_GATES = ['install', 'lint', 'typecheck', 'test', 'build'] as const

type WorkspaceGate = (typeof REQUIRED_WORKSPACE_GATES)[number]

function provesWorkspaceGate(command: CommandEvidence, gate: WorkspaceGate): boolean {
	return command.name === gate || command.name === `workspace-${gate}`
}

async function runStandardCommands({
	project,
	logs,
	commands
}: {
	project: string
	logs: string
	commands: CommandEvidence[]
}): Promise<void> {
	for (const task of REQUIRED_WORKSPACE_GATES) {
		if (commands.some((command) => command.outcome === 'failed')) break
		if (commands.some((command) => provesWorkspaceGate(command, task))) continue
		const args =
			task === 'install'
				? pnpmArgs({
					pnpmCommand: 'install',
					pnpmCommandArguments: ['--no-frozen-lockfile']
				})
				: pnpmArgs({ pnpmCommand: task })
		commands.push(
			await runCommand({
				name: task,
				program: 'corepack',
				args,
				cwd: project,
				logPath: join(logs, `${task}.log`),
				displayCommand: `corepack ${args.join(' ')}`
			})
		)
	}
}

async function workspaceGateAssertion(commands: CommandEvidence[]): Promise<AssertionEvidence> {
	return assertion('normal install, lint, typecheck, test, and build gates', async () => {
		const gates = Object.fromEntries(
			REQUIRED_WORKSPACE_GATES.map((gate) => {
				const evidence = commands.find((command) => provesWorkspaceGate(command, gate))
				if (!evidence || evidence.outcome !== 'passed') throw new Error(`${gate} gate is missing or did not pass`)
				return [gate, evidence.name]
			})
		)
		return gates
	})
}

async function verifyOpenApi({
	project,
	logs,
	commands
}: {
	project: string
	logs: string
	commands: CommandEvidence[]
}): Promise<AssertionEvidence> {
	const recordOpenApiCommand = async ({
		name,
		pnpmCommand,
		pnpmCommandArguments = [],
		expectedExitCode = 0,
		expectedOutput
	}: {
		name: string
		pnpmCommand: string
		pnpmCommandArguments?: string[]
		expectedExitCode?: number
		expectedOutput?: RegExp
	}) => {
		const pnpmArguments = pnpmArgs({
			pnpmCommand,
			pnpmCommandArguments
		})
		const result = await runCommand({
			name,
			program: 'corepack',
			args: pnpmArguments,
			cwd: project,
			logPath: join(logs, `${name}.log`),
			displayCommand: `corepack ${pnpmArguments.join(' ')}`,
			expectedExitCode,
			...(expectedOutput ? { expectedOutput } : {})
		})
		commands.push(result)
		if (result.outcome === 'failed') throw new Error(`${name} failed`)
	}
	const cleanDiagnostic = /OpenAPI is current \(sha256:[0-9a-f]{64}\)/
	const driftDiagnostic = /apps\/api\/openapi\.json drifted; run pnpm openapi:compose/
	return assertion(
		'OpenAPI composition, specific drift rejection, codegen, and typed consumers',
		async () => {
			await recordOpenApiCommand({
				name: 'openapi-check-baseline',
				pnpmCommand: 'openapi:check',
				expectedExitCode: 0,
				expectedOutput: cleanDiagnostic
			})
			await recordOpenApiCommand({
				name: 'openapi-compose-first',
				pnpmCommand: 'openapi:compose'
			})
			const path = join(project, 'apps/api/openapi.json')
			const first = await readFile(path, 'utf8')
			const firstHash = createHash('sha256').update(first).digest('hex')
			await recordOpenApiCommand({
				name: 'openapi-compose-second',
				pnpmCommand: 'openapi:compose'
			})
			const second = await readFile(path, 'utf8')
			const secondHash = createHash('sha256').update(second).digest('hex')
			if (first !== second) throw new Error('OpenAPI composition is not byte-identical')
			await writeFile(path, `${second} `)
			await recordOpenApiCommand({
				name: 'openapi-drift-rejection',
				pnpmCommand: 'openapi:check',
				expectedExitCode: 1,
				expectedOutput: driftDiagnostic
			})
			await recordOpenApiCommand({
				name: 'openapi-compose-restore',
				pnpmCommand: 'openapi:compose'
			})
			await recordOpenApiCommand({
				name: 'openapi-check-final',
				pnpmCommand: 'openapi:check',
				expectedExitCode: 0,
				expectedOutput: cleanDiagnostic
			})
			await recordOpenApiCommand({ name: 'openapi-codegen', pnpmCommand: 'codegen' })
			await recordOpenApiCommand({ name: 'typed-consumer-check', pnpmCommand: 'typecheck' })

			const packageJson = JSON.parse(
				await readFile(join(project, 'packages/openapi-client/package.json'), 'utf8')
			) as { exports?: Record<string, string> }
			const browser = await readFile(join(project, 'apps/web/src/routes/+layout.ts'), 'utf8')
			const ssr = await readFile(join(project, 'apps/web/src/routes/users/+page.server.ts'), 'utf8')
			if (JSON.stringify(packageJson.exports) !== JSON.stringify({ '.': './src/index.ts' })) throw new Error('OpenAPI client is not flat')
			if (!browser.includes("from '@repo/openapi-client'")) throw new Error('browser typed consumer missing')
			if ( !ssr.includes("from '@repo/openapi-client'") || !ssr.includes('usersGetMe({ baseUrl: url.origin, fetch })') ) throw new Error('SSR request-scoped typed consumer missing')
			return { firstHash, secondHash, driftRejected: true, clientExports: packageJson.exports }
		}
	)
}

async function snapshotAssertion(entry: GatewayMatrixEntry): Promise<AssertionEvidence> {
	return assertion('generated plan matches committed snapshot', async () => {
		const { parsed } = await loadConfig(entry)
		const manifest = buildScaffoldPlan(parsed)
			.map(
				(file) =>
					`${file.path}  ${new Bun.CryptoHasher('sha256').update(file.content).digest('hex').slice(0, 16)}`
			)
			.sort()
			.join('\n')
		const expected = (
			await readFile(resolve('fixtures/__snapshots__', `${entry.fixture}.txt`), 'utf8')
		).trimEnd()
		if (manifest !== expected) throw new Error(`${entry.fixture} differs from its snapshot`)
		return { fixture: entry.fixture, files: manifest.split('\n').length }
	})
}

async function topologyAssertion(
	entry: GatewayMatrixEntry,
	project: string
): Promise<AssertionEvidence> {
	return assertion('gateway and inside-frontend boundary', async () => {
		const apiPackage = await exists(join(project, 'apps/api/package.json'))
		const authPackage = await exists(join(project, 'services/auth/package.json'))
		const usersPackage = await exists(join(project, 'services/users/package.json'))
		if (entry.topology === 'hono' && (!apiPackage || !authPackage || !usersPackage)) throw new Error('Hono scaffold omits the gateway or a private service')
		if (entry.topology === 'inside-frontend' && (apiPackage || authPackage || usersPackage)) throw new Error('gateway topology leaked into inside-frontend output')
		return { apiPackage, authPackage, usersPackage }
	})
}

async function skippedApiClientAssertion(
	entry: GatewayMatrixEntry,
	project: string
): Promise<AssertionEvidence[]> {
	if (entry.topology !== 'hono' || entry.apiClient !== 'skip') return []
	return [
		await assertion('composed OpenAPI without client-only output', async () => {
			if (!(await exists(join(project, 'apps/api/openapi.json')))) throw new Error('composed OpenAPI is missing')
			if (await exists(join(project, 'packages/openapi-client'))) throw new Error('API client package exists despite apiClient: skip')
			const rootPackage = JSON.parse(await readFile(join(project, 'package.json'), 'utf8')) as {
				scripts?: Record<string, string>
			}
			if (rootPackage.scripts?.codegen) throw new Error('client codegen script exists')
			if (!rootPackage.scripts?.['openapi:compose'] || !rootPackage.scripts['openapi:check']) throw new Error('OpenAPI composition scripts are missing')
			const references: string[] = []
			for (const file of await collectFiles(project)) {
				if (!/\.(?:json|md|svelte|ts)$/.test(file)) continue
				const content = await readFile(file, 'utf8').catch(() => '')
				if (/(?:@repo\/openapi-client|packages\/openapi-client)/.test(content)) references.push(relative(project, file))
			}
			if (references.length > 0) throw new Error(`client-only references remain: ${references.join(', ')}`)
			return { composedOpenApi: true, clientPackage: false, clientReferences: [] }
		})
	]
}

const PRUNED_ARTIFACT_DIRECTORIES = new Set([
	'node_modules',
	'.git',
	'.turbo',
	'.svelte-kit',
	'.wrangler',
	'dist',
	'build',
	'cache',
	'paraglide',
	'.verify-bin'
])

async function pruneUnretainedArtifacts(root: string): Promise<void> {
	async function visit(directory: string): Promise<void> {
		for (const entry of await readdir(directory, { withFileTypes: true })) {
			const path = join(directory, entry.name)
			if (entry.isDirectory() && PRUNED_ARTIFACT_DIRECTORIES.has(entry.name)) await rm(path, { recursive: true, force: true })
			else if (entry.isDirectory()) await visit(path)
		}
	}
	await visit(root)
}

async function collectFiles(root: string): Promise<string[]> {
	const files: string[] = []
	async function visit(directory: string): Promise<void> {
		for (const entry of await readdir(directory, { withFileTypes: true })) {
			const path = join(directory, entry.name)
			if (entry.isDirectory()) await visit(path)
			else files.push(path)
		}
	}
	await visit(root)
	return files
}

const INTERNAL_GENERATOR_MARKER_PATTERN =
	/__(?:PROJECT|COMPAT_DATE|GATEWAY_TARGET|GATEWAY_SERVICE|GATEWAY_URL|AUTH_URL)__/g
const UMAMI_WEBSITE_ID_MARKER = '__UMAMI_WEBSITE_ID__'
const UMAMI_OUTPUT_PATH = 'apps/web/src/app.html'

export function unresolvedGeneratorMarkers({
	path,
	content,
	umamiSelected
}: {
	path: string
	content: string
	umamiSelected: boolean
}): string[] {
	const markers: string[] = content.match(INTERNAL_GENERATOR_MARKER_PATTERN) ?? []
	if ( content.includes(UMAMI_WEBSITE_ID_MARKER) && (!umamiSelected || path !== UMAMI_OUTPUT_PATH) ) markers.push(UMAMI_WEBSITE_ID_MARKER)
	return [...new Set(markers)]
}

async function residueAssertion(
	entry: GatewayMatrixEntry,
	project: string
): Promise<AssertionEvidence> {
	return assertion('negative generated-workspace scan', async () => {
		const { parsed } = await loadConfig(entry)
		const umamiSelected = parsed.choices.monitoring.includes('umami')
		const patterns = [
			{ name: 'old service path', pattern: /apps\/api\/(?:auth|users)(?:\/|\b)/ },
			...(entry.topology === 'hono'
				? [{ name: 'direct public service variable', pattern: /PUBLIC_(?:AUTH|USERS)_URL/ }]
				: []),
			{ name: 'service-specific client export', pattern: /@repo\/openapi-client\/users/ },
			{ name: 'old public auth host', pattern: /auth\.api\.<domain>/ },
			{ name: 'private-service public URL', pattern: /https?:\/\/(?:auth|users)\.[a-z0-9.-]+/i },
			{
				name: 'credential-shaped value',
				pattern:
					/(?:AKIA[0-9A-Z]{16}|-----BEGIN (?:RSA |EC )?PRIVATE KEY-----|eyJ[a-zA-Z0-9_-]{20,}\.|sk_live_[a-zA-Z0-9]{12,})/
			}
		]
		const failures: string[] = []
		const files = await collectFiles(project)
		for (const file of files) {
			const content = await readFile(file, 'utf8').catch(() => '')
			const path = relative(project, file)
			const haystack = `${path}\n${content}`
			for (const candidate of patterns) if (candidate.pattern.test(haystack)) failures.push(`${candidate.name}: ${path}`)
			for (const marker of unresolvedGeneratorMarkers({ path, content, umamiSelected })) failures.push(`unresolved generator marker ${marker}: ${path}`)
			for (const finding of unsafeArtifactFindings(haystack)) failures.push(`${finding}: ${path}`)
		}
		if (failures.length > 0) throw new Error([...new Set(failures)].join(', '))
		return { scannedFiles: files.length, failures: [] }
	})
}

type WranglerConfig = {
	name: string
	main?: string
	assets?: unknown
	workers_dev?: boolean
	preview_urls?: boolean
	routes?: unknown[]
	services?: Array<{ binding: string; service: string }>
}

async function cloudflareChecks({
	entry,
	project,
	logs,
	commands
}: {
	entry: GatewayMatrixEntry
	project: string
	logs: string
	commands: CommandEvidence[]
}): Promise<AssertionEvidence[]> {
	if (entry.deploy !== 'cf-workers') return []
	const configs = (await collectFiles(project)).filter(
		(path) => basename(path) === 'wrangler.jsonc'
	)
	const topology = await assertion('Cloudflare route and binding topology', async () => {
		const inventory: Record<string, WranglerConfig> = {}
		for (const path of configs) inventory[relative(project, dirname(path))] = parseJsonc(await readFile(path, 'utf8'))
		if (entry.topology === 'hono') {
			const gateway = inventory['apps/api']
			const auth = inventory['services/auth']
			const users = inventory['services/users']
			if (!gateway || !auth || !users) throw new Error('Cloudflare Hono Worker inventory is incomplete')
			if ( (auth.routes?.length ?? 0) > 0 || auth.workers_dev !== false || auth.preview_urls !== false ) throw new Error('auth service has a public trigger')
			if ( (users.routes?.length ?? 0) > 0 || users.workers_dev !== false || users.preview_urls !== false ) throw new Error('users service has a public trigger')
			if (gateway.services?.map(({ binding }) => binding).join(',') !== 'AUTH,USERS') throw new Error('gateway Service Bindings drifted')
		} else if (inventory['apps/api'] || inventory['services/auth'] || inventory['services/users']) throw new Error('inside-frontend Cloudflare output contains gateway Workers')
		return inventory
	})
	for (const configPath of configs.sort()) {
		if (commands.some((command) => command.outcome === 'failed')) break
		const config = parseJsonc<WranglerConfig>(await readFile(configPath, 'utf8'))
		if (config.main === undefined && config.assets === undefined) continue
		const directory = relative(project, dirname(configPath))
		const slug = directory.replaceAll('/', '-') || 'root'
		const pnpmArguments = pnpmArgs({
			workspaceDirectory: directory,
			pnpmCommand: 'exec',
			pnpmCommandArguments: [
				'wrangler',
				'deploy',
				'--dry-run',
				'--outdir',
				`.wrangler/matrix-${entry.id}`
			]
		})
		commands.push(
			await runCommand({
				name: `wrangler-dry-run-${slug}`,
				program: 'corepack',
				args: pnpmArguments,
				cwd: project,
				logPath: join(logs, `wrangler-${slug}.log`),
				displayCommand: `corepack ${pnpmArguments.join(' ')}`
			})
		)
	}
	return [topology]
}

async function dockerChecks({
	entry,
	project,
	logs,
	commands
}: {
	entry: GatewayMatrixEntry
	project: string
	logs: string
	commands: CommandEvidence[]
}): Promise<AssertionEvidence[]> {
	if (entry.deploy !== 'docker') return []
	commands.push(
		await runCommand({
			name: 'docker-compose-config',
			program: 'docker',
			args: ['compose', 'config', '--quiet'],
			cwd: project,
			logPath: join(logs, 'docker-compose-config.log')
		})
	)
	return [
		await assertion('Docker private service ports', async () => {
			const result = await runCommand({
				name: 'docker-compose-inventory',
				program: 'docker',
				args: ['compose', 'config', '--format', 'json'],
				cwd: project,
				logPath: join(logs, 'docker-compose-inventory.log')
			})
			commands.push(result)
			if (result.outcome === 'failed') throw new Error('could not parse Compose inventory')
			const output = await readFile(resolve(project, result.logPath), 'utf8')
			const json = output.slice(output.indexOf('\n\n') + 2)
			const compose = JSON.parse(json) as { services: Record<string, { ports?: unknown[] }> }
			for (const service of ['auth', 'users']) if ((compose.services[service]?.ports?.length ?? 0) > 0) throw new Error(`${service} publishes a host port`)
			return Object.fromEntries(
				Object.entries(compose.services).map(([name, service]) => [name, service.ports ?? []])
			)
		})
	]
}

type WorkflowStep = {
	id?: string
	name?: string
	uses?: string
	run?: string
	with?: Record<string, unknown>
	env?: Record<string, string>
}

type WorkflowRunDefaults = {
	run?: Record<string, unknown>
}

type WorkflowJob = {
	defaults?: WorkflowRunDefaults
	env?: Record<string, string>
	needs?: string | string[]
	steps?: WorkflowStep[]
}

type Workflow = {
	defaults?: WorkflowRunDefaults
	env?: Record<string, string>
	jobs?: Record<string, WorkflowJob>
	on?: Record<string, unknown>
}

export type CloudflareWorkflowSources = {
	production: string
	staging: string
}

type CloudflareWorkflowStructure = {
	productionSteps: string[]
	stagingSteps: string[]
	stagingNeeds: string[]
}

const TRUSTED_PREVIEW_REF =
	'${{ github.event.pull_request.base.sha || github.event.repository.default_branch }}'
const CREDENTIAL_REFERENCE =
	/\$\{\{(?:(?!\}\})[\s\S])*\bsecrets\b(?:(?!\}\})[\s\S])*\}\}|\bneeds\s*(?:\.|\[)[^}]*\bdatabase_url\b/
const TRUSTED_PREVIEW_BUILD_HASHES = new Set([
	'68dd1c0ebf22ccfde1384b944dace657672a3c65a07e97a2a8b44e655186b6aa',
	'2346d7df60877bab7bf7876faf3662eed696eaed0fbd8dbcc4dcdf3748620f8b',
	'8186ca72b2213506d91c9f02b1d3cf3c8a115bf5dfc8ab35cd6ffca8f156fa3d'
])
const TRUSTED_CREDENTIAL_STEP_HASHES: Record<string, string[]> = {
	'Verify managed preview ingress': ['124c50cdddcfc16422308f95d49de00958720fbb6607e91f4d076b6d7baedf5e'],
	'Create or reuse Neon preview branch': ['ae00d992be77dd4bc616b66bfd0689fdecfd5590bb5e2954884ca26b1a3e9725'],
	'Create or reuse D1 preview database': ['7fb92cb9e04ec7c618382a9c7fbb3b299c80b0c9b23320ab3780fd04a2cac5b2'],
	'Apply preview Neon migrations with a trusted pinned tool': ['97131c2f2e1a9ba00fb6368da22b37f1471d87733031c3fca6d82a8d96f86417'],
	'Apply preview D1 migrations with a trusted pinned tool': ['db0f90f9f13347ed6b8bca229915abcc884bd45c4086e393beffa75bf676d9d3'],
	'Write private Worker preview secret files from trusted code': [
		'a90cfd3115298aca2981225685c4d8b733ed54f54dd2e17e38899a4471f71015',
		'445114b3d91476f2316409a2150c942a57c08299cf09fc51213e339a9932e49f',
		'090ecb7d9b5b7f772eb7a24d25a86c835aa41b79af8f53cc8a4741d49ab4908c'
	],
	'Publish prebuilt preview Workers from trusted code': [
		'19efdb1e7a9c2b3ce5e742664b017cef2be335ccc36495a1bf94d1ad6106743e',
		'20c28796fbfaa6c83432ecb2d81d3d0e17312e4bd739dd145e3b7f3dfcb23c78'
	]
}

function orderedStepNames(steps: WorkflowStep[], expected: string[]): void {
	let previous = -1
	for (const name of expected) {
		const current = steps.findIndex((step) => step.name === name)
		if (current <= previous) throw new Error(`workflow step order is invalid at ${name}`)
		previous = current
	}
}

function workflowSteps(workflow: Workflow, jobName: string): WorkflowStep[] {
	const steps = workflow.jobs?.[jobName]?.steps
	if (!Array.isArray(steps)) throw new Error(`${jobName} workflow steps are missing`)
	return steps
}

function normalizedNeeds(needs: WorkflowJob['needs']): string[] {
	if (typeof needs === 'string') return [needs]
	return needs ?? []
}

async function loadCloudflareWorkflowSources(
	input: string | CloudflareWorkflowSources
): Promise<CloudflareWorkflowSources> {
	if (typeof input !== 'string') return input
	const workflowDirectory = join(input, '.github/workflows')
	return {
		production: await readFile(join(workflowDirectory, 'deploy-production.yml'), 'utf8'),
		staging: await readFile(join(workflowDirectory, 'deploy-staging.yml'), 'utf8')
	}
}

function workflowValueHash(value: unknown): string {
	return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function hasExactTrustedCredentialStep(step: WorkflowStep): boolean {
	const expected = TRUSTED_CREDENTIAL_STEP_HASHES[step.name ?? ''] ?? []
	return expected.includes(workflowValueHash(step))
}

function isTrustedCredentialStep(jobName: string, step: WorkflowStep): boolean {
	if (jobName === 'preview-ingress') return step.name === 'Verify managed preview ingress' && hasExactTrustedCredentialStep(step)
	if (jobName === 'preview-db') return ['Create or reuse Neon preview branch', 'Create or reuse D1 preview database'].includes(step.name ?? '') && hasExactTrustedCredentialStep(step)
	if (jobName !== 'deploy') return false
	return hasExactTrustedCredentialStep(step)
}

function assertTrustedCredentialBoundary(staging: Workflow): void {
	if (CREDENTIAL_REFERENCE.test(JSON.stringify(staging.env))) throw new Error('preview workflow exposes provider credentials at workflow scope')
	if (staging.defaults?.run) throw new Error('preview workflow overrides execution for credentialed steps')
	for (const [jobName, job] of Object.entries(staging.jobs ?? {})) {
		const { steps = [], ...jobConfiguration } = job
		if (CREDENTIAL_REFERENCE.test(JSON.stringify(jobConfiguration))) throw new Error(`${jobName} exposes provider credentials at job scope`)
		const credentialStepIndexes = steps.flatMap((step, index) =>
			CREDENTIAL_REFERENCE.test(JSON.stringify(step)) ? [index] : []
		)
		if (jobName === 'build-preview' && credentialStepIndexes.length > 0) throw new Error('PR-controlled preview build receives provider credentials')
		if (credentialStepIndexes.length > 0 && job.defaults?.run) throw new Error(`${jobName} overrides execution for credentialed steps`)
		for (const index of credentialStepIndexes) if (!isTrustedCredentialStep(jobName, steps[index]!)) throw new Error(`${jobName} exposes provider credentials to an untrusted step`)
		if (!['preview-ingress', 'deploy'].includes(jobName) || credentialStepIndexes.length === 0) continue
		const checkoutIndex = steps.findIndex(
			(step) =>
				step.uses === 'actions/checkout@v4' && step.with?.ref === TRUSTED_PREVIEW_REF
		)
		if (checkoutIndex < 0 || credentialStepIndexes.some((index) => index <= checkoutIndex)) throw new Error(`${jobName} uses provider credentials without an earlier trusted checkout`)
	}
	if (!TRUSTED_PREVIEW_BUILD_HASHES.has(workflowValueHash(staging.jobs?.['build-preview']))) throw new Error('preview build job does not match trusted passive structure')
}

export async function validateCloudflareWorkflowStructure(
	input: string | CloudflareWorkflowSources,
	entry: GatewayMatrixEntry
): Promise<CloudflareWorkflowStructure> {
	const sources = await loadCloudflareWorkflowSources(input)
	const production = Bun.YAML.parse(sources.production) as Workflow
	const staging = Bun.YAML.parse(sources.staging) as Workflow
	const productionSteps = workflowSteps(production, 'deploy')
	const buildSteps = workflowSteps(staging, 'build-preview')
	const stagingSteps = workflowSteps(staging, 'deploy')
	orderedStepNames(productionSteps, [
		'Run production database migrations',
		...(productionSteps.some((step) => step.name === 'Validate public deployment variables')
			? ['Validate public deployment variables']
			: []),
		'Deploy auth Worker',
		'Deploy users Worker',
		'Deploy gateway Worker',
		'Deploy web Worker'
	])
	const stagingNeeds = normalizedNeeds(staging.jobs?.deploy?.needs)
	if (JSON.stringify(stagingNeeds) !== JSON.stringify(['preview-db', 'build-preview'])) throw new Error('staging deploy must depend on preview-db and build-preview')
	if (JSON.stringify(normalizedNeeds(staging.jobs?.['build-preview']?.needs)) !== '["preview-db"]') throw new Error('preview build does not wait for preview-db')
	const usesTrustedWorkflowDefinition = staging.on && Object.hasOwn(staging.on, 'pull_request_target') && !Object.hasOwn(staging.on, 'pull_request')
	if (!usesTrustedWorkflowDefinition) throw new Error('preview deployment does not use a trusted workflow definition')

	const allStagingSteps = Object.values(staging.jobs ?? {}).flatMap((job) => job.steps ?? [])
	const obsoleteDeployStep = allStagingSteps.find(
		(step) => step.name?.startsWith('Deploy ') && step.name.endsWith(' Worker')
	)
	if (obsoleteDeployStep) throw new Error(`obsolete individual preview Worker deployment step: ${obsoleteDeployStep.name}`)
	for (const step of allStagingSteps) if (/\bpnpm\b[^\n]*\bdeploy:staging\b/.test(step.run ?? '')) throw new Error('obsolete individual preview package deployment command')

	orderedStepNames(buildSteps, [
		'Checkout untrusted preview source without provider credentials',
		'Write temporary staging Wrangler configs',
		'Build untrusted preview source and package passive Worker bundles',
		'Upload passive preview bundle'
	])
	const untrustedCheckout = buildSteps.find(
		(step) => step.name === 'Checkout untrusted preview source without provider credentials'
	)
	if (untrustedCheckout?.with?.ref !== '${{ github.event.pull_request.head.sha || github.sha }}') throw new Error('preview build does not check out the requested untrusted head')
	const bundleStep = buildSteps.find(
		(step) => step.name === 'Build untrusted preview source and package passive Worker bundles'
	)
	const passiveTargets = [
		'services/auth',
		'services/users',
		'apps/api',
		...(entry.marketing === 'astro' ? ['apps/marketing'] : []),
		'apps/web'
	]
	const bundleLines = (bundleStep?.run ?? '').split('\n').filter(Boolean)
	const buildCommandPattern = /^pnpm turbo run build(?: --filter=[@a-z0-9-/]+)+$/
	const passiveBundleCommandPattern = /^pnpm --filter [@a-z0-9-/]+ exec wrangler deploy --config wrangler\.staging\.jsonc --dry-run --outdir=\.preview-bundle$/
	const buildsOnlyPassiveBundles = bundleLines.length === 1 + passiveTargets.length * 2 && buildCommandPattern.test(bundleLines[0] ?? '') && passiveTargets.every((target, index) => passiveBundleCommandPattern.test(bundleLines[index * 2 + 1] ?? '') && bundleLines[index * 2 + 2] === `test -d ${target}/.preview-bundle`)
	if (!buildsOnlyPassiveBundles) throw new Error('untrusted preview build does not produce only passive Worker bundles')
	const unexpectedWorkerDeploy = allStagingSteps.find(
		(step) => step !== bundleStep && /\bwrangler deploy\b/.test(step.run ?? '')
	)
	if (unexpectedWorkerDeploy) throw new Error('staging workflow contains an untrusted Worker deploy')
	const expectedArtifactPaths = [
		'cloudflare-preview-manifest.json',
		...passiveTargets.flatMap((directory) => [
			`${directory}/wrangler.staging.jsonc`,
			`${directory}/.preview-bundle`
		]),
		'apps/web/.svelte-kit/cloudflare',
		...(entry.marketing === 'astro' ? ['apps/marketing/dist'] : [])
	]
	const expectedArtifactName =
		'cloudflare-preview-build-${{ needs.preview-db.outputs.alias }}-${{ github.run_id }}'
	const upload = buildSteps.find((step) => step.name === 'Upload passive preview bundle')
	const artifactPaths = String(upload?.with?.path ?? '')
		.trim()
		.split('\n')
	const uploadsOnlyPassiveOutput = upload?.uses === 'actions/upload-artifact@v4' && upload.with?.name === expectedArtifactName && JSON.stringify(artifactPaths) === JSON.stringify(expectedArtifactPaths)
	if (!uploadsOnlyPassiveOutput) throw new Error('untrusted preview artifact is not limited to passive build output')

	const migrationName =
		entry.db === 'sqlite'
			? 'Apply preview D1 migrations with a trusted pinned tool'
			: 'Apply preview Neon migrations with a trusted pinned tool'
	orderedStepNames(stagingSteps, [
		'Checkout trusted deployment code',
		'Download passive preview bundle',
		migrationName,
		'Publish prebuilt preview Workers from trusted code',
		'Remove private Worker preview secret files'
	])
	const trustedCheckout = stagingSteps.find(
		(step) => step.name === 'Checkout trusted deployment code'
	)
	const checksOutTrustedDeploymentCode = trustedCheckout?.uses === 'actions/checkout@v4' && trustedCheckout.with?.ref === TRUSTED_PREVIEW_REF && trustedCheckout.with.path === 'trusted-source'
	if (!checksOutTrustedDeploymentCode) throw new Error('trusted publisher does not use trusted deployment code')
	const download = stagingSteps.find((step) => step.name === 'Download passive preview bundle')
	const downloadsPassivePreviewArtifact = download?.uses === 'actions/download-artifact@v4' && download.with?.name === expectedArtifactName && download.with.path === 'preview-artifact'
	if (!downloadsPassivePreviewArtifact) throw new Error('trusted publisher does not download the passive preview artifact')
	const migration = stagingSteps.find((step) => step.name === migrationName)
	const usesTrustedMigrationInput = JSON.stringify(migration).includes('trusted-source/packages/db/') && !JSON.stringify(migration).includes('preview-artifact/packages/db/')
	if (!usesTrustedMigrationInput) throw new Error('preview database migration does not use trusted migration input')
	const publisherSteps = allStagingSteps.filter((step) =>
		(step.run ?? '').includes('trusted-source/scripts/publish-cloudflare-preview.sh')
	)
	if (publisherSteps.length !== 1) throw new Error('staging workflow must have one trusted publisher')
	const publisher = publisherSteps[0]!
	const executesTrustedPublicationCode = publisher.name === 'Publish prebuilt preview Workers from trusted code' && publisher.run === 'sh trusted-source/scripts/publish-cloudflare-preview.sh'
	if (!executesTrustedPublicationCode) throw new Error('trusted publisher does not execute trusted publication code')
	const requiredPublisherEnv = {
		PREVIEW_ARTIFACT: '${{ github.workspace }}/preview-artifact',
		PREVIEW_SECRETS_DIR: '${{ steps.preview_secrets.outputs.directory }}',
		TRUSTED_SOURCE: '${{ github.workspace }}/trusted-source',
		STAGING_ALIAS: '${{ needs.preview-db.outputs.alias }}',
		CLOUDFLARE_API_TOKEN: '${{ secrets.CLOUDFLARE_API_TOKEN }}',
		CLOUDFLARE_ACCOUNT_ID: '${{ secrets.CLOUDFLARE_ACCOUNT_ID }}'
	}
	for (const [name, value] of Object.entries(requiredPublisherEnv)) if (publisher.env?.[name] !== value) throw new Error(`trusted publisher does not map ${name}`)
	const mapsPreviewD1Identity = publisher.env?.STAGING_D1_DATABASE_NAME === '${{ needs.preview-db.outputs.d1_database_name }}' && publisher.env.STAGING_D1_DATABASE_ID === '${{ needs.preview-db.outputs.d1_database_id }}'
	if (entry.db === 'sqlite' && !mapsPreviewD1Identity) throw new Error('trusted publisher does not map the preview D1 identity')
	assertTrustedCredentialBoundary(staging)

	const productionDeploySteps = productionSteps.filter(
		(step) => step.name?.startsWith('Deploy ') && step.name.endsWith(' Worker')
	)
	const requiredProductionEnv = {
		DEPLOY_ALL:
			"${{ github.event_name == 'workflow_dispatch' || steps.scm.outputs.deploy_all == 'true' }}",
		CLOUDFLARE_API_TOKEN: '${{ secrets.CLOUDFLARE_API_TOKEN }}',
		CLOUDFLARE_ACCOUNT_ID: '${{ secrets.CLOUDFLARE_ACCOUNT_ID }}',
		TURBO_SCM_BASE: '${{ steps.scm.outputs.base }}',
		TURBO_SCM_HEAD: '${{ steps.scm.outputs.head }}'
	}
	for (const step of productionDeploySteps) for (const [name, value] of Object.entries(requiredProductionEnv)) if (step.env?.[name] !== value) throw new Error(`production ${step.name} does not map ${name}`)
	const publicKeys = [
		...new Set(
			productionDeploySteps.flatMap((step) =>
				Object.keys(step.env ?? {}).filter((name) => name.startsWith('PUBLIC_'))
			)
		)
	]
	const validation = productionSteps.find(
		(step) => step.name === 'Validate public deployment variables'
	)
	if (publicKeys.length > 0 && !validation) throw new Error('production public variables have no validation step')
	for (const name of publicKeys) {
		const mappedValue = `\${{ vars.${name} }}`
		const validatedBeforeDeploy =
			validation?.run?.includes(`test -n "$${name}"`) && validation.env?.[name] === mappedValue
		const validatedByDeploy = productionDeploySteps.some(
			(step) => step.run?.includes(`test -n "$${name}"`) && step.env?.[name] === mappedValue
		)
		if (!validatedBeforeDeploy && !validatedByDeploy) throw new Error(`production deployment does not validate ${name} from GitHub variables`)
	}

	const previewConfig = buildSteps.find((step) => step.id === 'preview_config')
	if (previewConfig?.env?.STAGING_ALIAS !== '${{ needs.preview-db.outputs.alias }}') throw new Error('preview config does not use the preview-db alias')
	const hasD1PreviewConfig = previewConfig?.env?.PREVIEW_DB_KIND === 'd1' && previewConfig.env.STAGING_D1_DATABASE_NAME === '${{ needs.preview-db.outputs.d1_database_name }}' && previewConfig.env.STAGING_D1_DATABASE_ID === '${{ needs.preview-db.outputs.d1_database_id }}'
	if (entry.db === 'sqlite' && !hasD1PreviewConfig) throw new Error('D1 preview config environment is incomplete')
	const hasNeonPreviewConfig = previewConfig?.env?.PREVIEW_DB_KIND === 'neon' && previewConfig.env.STAGING_NEON_BRANCH_NAME === '${{ needs.preview-db.outputs.neon_branch_name }}' && previewConfig.env.STAGING_NEON_BRANCH_ID === '${{ needs.preview-db.outputs.neon_branch_id }}'
	if (entry.db === 'postgres' && !hasNeonPreviewConfig) throw new Error('Neon preview config environment is incomplete')
	return {
		productionSteps: productionSteps.flatMap(({ name }) => (name ? [name] : [])),
		stagingSteps: stagingSteps.flatMap(({ name }) => (name ? [name] : [])),
		stagingNeeds
	}
}

async function previewAssertion(
	entry: GatewayMatrixEntry,
	project: string
): Promise<AssertionEvidence[]> {
	if (entry.highestSeam !== 'cloudflare-preview') return []
	return [
		await assertion('preview isolation and parsed deployment workflows', async () => {
			const evidence = JSON.parse(await readFile(join(project, 'evidence.json'), 'utf8')) as {
				database?: { kind?: 'd1' | 'neon' }
				preview?: {
					inventory?: Record<string, WranglerConfig>
					cleanupTargets?: {
						productionExcluded?: boolean
						database?: { kind?: 'd1' | 'neon' }
					}
					dryRuns?: Record<string, { bundleProved?: boolean }>
				}
			}
			const expectedDatabaseKind = entry.db === 'sqlite' ? 'd1' : 'neon'
			if ( evidence.database?.kind !== expectedDatabaseKind || evidence.preview?.cleanupTargets?.database?.kind !== expectedDatabaseKind ) throw new Error(`${expectedDatabaseKind} preview isolation evidence is missing`)
			if (!evidence.preview.cleanupTargets.productionExcluded) throw new Error('preview cleanup can target production')
			if (Object.values(evidence.preview.dryRuns ?? {}).some((result) => !result.bundleProved)) throw new Error('a preview Worker dry-run lacks bundle evidence')
			return {
				databaseKind: expectedDatabaseKind,
				productionExcluded: true,
				previewWorkers: Object.keys(evidence.preview.inventory ?? {}),
				workflows: await validateCloudflareWorkflowStructure(project, entry)
			}
		})
	]
}

async function verifyEntry(entry: GatewayMatrixEntry, output: string): Promise<EntryEvidence> {
	const started = performance.now()
	const entryRoot = join(output, entry.id)
	const logs = join(entryRoot, 'matrix-logs')
	await rm(entryRoot, { recursive: true, force: true })
	await mkdir(logs, { recursive: true })
	const commands: CommandEvidence[] = []
	const assertions: AssertionEvidence[] = []
	console.log(`[gateway-matrix] ${entry.id}: ${entry.highestSeam}`)

	const specialized = await runSpecializedSeam({
		entry,
		entryRoot,
		logPath: join(logs, 'highest-seam.log')
	})
	let project = join(entryRoot, 'workspace')
	if (specialized) {
		commands.push(...specialized.nestedCommands, specialized.command)
		project = specialized.project
	} else await materialize(entry, project)
	if (commands.every((command) => command.outcome === 'passed')) await runStandardCommands({ project, logs, commands })
	assertions.push(await workspaceGateAssertion(commands))
	assertions.push(await snapshotAssertion(entry))
	assertions.push(await topologyAssertion(entry, project))
	assertions.push(...(await skippedApiClientAssertion(entry, project)))
	if (entry.apiClient === 'hey-api' && commands.every((command) => command.outcome === 'passed')) assertions.push(await verifyOpenApi({ project, logs, commands }))
	if (entry.highestSeam !== 'cloudflare-preview') assertions.push(...(await cloudflareChecks({ entry, project, logs, commands })))
	assertions.push(...(await dockerChecks({ entry, project, logs, commands })))
	assertions.push(...(await previewAssertion(entry, project)))
	await pruneUnretainedArtifacts(project)
	assertions.push(await residueAssertion(entry, project))

	const retainedArtifacts = [
		project,
		logs,
		...(
			await Promise.all(
				['evidence.json', 'contract-evidence.json', 'compose-inventory.json', 'cleanup.log'].map(
					async (file) => ((await exists(join(project, file))) ? join(project, file) : '')
				)
			)
		).filter(Boolean)
	]
	const failed =
		commands.some((command) => command.outcome === 'failed') ||
		assertions.some((candidate) => candidate.outcome === 'failed')
	return {
		id: entry.id,
		configuration: {
			id: entry.id,
			fixture: entry.fixture,
			topology: entry.topology,
			deploy: entry.deploy,
			db: entry.db,
			auth: entry.auth,
			marketing: entry.marketing,
			apiClient: entry.apiClient,
			configVersion: entry.configVersion,
			highestSeam: entry.highestSeam
		},
		coverage: entry.coverage,
		artifactPath: relative(output, project),
		retainedArtifacts: retainedArtifacts.map((path) => relative(output, path)),
		outcome: failed ? 'failed' : 'passed',
		durationMs: Math.round(performance.now() - started),
		commands,
		assertions
	}
}

export type MatrixRunMetadata = {
	scope: 'full-matrix' | 'entry'
	state: 'partial' | 'complete'
	expectedEntryIds: string[]
	selectedEntryIds: string[]
	completedEntryIds: string[]
	matrixComplete: boolean
	reconciliationRequired: boolean
}

export function buildRunMetadata(
	selectedEntries: GatewayMatrixEntry[],
	results: Pick<EntryEvidence, 'id'>[]
): MatrixRunMetadata {
	const expectedEntryIds = GATEWAY_SCAFFOLD_MATRIX.map(({ id }) => id)
	const selectedEntryIds = selectedEntries.map(({ id }) => id)
	const completedEntryIds = results.map(({ id }) => id)
	const uniqueCompleted = new Set(completedEntryIds)
	const fullSelection =
		selectedEntryIds.length === expectedEntryIds.length &&
		expectedEntryIds.every((id) => selectedEntryIds.includes(id))
	const matrixComplete =
		fullSelection &&
		completedEntryIds.length === expectedEntryIds.length &&
		uniqueCompleted.size === expectedEntryIds.length &&
		expectedEntryIds.every((id) => uniqueCompleted.has(id))
	return {
		scope: fullSelection ? 'full-matrix' : 'entry',
		state: matrixComplete ? 'complete' : 'partial',
		expectedEntryIds,
		selectedEntryIds,
		completedEntryIds,
		matrixComplete,
		reconciliationRequired: !matrixComplete
	}
}

function markdownReport(results: EntryEvidence[], run: MatrixRunMetadata): string {
	const lines = [
		'# Gateway scaffold matrix report',
		'',
		`Selected for this invocation: ${run.selectedEntryIds.length}; committed matrix: ${run.expectedEntryIds.length}; matrix status: ${run.state}${run.reconciliationRequired ? ', reconciliation required' : ''}.`,
		`pnpm: ${PNPM_VERSION}`,
		'',
		'## Coverage rationale',
		'',
		...COVERAGE_RATIONALE.map((line) => `- ${line}`),
		'',
		'## Primary Cloudflare references',
		'',
		...PRIMARY_REFERENCES.map((url) => `- ${url}`),
		'',
		'## Results',
		'',
		'| Entry | Configuration | Highest seam | Outcome | Duration | Artifact |',
		'| --- | --- | --- | --- | ---: | --- |'
	]
	for (const result of results) {
		const config = result.configuration
		lines.push(
			`| ${result.id} | ${config.topology}, ${config.deploy}, ${config.db}, ${config.auth}, ${config.marketing}, ${config.apiClient}, v${config.configVersion} | ${config.highestSeam} | ${result.outcome} | ${(result.durationMs / 1000).toFixed(1)}s | ${result.artifactPath} |`
		)
	}
	for (const result of results) {
		lines.push(
			'',
			`## ${result.id}`,
			'',
			'| Command or assertion | Outcome | Exit code | Duration | Evidence |',
			'| --- | --- | ---: | ---: | --- |'
		)
		for (const command of result.commands) {
			lines.push(
				`| \`${command.command.replaceAll('|', '\\|')}\` | ${command.outcome} | ${command.exitCode} | ${(command.durationMs / 1000).toFixed(1)}s | ${command.logPath} |`
			)
		}
		for (const candidate of result.assertions) {
			lines.push(
				`| ${candidate.name} | ${candidate.outcome} | n/a | ${(candidate.durationMs / 1000).toFixed(1)}s | structured report |`
			)
		}
		lines.push(
			'',
			`Retained artifacts: ${result.retainedArtifacts.map((path) => `\`${path}\``).join(', ')}`
		)
	}
	return `${lines.join('\n')}\n`
}

function parseArgs(argv: string[]): { output: string; entry?: string; list: boolean } {
	let output = resolve('.scratch/gateway-scaffold-matrix')
	let entry: string | undefined
	let list = false
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index]
		if (arg === '--') continue
		if (arg === '--output') output = resolve(argv[++index] ?? output)
		else if (arg === '--entry') entry = argv[++index]
		else if (arg === '--list') list = true
		else throw new Error(`Unknown argument: ${arg}`)
	}
	return { output, ...(entry ? { entry } : {}), list }
}

function listMatrix(): void {
	console.log(
		`Gateway scaffold matrix: ${GATEWAY_SCAFFOLD_MATRIX.length} representative entries from ${MATERIAL_CARTESIAN_ROWS} normalized material rows.`
	)
	for (const line of COVERAGE_RATIONALE) console.log(`- ${line}`)
	console.log('')
	for (const entry of GATEWAY_SCAFFOLD_MATRIX) {
		console.log(
			`${entry.id}\t${JSON.stringify({ fixture: entry.fixture, topology: entry.topology, deploy: entry.deploy, db: entry.db, auth: entry.auth, marketing: entry.marketing, apiClient: entry.apiClient, configVersion: entry.configVersion, highestSeam: entry.highestSeam })}`
		)
	}
}

async function assertRetainedArtifactSafety(
	output: string,
	pendingReports: string[]
): Promise<number> {
	const failures: string[] = []
	const files = (await collectFiles(output)).filter(
		(path) => !['report.json', 'report.md'].includes(basename(path))
	)
	for (const file of files) {
		const content = await readFile(file, 'utf8').catch(() => '')
		for (const finding of unsafeArtifactFindings(content)) failures.push(`${finding}: ${relative(output, file)}`)
	}
	for (const [index, content] of pendingReports.entries()) for (const finding of unsafeArtifactFindings(content)) failures.push(`${finding}: pending-report-${index + 1}`)
	if (failures.length > 0) throw new Error([...new Set(failures)].join(', '))
	return files.length + pendingReports.length
}

async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2))
	if (args.list) {
		listMatrix()
		return
	}
	const matrixGaps = [...uncoveredMaterialValues(), ...uncoveredMaterialInteractions()]
	if (matrixGaps.length > 0) throw new Error(`Matrix misses: ${matrixGaps.join(', ')}`)
	const selected = args.entry
		? GATEWAY_SCAFFOLD_MATRIX.filter((entry) => entry.id === args.entry)
		: GATEWAY_SCAFFOLD_MATRIX
	if (selected.length === 0) throw new Error(`Unknown matrix entry: ${args.entry}`)
	await rm(args.output, { recursive: true, force: true })
	await mkdir(args.output, { recursive: true })
	const results: EntryEvidence[] = []
	for (const entry of selected) {
		results.push(await verifyEntry(entry, args.output))
		const run = buildRunMetadata(selected, results)
		const report = {
			schemaVersion: 2,
			generatedAt: new Date().toISOString(),
			pnpmVersion: PNPM_VERSION,
			materialCartesianRows: MATERIAL_CARTESIAN_ROWS,
			committedMatrixEntries: GATEWAY_SCAFFOLD_MATRIX,
			selectedMatrixEntries: selected,
			run,
			coverageRationale: COVERAGE_RATIONALE,
			uncoveredMaterialValues: uncoveredMaterialValues(),
			uncoveredMaterialInteractions: uncoveredMaterialInteractions(),
			primaryReferences: PRIMARY_REFERENCES,
			results,
			artifactSafety: { outcome: 'passed', scannedArtifacts: 0 }
		}
		const markdown = redactArtifactText(markdownReport(results, run), [args.output, resolve('.')])
		let json = redactArtifactText(`${JSON.stringify(report, null, 2)}\n`, [
			args.output,
			resolve('.')
		])
		report.artifactSafety.scannedArtifacts = await assertRetainedArtifactSafety(args.output, [
			json,
			markdown
		])
		json = redactArtifactText(`${JSON.stringify(report, null, 2)}\n`, [args.output, resolve('.')])
		await writeSanitizedArtifact({
			path: join(args.output, 'report.json'),
			content: json,
			roots: [args.output]
		})
		await writeSanitizedArtifact({
			path: join(args.output, 'report.md'),
			content: markdown,
			roots: [args.output]
		})
	}
	const failed = results.filter((result) => result.outcome === 'failed')
	if (failed.length > 0) throw new Error(`Gateway matrix failed: ${failed.map(({ id }) => id).join(', ')}`)
	console.log(
		`[gateway-matrix] ${results.length} entries passed; reports: ${join(args.output, 'report.md')}, ${join(args.output, 'report.json')}`
	)
}

if (import.meta.main) {
	main().catch((error: unknown) => {
		console.error(error instanceof Error ? error.message : String(error))
		process.exitCode = 1
	})
}
