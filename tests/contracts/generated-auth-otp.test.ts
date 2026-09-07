import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { describe, expect, test } from 'bun:test'
import { generateAuthService } from '../../src/generators/services/auth.js'
import type { GvKitConfig } from '../../src/schema/config.js'

type Runtime = 'cf-workers' | 'node'
type Provider = 'notifuse' | 'resend'
type Delivery = Record<string, unknown>
type ProbeState = {
	constructorArguments: unknown[]
	deliveries: Delivery[]
	failDelivery: boolean
	providerFailure?: { message: string; otp: string; recipient: string }
	options?: {
		sendVerificationOTP(
			input: { email: string; otp: string },
			context?: { request?: { headers: Headers } }
		): Promise<void>
	}
	mailer: {
		send(input: Delivery): Promise<void>
		sendTemplate(input: Delivery): Promise<void>
	}
}

const ENVIRONMENT_NAMES = [
	'AUTH_OTP_CAPTURE',
	'BETTER_AUTH_ALLOWED_HOSTS',
	'BETTER_AUTH_SECRET',
	'FROM_EMAIL',
	'NOTIFUSE_API_KEY',
	'NOTIFUSE_BASE_URL',
	'NOTIFUSE_WORKSPACE_ID',
	'RESEND_API_KEY',
	'TURNSTILE_SECRET_KEY'
] as const

const require = createRequire(import.meta.url)

function packageModuleUrl(specifier: string): string {
	return pathToFileURL(require.resolve(specifier)).href
}

function javascriptModuleUrl(source: string): string {
	return `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`
}

function generatedAuth(runtime: Runtime, provider: Provider): string {
	const config: GvKitConfig = {
		configVersion: 2,
		choices: {
			name: `otp-${runtime}-${provider}`,
			frontend: 'sveltekit',
			marketing: 'inside-web',
			backend: 'hono',
			i18n: 'skip',
			monitoring: [],
			db: 'sqlite',
			apiClient: 'skip',
			auth: ['emailOTP'],
			email: provider,
			aiTooling: [],
			deploy: runtime === 'cf-workers' ? 'cf-workers' : 'skip'
		}
	}
	const entry = generateAuthService(config).find(
		(candidate) => candidate.path === 'services/auth/src/auth.ts'
	)
	if (!entry) throw new Error('Generated auth source is missing')
	return entry.content
}

async function loadOtpProbe({
	runtime,
	provider,
	environment = {},
	failDelivery = false
}: {
	runtime: Runtime
	provider: Provider
	environment?: Record<string, string>
	failDelivery?: boolean
}): Promise<ProbeState> {
	const key = `__generated_auth_otp_${crypto.randomUUID().replaceAll('-', '')}`
	const state: ProbeState = {
		constructorArguments: [],
		deliveries: [],
		failDelivery,
		mailer: {
			async send(input) {
				state.deliveries.push(input)
				if (state.failDelivery) throw new Error('synthetic provider failure')
			},
			async sendTemplate(input) {
				state.deliveries.push(input)
				if (state.failDelivery) throw new Error('synthetic provider failure')
			}
		}
	}
	Object.assign(globalThis, { [key]: state })
	const stateReference = `globalThis[${JSON.stringify(key)}]`
	const betterAuthUrl = javascriptModuleUrl(
		`export function betterAuth(options) { ${stateReference}.auth = options; return options }`
	)
	const adapterUrl = javascriptModuleUrl('export function drizzleAdapter() { return {} }')
	const pluginsUrl = javascriptModuleUrl(`
export function captcha(options) { return options }
export function emailOTP(options) { ${stateReference}.options = options; return options }
`)
	const dbUrl = javascriptModuleUrl('export function createDb() { return {} }')
	const mailerUrl = javascriptModuleUrl(
		`export function createMailer(...args) { ${stateReference}.constructorArguments = args; return ${stateReference}.mailer }`
	)
	const utilsSource = generateAuthService({
		configVersion: 2,
		choices: {
			name: 'otp-utils',
			frontend: 'sveltekit',
			marketing: 'inside-web',
			backend: 'hono',
			i18n: 'skip',
			monitoring: [],
			db: 'sqlite',
			apiClient: 'skip',
			auth: ['emailOTP'],
			email: provider,
			aiTooling: [],
			deploy: runtime === 'cf-workers' ? 'cf-workers' : 'skip'
		}
	}).find((candidate) => candidate.path === 'services/auth/src/lib/utils.ts')!.content
	const transpiler = new Bun.Transpiler({ loader: 'ts', target: 'bun' })
	const utilsUrl = javascriptModuleUrl(transpiler.transformSync(utilsSource))
	let source = transpiler.transformSync(generatedAuth(runtime, provider))
	for (const [dependency, replacement] of [
		['better-auth/adapters/drizzle', adapterUrl],
		['better-auth/plugins', pluginsUrl],
		['better-auth', betterAuthUrl],
		['@repo/db/client', dbUrl],
		['@repo/mailer', mailerUrl],
		['./lib/utils.js', utilsUrl]
	] as const)
		source = source.replaceAll(`"${dependency}"`, `"${replacement}"`)

	const previous = Object.fromEntries(
		[...ENVIRONMENT_NAMES, 'NODE_ENV'].map((name) => [name, process.env[name]])
	)
	for (const name of ENVIRONMENT_NAMES) delete process.env[name]
	Object.assign(process.env, environment, { NODE_ENV: 'production' })
	const moduleUrl = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }))
	try {
		const module = (await import(moduleUrl)) as {
			getAuth?: (env: Record<string, string>) => unknown
		}
		if (runtime === 'cf-workers') module.getAuth?.(environment)
	} finally {
		URL.revokeObjectURL(moduleUrl)
		for (const [name, value] of Object.entries(previous)) {
			if (value === undefined) delete process.env[name]
			else process.env[name] = value
		}
	}
	if (!state.options) throw new Error('Generated email OTP plugin was not configured')
	return state
}

