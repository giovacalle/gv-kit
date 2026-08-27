import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { parseJsonc } from '../src/lib/jsonc.js'
import { buildScaffoldPlan } from '../src/pipeline/plan.js'
import { GvKitConfig, type GvKitConfig as Config } from '../src/schema/config.js'
import { appendCommandEvidence, writeSanitizedArtifact } from './gateway-verification-evidence.js'

const PNPM_VERSION = '11.1.1'
const LOCAL_CORS_ORIGINS = 'http://localhost:3000,http://localhost:5173'
const LOCAL_ENVIRONMENT_NAMES = [
	'API_CORS_ORIGINS',
	'API_PUBLIC_ORIGIN',
	'AUTH_CORS_ORIGINS',
	'AUTH_URL',
	'BETTER_AUTH_ALLOWED_HOSTS',
	'BETTER_AUTH_SECRET',
	'DATABASE_URL',
	'FROM_EMAIL',
	'GATEWAY_PUBLIC_ORIGINS',
	'GATEWAY_TRUSTED_INGRESS_SECRET',
	'GATEWAY_UPSTREAM_TIMEOUT_MS',
	'GATEWAY_URL',
	'GOOGLE_CLIENT_ID',
	'GOOGLE_CLIENT_SECRET',
	'NOTIFUSE_API_KEY',
	'NOTIFUSE_BASE_URL',
	'NOTIFUSE_WORKSPACE_ID',
	'PUBLIC_APP_URL',
	'PUBLIC_MARKETING_URL',
	'PUBLIC_POSTHOG_HOST',
	'PUBLIC_POSTHOG_KEY',
	'PUBLIC_TURNSTILE_SITE_KEY',
	'PUBLIC_UMAMI_HOST',
	'PUBLIC_UMAMI_WEBSITE_ID',
	'RESEND_API_KEY',
	'SQLITE_PATH',
	'TURNSTILE_SECRET_KEY',
	'USERS_URL'
]

type RunningCommand = {
	child: ReturnType<typeof spawn>
	output: () => string
	started: number
}

type CommandResult = { code: number; output: string }
type LocalCommandOptions = {
	executable: string
	args: string[]
	cwd: string
}
type RecordedLocalCommandOptions = LocalCommandOptions & {
	name: string
	logPath: string
	expectedExitCode?: number
	expectedOutput?: RegExp
}

type GeneratedProject = {
	config: Config
	project: string
}

type RecordedRequest = {
	pathname: string
	cookie: string | null
}

type AuthTarget = ReturnType<typeof Bun.serve>

type CookieJar = {
	header: string
	setCookies: string[]
}

function parseArgs(argv: string[]): { contract: boolean; fixture: string; output: string } {
	let contract = false
	let fixture = 'hono-skip-deploy'
	let output = resolve('.scratch/gateway-local')
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index]
		if (arg === '--contract') contract = true
		else if (arg === '--fixture') fixture = argv[++index] ?? fixture
		else if (arg === '--output') output = resolve(argv[++index] ?? output)
		else throw new Error(`Unknown argument: ${arg}`)
	}
	return { contract, fixture, output }
}

async function materialize(fixture: string, output: string): Promise<GeneratedProject> {
	const fixturePath = resolve('fixtures', `${fixture}.jsonc`)
	const config = GvKitConfig.parse(parseJsonc(await readFile(fixturePath, 'utf8')))
	if (config.choices.backend !== 'hono') throw new Error(`${fixture} is not a Hono fixture`)
	if (!['cf-workers', 'docker', 'skip'].includes(config.choices.deploy))
		throw new Error(`${fixture} does not use a supported local runtime`)

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
	return { config, project }
}

