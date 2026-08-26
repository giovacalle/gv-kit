import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { join, resolve } from 'node:path'
import { parseJsonc } from '../src/lib/jsonc.js'
import { buildScaffoldPlan } from '../src/pipeline/plan.js'
import { GvKitConfig, type GvKitConfig as Config } from '../src/schema/config.js'
import {
	appendCommandEvidence,
	writeSanitizedArtifact
} from './gateway-verification-evidence.js'

const PNPM_VERSION = '11.1.1'
const LOCAL_ALLOWED_HOSTS = 'localhost:3000,localhost:5173,localhost:8786,127.0.0.1:8786'
const LOCAL_CORS_ORIGINS = 'http://localhost:3000,http://localhost:5173'

type RunningCommand = {
	child: ReturnType<typeof spawn>
	output: () => string
	started: number
}

type CommandResult = { code: number; output: string }

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
	if (config.choices.deploy !== 'skip') throw new Error(`${fixture} does not use deploy: skip`)

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

async function runCommand(command: string, args: string[], cwd: string): Promise<CommandResult> {
	const child = spawn(command, args, {
		cwd,
		env: {
			...process.env,
			CI: '1',
			PUBLIC_TURNSTILE_SITE_KEY: '1x00000000000000000000AA',
			SQLITE_PATH: `file:${join(cwd, 'packages/db/local.db')}`,
			DATABASE_URL: '',
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

async function run(
	name: string,
	command: string,
	args: string[],
	cwd: string,
	logPath: string,
	expectedExitCode = 0,
	expectedOutput?: RegExp
): Promise<void> {
	const started = performance.now()
	const result = await runCommand(command, args, cwd)
	const rendered = `${command} ${args.join(' ')}`
	await writeSanitizedArtifact(logPath, `$ ${rendered}\n\n${result.output}`, [cwd])
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

async function availablePort(preferred: number): Promise<number> {
	for (const port of [preferred, ...Array.from({ length: 100 }, (_, index) => 18_700 + index)]) {
		const available = await new Promise<boolean>((done) => {
			const server = createServer()
			server.once('error', () => done(false))
			server.listen(port, '127.0.0.1', () => server.close(() => done(true)))
		})
		if (available) return port
	}
	throw new Error('Could not find a free local auth verification port')
}

function start(command: string, args: string[], cwd: string, authUrl: string): RunningCommand {
	const child = spawn(command, args, {
		cwd,
		detached: true,
		env: {
			...process.env,
			CI: '1',
			TURBO_FORCE: 'true',
			PATH: `${join(cwd, '.verify-bin')}:${process.env.PATH ?? ''}`,
			GATEWAY_URL: 'http://127.0.0.1:8786',
			API_PUBLIC_ORIGIN: 'http://localhost:8786',
			AUTH_URL: authUrl,
			AUTH_PORT: new URL(authUrl).port,
			USERS_URL: 'http://127.0.0.1:8788',
			BETTER_AUTH_SECRET: 'local-only-better-auth-secret-at-least-32-characters',
			BETTER_AUTH_ALLOWED_HOSTS: LOCAL_ALLOWED_HOSTS,
			AUTH_CORS_ORIGINS: LOCAL_CORS_ORIGINS,
			SQLITE_PATH: `file:${join(cwd, 'packages/db/local.db')}`,
			RESEND_API_KEY: '',
			NOTIFUSE_API_KEY: '',
			TURNSTILE_SECRET_KEY: '1x0000000000000000000000000000000AA'
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
	requests,
	authUrl
}: {
	project: string
	requests: RecordedRequest[]
	authUrl: string
}) {
	const gatewayHealth = await requestWhenReady('http://127.0.0.1:8786/api/healthz')
	const openApiResponse = await requestWhenReady('http://127.0.0.1:8786/api/openapi.json')
	const runtimeOpenApi = (await openApiResponse.json()) as { servers?: { url: string }[] }
	const webHealth = await requestWhenReady('http://localhost:5173/api/healthz')
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
	if (evidence.gatewayHealth.status !== 200 || evidence.gatewayHealth.body !== 'ok') {
		throw new Error('independent gateway health failed')
	}
	if (evidence.webAliasHealth.status !== 200 || evidence.webAliasHealth.body !== 'ok') {
		throw new Error('web same-origin alias health failed')
	}
	if (
		evidence.openApi.status !== 200 ||
		JSON.stringify(evidence.openApi.servers) !== JSON.stringify([{ url: 'http://localhost:8786' }])
	) {
		throw new Error('runtime OpenAPI did not advertise the configured local canonical origin')
	}
	if (evidence.knownPrefix.status !== 401) throw new Error('known users prefix was not forwarded')
	if (evidence.unknownPrefix.status !== 404) {
		throw new Error('unknown gateway prefix did not return 404')
	}
	if (evidence.directDebugHealth.status !== 200)
		throw new Error('users debug service did not start')
	if (
		evidence.directAuthTransport.requests.length !== 1 ||
		evidence.directAuthTransport.requests[0]?.cookie !== 'session=verification'
	) {
		throw new Error('users service did not call the direct private auth transport')
	}
	if (
		evidence.upstreamRedirect.status !== 302 ||
		evidence.upstreamRedirect.location !== '/api/auth/final' ||
		evidence.upstreamRedirect.marker !== 'preserved' ||
		evidence.upstreamRedirect.requests.length !== 1
	) {
		throw new Error('gateway did not preserve the upstream redirect response')
	}
	await writeSanitizedArtifact(
		join(project, 'evidence.json'),
		`${JSON.stringify(evidence, null, 2)}\n`,
		[project]
	)
	return evidence
}

async function postJson(url: string, body: unknown, headers: Record<string, string> = {}) {
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

async function signInWithOtp(origin: string, email: string, command: RunningCommand) {
	const send = await postJson(
		`${origin}/api/auth/email-otp/send-verification-otp`,
		{ email, type: 'sign-in' },
		{ origin, 'x-captcha-response': 'XXXX.DUMMY.TOKEN.XXXX' }
	)
	if (!send.ok)
		throw new Error(`OTP send failed for ${origin}: ${send.status} ${await send.text()}`)
	const otp = await waitForOtp(command, email)
	const signIn = await postJson(`${origin}/api/auth/sign-in/email-otp`, { email, otp }, { origin })
	if (!signIn.ok) {
		throw new Error(`OTP sign-in failed for ${origin}: ${signIn.status} ${await signIn.text()}`)
	}
	const jar = cookieJar(signIn)
	if (!jar.header) throw new Error(`OTP sign-in for ${origin} did not set a cookie`)
	if (jar.setCookies.some((cookie) => /(?:^|;)\s*domain=/i.test(cookie))) {
		throw new Error(`OTP sign-in for ${origin} emitted a domain cookie`)
	}
	return jar
}

async function verifySession(origin: string, jar: CookieJar, email: string) {
	const response = await fetch(`${origin}/api/auth/get-session`, {
		headers: { cookie: jar.header }
	})
	if (!response.ok) throw new Error(`session load failed for ${origin}: ${response.status}`)
	const session = (await response.json()) as { user?: { email?: string } }
	if (session.user?.email !== email)
		throw new Error(`session load returned the wrong user for ${origin}`)
	return { status: response.status, email: session.user.email }
}

async function verifyDualOriginAuth(project: string, command: RunningCommand, authUrl: string) {
	const webOrigin = 'http://localhost:5173'
	const apiOrigin = 'http://127.0.0.1:8786'
	const gatewayHealth = await requestWhenReady(`${apiOrigin}/api/healthz`)
	const gatewayHealthBody = await gatewayHealth.text()
	const openApiResponse = await requestWhenReady(`${apiOrigin}/api/openapi.json`)
	if (openApiResponse.status !== 200) throw new Error('runtime OpenAPI did not return 200')
	const runtimeOpenApi = (await openApiResponse.json()) as { servers?: { url: string }[] }
	if (
		JSON.stringify(runtimeOpenApi.servers) !== JSON.stringify([{ url: 'http://localhost:8786' }])
	) {
		throw new Error('runtime OpenAPI did not advertise the configured local canonical origin')
	}
	const webHealth = await requestWhenReady(`${webOrigin}/api/healthz`)
	const webHealthBody = await webHealth.text()
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
	const unknownHostBody = await unknownHost.text()
	if (allowedCors.status !== 200) {
		throw new Error(`approved Better Auth host control failed with ${allowedCors.status}`)
	}
	if (allowedCors.headers.get('access-control-allow-origin') !== webOrigin) {
		throw new Error(
			`approved CORS origin was not echoed: status=${allowedCors.status} headers=${JSON.stringify(Object.fromEntries(allowedCors.headers))}`
		)
	}
	if (allowedCors.headers.get('access-control-allow-credentials') !== 'true') {
		throw new Error('approved CORS origin did not allow credentials')
	}
	if (deniedCors.headers.get('access-control-allow-origin')) {
		throw new Error('denied CORS origin received an allow-origin header')
	}
	const unknownHostDiagnostic =
		'Host "evil.example.test" is not in the allowed hosts list.'
	if (
		unknownHost.status !== 500 ||
		unknownHostBody !== 'Internal Server Error' ||
		!command.output().includes(unknownHostDiagnostic)
	) {
		throw new Error(
			`unknown Better Auth host did not return the expected rejection: ${unknownHost.status} ${unknownHostBody}`
		)
	}

	const webEmail = 'web-origin@example.test'
	const apiEmail = 'api-origin@example.test'
	const webJar = await signInWithOtp(webOrigin, webEmail, command)
	const apiJar = await signInWithOtp(apiOrigin, apiEmail, command)
	if (webJar.header === apiJar.header)
		throw new Error('web and API origins received the same cookie jar')
	const webSession = await verifySession(webOrigin, webJar, webEmail)
	const apiSession = await verifySession(apiOrigin, apiJar, apiEmail)
	const knownPrefix = await fetch(`${apiOrigin}/api/v1/users/me`, {
		headers: { cookie: apiJar.header }
	})
	const knownBody = (await knownPrefix.json()) as { email?: string }
	const unknownPrefix = await fetch(`${apiOrigin}/api/unknown`)
	if (!knownPrefix.ok || knownBody.email !== apiEmail) {
		throw new Error('known users prefix did not return the API-origin session')
	}
	if (unknownPrefix.status !== 404) throw new Error('unknown gateway prefix did not return 404')
	const ssr = await fetch(webOrigin, { headers: { cookie: webJar.header } })
	const ssrBody = await ssr.text()
	if (!ssr.ok || !ssrBody.includes(webEmail))
		throw new Error('web SSR did not load the gateway session')
	const sdkSsr = await fetch(`${webOrigin}/users`, { headers: { cookie: webJar.header } })
	const sdkSsrBody = await sdkSsr.text()
	if (!sdkSsr.ok || !sdkSsrBody.includes(webEmail)) {
		throw new Error('SSR flat client operation did not use the private gateway transport')
	}

	const evidence = {
		project: '.',
		ingress: {
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
		unknownHost: {
			host: 'evil.example.test',
			status: unknownHost.status,
			responseBody: unknownHostBody,
			diagnostic: unknownHostDiagnostic
		},
		sessions: { web: webSession, api: apiSession },
		routes: {
			knownPrefix: { status: knownPrefix.status, email: knownBody.email },
			unknownPrefix: { status: unknownPrefix.status }
		},
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
	await writeSanitizedArtifact(
		join(project, 'evidence.json'),
		`${JSON.stringify(evidence, null, 2)}\n`,
		[project]
	)
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
	await run(
		'openapi-check-baseline',
		'corepack',
		[...pnpm, 'openapi:check'],
		project,
		join(project, 'openapi-check-baseline.log'),
		0,
		cleanDiagnostic
	)
	await run(
		'openapi-compose-first',
		'corepack',
		[...pnpm, 'openapi:compose'],
		project,
		join(project, 'openapi-compose-first.log')
	)
	const openApiPath = join(project, 'apps/api/openapi.json')
	const firstDocument = await readFile(openApiPath, 'utf8')
	const firstHash = createHash('sha256').update(firstDocument).digest('hex')
	await run(
		'openapi-compose-second',
		'corepack',
		[...pnpm, 'openapi:compose'],
		project,
		join(project, 'openapi-compose-second.log')
	)
	const secondDocument = await readFile(openApiPath, 'utf8')
	const secondHash = createHash('sha256').update(secondDocument).digest('hex')
	if (firstHash !== secondHash || firstDocument !== secondDocument) {
		throw new Error('repeated OpenAPI composition was not byte-identical')
	}

	await writeFile(openApiPath, `${secondDocument} `)
	await run(
		'openapi-drift-rejection',
		'corepack',
		[...pnpm, 'openapi:check'],
		project,
		join(project, 'openapi-drift.log'),
		1,
		driftDiagnostic
	)
	await run(
		'openapi-compose-restore',
		'corepack',
		[...pnpm, 'openapi:compose'],
		project,
		join(project, 'openapi-compose-restore.log')
	)
	await run(
		'openapi-check-final',
		'corepack',
		[...pnpm, 'openapi:check'],
		project,
		join(project, 'openapi-check-final.log'),
		0,
		cleanDiagnostic
	)
	await run('openapi-codegen', 'corepack', [...pnpm, 'codegen'], project, join(project, 'codegen.log'))
	await run(
		'typed-consumer-check',
		'corepack',
		[...pnpm, 'typecheck'],
		project,
		join(project, 'typecheck.log')
	)

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
	if (Object.keys(checkedDocument.paths).some((path) => path.startsWith('/api/auth'))) {
		throw new Error('checked OpenAPI contains Better Auth routes')
	}
	if (JSON.stringify(clientPackage.exports) !== JSON.stringify({ '.': './src/index.ts' })) {
		throw new Error('generated client exposes service package subpaths')
	}
	if (!clientConfig.includes('apps/api/openapi.json') || clientConfig.includes('services/users')) {
		throw new Error('Hey API does not read only the composed gateway document')
	}
	if (!generatedClient.includes('usersGetMe') || generatedClient.includes('/api/auth')) {
		throw new Error('generated client operation inventory is not the flat public domain contract')
	}
	if (!browserConsumer.includes("from '@repo/openapi-client'")) {
		throw new Error('browser consumer does not use the flat client root')
	}
	if (
		!ssrConsumer.includes("usersGetMe } from '@repo/openapi-client'") ||
		!ssrConsumer.includes('usersGetMe({ baseUrl: url.origin, fetch })')
	) {
		throw new Error('SSR consumer does not inject its request-scoped fetch transport')
	}

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
	await writeSanitizedArtifact(
		join(project, 'contract-evidence.json'),
		`${JSON.stringify(evidence, null, 2)}\n`,
		[project]
	)
	return evidence
}

async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2))
	const generated = await materialize(args.fixture, args.output)
	console.log(`[gateway-local] generated project: ${generated.project}`)

	await run(
		'install',
		'corepack',
		[`pnpm@${PNPM_VERSION}`, 'install', '--no-frozen-lockfile'],
		generated.project,
		join(generated.project, 'install.log')
	)
	if (args.contract) {
		if (generated.config.choices.apiClient !== 'hey-api') {
			throw new Error('--contract requires a fixture with apiClient: hey-api')
		}
		const contractEvidence = await verifyOpenApiContract(generated.project)
		console.log(JSON.stringify(contractEvidence, null, 2))
	}

	const hasAuth = generated.config.choices.auth.length > 0
	if (hasAuth) {
		await run(
			'database-prepare',
			'corepack',
			[`pnpm@${PNPM_VERSION}`, '--filter', '@repo/db', 'exec', 'drizzle-kit', 'push', '--force'],
			generated.project,
			join(generated.project, 'database.log')
		)
	}
	const recorder = hasAuth ? undefined : startAuthRecorder()
	const authPort = hasAuth ? await availablePort(8787) : undefined
	const authUrl = recorder
		? `http://127.0.0.1:${recorder.target.port}`
		: `http://127.0.0.1:${authPort}`
	const dev = start(
		'corepack',
		[`pnpm@${PNPM_VERSION}`, 'dev', '--env-mode=loose'],
		generated.project,
		authUrl
	)
	let runtimePassed = false
	try {
		const evidence = hasAuth
			? await verifyDualOriginAuth(generated.project, dev, authUrl)
			: await verifyGatewayTopology({
					project: generated.project,
					requests: recorder!.requests,
					authUrl
				})
		console.log(JSON.stringify(evidence, null, 2))
		runtimePassed = true
	} finally {
		await writeSanitizedArtifact(join(generated.project, 'startup.log'), dev.output(), [
			generated.project
		])
		await stop(dev)
		await appendCommandEvidence(generated.project, {
			name: 'local-runtime-smoke',
			command: `corepack pnpm@${PNPM_VERSION} dev --env-mode=loose`,
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