async function invokeOtp(
	state: ProbeState,
	email = 'person@example.test',
	otp = '654321'
): Promise<{ error: Error | undefined; logs: string[] }> {
	const logs: string[] = []
	const previousLog = console.log
	console.log = (...values: unknown[]) => logs.push(values.map(String).join(' '))
	let error: Error | undefined
	try {
		await state.options!.sendVerificationOTP(
			{ email, otp },
			{ request: { headers: new Headers({ 'x-locale': 'it-IT' }) } }
		)
	} catch (cause) {
		error = cause instanceof Error ? cause : new Error(String(cause))
	} finally {
		console.log = previousLog
	}
	return { error, logs }
}

function diagnosticText(value: unknown): string {
	if (!(value instanceof Error)) return Bun.inspect(value)
	const cause = value.cause === undefined ? '' : ` ${diagnosticText(value.cause)}`
	return `${value.name}: ${value.message} ${value.stack ?? ''}${cause}`
}

async function invokeProviderFailureThroughBetterAuth({
	runtime,
	provider,
	environment
}: {
	runtime: Runtime
	provider: Provider
	environment: Record<string, string>
}): Promise<{
	deliveries: Delivery[]
	diagnostics: string
	providerFailure: NonNullable<ProbeState['providerFailure']>
	responseBody: string
	status: number
}> {
	const key = `__generated_auth_framework_${crypto.randomUUID().replaceAll('-', '')}`
	const state: ProbeState = {
		constructorArguments: [],
		deliveries: [],
		failDelivery: true,
		mailer: {
			async send(input) {
				throwProviderFailure(input)
			},
			async sendTemplate(input) {
				throwProviderFailure(input)
			}
		}
	}
	function throwProviderFailure(input: Delivery): never {
		state.deliveries.push(input)
		const recipient =
			typeof input.to === 'string'
				? input.to
				: String((input.to as { email?: unknown } | undefined)?.email)
		const otp = String((input.data as { code?: unknown } | undefined)?.code)
		const message = `synthetic provider echoed recipient ${recipient} OTP ${otp}`
		state.providerFailure = { message, otp, recipient }
		throw new Error(message)
	}
	Object.assign(globalThis, { [key]: state })
	const stateReference = `globalThis[${JSON.stringify(key)}]`
	const adapterUrl = javascriptModuleUrl(
		`import { memoryAdapter } from ${JSON.stringify(packageModuleUrl('better-auth/adapters/memory'))}; export function drizzleAdapter() { return memoryAdapter({ user: [], session: [], account: [], verification: [] }) }`
	)
	const pluginsUrl = javascriptModuleUrl(
		`import { emailOTP as actualEmailOTP } from ${JSON.stringify(packageModuleUrl('better-auth/plugins'))}; export const emailOTP = actualEmailOTP; export function captcha() { return { id: 'captcha-probe' } }`
	)
	const dbUrl = javascriptModuleUrl('export function createDb() { return {} }')
	const mailerUrl = javascriptModuleUrl(
		`export function createMailer(...args) { ${stateReference}.constructorArguments = args; return ${stateReference}.mailer }`
	)
	const utilsSource = generateAuthService({
		configVersion: 2,
		choices: {
			name: 'otp-framework-utils',
			frontend: 'sveltekit',
			marketing: 'inside-web',
			backend: 'hono',
			i18n: 'skip',
			monitoring: [],
			db: 'sqlite',
			apiClient: 'skip',
			auth: ['emailOTP'],
			email: provider,
			aiTooling: [],
			deploy: runtime === 'cf-workers' ? 'cf-workers' : 'skip'
		}
	}).find((candidate) => candidate.path === 'services/auth/src/lib/utils.ts')!.content
	const transpiler = new Bun.Transpiler({ loader: 'ts', target: 'bun' })
	const utilsUrl = javascriptModuleUrl(transpiler.transformSync(utilsSource))
	let source = transpiler.transformSync(generatedAuth(runtime, provider))
	for (const [dependency, replacement] of [
		['better-auth/adapters/drizzle', adapterUrl],
		['better-auth/plugins', pluginsUrl],
		['better-auth', packageModuleUrl('better-auth')],
		['@repo/db/client', dbUrl],
		['@repo/mailer', mailerUrl],
		['./lib/utils.js', utilsUrl]
	] as const)
		source = source.replaceAll(`"${dependency}"`, `"${replacement}"`)

	const runtimeEnvironment = {
		...environment,
		BETTER_AUTH_ALLOWED_HOSTS: 'localhost:3000',
		BETTER_AUTH_SECRET: 'synthetic-provider-failure-secret-at-least-32-characters',
		TURNSTILE_SECRET_KEY: 'synthetic-turnstile-key'
	}
	const previousEnvironment = Object.fromEntries(
		[...ENVIRONMENT_NAMES, 'NODE_ENV'].map((name) => [name, process.env[name]])
	)
	for (const name of ENVIRONMENT_NAMES) delete process.env[name]
	Object.assign(process.env, runtimeEnvironment, { NODE_ENV: 'production' })
	const generatedUrl = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }))
	const diagnostics: string[] = []
	const previousConsole = {
		error: console.error,
		log: console.log,
		warn: console.warn
	}
	const capture = (...values: unknown[]) => {
		diagnostics.push(values.map(diagnosticText).join(' '))
	}
	console.error = capture
	console.log = capture
	console.warn = capture
	try {
		const module = (await import(generatedUrl)) as {
			auth?: { handler(request: Request): Promise<Response> }
			getAuth?: (env: Record<string, string>) => {
				handler(request: Request): Promise<Response>
			}
		}
		const auth = runtime === 'cf-workers' ? module.getAuth?.(runtimeEnvironment) : module.auth
		if (!auth) throw new Error('Generated Better Auth handler is missing')
		const clientIp = `127.0.0.${runtime === 'node' ? (provider === 'resend' ? 1 : 2) : provider === 'resend' ? 3 : 4}`
		const response = await auth.handler(
			new Request('http://localhost:3000/api/auth/email-otp/send-verification-otp', {
				method: 'POST',
				headers: {
					'cf-connecting-ip': clientIp,
					'content-type': 'application/json',
					origin: 'http://localhost:3000',
					'x-forwarded-for': clientIp
				},
				body: JSON.stringify({ email: 'person@example.test', type: 'sign-in' })
			})
		)
		const responseBody = await response.text()
		await Bun.sleep(25)
		if (!state.providerFailure) throw new Error('Provider failure was not exercised')
		return {
			deliveries: state.deliveries,
			diagnostics: diagnostics.join('\n'),
			providerFailure: state.providerFailure,
			responseBody,
			status: response.status
		}
	} finally {
		console.error = previousConsole.error
		console.log = previousConsole.log
		console.warn = previousConsole.warn
		URL.revokeObjectURL(generatedUrl)
		Reflect.deleteProperty(globalThis, key)
		for (const [name, value] of Object.entries(previousEnvironment)) {
			if (value === undefined) delete process.env[name]
			else process.env[name] = value
		}
	}
}