async function runCommand({
	executable,
	args,
	cwd
}: LocalCommandOptions): Promise<CommandResult> {
	const child = spawn(executable, args, {
		cwd,
		env: {
			...process.env,
			CI: '1',
			PATH: `${join(cwd, '.verify-bin')}:${process.env.PATH ?? ''}`
		},
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
	executable,
	args,
	cwd,
	logPath,
	expectedExitCode = 0,
	expectedOutput
}: RecordedLocalCommandOptions): Promise<void> {
	const started = performance.now()
	const result = await runCommand({ executable, args, cwd })
	const rendered = `${executable} ${args.join(' ')}`
	await writeSanitizedArtifact({
		path: logPath,
		content: `$ ${rendered}\n\n${result.output}`,
		roots: [cwd]
	})
	const passed =
		result.code === expectedExitCode &&
		(expectedOutput === undefined || expectedOutput.test(result.output))
	await appendCommandEvidence(cwd, {
		name,
		command: rendered,
		outcome: passed ? 'passed' : 'failed',
		durationMs: Math.round(performance.now() - started),
		logPath,
		exitCode: result.code
	})
	if (!passed) throw new Error(`${rendered} failed its verification expectation; see ${logPath}`)
}

async function writeLocalEnvironment(
	project: string,
	authUrl: string
): Promise<Record<string, string>> {
	const example = await readFile(join(project, '.env.example'), 'utf8')
	const environment = example
		.replace(
			/^BETTER_AUTH_SECRET=$/m,
			'BETTER_AUTH_SECRET=local-only-better-auth-secret-at-least-32-characters'
		)
		.replace(
			/^TURNSTILE_SECRET_KEY=$/m,
			'TURNSTILE_SECRET_KEY=1x0000000000000000000000000000000AA'
		)
		.replace(
			/^PUBLIC_TURNSTILE_SITE_KEY=$/m,
			'PUBLIC_TURNSTILE_SITE_KEY=1x00000000000000000000AA'
		)
		.replace(/^GOOGLE_CLIENT_ID=$/m, 'GOOGLE_CLIENT_ID=local-only-google-client-id')
		.replace(
			/^GOOGLE_CLIENT_SECRET=$/m,
			'GOOGLE_CLIENT_SECRET=local-only-google-client-secret'
		)
		.replace(/^AUTH_URL=.*$/m, `AUTH_URL=${authUrl}`)
		.replace(
			/^GATEWAY_TRUSTED_INGRESS_SECRET=$/m,
			'GATEWAY_TRUSTED_INGRESS_SECRET=local-only-gateway-ingress-secret'
		)
	await writeFile(join(project, '.env'), environment)
	return Object.fromEntries(
		environment.split('\n').flatMap((line) => {
			const separator = line.indexOf('=')
			if (separator < 1 || line.startsWith('#')) return []
			return [[line.slice(0, separator), line.slice(separator + 1)]]
		})
	)
}

function start({ executable, args, cwd }: LocalCommandOptions): RunningCommand {
	const environment = { ...process.env }
	for (const name of LOCAL_ENVIRONMENT_NAMES) delete environment[name]
	const child = spawn(executable, args, {
		cwd,
		detached: true,
		env: {
			...environment,
			CI: '1',
			PATH: `${join(cwd, '.verify-bin')}:${process.env.PATH ?? ''}`
		},
		stdio: ['ignore', 'pipe', 'pipe']
	})
	let text = ''
	child.stdout.on('data', (chunk) => (text += chunk.toString()))
	child.stderr.on('data', (chunk) => (text += chunk.toString()))
	return { child, output: () => text, started: performance.now() }
}

async function requestWhenReady(url: string, timeoutMs = 60_000): Promise<Response> {
	const deadline = Date.now() + timeoutMs
	let lastError: unknown
	while (Date.now() < deadline) {
		try {
			return await fetch(url)
		} catch (error) {
			lastError = error
			await Bun.sleep(250)
		}
	}
	throw new Error(`Timed out waiting for ${url}: ${String(lastError)}`)
}

async function healthWhenReady(url: string, timeoutMs = 60_000) {
	const deadline = Date.now() + timeoutMs
	let latest = { status: 0, body: '' }
	while (Date.now() < deadline) {
		try {
			const response = await fetch(url)
			latest = { status: response.status, body: await response.text() }
			if (latest.status === 200 && latest.body === 'ok') return latest
		} catch {
			latest = { status: 0, body: '' }
		}
		await Bun.sleep(250)
	}
	throw new Error(`Timed out waiting for ${url} health: ${latest.status} ${latest.body}`)
}

async function localAuthWhenReady() {
	const deadline = Date.now() + 60_000
	let latest: Response | undefined
	while (Date.now() < deadline) {
		try {
			latest = await fetch('http://127.0.0.1:8786/api/auth/get-session', {
				headers: { origin: 'http://localhost:5173' }
			})
			if (
				latest.status === 200 &&
				latest.headers.get('access-control-allow-origin') === 'http://localhost:5173' &&
				latest.headers.get('access-control-allow-credentials') === 'true'
			)
				return latest
		} catch {
			latest = undefined
		}
		await Bun.sleep(250)
	}
	throw new Error(`Timed out waiting for the Cloudflare auth contract: ${latest?.status ?? 0}`)
}

async function stop(command: RunningCommand): Promise<void> {
	const pid = command.child.pid
	if (!pid) return
	try {
		process.kill(-pid, 'SIGTERM')
	} catch {
		return
	}
	await Bun.sleep(500)
	try {
		process.kill(-pid, 'SIGKILL')
	} catch {
		// The process group stopped after SIGTERM.
	}
}

function localWebOrigin(deploy: Config['choices']['deploy']): string {
	return deploy === 'docker' ? 'http://localhost:3000' : 'http://localhost:5173'
}

function processInventory(command: RunningCommand, deploy: Config['choices']['deploy']) {
	const output = command.output().replaceAll(/\u001b\[[0-9;]*m/g, '')
	const loopbackEndpoint = (port: number) =>
		new RegExp(`https?://(?:localhost|127\\.0\\.0\\.1):${port}(?:/|\\b)`).test(output)
	const inventory = {
		web: loopbackEndpoint(deploy === 'docker' ? 3000 : 5173),
		gateway:
			deploy === 'cf-workers'
				? loopbackEndpoint(8786)
				: output.includes('gateway listening on http://127.0.0.1:8786'),
		auth:
			deploy === 'cf-workers'
				? loopbackEndpoint(8787)
				: output.includes('auth listening on http://127.0.0.1:8787'),
		users:
			deploy === 'cf-workers'
				? loopbackEndpoint(8788)
				: output.includes('users listening on http://127.0.0.1:8788')
	}
	if (Object.values(inventory).some((started) => !started))
		throw new Error(`plain root dev command omitted a process: ${JSON.stringify(inventory)}`)
	return inventory
}

function startAuthRecorder(): { requests: RecordedRequest[]; target: AuthTarget } {
	const requests: RecordedRequest[] = []
	const target = Bun.serve({
		hostname: '127.0.0.1',
		port: 0,
		fetch(request) {
			const { pathname } = new URL(request.url)
			requests.push({ pathname, cookie: request.headers.get('cookie') })
			if (pathname === '/internal/session') return new Response(null, { status: 401 })
			if (pathname === '/api/auth/redirect') {
				return new Response(null, {
					status: 302,
					headers: { location: '/api/auth/final', 'x-upstream-redirect': 'preserved' }
				})
			}
			if (pathname === '/api/auth/final') return new Response('redirect was followed')
			return new Response('not found', { status: 404 })
		}
	})
	return { requests, target }
}

async function verifyGatewayTopology({
	project,
	command,
	requests,
	authUrl,
	deploy
}: {
	project: string
	command: RunningCommand
	requests: RecordedRequest[]
	authUrl: string
	deploy: Config['choices']['deploy']
}) {
	const gatewayHealth = await requestWhenReady('http://127.0.0.1:8786/api/healthz')
	const openApiResponse = await requestWhenReady('http://127.0.0.1:8786/api/openapi.json')
	const runtimeOpenApi = (await openApiResponse.json()) as { servers?: { url: string }[] }
	const webHealth = await requestWhenReady(`${localWebOrigin(deploy)}/api/healthz`)
	const direct = await requestWhenReady('http://127.0.0.1:8788/healthz')
	const known = await fetch('http://127.0.0.1:8786/api/v1/users/me', {
		headers: { cookie: 'session=verification' }
	})
	const redirect = await fetch('http://127.0.0.1:8786/api/auth/redirect', {
		redirect: 'manual'
	})
	const unknown = await fetch('http://127.0.0.1:8786/api/unknown')
	const evidence = {
		project: '.',
		processInventory: processInventory(command, deploy),
		gatewayHealth: { status: gatewayHealth.status, body: await gatewayHealth.text() },
		openApi: { status: openApiResponse.status, servers: runtimeOpenApi.servers },
		webAliasHealth: { status: webHealth.status, body: await webHealth.text() },
		knownPrefix: { status: known.status, body: await known.text() },
		unknownPrefix: { status: unknown.status, body: await unknown.text() },
		directDebugHealth: { status: direct.status, body: await direct.text() },
		directAuthTransport: {
			target: authUrl,
			requests: requests.filter(({ pathname }) => pathname === '/internal/session')
		},
		upstreamRedirect: {
			status: redirect.status,
			location: redirect.headers.get('location'),
			marker: redirect.headers.get('x-upstream-redirect'),
			requests: requests.filter(({ pathname }) => pathname.startsWith('/api/auth/'))
		},
		normalApplicationPath: 'web alias or independent gateway; direct service ports are debug-only'
	}
	if (evidence.gatewayHealth.status !== 200 || evidence.gatewayHealth.body !== 'ok')
		throw new Error('independent gateway health failed')
	if (evidence.webAliasHealth.status !== 200 || evidence.webAliasHealth.body !== 'ok')
		throw new Error('web same-origin alias health failed')
	if (
		evidence.openApi.status !== 200 ||
		JSON.stringify(evidence.openApi.servers) !== JSON.stringify([{ url: 'http://localhost:8786' }])
	)
		throw new Error('runtime OpenAPI did not advertise the configured local canonical origin')
	if (evidence.knownPrefix.status !== 401) throw new Error('known users prefix was not forwarded')
	if (evidence.unknownPrefix.status !== 404)
		throw new Error('unknown gateway prefix did not return 404')
	if (evidence.directDebugHealth.status !== 200)
		throw new Error('users debug service did not start')
	if (
		evidence.directAuthTransport.requests.length !== 1 ||
		evidence.directAuthTransport.requests[0]?.cookie !== 'session=verification'
	)
		throw new Error('users service did not call the direct private auth transport')
	if (
		evidence.upstreamRedirect.status !== 302 ||
		evidence.upstreamRedirect.location !== '/api/auth/final' ||
		evidence.upstreamRedirect.marker !== 'preserved' ||
		evidence.upstreamRedirect.requests.length !== 1
	)
		throw new Error('gateway did not preserve the upstream redirect response')
	await writeSanitizedArtifact({
		path: join(project, 'evidence.json'),
		content: `${JSON.stringify(evidence, null, 2)}\n`,
		roots: [project]
	})
	return evidence
}

async function verifyCloudflareTopology({
	project,
	command,
	authUrl
}: {
	project: string
	command: RunningCommand
	authUrl: string
}) {
	const gatewayHealth = await healthWhenReady('http://127.0.0.1:8786/api/healthz')
	const openApiResponse = await requestWhenReady('http://127.0.0.1:8786/api/openapi.json')
	const runtimeOpenApi = (await openApiResponse.json()) as { servers?: { url: string }[] }
	const webHealth = await healthWhenReady('http://localhost:5173/api/healthz')
	const authHealth = await healthWhenReady(`${authUrl}/healthz`)
	const usersHealth = await healthWhenReady('http://127.0.0.1:8788/healthz')
	const authSession = await localAuthWhenReady()
	const evidence = {
		project: '.',
		processInventory: processInventory(command, 'cf-workers'),
		health: {
			gateway: gatewayHealth,
			webAlias: webHealth,
			auth: authHealth,
			users: usersHealth
		},
		openApi: { status: openApiResponse.status, servers: runtimeOpenApi.servers },
		localAuthEnvironment: {
			status: authSession.status,
			allowOrigin: authSession.headers.get('access-control-allow-origin'),
			credentials: authSession.headers.get('access-control-allow-credentials')
		}
	}
	if (
		evidence.openApi.status !== 200 ||
		JSON.stringify(evidence.openApi.servers) !== JSON.stringify([{ url: 'http://localhost:8786' }])
	)
		throw new Error('Cloudflare OpenAPI did not advertise the local canonical origin')
	if (
		evidence.localAuthEnvironment.status !== 200 ||
		evidence.localAuthEnvironment.allowOrigin !== 'http://localhost:5173' ||
		evidence.localAuthEnvironment.credentials !== 'true'
	)
		throw new Error('Cloudflare auth did not receive the local host and CORS contract')
	await writeSanitizedArtifact({
		path: join(project, 'evidence.json'),
		content: `${JSON.stringify(evidence, null, 2)}\n`,
		roots: [project]
	})
	return evidence
}

async function postJson({
	url,
	body,
	headers = {}
}: {
	url: string
	body: unknown
	headers?: Record<string, string>
}) {
	return fetch(url, {
		method: 'POST',
		headers: { 'content-type': 'application/json', ...headers },
		body: JSON.stringify(body),
		redirect: 'manual'
	})
}

async function waitForOtp(command: RunningCommand, email: string): Promise<string> {
	const deadline = Date.now() + 10_000
	const escapedEmail = email.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
	const pattern = new RegExp(`\\[auth\\] OTP for ${escapedEmail}: (\\d{6})`)
	while (Date.now() < deadline) {
		const otp = command.output().match(pattern)?.[1]
		if (otp) return otp
		await Bun.sleep(100)
	}
	throw new Error(`Timed out waiting for the local OTP for ${email}`)
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
		const name = pair.slice(0, pair.indexOf('='))
		return { name, value: '[redacted]', attributes }
	})
}

