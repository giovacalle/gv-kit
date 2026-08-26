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
		highestSeam: 'generated-workspace',
		coverage: [
			'Compose no-auth topology',
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
	'One Docker auth topology runs Compose end to end; the second validates the no-auth Compose and Astro shape. Every Docker case validates Compose configuration.',
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
		matches: (entry: GatewayMatrixEntry) =>
			entry.topology === 'hono' && entry.apiClient === 'skip'
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
	BETTER_AUTH_ALLOWED_HOSTS: 'localhost:3000,localhost:5173,localhost:8786,127.0.0.1:8786',
	AUTH_CORS_ORIGINS: 'http://localhost:3000,http://localhost:5173',
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
	await writeSanitizedArtifact(options.logPath, `$ ${command}\n\n${output}`, [options.cwd])
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

function pnpmArgs(...args: string[]): string[] {
	return [`pnpm@${PNPM_VERSION}`, ...args]
}

async function runSpecializedSeam(
	entry: GatewayMatrixEntry,
	entryRoot: string,
	logPath: string
): Promise<{ command: CommandEvidence; nestedCommands: CommandEvidence[]; project: string } | undefined> {
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
	if (command.outcome === 'passed' && nestedCommands.length === 0) {
		throw new Error(`${entry.id} specialized seam produced no command evidence`)
	}
	return { command, nestedCommands, project }
}

const REQUIRED_WORKSPACE_GATES = ['install', 'lint', 'typecheck', 'test', 'build'] as const

type WorkspaceGate = (typeof REQUIRED_WORKSPACE_GATES)[number]

function provesWorkspaceGate(command: CommandEvidence, gate: WorkspaceGate): boolean {
	return command.name === gate || command.name === `workspace-${gate}`
}

async function runStandardCommands(
	project: string,
	logs: string,
	commands: CommandEvidence[]
): Promise<void> {
	for (const task of REQUIRED_WORKSPACE_GATES) {
		if (commands.some((command) => command.outcome === 'failed')) break
		if (commands.some((command) => provesWorkspaceGate(command, task))) continue
		const args = task === 'install' ? pnpmArgs('install', '--no-frozen-lockfile') : pnpmArgs(task)
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
				if (!evidence || evidence.outcome !== 'passed') {
					throw new Error(`${gate} gate is missing or did not pass`)
				}
				return [gate, evidence.name]
			})
		)
		return gates
	})
}

