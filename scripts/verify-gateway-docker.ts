import { spawn } from 'node:child_process'
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createConnection, createServer } from 'node:net'
import { join, resolve } from 'node:path'
import { parseJsonc } from '../src/lib/jsonc.js'
import { buildScaffoldPlan } from '../src/pipeline/plan.js'
import { GvKitConfig } from '../src/schema/config.js'
import { appendCommandEvidence, writeSanitizedArtifact } from './gateway-verification-evidence.js'

const PNPM_VERSION = '11.1.1'
let webOrigin = 'http://localhost:3000'
let apiOrigin = 'http://api.localhost:3000'
let marketingOrigin = 'http://localhost:4321'
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
type ComposeArgumentsOptions =
	| { composeCommand: 'logs'; noColor?: boolean; services?: string[] }
	| { composeCommand: 'ps'; all?: boolean; format?: 'json'; quiet?: boolean }
	| {
			composeCommand: 'down'
			volumes?: boolean
			removeOrphans?: boolean
			removeImages?: 'local'
		}
	| { composeCommand: 'config'; format?: 'json' }
	| { composeCommand: 'up'; build?: boolean; detached?: boolean }

function parseArgs(argv: string[]): { contract: boolean; fixture: string; output: string } {
	let contract = false
	let fixture = 'hono-docker-emailotp-only'
	let output = resolve('.scratch/gateway-docker')
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index]
		if (arg === '--contract') contract = true
		else if (arg === '--fixture') fixture = argv[++index] ?? fixture
		else if (arg === '--output') output = resolve(argv[++index] ?? output)
		else throw new Error(`Unknown argument: ${arg}`)
	}
	return { contract, fixture, output }
}