async function signInWithOtp({
	origin,
	email,
	command
}: {
	origin: string
	email: string
	command: RunningCommand
}) {
	const send = await postJson({
		url: `${origin}/api/auth/email-otp/send-verification-otp`,
		body: { email, type: 'sign-in' },
		headers: { origin, 'x-captcha-response': 'XXXX.DUMMY.TOKEN.XXXX' }
	})
	if (!send.ok)
		throw new Error(`OTP send failed for ${origin}: ${send.status} ${await send.text()}`)
	const otp = await waitForOtp(command, email)
	const signIn = await postJson({
		url: `${origin}/api/auth/sign-in/email-otp`,
		body: { email, otp },
		headers: { origin }
	})
	if (!signIn.ok)
		throw new Error(`OTP sign-in failed for ${origin}: ${signIn.status} ${await signIn.text()}`)
	const jar = cookieJar(signIn)
	if (!jar.header) throw new Error(`OTP sign-in for ${origin} did not set a cookie`)
	if (jar.setCookies.some((cookie) => /(?:^|;)\s*domain=/i.test(cookie)))
		throw new Error(`OTP sign-in for ${origin} emitted a domain cookie`)
	return jar
}

async function verifySession({
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
	if (!response.ok) throw new Error(`session load failed for ${origin}: ${response.status}`)
	const session = (await response.json()) as { user?: { email?: string } }
	if (session.user?.email !== email)
		throw new Error(`session load returned the wrong user for ${origin}`)
	return { status: response.status, email: session.user.email }
}

async function verifyOperationalRuntime(project: string) {
	const gatewayModule = (await import(join(project, 'apps/api/src/app.ts'))) as {
		createGateway(
			targets: Record<string, { fetch(request: Request): Promise<Response> }>,
			options: {
				openApiDocument: {
					openapi: string
					info: Record<string, unknown>
					paths: Record<string, unknown>
				}
				canonicalApiOrigin: string
				publicOrigins: string
				corsOrigins: string
				logger: (line: string) => void
				upstreamTimeoutMs: number
			}
		): { fetch(request: Request): Promise<Response> }
	}
	const logs: string[] = []
	const publicOrigin = 'http://operational.example.test'
	const app = gatewayModule.createGateway(
		{
			USERS: {
				async fetch(request) {
					const pathname = new URL(request.url).pathname
					if (pathname.endsWith('/timeout')) return new Promise<Response>(() => undefined)
					if (pathname.endsWith('/transport')) throw new Error('verification transport failure')
					return new Response('upstream response', {
						status: 418,
						headers: {
							'x-request-id': request.headers.get('x-request-id') ?? '',
							'x-upstream': 'preserved'
						}
					})
				}
			}
		},
		{
			openApiDocument: { openapi: '3.0.0', info: {}, paths: {} },
			canonicalApiOrigin: 'http://localhost:8786',
			publicOrigins: publicOrigin,
			corsOrigins: LOCAL_CORS_ORIGINS,
			logger: (line) => logs.push(line),
			upstreamTimeoutMs: 25
		}
	)
	const server = Bun.serve({
		hostname: '127.0.0.1',
		port: 0,
		fetch: (request) => app.fetch(request)
	})
	const origin = `http://127.0.0.1:${server.port}`
	try {
		const headers = {
			cookie: 'not-logged',
			origin: 'http://localhost:5173',
			'x-request-id': 'operational-contract-request'
		}
		const publicHeaders = { ...headers, host: new URL(publicOrigin).host }
		const valid = await fetch(`${origin}/api/v1/users/valid?token=not-logged`, {
			headers: publicHeaders
		})
		const validBody = await valid.text()
		const missing = await fetch(`${origin}/api/auth/session`, { headers: publicHeaders })
		const transport = await fetch(`${origin}/api/v1/users/transport`, { headers: publicHeaders })
		const timeout = await fetch(`${origin}/api/v1/users/timeout`, { headers: publicHeaders })
		const denied = await fetch(`${origin}/api/v1/users/valid`, {
			headers: { ...publicHeaders, origin: 'https://evil.example.test' }
		})

		if (
			valid.status !== 418 ||
			validBody !== 'upstream response' ||
			valid.headers.get('x-upstream') !== 'preserved'
		)
			throw new Error('valid upstream response did not pass through the gateway')
		for (const response of [valid, missing, transport, timeout]) {
			if (response.headers.get('x-request-id') !== 'operational-contract-request')
				throw new Error('gateway response did not preserve one stable request ID')
			if (
				response.headers.get('access-control-allow-origin') !== 'http://localhost:5173' ||
				response.headers.get('access-control-allow-credentials') !== 'true'
			)
				throw new Error('gateway operational response did not apply approved CORS')
		}
		if (missing.status !== 503) throw new Error('missing target did not return 503')
		if (transport.status !== 502) throw new Error('transport failure did not return 502')
		if (timeout.status !== 504) throw new Error('upstream timeout did not return 504')
		if (valid.headers.get('access-control-allow-origin') !== 'http://localhost:5173')
			throw new Error('versioned route did not apply the API CORS allowlist')
		if (valid.headers.get('access-control-allow-credentials') !== 'true')
			throw new Error('versioned route did not allow approved credentials')
		if (denied.headers.get('access-control-allow-origin'))
			throw new Error('versioned route allowed a denied CORS origin')
		const events = logs
			.map((line) => JSON.parse(line) as { event?: string })
			.map(({ event }) => event)
		for (const event of [
			'route_selected',
			'target_missing',
			'transport_failure',
			'upstream_timeout',
			'request_completed'
		]) {
			if (!events.includes(event)) throw new Error(`gateway structured logs lack ${event}`)
		}
		if (logs.join('\n').includes('not-logged'))
			throw new Error('gateway structured logs contain a cookie, query, or body value')
		return {
			requestId: '[redacted]',
			statuses: {
				valid: valid.status,
				missing: missing.status,
				transport: transport.status,
				timeout: timeout.status
			},
			cors: {
				allowedOrigin: valid.headers.get('access-control-allow-origin'),
				credentials: valid.headers.get('access-control-allow-credentials'),
				deniedOrigin: denied.headers.get('access-control-allow-origin')
			},
			structuredLogEvents: [...new Set(events)].filter(Boolean)
		}
	} finally {
		server.stop(true)
	}
}

async function waitForStructuredTrace(command: RunningCommand, requestId: string): Promise<void> {
	const deadline = Date.now() + 5_000
	while (Date.now() < deadline) {
		const records = command
			.output()
			.split('\n')
			.flatMap((line) => {
				const start = line.indexOf('{\"event\"')
				if (start < 0) return []
				try {
					return [JSON.parse(line.slice(start)) as Record<string, unknown>]
				} catch {
					return []
				}
			})
			.filter((record) => record.requestId === requestId)
		const gateway = records.some(
			(record) => record.event === 'route_selected' && record.target === 'USERS'
		)
		const users = records.some(
			(record) => record.event === 'service_request_completed' && record.service === 'users'
		)
		const auth = records.some(
			(record) =>
				record.event === 'service_request_completed' &&
				record.service === 'auth' &&
				record.path === '/internal/session'
		)
		if (gateway && users && auth) return
		await Bun.sleep(50)
	}
	throw new Error('one request ID was not present in gateway, users, and auth structured logs')
}

async function verifyDualOriginAuth({
	project,
	command,
	authUrl,
	deploy
}: {
	project: string
	command: RunningCommand
	authUrl: string
	deploy: Config['choices']['deploy']
}) {
	const webOrigin = localWebOrigin(deploy)
	const apiOrigin = 'http://127.0.0.1:8786'
	const gatewayHealth = await requestWhenReady(`${apiOrigin}/api/healthz`)
	const gatewayHealthBody = await gatewayHealth.text()
	const openApiResponse = await requestWhenReady(`${apiOrigin}/api/openapi.json`)
	if (openApiResponse.status !== 200) throw new Error('runtime OpenAPI did not return 200')
	const runtimeOpenApi = (await openApiResponse.json()) as { servers?: { url: string }[] }
	if (JSON.stringify(runtimeOpenApi.servers) !== JSON.stringify([{ url: 'http://localhost:8786' }]))
		throw new Error('runtime OpenAPI did not advertise the configured local canonical origin')
	const webHealth = await requestWhenReady(`${webOrigin}/api/healthz`)
	const webHealthBody = await webHealth.text()
	const exactWebAlias = await fetch(`${webOrigin}/api`)
	const exactWebAliasWithQuery = await fetch(`${webOrigin}/api?probe=1`)
	const outsideWebAlias = await fetch(`${webOrigin}/apiary`)
	if (
		exactWebAlias.status !== 404 ||
		!exactWebAlias.headers.get('x-request-id') ||
		exactWebAliasWithQuery.status !== 404 ||
		!exactWebAliasWithQuery.headers.get('x-request-id')
	)
		throw new Error('exact local web-origin /api boundary did not reach the gateway')
	if (outsideWebAlias.headers.get('x-request-id'))
		throw new Error('local /apiary path escaped the web application boundary')
	const authHealth = await requestWhenReady(`${authUrl}/healthz`)
	const authHealthBody = await authHealth.text()
	for (const [name, status, body] of [
		['independent gateway', gatewayHealth.status, gatewayHealthBody],
		['web alias', webHealth.status, webHealthBody],
		['auth service', authHealth.status, authHealthBody]
	] as const) {
		if (status !== 200 || body !== 'ok') throw new Error(`${name} health did not return 200 ok`)
	}

	const allowedCors = await fetch(`${apiOrigin}/api/auth/get-session`, {
		headers: { origin: webOrigin }
	})
	const deniedCors = await fetch(`${apiOrigin}/api/auth/get-session`, {
		headers: { origin: 'https://evil.example.test' }
	})
	const unknownHost = await fetch(`${apiOrigin}/api/auth/get-session`, {
		headers: { host: 'evil.example.test' }
	})
	const forgedUnknownHost = await fetch(`${apiOrigin}/api/auth/get-session`, {
		headers: {
			host: 'evil.example.test',
			'x-forwarded-host': new URL(webOrigin).host,
			'x-forwarded-proto': new URL(webOrigin).protocol.slice(0, -1)
		}
	})
	const approvedHostWithForgedForwarding = await fetch(`${apiOrigin}/api/auth/get-session`, {
		headers: {
			'x-forwarded-host': 'evil.example.test',
			'x-forwarded-proto': 'https'
		}
	})
	const unknownHostBody = await unknownHost.text()
	const forgedUnknownHostBody = await forgedUnknownHost.text()
	if (allowedCors.status !== 200)
		throw new Error(`approved Better Auth host control failed with ${allowedCors.status}`)
	if (allowedCors.headers.get('access-control-allow-origin') !== webOrigin)
		throw new Error(
			`approved CORS origin was not echoed: status=${allowedCors.status} headers=${JSON.stringify(Object.fromEntries(allowedCors.headers))}`
		)
	if (allowedCors.headers.get('access-control-allow-credentials') !== 'true')
		throw new Error('approved CORS origin did not allow credentials')
	if (deniedCors.headers.get('access-control-allow-origin'))
		throw new Error('denied CORS origin received an allow-origin header')
	if (unknownHost.status !== 421 || unknownHostBody !== 'misdirected request')
		throw new Error(
			`unknown direct host did not fail at the gateway boundary: ${unknownHost.status} ${unknownHostBody}`
		)
	if (forgedUnknownHost.status !== 421 || forgedUnknownHostBody !== 'misdirected request')
		throw new Error(
			`forged forwarding headers approved an unknown direct host: ${forgedUnknownHost.status} ${forgedUnknownHostBody}`
		)
	if (approvedHostWithForgedForwarding.status !== 200)
		throw new Error(
			`forged forwarding headers overrode an approved direct host: ${approvedHostWithForgedForwarding.status}`
		)

	const webEmail = 'web-origin@example.test'
	const apiEmail = 'api-origin@example.test'
	const webJar = await signInWithOtp({ origin: webOrigin, email: webEmail, command })
	const apiJar = await signInWithOtp({ origin: apiOrigin, email: apiEmail, command })
	if (webJar.header === apiJar.header)
		throw new Error('web and API origins received the same cookie jar')
	const webSession = await verifySession({ origin: webOrigin, jar: webJar, email: webEmail })
	const apiSession = await verifySession({ origin: apiOrigin, jar: apiJar, email: apiEmail })
	const traceRequestId = 'local-contract-request'
	const knownPrefix = await fetch(`${apiOrigin}/api/v1/users/me`, {
		headers: {
			cookie: apiJar.header,
			origin: webOrigin,
			'x-request-id': traceRequestId
		}
	})
	const knownBody = (await knownPrefix.json()) as { email?: string }
	const deniedUsersCors = await fetch(`${apiOrigin}/api/v1/users/me`, {
		headers: { cookie: apiJar.header, origin: 'https://evil.example.test' }
	})
	const unknownPrefix = await fetch(`${apiOrigin}/api/unknown`)
	if (!knownPrefix.ok || knownBody.email !== apiEmail)
		throw new Error('known users prefix did not return the API-origin session')
	if (knownPrefix.headers.get('x-request-id') !== traceRequestId)
		throw new Error('gateway did not return the propagated request ID')
	if (knownPrefix.headers.get('access-control-allow-origin') !== webOrigin)
		throw new Error('versioned users route did not apply approved CORS')
	if (deniedUsersCors.headers.get('access-control-allow-origin'))
		throw new Error('versioned users route allowed a denied CORS origin')
	await waitForStructuredTrace(command, traceRequestId)
	if (unknownPrefix.status !== 404) throw new Error('unknown gateway prefix did not return 404')
	const ssr = await fetch(webOrigin, { headers: { cookie: webJar.header } })
	const ssrBody = await ssr.text()
	if (!ssr.ok || !ssrBody.includes(webEmail))
		throw new Error('web SSR did not load the gateway session')
	const sdkSsr = await fetch(`${webOrigin}/users`, { headers: { cookie: webJar.header } })
	const sdkSsrBody = await sdkSsr.text()
	if (!sdkSsr.ok || !sdkSsrBody.includes(webEmail))
		throw new Error('SSR flat client operation did not use the private gateway transport')

	const operational = await verifyOperationalRuntime(project)
	const evidence = {
		project: '.',
		processInventory: processInventory(command, deploy),
		ingress: {
			exactWebAlias: {
				url: `${webOrigin}/api`,
				status: exactWebAlias.status,
				queryStatus: exactWebAliasWithQuery.status,
				gatewayRequestId: true,
				outsideBoundaryGatewayRequestId: outsideWebAlias.headers.get('x-request-id')
			},
			web: `${webOrigin}/api/auth/* -> gateway -> auth`,
			api: `${apiOrigin}/api/auth/* -> gateway -> auth`
		},
		cookies: {
			webOrigin: redactedCookies(webJar),
			apiOrigin: redactedCookies(apiJar),
			hostOnly: true,
			separateJars: true
		},
		cors: {
			allowed: {
				origin: webOrigin,
				status: allowedCors.status,
				allowOrigin: allowedCors.headers.get('access-control-allow-origin'),
				credentials: allowedCors.headers.get('access-control-allow-credentials')
			},
			versionedRoute: {
				allowOrigin: knownPrefix.headers.get('access-control-allow-origin'),
				credentials: knownPrefix.headers.get('access-control-allow-credentials'),
				deniedOrigin: deniedUsersCors.headers.get('access-control-allow-origin')
			},
			denied: {
				origin: 'https://evil.example.test',
				allowOrigin: deniedCors.headers.get('access-control-allow-origin')
			}
		},
		health: {
			gateway: { status: gatewayHealth.status, body: gatewayHealthBody },
			webAlias: { status: webHealth.status, body: webHealthBody },
			auth: { status: authHealth.status, body: authHealthBody }
		},
		publicHostMatrix: {
			approvedDirectHost: { status: allowedCors.status },
			approvedDirectHostWithForgedForwarding: {
				status: approvedHostWithForgedForwarding.status
			},
			unknownDirectHost: {
				host: 'evil.example.test',
				status: unknownHost.status,
				responseBody: unknownHostBody
			},
			unknownDirectHostWithApprovedForwarding: {
				status: forgedUnknownHost.status,
				responseBody: forgedUnknownHostBody
			}
		},
		sessions: { web: webSession, api: apiSession },
		routes: {
			knownPrefix: { status: knownPrefix.status, email: knownBody.email },
			unknownPrefix: { status: unknownPrefix.status }
		},
		requestTrace: {
			requestId: '[redacted]',
			gatewayLog: 'route_selected',
			serviceLog: 'service_request_completed',
			responseHeader: true
		},
		operational,
		openApi: { status: openApiResponse.status, servers: runtimeOpenApi.servers },
		ssr: {
			status: ssr.status,
			user: webEmail,
			trace:
				'web request -> event.fetch(/api/auth/get-session) -> private GATEWAY_URL -> AUTH target'
		},
		flatClientSsr: {
			status: sdkSsr.status,
			operation: 'usersGetMe',
			trace: 'absolute same-origin URL -> event.fetch -> private GATEWAY_URL -> USERS target'
		},
		authFacade: 'absent',
		captchaHeader: 'x-captcha-response survived the web and API gateway paths',
		oauth: 'dynamic callback host resolution is covered structurally; no provider credentials used'
	}
	await writeSanitizedArtifact({
		path: join(project, 'evidence.json'),
		content: `${JSON.stringify(evidence, null, 2)}\n`,
		roots: [project]
	})
	return evidence
}

async function readTree(directory: string): Promise<string> {
	const contents: string[] = []
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name)
		if (entry.isDirectory()) contents.push(await readTree(path))
		else if (entry.name.endsWith('.ts')) contents.push(await readFile(path, 'utf8'))
	}
	return contents.join('\n')
}