async function verifyOpenApi(
	project: string,
	logs: string,
	commands: CommandEvidence[]
): Promise<AssertionEvidence> {
	const command = async (
		name: string,
		args: string[],
		expectedExitCode = 0,
		expectedOutput?: RegExp
	) => {
		const result = await runCommand({
			name,
			program: 'corepack',
			args: pnpmArgs(...args),
			cwd: project,
			logPath: join(logs, `${name}.log`),
			displayCommand: `corepack ${pnpmArgs(...args).join(' ')}`,
			expectedExitCode,
			...(expectedOutput ? { expectedOutput } : {})
		})
		commands.push(result)
		if (result.outcome === 'failed') throw new Error(`${name} failed`)
	}
	const cleanDiagnostic = /OpenAPI is current \(sha256:[0-9a-f]{64}\)/
	const driftDiagnostic = /apps\/api\/openapi\.json drifted; run pnpm openapi:compose/
	return assertion('OpenAPI composition, specific drift rejection, codegen, and typed consumers', async () => {
		await command('openapi-check-baseline', ['openapi:check'], 0, cleanDiagnostic)
		await command('openapi-compose-first', ['openapi:compose'])
		const path = join(project, 'apps/api/openapi.json')
		const first = await readFile(path, 'utf8')
		const firstHash = createHash('sha256').update(first).digest('hex')
		await command('openapi-compose-second', ['openapi:compose'])
		const second = await readFile(path, 'utf8')
		const secondHash = createHash('sha256').update(second).digest('hex')
		if (first !== second) throw new Error('OpenAPI composition is not byte-identical')
		await writeFile(path, `${second} `)
		await command('openapi-drift-rejection', ['openapi:check'], 1, driftDiagnostic)
		await command('openapi-compose-restore', ['openapi:compose'])
		await command('openapi-check-final', ['openapi:check'], 0, cleanDiagnostic)
		await command('openapi-codegen', ['codegen'])
		await command('typed-consumer-check', ['typecheck'])

		const packageJson = JSON.parse(
			await readFile(join(project, 'packages/openapi-client/package.json'), 'utf8')
		) as { exports?: Record<string, string> }
		const browser = await readFile(join(project, 'apps/web/src/routes/+layout.ts'), 'utf8')
		const ssr = await readFile(join(project, 'apps/web/src/routes/users/+page.server.ts'), 'utf8')
		if (JSON.stringify(packageJson.exports) !== JSON.stringify({ '.': './src/index.ts' })) {
			throw new Error('OpenAPI client is not flat')
		}
		if (!browser.includes("from '@repo/openapi-client'"))
			throw new Error('browser typed consumer missing')
		if (
			!ssr.includes("from '@repo/openapi-client'") ||
			!ssr.includes('usersGetMe({ baseUrl: url.origin, fetch })')
		) {
			throw new Error('SSR request-scoped typed consumer missing')
		}
		return { firstHash, secondHash, driftRejected: true, clientExports: packageJson.exports }
	})
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
		if (entry.topology === 'hono' && (!apiPackage || !authPackage || !usersPackage)) {
			throw new Error('Hono scaffold omits the gateway or a private service')
		}
		if (entry.topology === 'inside-frontend' && (apiPackage || authPackage || usersPackage)) {
			throw new Error('gateway topology leaked into inside-frontend output')
		}
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
			if (!(await exists(join(project, 'apps/api/openapi.json')))) {
				throw new Error('composed OpenAPI is missing')
			}
			if (await exists(join(project, 'packages/openapi-client'))) {
				throw new Error('API client package exists despite apiClient: skip')
			}
			const rootPackage = JSON.parse(await readFile(join(project, 'package.json'), 'utf8')) as {
				scripts?: Record<string, string>
			}
			if (rootPackage.scripts?.codegen) throw new Error('client codegen script exists')
			if (!rootPackage.scripts?.['openapi:compose'] || !rootPackage.scripts['openapi:check']) {
				throw new Error('OpenAPI composition scripts are missing')
			}
			const references: string[] = []
			for (const file of await collectFiles(project)) {
				if (!/\.(?:json|md|svelte|ts)$/.test(file)) continue
				const content = await readFile(file, 'utf8').catch(() => '')
				if (/(?:@repo\/openapi-client|packages\/openapi-client)/.test(content)) {
					references.push(relative(project, file))
				}
			}
			if (references.length > 0) {
				throw new Error(`client-only references remain: ${references.join(', ')}`)
			}
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
			if (entry.isDirectory() && PRUNED_ARTIFACT_DIRECTORIES.has(entry.name)) {
				await rm(path, { recursive: true, force: true })
			} else if (entry.isDirectory()) await visit(path)
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

async function residueAssertion(
	entry: GatewayMatrixEntry,
	project: string
): Promise<AssertionEvidence> {
	return assertion('negative generated-workspace scan', async () => {
		const patterns = [
			{ name: 'old service path', pattern: /apps\/api\/(?:auth|users)(?:\/|\b)/ },
			...(entry.topology === 'hono'
				? [{ name: 'direct public service variable', pattern: /PUBLIC_(?:AUTH|USERS)_URL/ }]
				: []),
			{ name: 'service-specific client export', pattern: /@repo\/openapi-client\/users/ },
			{ name: 'old public auth host', pattern: /auth\.api\.<domain>/ },
			{
				name: 'unresolved generator marker',
				pattern:
					/__(?:PROJECT|COMPAT_DATE|GATEWAY_TARGET|GATEWAY_SERVICE|GATEWAY_URL|AUTH_URL|UMAMI_WEBSITE_ID)__/
			},
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
			const haystack = `${relative(project, file)}\n${content}`
			for (const candidate of patterns) {
				if (candidate.pattern.test(haystack)) {
					failures.push(`${candidate.name}: ${relative(project, file)}`)
				}
			}
			for (const finding of unsafeArtifactFindings(haystack)) {
				failures.push(`${finding}: ${relative(project, file)}`)
			}
		}
		if (failures.length > 0) throw new Error([...new Set(failures)].join(', '))
		return { scannedFiles: files.length, failures: [] }
	})
}

type WranglerConfig = {
	name: string
	workers_dev?: boolean
	preview_urls?: boolean
	routes?: unknown[]
	services?: Array<{ binding: string; service: string }>
}

async function cloudflareChecks(
	entry: GatewayMatrixEntry,
	project: string,
	logs: string,
	commands: CommandEvidence[]
): Promise<AssertionEvidence[]> {
	if (entry.deploy !== 'cf-workers') return []
	const configs = (await collectFiles(project)).filter(
		(path) => basename(path) === 'wrangler.jsonc'
	)
	const topology = await assertion('Cloudflare route and binding topology', async () => {
		const inventory: Record<string, WranglerConfig> = {}
		for (const path of configs)
			inventory[relative(project, dirname(path))] = parseJsonc(await readFile(path, 'utf8'))
		if (entry.topology === 'hono') {
			const gateway = inventory['apps/api']
			const auth = inventory['services/auth']
			const users = inventory['services/users']
			if (!gateway || !auth || !users)
				throw new Error('Cloudflare Hono Worker inventory is incomplete')
			if (
				(auth.routes?.length ?? 0) > 0 ||
				auth.workers_dev !== false ||
				auth.preview_urls !== false
			) {
				throw new Error('auth service has a public trigger')
			}
			if (
				(users.routes?.length ?? 0) > 0 ||
				users.workers_dev !== false ||
				users.preview_urls !== false
			) {
				throw new Error('users service has a public trigger')
			}
			if (gateway.services?.map(({ binding }) => binding).join(',') !== 'AUTH,USERS') {
				throw new Error('gateway Service Bindings drifted')
			}
		} else if (inventory['apps/api'] || inventory['services/auth'] || inventory['services/users']) {
			throw new Error('inside-frontend Cloudflare output contains gateway Workers')
		}
		return inventory
	})
	for (const configPath of configs.sort()) {
		if (commands.some((command) => command.outcome === 'failed')) break
		const directory = relative(project, dirname(configPath))
		const slug = directory.replaceAll('/', '-') || 'root'
		commands.push(
			await runCommand({
				name: `wrangler-dry-run-${slug}`,
				program: 'corepack',
				args: pnpmArgs(
					'--dir',
					directory,
					'exec',
					'wrangler',
					'deploy',
					'--dry-run',
					'--outdir',
					`.wrangler/matrix-${entry.id}`
				),
				cwd: project,
				logPath: join(logs, `wrangler-${slug}.log`),
				displayCommand: `corepack ${pnpmArgs('--dir', directory, 'exec', 'wrangler', 'deploy', '--dry-run', '--outdir', `.wrangler/matrix-${entry.id}`).join(' ')}`
			})
		)
	}
	return [topology]
}

async function dockerChecks(
	entry: GatewayMatrixEntry,
	project: string,
	logs: string,
	commands: CommandEvidence[]
): Promise<AssertionEvidence[]> {
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
			for (const service of ['auth', 'users']) {
				if ((compose.services[service]?.ports?.length ?? 0) > 0)
					throw new Error(`${service} publishes a host port`)
			}
			return Object.fromEntries(
				Object.entries(compose.services).map(([name, service]) => [name, service.ports ?? []])
			)
		})
	]
}

