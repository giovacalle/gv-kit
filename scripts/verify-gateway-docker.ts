import { spawn } from 'node:child_process'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { join, resolve } from 'node:path'
import { parseJsonc } from '../src/lib/jsonc.js'
import { buildScaffoldPlan } from '../src/pipeline/plan.js'
import { GvKitConfig } from '../src/schema/config.js'
import { appendCommandEvidence, writeSanitizedArtifact } from './gateway-verification-evidence.js'

const PNPM_VERSION = '11.1.1'
let webOrigin = 'http://localhost:3000'
let apiOrigin = 'http://api.localhost:3000'
const DIRECT_API_ORIGIN = 'http://127.0.0.1:8786'
const API_HOST = 'api.localhost'

type CookieJar = { header: string; setCookies: string[] }
type CommandResult = { code: number; output: string }
type DockerCommandOptions = {
	program: string
	args: string[]
	cwd: string
	env: NodeJS.ProcessEnv
}
type RecordedDockerCommandOptions = DockerCommandOptions & {
	name: string
	logPath: string
}

function parseArgs(argv: string[]): { fixture: string; output: string } {
	let fixture = 'hono-docker-emailotp-only'
	let output = resolve('.scratch/gateway-docker')
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index]
		if (arg === '--fixture') fixture = argv[++index] ?? fixture
		else if (arg === '--output') output = resolve(argv[++index] ?? output)
		else throw new Error(`Unknown argument: ${arg}`)
	}
	return { fixture, output }
}

async function materialize(fixture: string, output: string) {
	const config = GvKitConfig.parse(
		parseJsonc(await readFile(resolve('fixtures', `${fixture}.jsonc`), 'utf8'))
	)
	if (config.choices.backend !== 'hono' || config.choices.deploy !== 'docker')
		throw new Error(`${fixture} must use the Hono Docker topology`)
	const project = join(output, fixture)
	await rm(project, { recursive: true, force: true })
	await mkdir(project, { recursive: true })
	for (const file of buildScaffoldPlan(config)) {
		const target = join(project, file.path)
		await mkdir(resolve(target, '..'), { recursive: true })
		await writeFile(target, file.content, { encoding: 'utf8', mode: file.mode })
	}
	const binPath = join(project, '.verify-bin')
	await mkdir(binPath, { recursive: true })
	await writeFile(join(binPath, 'pnpm'), `#!/bin/sh\nexec corepack pnpm@${PNPM_VERSION} "$@"\n`, {
		mode: 0o755
	})
	return { config, project, binPath }
}

async function command({
	program,
	args,
	cwd,
	env
}: DockerCommandOptions): Promise<CommandResult> {
	const child = spawn(program, args, {
		cwd,
		env: { ...process.env, ...env },
		stdio: ['ignore', 'pipe', 'pipe']
	})
	let output = ''
	child.stdout.on('data', (chunk) => (output += chunk.toString()))
	child.stderr.on('data', (chunk) => (output += chunk.toString()))
	const code = await new Promise<number>((done, reject) => {
		child.on('error', reject)
		child.on('close', (status) => done(status ?? 1))
	})
	return { code, output }
}

async function run({
	name,
	program,
	args,
	cwd,
	env,
	logPath
}: RecordedDockerCommandOptions): Promise<string> {
	const started = performance.now()
	const result = await command({ program, args, cwd, env })
	const rendered = `${program} ${args.join(' ')}`
	await writeSanitizedArtifact({
		path: logPath,
		content: `$ ${rendered}\n\n${result.output}`,
		roots: [cwd]
	})
	await appendCommandEvidence(cwd, {
		name,
		command: rendered,
		outcome: result.code === 0 ? 'passed' : 'failed',
		durationMs: Math.round(performance.now() - started),
		logPath,
		exitCode: result.code
	})
	if (result.code !== 0) throw new Error(`${rendered} failed; see ${logPath}`)
	return result.output
}

function composeArgs(...args: string[]): string[] {
	return ['compose', ...args]
}

async function portAvailable(port: number): Promise<boolean> {
	return new Promise((done) => {
		const server = createServer()
		server.once('error', () => done(false))
		server.listen(port, '0.0.0.0', () => server.close(() => done(true)))
	})
}