async function materialize(fixture: string, output: string) {
	const config = GvKitConfig.parse(
		parseJsonc(await readFile(resolve('fixtures', `${fixture}.jsonc`), 'utf8'))
	)
	if (config.choices.backend !== 'hono' || config.choices.deploy !== 'docker') throw new Error(`${fixture} must use the Hono Docker topology`)
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

async function installStreamingProbe(project: string): Promise<void> {
	const path = join(project, 'services/users/src/app.ts')
	const app = await readFile(path, 'utf8')
	const authBoundary = "app.use('/api/v1/users/*', requireAuth)"
	const probe = `let firstUploadChunkReceived = false

app.get('/api/v1/users/__verify/stream', () => {
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(new TextEncoder().encode('first\\n'))
			setTimeout(() => {
				controller.enqueue(new TextEncoder().encode('second\\n'))
				controller.close()
			}, 1000)
		}
	})
	return new Response(body, { headers: { 'content-type': 'text/plain' } })
})

app.post('/api/v1/users/__verify/upload', async (c) => {
	const reader = c.req.raw.body?.getReader()
	if (!reader) return c.text('request body required', 400)
	const first = await reader.read()
	firstUploadChunkReceived = !first.done
	while (!(await reader.read()).done) {}
	return c.text('uploaded')
})

app.get('/api/v1/users/__verify/upload-status', (c) =>
	c.json({ firstUploadChunkReceived })
)

${authBoundary}`
	if (!app.includes(authBoundary)) throw new Error('Could not install the Docker streaming probe')
	await writeFile(path, app.replace(authBoundary, probe))
}

async function captureCommandResult({
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

async function recordCommandEvidence({
	name,
	program,
	args,
	cwd,
	env,
	logPath
}: RecordedDockerCommandOptions): Promise<string> {
	const started = performance.now()
	const result = await captureCommandResult({ program, args, cwd, env })
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

function composeArgs(options: ComposeArgumentsOptions): string[] {
	const args = ['compose', options.composeCommand]
	if (options.composeCommand === 'logs') {
		if (options.noColor) args.push('--no-color')
		args.push(...(options.services ?? []))
	} else if (options.composeCommand === 'ps') {
		if (options.all) args.push('--all')
		if (options.format) args.push('--format', options.format)
		if (options.quiet) args.push('-q')
	} else if (options.composeCommand === 'down') {
		if (options.volumes) args.push('--volumes')
		if (options.removeOrphans) args.push('--remove-orphans')
		if (options.removeImages) args.push('--rmi', options.removeImages)
	} else if (options.composeCommand === 'config') {
		const { format } = options
		if (format) args.push('--format', format)
	} else if (options.composeCommand === 'up') {
		if (options.build) args.push('--build')
		if (options.detached) args.push('-d')
	}
	return args
}

async function portAvailable(port: number): Promise<boolean> {
	return new Promise((done) => {
		const server = createServer()
		server.once('error', () => done(false))
		server.listen(port, '0.0.0.0', () => server.close(() => done(true)))
	})
}

async function availableRuntimePort(preferred: number, start: number): Promise<number> {
	if (await portAvailable(preferred)) return preferred
	for (let port = start; port < start + 100; port += 1) if (await portAvailable(port)) return port
	throw new Error(`Could not find a free verification port for ${preferred}`)
}

async function pathExists(path: string): Promise<boolean> {
	return access(path).then(
		() => true,
		() => false
	)
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

async function verifyDelayedResponse(url: string) {
	const started = performance.now()
	const response = await fetch(url)
	const reader = response.body?.getReader()
	if (!response.ok || !reader) throw new Error(`Streaming response failed at ${url}`)
	const first = await reader.read()
	const firstChunkAtMs = Math.round(performance.now() - started)
	const firstText = new TextDecoder().decode(first.value)
	if (first.done || firstText !== 'first\n') throw new Error(`First response chunk was buffered at ${url}`)
	let remainder = ''
	while (true) {
		const chunk = await reader.read()
		if (chunk.done) break
		remainder += new TextDecoder().decode(chunk.value)
	}
	const completedAtMs = Math.round(performance.now() - started)
	if (remainder !== 'second\n' || completedAtMs - firstChunkAtMs < 500) throw new Error(`Delayed response chunks were not streamed at ${url}`)
	return { firstChunkAtMs, completedAtMs }
}

async function verifyChunkedRequest(url: string, statusUrl: string) {
	const target = new URL(url)
	const firstChunk = 'first-upload-chunk'
	const secondChunk = 'second-upload-chunk'
	const socket = createConnection({ host: '127.0.0.1', port: Number(target.port) })
	let rawResponse = ''
	const completed = new Promise<string>((done) => {
		socket.on('data', (chunk) => (rawResponse += chunk.toString()))
		socket.on('end', () => done(rawResponse))
		socket.on('error', () => done(rawResponse))
	})
	await new Promise<void>((done, reject) => {
		socket.once('connect', done)
		socket.once('error', reject)
	})
	socket.write(
		`POST ${target.pathname} HTTP/1.1\r\nHost: ${target.host}\r\nContent-Type: application/octet-stream\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n`
	)
	socket.write(`${Buffer.byteLength(firstChunk).toString(16)}\r\n${firstChunk}\r\n`)

	const deadline = Date.now() + 2_000
	let firstChunkObserved = false
	while (Date.now() < deadline) {
		const status = await fetch(statusUrl)
		const body = (await status.json()) as { firstUploadChunkReceived?: boolean }
		if (body.firstUploadChunkReceived) {
			firstChunkObserved = true
			break
		}
		await Bun.sleep(25)
	}
	if (!firstChunkObserved) {
		socket.destroy()
		throw new Error('Gateway upstream did not receive the first chunk before upload completion')
	}

	socket.write(`${Buffer.byteLength(secondChunk).toString(16)}\r\n${secondChunk}\r\n0\r\n\r\n`)
	const response = await completed
	const status = Number(response.match(/^HTTP\/1\.1 (\d{3})/)?.[1] ?? 0)
	if (status !== 200 || !response.includes('uploaded')) throw new Error(`Chunked upload did not complete through Docker ingress: status ${status}`)
	return { firstChunkObservedBeforeUploadCompletion: true, status }
}

async function verifyStreamingRuntime() {
	const path = '/api/v1/users/__verify/stream'
	const uploadPath = '/api/v1/users/__verify/upload'
	return {
		responses: {
			webAlias: await verifyDelayedResponse(`${webOrigin}${path}`),
			canonicalApiHost: await verifyDelayedResponse(`${apiOrigin}${path}`)
		},
		request: await verifyChunkedRequest(
			`${apiOrigin}${uploadPath}`,
			`${apiOrigin}${uploadPath}-status`
		)
	}
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
		const result = await captureCommandResult({
			program: 'docker',
			args: composeArgs({ composeCommand: 'logs', noColor: true, services: ['auth'] }),
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
				content: result.output.replace(/(\[auth\] OTP for [^:]+: )\d{6}/g, '$1[REDACTED]'),
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
	if (!response.ok) throw new Error(`OTP sign-in failed at ${origin}: ${response.status} ${await response.text()}`)
	const jar = cookieJar(response)
	if (!jar.header) throw new Error(`OTP sign-in at ${origin} did not set a cookie`)
	if (jar.setCookies.some((cookie) => /(?:^|;)\s*domain=/i.test(cookie))) throw new Error(`OTP sign-in at ${origin} emitted a domain cookie`)
	return jar
}

async function session({ origin, jar, email }: { origin: string; jar: CookieJar; email: string }) {
	const response = await fetch(`${origin}/api/auth/get-session`, {
		headers: { cookie: jar.header }
	})
	const body = (await response.json()) as { user?: { email?: string } }
	if (!response.ok || body.user?.email !== email) throw new Error(`Session at ${origin} did not return ${email}`)
	return { status: response.status, email: body.user.email }
}

async function verifyRuntime({
	project,
	env,
	inventory,
	config,
	contract
}: {
	project: string
	env: NodeJS.ProcessEnv
	inventory: unknown
	config: GvKitConfig
	contract: boolean
}) {
	const hasAuth = config.choices.auth.length > 0
	const hasMarketing = config.choices.marketing === 'astro'
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
	const openApi = (await openApiResponse.json()) as {
		servers?: { url: string }[]
		paths?: Record<string, unknown>
	}
	const webResponse = await requestWhenReady(webOrigin)
	const marketingResponse = hasMarketing ? await requestWhenReady(marketingOrigin) : undefined
	const marketingHealth = hasMarketing
		? await requestWhenReady(`${marketingOrigin}/healthz`)
		: undefined
	const streaming = contract ? await verifyStreamingRuntime() : undefined
	if ( directHealth.status !== 200 || webAliasHealth.status !== 200 || canonicalHostHealth.status !== 200 ) throw new Error('One or more gateway ingress health checks failed')
	if (exactWebAlias.status !== 404 || !exactWebAlias.headers.get('x-request-id')) throw new Error('Exact web-origin /api boundary did not reach the gateway')
	if (JSON.stringify(openApi.servers) !== JSON.stringify([{ url: apiOrigin }])) throw new Error('Runtime OpenAPI did not advertise the explicit independent API origin')
	if ( unknownDirectHost.status !== 421 || (await unknownDirectHost.text()) !== 'misdirected request' ) throw new Error('Forged forwarding headers approved an unknown Docker direct host')
	const approvedAuthStatus = hasAuth ? 200 : 404
	if ( approvedWebWithForgedForwarding.status !== approvedAuthStatus || approvedApiWithForgedForwarding.status !== approvedAuthStatus ) throw new Error('Caller forwarding headers overrode an approved Docker public host')
	if (!webResponse.ok) throw new Error(`Web ingress failed: ${webResponse.status}`)
	if (hasMarketing && (!marketingResponse?.ok || marketingHealth?.status !== 200)) throw new Error('Marketing ingress failed')

	if (!hasAuth) {
		const webAuth = await fetch(`${webOrigin}/api/auth/get-session`)
		const apiAuth = await fetch(`${apiOrigin}/api/auth/get-session`)
		const webUsers = await fetch(`${webOrigin}/api/v1/users/me`)
		const apiUsers = await fetch(`${apiOrigin}/api/v1/users/me`)
		if (webAuth.status !== 404 || apiAuth.status !== 404) throw new Error('No-auth mode exposed a public Better Auth method')
		if (webAuth.headers.has('set-cookie') || apiAuth.headers.has('set-cookie')) throw new Error('No-auth mode emitted an auth cookie')
		if (webUsers.status !== 401 || apiUsers.status !== 401) throw new Error('No-auth users behavior did not reject the absent session')
		if (!openApi.paths?.['/api/v1/users/me'] || openApi.paths['/api/auth/get-session']) throw new Error('No-auth OpenAPI contract exposed the wrong paths')

		return {
			project: '.',
			inventory,
			streaming,
			ingress: {
				exactWebAlias: {
					url: `${webOrigin}/api`,
					status: exactWebAlias.status,
					gatewayRequestId: true
				},
				web: { url: webOrigin, status: webResponse.status },
				webAlias: { url: `${webOrigin}/api/healthz`, status: webAliasHealth.status },
				canonicalApiHost: { host: new URL(apiOrigin).host, status: canonicalHostHealth.status },
				independentApi: { url: `${DIRECT_API_ORIGIN}/api/healthz`, status: directHealth.status },
				...(hasMarketing
					? {
							marketing: {
								url: marketingOrigin,
								status: marketingResponse!.status,
								healthStatus: marketingHealth!.status
							}
						}
					: {}),
				publicHostMatrix: {
					approvedWebWithForgedForwarding: approvedWebWithForgedForwarding.status,
					approvedApiWithForgedForwarding: approvedApiWithForgedForwarding.status,
					unknownDirectWithApprovedForwarding: unknownDirectHost.status
				}
			},
			auth: {
				enabled: false,
				webPublicMethodStatus: webAuth.status,
				apiPublicMethodStatus: apiAuth.status,
				cookies: []
			},
			users: { web: { status: webUsers.status }, api: { status: apiUsers.status } },
			openApi: {
				status: openApiResponse.status,
				servers: openApi.servers,
				paths: Object.keys(openApi.paths ?? {}).sort()
			}
		}
	}

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
	if (!webUsers.ok || !apiUsers.ok) {
		throw new Error(
			`Versioned users route failed through an ingress: web=${webUsers.status} ${await webUsers.text()}; api=${apiUsers.status} ${await apiUsers.text()}`
		)
	}
	const webUsersBody = (await webUsers.json()) as { email?: string }
	const apiUsersBody = (await apiUsers.json()) as { email?: string }
	if (webUsersBody.email !== webEmail || apiUsersBody.email !== apiEmail) throw new Error('Versioned users route returned the wrong authenticated user')

	const ssr = await fetch(webOrigin, { headers: { cookie: webJar.header } })
	const ssrBody = await ssr.text()
	if (!ssr.ok || !ssrBody.includes(webEmail)) throw new Error('Web SSR did not load the session through the private gateway URL')

	return {
		project: '.',
		inventory,
		streaming,
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

type ComposeProcess = {
	Service: string
	State: string
	Health?: string
	ExitCode?: number
	Publishers?: Array<{ PublishedPort?: number }>
}

function parseComposeProcesses(output: string): ComposeProcess[] {
	try {
		const parsed = JSON.parse(output) as ComposeProcess | ComposeProcess[]
		return Array.isArray(parsed) ? parsed : [parsed]
	} catch {
		return output
			.split('\n')
			.filter(Boolean)
			.map((line) => JSON.parse(line) as ComposeProcess)
	}
}

async function runtimeServiceInventory({
	project,
	env,
	expected
}: {
	project: string
	env: NodeJS.ProcessEnv
	expected: string[]
}) {
	const started = performance.now()
	const deadline = Date.now() + 30_000
	let output = ''
	let exitCode = 1
	let inventory: Record<
		string,
		{ state: string; health: string; exitCode: number | undefined; publishedPorts: number[] }
	> = {}
	let failure = 'Compose runtime inventory did not become ready'
	while (Date.now() < deadline) {
		const result = await captureCommandResult({
			program: 'docker',
			args: composeArgs({ composeCommand: 'ps', all: true, format: 'json' }),
			cwd: project,
			env
		})
		output = result.output
		exitCode = result.code
		if (result.code === 0) {
			const processes = parseComposeProcesses(output)
			inventory = Object.fromEntries(
				processes.map((process) => [
					process.Service,
					{
						state: process.State,
						health: process.Health ?? '',
						exitCode: process.ExitCode,
						publishedPorts: (process.Publishers ?? []).flatMap(({ PublishedPort }) =>
							PublishedPort ? [PublishedPort] : []
						)
					}
				])
			)
			const unavailable = expected.find((name) => {
				const service = inventory[name]
				if (!service) return true
				if (name === 'migrate') return service.state !== 'exited' || service.exitCode !== 0
				return service.state !== 'running' || service.health !== 'healthy'
			})
			if (!unavailable) {
				failure = ''
				break
			}
			failure = `${unavailable} is not ready`
		}
		await Bun.sleep(500)
	}
	const logPath = join(project, 'runtime-service-inventory.log')
	await writeSanitizedArtifact({
		path: logPath,
		content: `$ docker compose ps --all --format json\n\n${output}`,
		roots: [project]
	})
	await appendCommandEvidence(project, {
		name: 'compose-runtime-service-inventory',
		command: 'docker compose ps --all --format json',
		outcome: failure ? 'failed' : 'passed',
		durationMs: Math.round(performance.now() - started),
		logPath,
		exitCode
	})
	if (failure) throw new Error(failure)
	return inventory
}

async function assertCleanup(project: string, env: NodeJS.ProcessEnv) {
	const checks = [
		{
			name: 'cleanup-container-inventory',
			args: composeArgs({ composeCommand: 'ps', quiet: true }),
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
		const result = await captureCommandResult({ program: 'docker', args: [...check.args], cwd: project, env })
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
	if (args.contract) await installStreamingProbe(generated.project)
	const hasAuth = generated.config.choices.auth.length > 0
	const hasMarketing = generated.config.choices.marketing === 'astro'
	const webPort = await availableRuntimePort(3000, 13_000)
	const marketingPort = hasMarketing ? await availableRuntimePort(4321, 14_000) : 4321
	webOrigin = `http://localhost:${webPort}`
	apiOrigin = `http://${API_HOST}:${webPort}`
	marketingOrigin = `http://localhost:${marketingPort}`
	const composeOverrides = ['services:']
	const marketingOverrides = [
		'  marketing:',
		'    ports: !override',
		`      - "${marketingPort}:8080"`
	]
	if (webPort !== 3000) composeOverrides.push('  ingress:', '    ports: !override', `      - "${webPort}:8080"`)
	if (hasMarketing && marketingPort !== 4321) composeOverrides.push(...marketingOverrides)
	const composeOverridePath = join(generated.project, 'compose.verify.yml')
	const composeOverride = `${composeOverrides.join('\n')}\n`
	if (composeOverrides.length > 1) await writeFile(composeOverridePath, composeOverride)
	const projectName = `gvkit-${generated.config.choices.name}`.replace(/[^a-z0-9_-]/g, '-')
	const env: NodeJS.ProcessEnv = {
		CI: '1',
		PATH: `${generated.binPath}:${process.env.PATH ?? ''}`,
		COMPOSE_PROJECT_NAME: projectName,
		...(composeOverrides.length === 1
			? {}
			: {
					COMPOSE_FILE: `docker-compose.yml${process.platform === 'win32' ? ';' : ':'}compose.verify.yml`
				}),
		POSTGRES_USER: 'gvkit',
		POSTGRES_PASSWORD: 'gvkit-local-password',
		POSTGRES_DB: 'gvkit',
		DATABASE_URL: 'postgres://gvkit:gvkit-local-password@postgres:5432/gvkit',
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
		GATEWAY_UPSTREAM_TIMEOUT_MS: '10000'
	}
	if (hasAuth) {
		Object.assign(env, {
			BETTER_AUTH_SECRET: 'docker-only-better-auth-secret-at-least-32-characters',
			GOOGLE_CLIENT_ID: 'docker-google-client',
			GOOGLE_CLIENT_SECRET: 'docker-google-secret',
			RESEND_API_KEY: '',
			FROM_EMAIL: 'verify@example.test',
			NOTIFUSE_API_KEY: 'docker-notifuse-key',
			NOTIFUSE_WORKSPACE_ID: 'docker-workspace',
			NOTIFUSE_BASE_URL: 'https://notifuse.example.test',
			TURNSTILE_SECRET_KEY: '1x0000000000000000000000000000000AA',
			PUBLIC_TURNSTILE_SITE_KEY: '1x00000000000000000000AA'
		})
	}
	console.log(`[gateway-docker] generated project: ${generated.project}`)
	const webHooks = await readFile(join(generated.project, 'apps/web/src/hooks.server.ts'), 'utf8')
	if (webHooks.includes('forwardApiAlias') || webHooks.includes('gateway.fetch(event.request)')) throw new Error('generated SvelteKit hooks contain an inbound browser API proxy')
	if (!webHooks.includes('export const handleFetch') || !webHooks.includes('env.GATEWAY_URL')) throw new Error('generated SvelteKit hooks omit the private SSR gateway transport')
	const ingressConfig = await readFile(
		join(generated.project, 'docker/ingress.conf.template'),
		'utf8'
	)
	if (!ingressConfig.includes('location = /api') || !ingressConfig.includes('location ^~ /api/')) throw new Error('generated Docker ingress omits an exact API boundary')
	if (!hasAuth) {
		const authPackage = await readFile(join(generated.project, 'services/auth/package.json'), 'utf8')
		const absentAuthPaths = [
			'services/auth/src/auth.ts',
			'services/auth/src/lib/utils.ts',
			'apps/web/src/lib/auth/client.ts',
			'apps/web/src/routes/login/+page.svelte'
		]
		if (authPackage.includes('better-auth') || authPackage.includes('@repo/db')) throw new Error('no-auth transport retained auth-only dependencies')
		for (const path of absentAuthPaths) if (await pathExists(join(generated.project, path))) throw new Error(`no-auth output retained ${path}`)
	}

	let evidence: unknown
	let cleanup: unknown
	try {
		await recordCommandEvidence({
			name: 'install',
			program: 'corepack',
			args: [`pnpm@${PNPM_VERSION}`, 'install', '--no-frozen-lockfile'],
			cwd: generated.project,
			env,
			logPath: join(generated.project, 'install.log')
		})
		await recordCommandEvidence({
			name: 'database-generate',
			program: 'corepack',
			args: [`pnpm@${PNPM_VERSION}`, '--filter', '@repo/db', 'db:generate'],
			cwd: generated.project,
			env,
			logPath: join(generated.project, 'database-generate.log')
		})
		await recordCommandEvidence({
			name: 'compose-pre-cleanup',
			program: 'docker',
			args: composeArgs({ composeCommand: 'down', volumes: true, removeOrphans: true }),
			cwd: generated.project,
			env,
			logPath: join(generated.project, 'pre-cleanup.log')
		})
		const configJson = await recordCommandEvidence({
			name: 'compose-config',
			program: 'docker',
			args: composeArgs({ composeCommand: 'config', format: 'json' }),
			cwd: generated.project,
			env,
			logPath: join(generated.project, 'compose-config.log')
		})
		const parsed = JSON.parse(configJson) as {
			services: Record<
				string,
				{ ports?: unknown[]; depends_on?: unknown; environment?: Record<string, string> }
			>
			networks: Record<string, unknown>
			volumes?: Record<string, unknown>
		}
		if ((parsed.services.auth?.ports?.length ?? 0) > 0 || (parsed.services.users?.ports?.length ?? 0) > 0) throw new Error('A private service publishes a host port')
		if (!hasAuth && JSON.stringify(parsed.services.auth?.environment ?? {}) !== JSON.stringify({ PORT: '8787' })) throw new Error('No-auth Compose requires auth-only environment')
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
		await recordCommandEvidence({
			name: 'compose-build-and-up',
			program: 'docker',
			args: composeArgs({ composeCommand: 'up', build: true, detached: true }),
			cwd: generated.project,
			env,
			logPath: join(generated.project, 'compose-up.log')
		})
		const runtimeStarted = performance.now()
		try {
			evidence = await verifyRuntime({
				project: generated.project,
				env,
				inventory,
				config: generated.config,
				contract: args.contract
			})
			const runtimeServices = await runtimeServiceInventory({
				project: generated.project,
				env,
				expected: Object.keys(parsed.services)
			})
			evidence = { ...((evidence ?? {}) as object), runtimeServices }
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
		const runtimeLogs = await captureCommandResult({
			program: 'docker',
			args: composeArgs({ composeCommand: 'logs', noColor: true }),
			cwd: generated.project,
			env
		})
		const runtimeLogPath = join(generated.project, 'runtime.log')
		await writeSanitizedArtifact({
			path: runtimeLogPath,
			content: runtimeLogs.output.replace(/(\[auth\] OTP for [^:]+: )\d{6}/g, '$1[REDACTED]'),
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
		const down = await captureCommandResult({
			program: 'docker',
			args: composeArgs({
				composeCommand: 'down',
				volumes: true,
				removeOrphans: true,
				removeImages: 'local'
			}),
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