type WorkflowStep = {
	id?: string
	name?: string
	run?: string
	env?: Record<string, string>
}

type Workflow = {
	jobs?: Record<string, { needs?: string; steps?: WorkflowStep[] }>
}

function orderedStepNames(steps: WorkflowStep[], expected: string[]): void {
	let previous = -1
	for (const name of expected) {
		const current = steps.findIndex((step) => step.name === name)
		if (current <= previous) throw new Error(`workflow step order is invalid at ${name}`)
		previous = current
	}
}

export async function validateCloudflareWorkflowStructure(
	project: string,
	entry: GatewayMatrixEntry
): Promise<{ productionSteps: string[]; stagingSteps: string[] }> {
	const parse = async (file: string) =>
		Bun.YAML.parse(await readFile(join(project, '.github/workflows', file), 'utf8')) as Workflow
	const production = await parse('deploy-production.yml')
	const staging = await parse('deploy-staging.yml')
	const productionSteps = production.jobs?.deploy?.steps
	const stagingSteps = staging.jobs?.deploy?.steps
	if (!Array.isArray(productionSteps) || !Array.isArray(stagingSteps)) {
		throw new Error('deploy workflow steps are missing')
	}
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
	if (staging.jobs?.deploy?.needs !== 'preview-db') {
		throw new Error('staging deploy does not depend on preview-db')
	}
	orderedStepNames(stagingSteps, [
		'Write temporary staging Wrangler configs',
		'Run preview database migrations',
		'Write private Worker preview secret files',
		'Deploy auth Worker',
		'Deploy users Worker',
		'Remove private Worker preview secret files',
		'Deploy gateway Worker',
		'Deploy web Worker'
	])
	const productionDeploySteps = productionSteps.filter(
		(step) => step.name?.startsWith('Deploy ') && step.name.endsWith(' Worker')
	)
	const stagingDeploySteps = stagingSteps.filter(
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
	const requiredStagingEnv = {
		DEPLOY_ALL: "${{ github.event.action != 'synchronize' }}",
		CLOUDFLARE_API_TOKEN: '${{ secrets.CLOUDFLARE_API_TOKEN }}',
		CLOUDFLARE_ACCOUNT_ID: '${{ secrets.CLOUDFLARE_ACCOUNT_ID }}',
		STAGING_ALIAS: '${{ needs.preview-db.outputs.alias }}',
		STAGING_WRANGLER_CONFIG: 'wrangler.staging.jsonc',
		TURBO_SCM_BASE: '${{ github.event.pull_request.base.sha }}',
		TURBO_SCM_HEAD: '${{ github.event.pull_request.head.sha }}'
	}
	for (const [stage, steps, expected] of [
		['production', productionDeploySteps, requiredProductionEnv],
		['staging', stagingDeploySteps, requiredStagingEnv]
	] as const) {
		for (const step of steps) {
			for (const [name, value] of Object.entries(expected)) {
				if (step.env?.[name] !== value) {
					throw new Error(`${stage} ${step.name} does not map ${name}`)
				}
			}
		}
	}
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
	if (publicKeys.length > 0 && !validation) {
		throw new Error('production public variables have no validation step')
	}
	for (const name of publicKeys) {
		if (
			!validation?.run?.includes(`test -n "$${name}"`) ||
			validation.env?.[name] !== `\${{ vars.${name} }}`
		) {
			throw new Error(`production validation does not map ${name} from GitHub variables`)
		}
	}
	const previewConfig = stagingSteps.find((step) => step.id === 'preview_config')
	if (previewConfig?.env?.STAGING_ALIAS !== '${{ needs.preview-db.outputs.alias }}') {
		throw new Error('preview config does not use the preview-db alias')
	}
	if (entry.db === 'sqlite') {
		if (
			previewConfig.env?.PREVIEW_DB_KIND !== 'd1' ||
			previewConfig.env?.STAGING_D1_DATABASE_NAME !==
				'${{ needs.preview-db.outputs.d1_database_name }}' ||
			previewConfig.env?.STAGING_D1_DATABASE_ID !==
				'${{ needs.preview-db.outputs.d1_database_id }}'
		) {
			throw new Error('D1 preview config environment is incomplete')
		}
	} else if (
		previewConfig?.env?.PREVIEW_DB_KIND !== 'neon' ||
		previewConfig.env?.STAGING_DATABASE_URL !== '${{ needs.preview-db.outputs.database_url }}'
	) {
		throw new Error('Neon preview config environment is incomplete')
	}
	return {
		productionSteps: productionSteps.flatMap(({ name }) => (name ? [name] : [])),
		stagingSteps: stagingSteps.flatMap(({ name }) => (name ? [name] : []))
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
			if (
				evidence.database?.kind !== expectedDatabaseKind ||
				evidence.preview?.cleanupTargets?.database?.kind !== expectedDatabaseKind
			) {
				throw new Error(`${expectedDatabaseKind} preview isolation evidence is missing`)
			}
			if (!evidence.preview.cleanupTargets.productionExcluded) {
				throw new Error('preview cleanup can target production')
			}
			if (Object.values(evidence.preview.dryRuns ?? {}).some((result) => !result.bundleProved)) {
				throw new Error('a preview Worker dry-run lacks bundle evidence')
			}
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

	const specialized = await runSpecializedSeam(entry, entryRoot, join(logs, 'highest-seam.log'))
	let project = join(entryRoot, 'workspace')
	if (specialized) {
		commands.push(...specialized.nestedCommands, specialized.command)
		project = specialized.project
	} else {
		await materialize(entry, project)
	}
	if (commands.every((command) => command.outcome === 'passed')) {
		await runStandardCommands(project, logs, commands)
	}
	assertions.push(await workspaceGateAssertion(commands))
	assertions.push(await snapshotAssertion(entry))
	assertions.push(await topologyAssertion(entry, project))
	assertions.push(...(await skippedApiClientAssertion(entry, project)))
	if (entry.apiClient === 'hey-api' && commands.every((command) => command.outcome === 'passed')) {
		assertions.push(await verifyOpenApi(project, logs, commands))
	}
	if (entry.highestSeam !== 'cloudflare-preview') {
		assertions.push(...(await cloudflareChecks(entry, project, logs, commands)))
	}
	assertions.push(...(await dockerChecks(entry, project, logs, commands)))
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
		for (const finding of unsafeArtifactFindings(content)) {
			failures.push(`${finding}: ${relative(output, file)}`)
		}
	}
	for (const [index, content] of pendingReports.entries()) {
		for (const finding of unsafeArtifactFindings(content)) {
			failures.push(`${finding}: pending-report-${index + 1}`)
		}
	}
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
		json = redactArtifactText(`${JSON.stringify(report, null, 2)}\n`, [
			args.output,
			resolve('.')
		])
		await writeSanitizedArtifact(join(args.output, 'report.json'), json, [args.output])
		await writeSanitizedArtifact(join(args.output, 'report.md'), markdown, [args.output])
	}
	const failed = results.filter((result) => result.outcome === 'failed')
	if (failed.length > 0)
		throw new Error(`Gateway matrix failed: ${failed.map(({ id }) => id).join(', ')}`)
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