async function runtimeWebPort(): Promise<number> {
	if (await portAvailable(3000)) return 3000
	for (let port = 13_000; port < 13_100; port += 1) {
		if (await portAvailable(port)) return port
	}
	throw new Error('Could not find a free verification port for the web ingress')
}

async function requestWhenReady(url: string, init?: RequestInit): Promise<Response> {
	const deadline = Date.now() + 120_000
	let lastError: unknown
	while (Date.now() < deadline) {
		try {
			const response = await fetch(url, init)
			if (response.status < 500) return response
			lastError = new Error(`status ${response.status}: ${await response.text()}`)
		} catch (error) {
			lastError = error
		}
		await Bun.sleep(500)
	}
	throw new Error(`Timed out waiting for ${url}: ${String(lastError)}`)
}

function cookieJar(response: Response): CookieJar {
	const setCookies = response.headers.getSetCookie()
	return {
		header: setCookies.map((cookie) => cookie.split(';', 1)[0]).join('; '),
		setCookies
	}
}

function redactedCookies(jar: CookieJar) {
	return jar.setCookies.map((cookie) => {
		const [pair = '', ...attributes] = cookie.split(';').map((part) => part.trim())
		return { name: pair.slice(0, pair.indexOf('=')), value: '[redacted]', attributes }
	})
}

async function postJson({
	url,
	body,
	headers
}: {
	url: string
	body: unknown
	headers: Record<string, string>
}) {
	return fetch(url, {
		method: 'POST',
		headers: { 'content-type': 'application/json', ...headers },
		body: JSON.stringify(body),
		redirect: 'manual'
	})
}

async function waitForOtp({
	project,
	env,
	email
}: {
	project: string
	env: NodeJS.ProcessEnv
	email: string
}): Promise<string> {
	const started = performance.now()
	const deadline = Date.now() + 20_000
	const escaped = email.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
	const pattern = new RegExp(`\\[auth\\] OTP for ${escaped}: (\\d{6})`)
	let lastOutput = ''
	while (Date.now() < deadline) {
		const result = await command({
			program: 'docker',
			args: composeArgs('logs', '--no-color', 'auth'),
			cwd: project,
			env
		})
		lastOutput = result.output
		const otp = result.output.match(pattern)?.[1]
		if (otp) {
			const logPath = join(
				project,
				`otp-poll-${email.startsWith('docker-web') ? 'web' : 'api'}.log`
			)
			await writeSanitizedArtifact({
				path: logPath,
				content: result.output.replace(
					/(\[auth\] OTP for [^:]+: )\d{6}/g,
					'$1[REDACTED]'
				),
				roots: [project]
			})
			await appendCommandEvidence(project, {
				name: `compose-auth-log-poll-${email.startsWith('docker-web') ? 'web' : 'api'}`,
				command: 'docker compose logs --no-color auth (poll)',
				outcome: result.code === 0 ? 'passed' : 'failed',
				durationMs: Math.round(performance.now() - started),
				logPath,
				exitCode: result.code
			})
			if (result.code !== 0) throw new Error('Docker auth log polling failed')
			return otp
		}
		await Bun.sleep(250)
	}
	await writeSanitizedArtifact({
		path: join(project, 'otp-poll-timeout.log'),
		content: lastOutput,
		roots: [project]
	})
	await appendCommandEvidence(project, {
		name: 'compose-auth-log-poll',
		command: 'docker compose logs --no-color auth (poll)',
		outcome: 'failed',
		durationMs: Math.round(performance.now() - started),
		logPath: join(project, 'otp-poll-timeout.log'),
		exitCode: 1
	})
	throw new Error(`Timed out waiting for the container OTP for ${email}`)
}