async function verifyOpenApiContract(project: string) {
	const pnpm = [`pnpm@${PNPM_VERSION}`]
	const cleanDiagnostic = /OpenAPI is current \(sha256:[0-9a-f]{64}\)/
	const driftDiagnostic = /apps\/api\/openapi\.json drifted; run pnpm openapi:compose/
	await run({
		name: 'openapi-check-baseline',
		executable: 'corepack',
		args: [...pnpm, 'openapi:check'],
		cwd: project,
		logPath: join(project, 'openapi-check-baseline.log'),
		expectedExitCode: 0,
		expectedOutput: cleanDiagnostic
	})
	await run({
		name: 'openapi-compose-first',
		executable: 'corepack',
		args: [...pnpm, 'openapi:compose'],
		cwd: project,
		logPath: join(project, 'openapi-compose-first.log')
	})
	const openApiPath = join(project, 'apps/api/openapi.json')
	const firstDocument = await readFile(openApiPath, 'utf8')
	const firstHash = createHash('sha256').update(firstDocument).digest('hex')
	await run({
		name: 'openapi-compose-second',
		executable: 'corepack',
		args: [...pnpm, 'openapi:compose'],
		cwd: project,
		logPath: join(project, 'openapi-compose-second.log')
	})
	const secondDocument = await readFile(openApiPath, 'utf8')
	const secondHash = createHash('sha256').update(secondDocument).digest('hex')
	if (firstHash !== secondHash || firstDocument !== secondDocument)
		throw new Error('repeated OpenAPI composition was not byte-identical')

	await writeFile(openApiPath, `${secondDocument} `)
	await run({
		name: 'openapi-drift-rejection',
		executable: 'corepack',
		args: [...pnpm, 'openapi:check'],
		cwd: project,
		logPath: join(project, 'openapi-drift.log'),
		expectedExitCode: 1,
		expectedOutput: driftDiagnostic
	})
	await run({
		name: 'openapi-compose-restore',
		executable: 'corepack',
		args: [...pnpm, 'openapi:compose'],
		cwd: project,
		logPath: join(project, 'openapi-compose-restore.log')
	})
	await run({
		name: 'openapi-check-final',
		executable: 'corepack',
		args: [...pnpm, 'openapi:check'],
		cwd: project,
		logPath: join(project, 'openapi-check-final.log'),
		expectedExitCode: 0,
		expectedOutput: cleanDiagnostic
	})
	await run({
		name: 'openapi-codegen',
		executable: 'corepack',
		args: [...pnpm, 'codegen'],
		cwd: project,
		logPath: join(project, 'codegen.log')
	})
	await run({
		name: 'typed-consumer-check',
		executable: 'corepack',
		args: [...pnpm, 'typecheck'],
		cwd: project,
		logPath: join(project, 'typecheck.log')
	})

	const checkedDocument = JSON.parse(await readFile(openApiPath, 'utf8')) as {
		paths: Record<string, unknown>
		servers?: unknown
	}
	const clientPackage = JSON.parse(
		await readFile(join(project, 'packages/openapi-client/package.json'), 'utf8')
	) as { exports: Record<string, string> }
	const clientConfig = await readFile(
		join(project, 'packages/openapi-client/openapi-ts.config.ts'),
		'utf8'
	)
	const generatedClient = await readTree(join(project, 'packages/openapi-client/src/generated'))
	const browserConsumer = await readFile(join(project, 'apps/web/src/routes/+layout.ts'), 'utf8')
	const ssrConsumer = await readFile(
		join(project, 'apps/web/src/routes/users/+page.server.ts'),
		'utf8'
	)
	if (checkedDocument.servers !== undefined) throw new Error('checked OpenAPI contains servers')
	if (Object.keys(checkedDocument.paths).some((path) => path.startsWith('/api/auth')))
		throw new Error('checked OpenAPI contains Better Auth routes')
	if (JSON.stringify(clientPackage.exports) !== JSON.stringify({ '.': './src/index.ts' }))
		throw new Error('generated client exposes service package subpaths')
	if (!clientConfig.includes('apps/api/openapi.json') || clientConfig.includes('services/users'))
		throw new Error('Hey API does not read only the composed gateway document')
	if (!generatedClient.includes('usersGetMe') || generatedClient.includes('/api/auth'))
		throw new Error('generated client operation inventory is not the flat public domain contract')
	if (!browserConsumer.includes("from '@repo/openapi-client'"))
		throw new Error('browser consumer does not use the flat client root')
	if (
		!ssrConsumer.includes("usersGetMe } from '@repo/openapi-client'") ||
		!ssrConsumer.includes('usersGetMe({ baseUrl: url.origin, fetch })')
	)
		throw new Error('SSR consumer does not inject its request-scoped fetch transport')

	const evidence = {
		byteIdentical: true,
		hashes: [firstHash, secondHash],
		driftRejected: true,
		checkedServers: null,
		paths: Object.keys(checkedDocument.paths),
		clientExports: clientPackage.exports,
		operations: ['usersGetMe'],
		betterAuthOperations: [],
		browserTransport: 'same-origin baseUrl',
		ssrTransport: 'request-scoped fetch'
	}
	await writeSanitizedArtifact({
		path: join(project, 'contract-evidence.json'),
		content: `${JSON.stringify(evidence, null, 2)}\n`,
		roots: [project]
	})
	return evidence
}