describe('generated Hono OTP delivery', () => {
	for (const runtime of ['node', 'cf-workers'] as const) {
		for (const provider of ['resend', 'notifuse'] as const) {
			test(`${runtime} ${provider} fails closed without complete mail settings`, async () => {
				const incompleteEnvironment =
					provider === 'resend'
						? { RESEND_API_KEY: 'resend-key' }
						: {
								NOTIFUSE_API_KEY: 'notifuse-key',
								NOTIFUSE_WORKSPACE_ID: 'workspace-id'
							}
				const state = await loadOtpProbe({
					runtime,
					provider,
					environment: incompleteEnvironment
				})
				const result = await invokeOtp(state)

				expect(result.error?.message).toBe('OTP mailer is not configured')
				expect(result.error?.message).not.toContain('person@example.test')
				expect(result.error?.message).not.toContain('654321')
				expect(result.logs).toEqual([])
				expect(state.constructorArguments).toEqual([])
				expect(state.deliveries).toEqual([])
			})

			test(`${runtime} ${provider} captures only with the explicit local opt-in`, async () => {
				const state = await loadOtpProbe({
					runtime,
					provider,
					environment: { AUTH_OTP_CAPTURE: 'console' }
				})
				const result = await invokeOtp(state)

				expect(result.error).toBeUndefined()
				expect(result.logs).toEqual(['[auth] OTP for person@example.test: 654321'])
				expect(state.constructorArguments).toEqual([])
				expect(state.deliveries).toEqual([])
			})

			test(`${runtime} ${provider} delivers the OTP and locale without logging`, async () => {
				const environment =
					provider === 'resend'
						? { RESEND_API_KEY: 'resend-key', FROM_EMAIL: 'auth@example.test' }
						: {
								NOTIFUSE_API_KEY: 'notifuse-key',
								NOTIFUSE_WORKSPACE_ID: 'workspace-id',
								NOTIFUSE_BASE_URL: 'https://notifuse.example.test'
							}
				const state = await loadOtpProbe({ runtime, provider, environment })
				const result = await invokeOtp(state)

				expect(result.error).toBeUndefined()
				expect(result.logs).toEqual([])
				if (provider === 'resend') {
					expect(state.constructorArguments).toEqual(['resend-key'])
					expect(state.deliveries).toEqual([
						{
							from: 'auth@example.test',
							to: 'person@example.test',
							template: 'otp',
							data: { code: '654321', expiryMinutes: 10, locale: 'it' }
						}
					])
				} else {
					expect(state.constructorArguments).toEqual([
						{
							apiKey: 'notifuse-key',
							workspaceId: 'workspace-id',
							baseUrl: 'https://notifuse.example.test'
						}
					])
					expect(state.deliveries).toEqual([
						{
							to: { email: 'person@example.test', language: 'it' },
							template: 'otp-login',
							data: { code: '654321', expiry_minutes: 10 }
						}
					])
				}
			})

			test(`${runtime} ${provider} replaces provider failures at the callback boundary`, async () => {
				const environment =
					provider === 'resend'
						? { RESEND_API_KEY: 'resend-key', FROM_EMAIL: 'auth@example.test' }
						: {
								NOTIFUSE_API_KEY: 'notifuse-key',
								NOTIFUSE_WORKSPACE_ID: 'workspace-id',
								NOTIFUSE_BASE_URL: 'https://notifuse.example.test'
							}
				const state = await loadOtpProbe({ runtime, provider, environment, failDelivery: true })
				const result = await invokeOtp(state)

				expect(result.error?.message).toBe('OTP delivery failed')
				expect(result.error?.cause).toBeUndefined()
				expect(result.logs).toEqual([])
				expect(state.deliveries).toHaveLength(1)
			})

			test(`${runtime} ${provider} keeps OTP-bearing provider errors out of Better Auth diagnostics`, async () => {
				const environment =
					provider === 'resend'
						? { RESEND_API_KEY: 'resend-key', FROM_EMAIL: 'auth@example.test' }
						: {
								NOTIFUSE_API_KEY: 'notifuse-key',
								NOTIFUSE_WORKSPACE_ID: 'workspace-id',
								NOTIFUSE_BASE_URL: 'https://notifuse.example.test'
							}
				const result = await invokeProviderFailureThroughBetterAuth({
					runtime,
					provider,
					environment
				})
				const output = `${result.diagnostics}\n${result.responseBody}`

				expect(result.status).toBe(200)
				expect(result.deliveries).toHaveLength(1)
				expect(result.diagnostics).toContain('OTP delivery failed')
				expect(output).not.toContain(result.providerFailure.message)
				expect(output).not.toContain(result.providerFailure.otp)
				expect(output).not.toContain(result.providerFailure.recipient)
			})
		}
	}
})