async function signIn({
	project,
	env,
	origin,
	email
}: {
	project: string
	env: NodeJS.ProcessEnv
	origin: string
	email: string
}): Promise<CookieJar> {
	const send = await postJson({
		url: `${origin}/api/auth/email-otp/send-verification-otp`,
		body: { email, type: 'sign-in' },
		headers: { origin, 'x-captcha-response': 'XXXX.DUMMY.TOKEN.XXXX' }
	})
	if (!send.ok) throw new Error(`OTP send failed at ${origin}: ${send.status} ${await send.text()}`)
	const otp = await waitForOtp({ project, env, email })
	const response = await postJson({
		url: `${origin}/api/auth/sign-in/email-otp`,
		body: { email, otp },
		headers: { origin }
	})
	if (!response.ok)
		throw new Error(`OTP sign-in failed at ${origin}: ${response.status} ${await response.text()}`)
	const jar = cookieJar(response)
	if (!jar.header) throw new Error(`OTP sign-in at ${origin} did not set a cookie`)
	if (jar.setCookies.some((cookie) => /(?:^|;)\s*domain=/i.test(cookie)))
		throw new Error(`OTP sign-in at ${origin} emitted a domain cookie`)
	return jar
}

async function session({
	origin,
	jar,
	email
}: {
	origin: string
	jar: CookieJar
	email: string
}) {
	const response = await fetch(`${origin}/api/auth/get-session`, {
		headers: { cookie: jar.header }
	})
	const body = (await response.json()) as { user?: { email?: string } }
	if (!response.ok || body.user?.email !== email)
		throw new Error(`Session at ${origin} did not return ${email}`)
	return { status: response.status, email: body.user.email }
}

async function verifyRuntime({
	project,
	env,
	inventory
}: {
	project: string
	env: NodeJS.ProcessEnv
	inventory: unknown
}) {
	const directHealth = await requestWhenReady(`${DIRECT_API_ORIGIN}/api/healthz`)
	const webAliasHealth = await requestWhenReady(`${webOrigin}/api/healthz`)
	const exactWebAlias = await fetch(`${webOrigin}/api`)
	const canonicalHostHealth = await requestWhenReady(`${apiOrigin}/api/healthz`)
	const unknownDirectHost = await fetch(`${DIRECT_API_ORIGIN}/api/auth/get-session`, {
		headers: {
			host: 'evil.example.test',
			'x-forwarded-host': new URL(apiOrigin).host,
			'x-forwarded-proto': 'http'
		}
	})
	const approvedWebWithForgedForwarding = await fetch(`${webOrigin}/api/auth/get-session`, {
		headers: { 'x-forwarded-host': 'evil.example.test', 'x-forwarded-proto': 'https' }
	})
	const approvedApiWithForgedForwarding = await fetch(`${apiOrigin}/api/auth/get-session`, {
		headers: { 'x-forwarded-host': 'evil.example.test', 'x-forwarded-proto': 'https' }
	})
	const openApiResponse = await fetch(`${apiOrigin}/api/openapi.json`)
	const openApi = (await openApiResponse.json()) as { servers?: { url: string }[] }
	if (
		directHealth.status !== 200 ||
		webAliasHealth.status !== 200 ||
		canonicalHostHealth.status !== 200
	)
		throw new Error('One or more gateway ingress health checks failed')
	if (exactWebAlias.status !== 404 || !exactWebAlias.headers.get('x-request-id'))
		throw new Error('Exact web-origin /api boundary did not reach the gateway')
	if (JSON.stringify(openApi.servers) !== JSON.stringify([{ url: apiOrigin }]))
		throw new Error('Runtime OpenAPI did not advertise the explicit independent API origin')
	if (unknownDirectHost.status !== 421 || (await unknownDirectHost.text()) !== 'misdirected request')
		throw new Error('Forged forwarding headers approved an unknown Docker direct host')
	if (approvedWebWithForgedForwarding.status !== 200 || approvedApiWithForgedForwarding.status !== 200)
		throw new Error('Caller forwarding headers overrode an approved Docker public host')

	const suffix = Date.now()
	const webEmail = `docker-web-${suffix}@example.test`
	const apiEmail = `docker-api-${suffix}@example.test`
	const webJar = await signIn({ project, env, origin: webOrigin, email: webEmail })
	const apiJar = await signIn({ project, env, origin: apiOrigin, email: apiEmail })
	if (webJar.header === apiJar.header) throw new Error('Web and API origins shared a cookie jar')
	const webSession = await session({ origin: webOrigin, jar: webJar, email: webEmail })
	const apiSession = await session({ origin: apiOrigin, jar: apiJar, email: apiEmail })

	const webUsers = await fetch(`${webOrigin}/api/v1/users/me`, {
		headers: { cookie: webJar.header }
	})
	const apiUsers = await fetch(`${apiOrigin}/api/v1/users/me`, {
		headers: { cookie: apiJar.header }
	})
	if (!webUsers.ok || !apiUsers.ok)
		throw new Error(
			`Versioned users route failed through an ingress: web=${webUsers.status} ${await webUsers.text()}; api=${apiUsers.status} ${await apiUsers.text()}`
		)
	const webUsersBody = (await webUsers.json()) as { email?: string }
	const apiUsersBody = (await apiUsers.json()) as { email?: string }
	if (webUsersBody.email !== webEmail || apiUsersBody.email !== apiEmail)
		throw new Error('Versioned users route returned the wrong authenticated user')

	const ssr = await fetch(webOrigin, { headers: { cookie: webJar.header } })
	const ssrBody = await ssr.text()
	if (!ssr.ok || !ssrBody.includes(webEmail))
		throw new Error('Web SSR did not load the session through the private gateway URL')

	return {
		project: '.',
		inventory,
		ingress: {
			exactWebAlias: {
				url: `${webOrigin}/api`,
				status: exactWebAlias.status,
				gatewayRequestId: true
			},
			webAlias: { url: `${webOrigin}/api/healthz`, status: webAliasHealth.status },
			canonicalApiHost: {
				host: new URL(apiOrigin).host,
				status: canonicalHostHealth.status
			},
			independentApi: { url: `${DIRECT_API_ORIGIN}/api/healthz`, status: directHealth.status },
			publicHostMatrix: {
				approvedWebWithForgedForwarding: approvedWebWithForgedForwarding.status,
				approvedApiWithForgedForwarding: approvedApiWithForgedForwarding.status,
				unknownDirectWithApprovedForwarding: unknownDirectHost.status
			}
		},
		cookies: {
			web: redactedCookies(webJar),
			api: redactedCookies(apiJar),
			hostOnly: true,
			separateJars: true
		},
		sessions: { web: webSession, api: apiSession },
		users: {
			web: { status: webUsers.status, email: webUsersBody.email },
			api: { status: apiUsers.status, email: apiUsersBody.email }
		},
		ssr: {
			status: ssr.status,
			user: webEmail,
			trace: 'web -> private GATEWAY_URL -> gateway -> auth'
		},
		openApi: { status: openApiResponse.status, servers: openApi.servers }
	}
}