async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2))
	const generated = await materialize(args.fixture, args.output)
	console.log(`[gateway-local] generated project: ${generated.project}`)
	const webHooks = await readFile(join(generated.project, 'apps/web/src/hooks.server.ts'), 'utf8')
	if (webHooks.includes('forwardApiAlias') || webHooks.includes('gateway.fetch(event.request)'))
		throw new Error('generated SvelteKit hooks contain an inbound browser API proxy')
	if (!webHooks.includes('export const handleFetch') || !webHooks.includes('env.GATEWAY_URL'))
		throw new Error('generated SvelteKit hooks omit the private SSR gateway transport')
	const viteConfig = await readFile(join(generated.project, 'apps/web/vite.config.ts'), 'utf8')
	if (!viteConfig.includes("'^/api(?:[/?]|$)': { target:"))
		throw new Error('generated local Vite ingress omits the exact API boundary')
	if (viteConfig.includes("'/api': { target:"))
		throw new Error('generated local Vite ingress overmatches paths outside /api')

	await run({
		name: 'install',
		executable: 'corepack',
		args: [`pnpm@${PNPM_VERSION}`, 'install', '--no-frozen-lockfile'],
		cwd: generated.project,
		logPath: join(generated.project, 'install.log')
	})
	await run({
		name: 'missing-local-environment',
		executable: 'corepack',
		args: [`pnpm@${PNPM_VERSION}`, 'dev'],
		cwd: generated.project,
		logPath: join(generated.project, 'missing-local-environment.log'),
		expectedExitCode: 1,
		expectedOutput: /Missing \.env\. Run `cp \.env\.example \.env`/
	})

	const hasAuth = generated.config.choices.auth.length > 0
	const localEnvironment = await writeLocalEnvironment(
		generated.project,
		'http://127.0.0.1:8787'
	)
	Object.assign(process.env, localEnvironment)
	await run({
		name: 'local-environment-prepare',
		executable: 'corepack',
		args: [`pnpm@${PNPM_VERSION}`, 'local:prepare'],
		cwd: generated.project,
		logPath: join(generated.project, 'database.log')
	})
	if (args.contract) {
		if (generated.config.choices.apiClient !== 'hey-api')
			throw new Error('--contract requires a fixture with apiClient: hey-api')
		const contractEvidence = await verifyOpenApiContract(generated.project)
		console.log(JSON.stringify(contractEvidence, null, 2))
	}
	const recorder = hasAuth ? undefined : startAuthRecorder()
	const authUrl = recorder
		? `http://127.0.0.1:${recorder.target.port}`
		: 'http://127.0.0.1:8787'
	if (recorder) await writeLocalEnvironment(generated.project, authUrl)
	const dev = start({
		executable: 'corepack',
		args: [`pnpm@${PNPM_VERSION}`, 'dev'],
		cwd: generated.project
	})
	let runtimePassed = false
	try {
		const evidence =
			generated.config.choices.deploy === 'cf-workers'
				? await verifyCloudflareTopology({ project: generated.project, command: dev, authUrl })
				: hasAuth
					? await verifyDualOriginAuth({
							project: generated.project,
							command: dev,
							authUrl,
							deploy: generated.config.choices.deploy
						})
					: await verifyGatewayTopology({
							project: generated.project,
							command: dev,
							requests: recorder!.requests,
							authUrl,
							deploy: generated.config.choices.deploy
						})
		console.log(JSON.stringify(evidence, null, 2))
		runtimePassed = true
	} finally {
		await writeSanitizedArtifact({
			path: join(generated.project, 'startup.log'),
			content: dev.output(),
			roots: [generated.project]
		})
		await stop(dev)
		await appendCommandEvidence(generated.project, {
			name: 'local-runtime-smoke',
			command: `corepack pnpm@${PNPM_VERSION} dev`,
			outcome: runtimePassed ? 'passed' : 'failed',
			durationMs: Math.round(performance.now() - dev.started),
			logPath: join(generated.project, 'startup.log'),
			exitCode: runtimePassed ? 0 : 1
		})
		if (recorder) await recorder.target.stop(true)
	}
}

if (import.meta.main) {
	main().catch((error: unknown) => {
		console.error(error instanceof Error ? error.message : String(error))
		process.exitCode = 1
	})
}