async function assertCleanup(project: string, env: NodeJS.ProcessEnv) {
	const checks = [
		{
			name: 'cleanup-container-inventory',
			args: composeArgs('ps', '-q'),
			failure: 'Compose cleanup left project containers running'
		},
		{
			name: 'cleanup-volume-inventory',
			args: [
				'volume',
				'ls',
				'--filter',
				`label=com.docker.compose.project=${env.COMPOSE_PROJECT_NAME}`,
				'-q'
			],
			failure: 'Compose cleanup left temporary project volumes'
		}
	] as const
	for (const check of checks) {
		const started = performance.now()
		const result = await command({ program: 'docker', args: [...check.args], cwd: project, env })
		const logPath = join(project, `${check.name}.log`)
		await writeSanitizedArtifact({ path: logPath, content: result.output, roots: [project] })
		const passed = result.code === 0 && !result.output.trim()
		await appendCommandEvidence(project, {
			name: check.name,
			command: `docker ${check.args.join(' ')}`,
			outcome: passed ? 'passed' : 'failed',
			durationMs: Math.round(performance.now() - started),
			logPath,
			exitCode: result.code
		})
		if (!passed) throw new Error(check.failure)
	}
	return { containers: [], volumes: [] }
}

async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2))
	const generated = await materialize(args.fixture, args.output)
	const webPort = await runtimeWebPort()
	webOrigin = `http://localhost:${webPort}`
	apiOrigin = `http://${API_HOST}:${webPort}`
	if (webPort !== 3000) {
		await writeFile(
			join(generated.project, 'compose.verify.yml'),
			`services:\n  ingress:\n    ports: !override\n      - "${webPort}:8080"\n`
		)
	}
	const projectName = `gvkit-${generated.config.choices.name}`.replace(/[^a-z0-9_-]/g, '-')
	const env: NodeJS.ProcessEnv = {
		CI: '1',
		PATH: `${generated.binPath}:${process.env.PATH ?? ''}`,
		COMPOSE_PROJECT_NAME: projectName,
		...(webPort === 3000
			? {}
			: {
					COMPOSE_FILE: `docker-compose.yml${process.platform === 'win32' ? ';' : ':'}compose.verify.yml`
				}),
		POSTGRES_USER: 'gvkit',
		POSTGRES_PASSWORD: 'gvkit-local-password',
		POSTGRES_DB: 'gvkit',
		DATABASE_URL: 'postgres://gvkit:gvkit-local-password@postgres:5432/gvkit',
		BETTER_AUTH_SECRET: 'docker-only-better-auth-secret-at-least-32-characters',
		GOOGLE_CLIENT_ID: 'docker-google-client',
		GOOGLE_CLIENT_SECRET: 'docker-google-secret',
		RESEND_API_KEY: '',
		FROM_EMAIL: 'verify@example.test',
		NOTIFUSE_API_KEY: 'docker-notifuse-key',
		NOTIFUSE_WORKSPACE_ID: 'docker-workspace',
		NOTIFUSE_BASE_URL: 'https://notifuse.example.test',
		...(webPort === 3000
			? {}
			: {
					ORIGIN: webOrigin,
					BETTER_AUTH_ALLOWED_HOSTS: `localhost:${webPort},api.localhost:${webPort},localhost:8786,127.0.0.1:8786`,
					AUTH_CORS_ORIGINS: `${webOrigin},${apiOrigin}`,
					API_CORS_ORIGINS: webOrigin,
					API_PUBLIC_ORIGIN: apiOrigin,
					GATEWAY_PUBLIC_ORIGINS: `${webOrigin},${apiOrigin},http://localhost:8786,http://127.0.0.1:8786`
				}),
		GATEWAY_TRUSTED_INGRESS_SECRET: 'docker-only-gateway-ingress-secret',
		GATEWAY_UPSTREAM_TIMEOUT_MS: '10000',
		TURNSTILE_SECRET_KEY: '1x0000000000000000000000000000000AA',
		PUBLIC_TURNSTILE_SITE_KEY: '1x00000000000000000000AA'
	}
	console.log(`[gateway-docker] generated project: ${generated.project}`)
	const webHooks = await readFile(join(generated.project, 'apps/web/src/hooks.server.ts'), 'utf8')
	if (webHooks.includes('forwardApiAlias') || webHooks.includes('gateway.fetch(event.request)'))
		throw new Error('generated SvelteKit hooks contain an inbound browser API proxy')
	if (!webHooks.includes('export const handleFetch') || !webHooks.includes('env.GATEWAY_URL'))
		throw new Error('generated SvelteKit hooks omit the private SSR gateway transport')
	const ingressConfig = await readFile(
		join(generated.project, 'docker/ingress.conf.template'),
		'utf8'
	)
	if (!ingressConfig.includes('location = /api') || !ingressConfig.includes('location ^~ /api/'))
		throw new Error('generated Docker ingress omits an exact API boundary')

	let evidence: unknown
	let cleanup: unknown
	try {
		await run({
			name: 'install',
			program: 'corepack',
			args: [`pnpm@${PNPM_VERSION}`, 'install', '--no-frozen-lockfile'],
			cwd: generated.project,
			env,
			logPath: join(generated.project, 'install.log')
		})
		await run({
			name: 'database-generate',
			program: 'corepack',
			args: [`pnpm@${PNPM_VERSION}`, '--filter', '@repo/db', 'db:generate'],
			cwd: generated.project,
			env,
			logPath: join(generated.project, 'database-generate.log')
		})
		await run({
			name: 'compose-pre-cleanup',
			program: 'docker',
			args: composeArgs('down', '--volumes', '--remove-orphans'),
			cwd: generated.project,
			env,
			logPath: join(generated.project, 'pre-cleanup.log')
		})
		const configJson = await run({
			name: 'compose-config',
			program: 'docker',
			args: composeArgs('config', '--format', 'json'),
			cwd: generated.project,
			env,
			logPath: join(generated.project, 'compose-config.log')
		})
		const parsed = JSON.parse(configJson) as {
			services: Record<string, { ports?: unknown; depends_on?: unknown }>
			networks: Record<string, unknown>
			volumes?: Record<string, unknown>
		}
		const inventory = {
			services: Object.fromEntries(
				Object.entries(parsed.services).map(([name, service]) => [
					name,
					{ ports: service.ports ?? [], dependsOn: service.depends_on ?? {} }
				])
			),
			networks: Object.keys(parsed.networks),
			volumes: Object.keys(parsed.volumes ?? {})
		}
		await writeFile(
			join(generated.project, 'compose-inventory.json'),
			`${JSON.stringify(inventory, null, 2)}\n`
		)
		await run({
			name: 'compose-build-and-up',
			program: 'docker',
			args: composeArgs('up', '--build', '-d'),
			cwd: generated.project,
			env,
			logPath: join(generated.project, 'compose-up.log')
		})
		const runtimeStarted = performance.now()
		try {
			evidence = await verifyRuntime({ project: generated.project, env, inventory })
			await appendCommandEvidence(generated.project, {
				name: 'dual-ingress-http-runtime',
				command: 'generated Docker dual-ingress HTTP runtime checks',
				outcome: 'passed',
				durationMs: Math.round(performance.now() - runtimeStarted),
				logPath: join(generated.project, 'evidence.json'),
				exitCode: 0
			})
		} catch (error) {
			await appendCommandEvidence(generated.project, {
				name: 'dual-ingress-http-runtime',
				command: 'generated Docker dual-ingress HTTP runtime checks',
				outcome: 'failed',
				durationMs: Math.round(performance.now() - runtimeStarted),
				logPath: join(generated.project, 'evidence.json'),
				exitCode: 1
			})
			throw error
		}
		await writeSanitizedArtifact({
			path: join(generated.project, 'evidence.json'),
			content: `${JSON.stringify(evidence, null, 2)}\n`,
			roots: [generated.project]
		})
	} finally {
		const runtimeLogsStarted = performance.now()
		const runtimeLogs = await command({
			program: 'docker',
			args: composeArgs('logs', '--no-color'),
			cwd: generated.project,
			env
		})
		const runtimeLogPath = join(generated.project, 'runtime.log')
		await writeSanitizedArtifact({
			path: runtimeLogPath,
			content: runtimeLogs.output.replace(
				/(\[auth\] OTP for [^:]+: )\d{6}/g,
				'$1[REDACTED]'
			),
			roots: [generated.project]
		})
		await appendCommandEvidence(generated.project, {
			name: 'compose-runtime-logs',
			command: 'docker compose logs --no-color',
			outcome: runtimeLogs.code === 0 ? 'passed' : 'failed',
			durationMs: Math.round(performance.now() - runtimeLogsStarted),
			logPath: runtimeLogPath,
			exitCode: runtimeLogs.code
		})
		const downStarted = performance.now()
		const down = await command({
			program: 'docker',
			args: composeArgs('down', '--volumes', '--remove-orphans', '--rmi', 'local'),
			cwd: generated.project,
			env
		})
		const cleanupLogPath = join(generated.project, 'cleanup.log')
		await writeSanitizedArtifact({
			path: cleanupLogPath,
			content: `$ docker compose down --volumes --remove-orphans --rmi local\n\n${down.output}`,
			roots: [generated.project]
		})
		await appendCommandEvidence(generated.project, {
			name: 'compose-down-and-image-cleanup',
			command: 'docker compose down --volumes --remove-orphans --rmi local',
			outcome: down.code === 0 ? 'passed' : 'failed',
			durationMs: Math.round(performance.now() - downStarted),
			logPath: cleanupLogPath,
			exitCode: down.code
		})
		if (down.code !== 0) throw new Error('Docker Compose cleanup failed; see cleanup.log')
		cleanup = await assertCleanup(generated.project, env)
	}
	console.log(JSON.stringify({ ...((evidence ?? {}) as object), cleanup }, null, 2))
}

if (import.meta.main) {
	main().catch((error: unknown) => {
		console.error(error instanceof Error ? error.message : String(error))
		process.exitCode = 1
	})
}
