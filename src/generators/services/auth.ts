import type { FileEntry } from '../../lib/files.js'
import type { GvKitConfig } from '../../schema/config.js'

const COMPATIBILITY_DATE = '2026-04-01'

type Runtime = 'cf-workers' | 'node'
type AuthChoice = GvKitConfig['choices']['auth'][number]
type EmailChoice = GvKitConfig['choices']['email']

function deriveRuntime(deploy: GvKitConfig['choices']['deploy']): Runtime {
	return deploy === 'cf-workers' ? 'cf-workers' : 'node'
}

export function generateAuthService(cfg: GvKitConfig): FileEntry[] {
	return cfg.choices.backendRuntime === 'effect'
		? generateEffectAuthService(cfg)
		: generatePromiseAuthService(cfg)
}

function generatePromiseAuthService(cfg: GvKitConfig): FileEntry[] {
	const project = cfg.choices.name
	const usesSqlite = cfg.choices.db === 'sqlite'
	const auth = cfg.choices.auth
	const email = cfg.choices.email
	const wantsGoogle = auth.includes('google')
	const wantsEmailOTP = auth.includes('emailOTP')
	const runtime = deriveRuntime(cfg.choices.deploy)

	const entries: FileEntry[] = [
		{
			path: 'apps/api/auth/package.json',
			content: promisePkgJson({ project, runtime, auth })
		},
		{
			path: 'apps/api/auth/tsconfig.json',
			content: tsconfig({ runtime, usesSqlite })
		},
		{
			path: 'apps/api/auth/env.d.ts',
			content: envDts({ runtime, usesSqlite, wantsGoogle, auth, email })
		},
		{
			path: 'apps/api/auth/src/lib/utils.ts',
			content: utilsTs({ wantsEmailOTP })
		},
		{
			path: 'apps/api/auth/src/auth.ts',
			content: authTs({ runtime, usesSqlite, wantsGoogle, auth, email })
		},
		{
			path: 'apps/api/auth/src/openapi.ts',
			content: openapiTs(project)
		},
		{
			path: 'apps/api/auth/src/app.ts',
			content: appTs(runtime)
		},
		{
			path: 'apps/api/auth/src/index.ts',
			content: indexTs(runtime)
		},
		{
			path: 'apps/api/auth/README.md',
			content: readme({ project, runtime, wantsGoogle, wantsEmailOTP, email })
		}
	]

	if (runtime === 'cf-workers') {
		entries.push({
			path: 'apps/api/auth/wrangler.jsonc',
			content: promiseWranglerJsonc({ project, usesSqlite, wantsEmailOTP, email })
		})
	}

	if (wantsEmailOTP) {
		entries.push({
			path: 'apps/api/auth/.dev.vars',
			content: devVars()
		})
	}

	return entries
}

function generateEffectAuthService(cfg: GvKitConfig): FileEntry[] {
	const project = cfg.choices.name
	const usesSqlite = cfg.choices.db === 'sqlite'
	const auth = cfg.choices.auth
	const email = cfg.choices.email
	const wantsGoogle = auth.includes('google')
	const wantsEmailOTP = auth.includes('emailOTP')
	const hasMailerWorkflow = wantsEmailOTP && email !== 'skip'
	const runtime = deriveRuntime(cfg.choices.deploy)

	const entries: FileEntry[] = [
		{
			path: 'apps/api/auth/package.json',
			content: effectPkgJson({ project, runtime, auth, hasMailerWorkflow })
		},
		{
			path: 'apps/api/auth/tsconfig.json',
			content: tsconfig({ runtime, usesSqlite })
		},
		{
			path: 'apps/api/auth/env.d.ts',
			content: envDts({ runtime, usesSqlite, wantsGoogle, auth, email })
		},
		{ path: 'apps/api/auth/src/lib/utils.ts', content: utilsTs({ wantsEmailOTP }) },
		{
			path: 'apps/api/auth/src/auth.ts',
			content: hasMailerWorkflow
				? effectAuthTs({ runtime, usesSqlite, wantsGoogle, auth, email })
				: authTs({ runtime, usesSqlite, wantsGoogle, auth, email })
		},
		{ path: 'apps/api/auth/src/openapi.ts', content: openapiEffectTs(project) },
		{
			path: 'apps/api/auth/src/effect/auth-session.ts',
			content: authSessionEffectTs(runtime)
		},
		...(hasMailerWorkflow
			? [
					{
						path: 'apps/api/auth/src/effect/otp-mailer.ts',
						content: otpMailerEffectTs(email)
					},
					{
						path: 'apps/api/auth/src/effect/otp-mailer.test.ts',
						content: otpMailerEffectTestTs(email)
					}
				]
			: []),
		{ path: 'apps/api/auth/src/app.ts', content: appEffectTs(runtime) },
		{ path: 'apps/api/auth/src/index.ts', content: indexTs(runtime) },
		{
			path: 'apps/api/auth/README.md',
			content: readme({ project, runtime, wantsGoogle, wantsEmailOTP, email })
		}
	]

	if (runtime === 'cf-workers')
		entries.push({
			path: 'apps/api/auth/wrangler.jsonc',
			content: effectWranglerJsonc({ project, usesSqlite, wantsEmailOTP, email })
		})

	if (wantsEmailOTP) entries.push({ path: 'apps/api/auth/.dev.vars', content: devVars() })

	return entries
}

function promisePkgJson({
	project,
	runtime,
	auth
}: {
	project: string
	runtime: Runtime
	auth: AuthChoice[]
}): string {
	const dependencies: Record<string, string> = {
		'@hono/zod-openapi': '^1.0.0',
		'@repo/backend': 'workspace:*',
		'@repo/db': 'workspace:*',
		'better-auth': '^1.6.0',
		hono: '^4.6.0',
		zod: '^4.3.0'
	}
	if (auth.includes('emailOTP')) dependencies['@repo/mailer'] = 'workspace:*'
	return renderPkgJson({
		project,
		runtime,
		dependencies,
		cfBuild: 'pnpm cf-typegen && wrangler deploy --dry-run --outdir=dist'
	})
}

function effectPkgJson({
	project,
	runtime,
	auth,
	hasMailerWorkflow
}: {
	project: string
	runtime: Runtime
	auth: AuthChoice[]
	hasMailerWorkflow: boolean
}): string {
	const dependencies: Record<string, string> = {
		'@hono/standard-validator': '^0.2.2',
		'@repo/backend': 'workspace:*',
		'@repo/db': 'workspace:*',
		'@standard-community/standard-json': '^0.3.5',
		'@standard-community/standard-openapi': '^0.2.9',
		'@types/json-schema': '^7.0.15',
		'better-auth': '^1.6.0',
		effect: '^3.21.2',
		hono: '^4.12.0',
		'hono-openapi': '^1.3.0',
		'openapi-types': '^12.1.3'
	}
	if (auth.includes('emailOTP')) dependencies['@repo/mailer'] = 'workspace:*'
	return renderPkgJson({
		project,
		runtime,
		dependencies,
		cfBuild: 'pnpm cf-typegen && wrangler deploy --dry-run --strict --outdir=dist',
		nodeBuild: 'tsup src/index.ts --format esm --target=node20 --out-dir dist',
		hasMailerWorkflow
	})
}

function renderPkgJson({
	project,
	runtime,
	dependencies,
	cfBuild,
	nodeBuild = 'tsup src/index.ts --format esm --target=node20 --outdir dist',
	hasMailerWorkflow = false
}: {
	project: string
	runtime: Runtime
	dependencies: Record<string, string>
	cfBuild: string
	nodeBuild?: string
	hasMailerWorkflow?: boolean
}): string {
	const devDependencies: Record<string, string> = {
		'@repo/tooling-typescript': 'workspace:*',
		typescript: '~5.9.0'
	}

	const scripts: Record<string, string> = {
		typecheck: 'tsc --noEmit',
		lint: 'eslint .'
	}
	if (hasMailerWorkflow) {
		scripts.test = 'vitest run src/effect/otp-mailer.test.ts'
		devDependencies.vitest = '^4.1.7'
	}

	if (runtime === 'cf-workers') {
		devDependencies.wrangler = '^4.0.0'
		devDependencies['@cloudflare/workers-types'] = '^4.20251101.0'
		devDependencies['@types/node'] = '^22.10.0'
		// `cf-typegen` must run before tsc/wrangler so `Env` matches wrangler.jsonc.
		scripts['cf-typegen'] = 'wrangler types'
		scripts.dev = 'pnpm cf-typegen && wrangler dev'
		scripts.build = cfBuild
		scripts.deploy = 'pnpm cf-typegen && wrangler deploy'
		scripts['deploy:production'] = 'pnpm cf-typegen && wrangler deploy'
		scripts['deploy:staging'] =
			`pnpm cf-typegen && test -n "$STAGING_ALIAS" && wrangler deploy --config "\${STAGING_WRANGLER_CONFIG:-wrangler.jsonc}" --name ${project}-auth-$STAGING_ALIAS`
		scripts.typecheck = 'pnpm cf-typegen && tsc --noEmit'
	} else {
		dependencies['@hono/node-server'] = '^1.13.0'
		devDependencies.tsup = '^8.3.0'
		devDependencies.tsx = '^4.19.0'
		devDependencies['@types/node'] = '^22.10.0'
		scripts.dev = 'tsx watch src/index.ts'
		scripts.build = nodeBuild
		scripts.start = 'node dist/index.js'
	}

	return (
		JSON.stringify(
			{
				name: `@${project}/auth-worker`,
				version: '0.0.0',
				private: true,
				type: 'module',
				main: 'src/index.ts',
				scripts,
				dependencies,
				devDependencies
			},
			null,
			2
		) + '\n'
	)
}

function tsconfig({
	runtime,
	usesSqlite: _usesSqlite
}: {
	runtime: Runtime
	usesSqlite: boolean
}): string {
	if (runtime === 'cf-workers') {
		return (
			JSON.stringify(
				{
					extends: '@repo/tooling-typescript/workers.json',
					compilerOptions: {
						noEmit: true
					},
					include: ['src/**/*', '*.d.ts']
				},
				null,
				2
			) + '\n'
		)
	}

	return (
		JSON.stringify(
			{
				extends: '@repo/tooling-typescript/node.json',
				compilerOptions: {
					noEmit: true
				},
				include: ['src/**/*', '*.d.ts']
			},
			null,
			2
		) + '\n'
	)
}

function promiseWranglerJsonc({
	project,
	usesSqlite,
	wantsEmailOTP,
	email
}: {
	project: string
	usesSqlite: boolean
	wantsEmailOTP: boolean
	email: EmailChoice
}): string {
	return renderWranglerJsonc({
		project,
		usesSqlite,
		wantsEmailOTP,
		email,
		migrationsLine: ''
	})
}

function effectWranglerJsonc({
	project,
	usesSqlite,
	wantsEmailOTP,
	email
}: {
	project: string
	usesSqlite: boolean
	wantsEmailOTP: boolean
	email: EmailChoice
}): string {
	return renderWranglerJsonc({
		project,
		usesSqlite,
		wantsEmailOTP,
		email,
		migrationsLine: ',\n\t\t\t"migrations_dir": "../../../packages/db/migrations"'
	})
}

function renderWranglerJsonc({
	project,
	usesSqlite,
	wantsEmailOTP,
	email,
	migrationsLine
}: {
	project: string
	usesSqlite: boolean
	wantsEmailOTP: boolean
	email: EmailChoice
	migrationsLine: string
}): string {
	const dbBlock = usesSqlite
		? `,
	"d1_databases": [
		{
			"binding": "DB",
			"database_name": "${project}-db",
			"database_id": "<run: wrangler d1 create ${project}-db>"${migrationsLine}
		}
	]`
		: `,
	// Set DATABASE_URL via \`wrangler secret put DATABASE_URL\`. For production prefer:
	// "hyperdrive": [{ "binding": "HYPERDRIVE", "id": "<hyperdrive id>" }]
	"vars": {}`

	return `{
	"$schema": "node_modules/wrangler/config-schema.json",
	"name": "${project}-auth",
	"main": "src/index.ts",
	"compatibility_date": "${COMPATIBILITY_DATE}",
	"compatibility_flags": ["nodejs_compat"],
	// Replace <domain> with the project's apex domain before deploying.
	"routes": [
		{ "pattern": "auth.api.<domain>", "custom_domain": true }
	],
	// "host" is required because production routes use a placeholder domain.
	"dev": {
		"ip": "127.0.0.1",
		"port": 8787,
		"host": "localhost",
		"inspector_port": 9229
	},
	// Secrets: \`wrangler secret put BETTER_AUTH_SECRET\` (and OAuth secrets). NEVER commit values.${
		wantsEmailOTP ? '\n\t// SECRET: TURNSTILE_SECRET_KEY — required when emailOTP is enabled.' : ''
	}${
		wantsEmailOTP && email === 'notifuse'
			? '\n\t// SECRETS: NOTIFUSE_API_KEY, NOTIFUSE_WORKSPACE_ID, NOTIFUSE_BASE_URL — self-hosted Notifuse instance.'
			: ''
	}
	"observability": { "enabled": true }${dbBlock}
}
`
}

function devVars(): string {
	return `# Replace with real Turnstile keys before deploy. Get them at https://dash.cloudflare.com/?to=/:account/turnstile
TURNSTILE_SECRET_KEY=1x0000000000000000000000000000000AA
`
}

function envDts({
	runtime,
	usesSqlite,
	wantsGoogle,
	auth,
	email
}: {
	runtime: Runtime
	usesSqlite: boolean
	wantsGoogle: boolean
	auth: AuthChoice[]
	email: EmailChoice
}): string {
	const wantsEmailOTP = auth.includes('emailOTP')

	const oauthLines = wantsGoogle
		? '\t\tGOOGLE_CLIENT_ID?: string\n\t\tGOOGLE_CLIENT_SECRET?: string\n'
		: ''

	let emailLines = ''
	if (wantsEmailOTP) {
		if (email === 'resend') {
			emailLines += '\t\tRESEND_API_KEY: string\n'
			emailLines += '\t\tFROM_EMAIL: string\n'
		} else if (email === 'notifuse') {
			emailLines += '\t\tNOTIFUSE_API_KEY: string\n'
			emailLines += '\t\tNOTIFUSE_WORKSPACE_ID: string\n'
			emailLines += '\t\tNOTIFUSE_BASE_URL: string\n'
		}
	}

	const turnstileLine = wantsEmailOTP ? '\t\tTURNSTILE_SECRET_KEY: string\n' : ''

	if (runtime === 'cf-workers') {
		const dbBinding = usesSqlite
			? '\t\tDB: D1Database'
			: '\t\tDATABASE_URL: string\n\t\tHYPERDRIVE?: Hyperdrive'

		return `// Merges with wrangler-generated worker-configuration.d.ts via interface declaration merging.
// Other services MUST NOT read these secrets — they call /internal/session via a CF service binding.
declare global {
	interface Env {
		BETTER_AUTH_SECRET: string
		BETTER_AUTH_URL?: string
		BETTER_AUTH_TRUSTED_ORIGINS?: string
${oauthLines}${emailLines}${turnstileLine}${dbBinding}
	}
}
export {}
`
	}

	const nodeDb = usesSqlite ? '\t\tSQLITE_PATH?: string' : '\t\tDATABASE_URL: string'

	return `// Ambient \`Env\` for OpenAPIHono<{ Bindings: Env }>; values are read from \`process.env\` at runtime.
// Other services MUST NOT read these secrets — they call /internal/session via \`AUTH_URL\`.
declare global {
	interface Env {
		BETTER_AUTH_SECRET: string
		BETTER_AUTH_URL?: string
		BETTER_AUTH_TRUSTED_ORIGINS?: string
${oauthLines}${emailLines}${turnstileLine}${nodeDb}
	}
}
export {}
`
}

type OtpDelivery = {
	imports: string[]
	cfMailerLine: string
	cfPlugin: string
	nodeMailerLine: string
	nodePlugin: string
}

function effectAuthTs(args: {
	runtime: Runtime
	usesSqlite: boolean
	wantsGoogle: boolean
	auth: AuthChoice[]
	email: EmailChoice
}): string {
	return authTs({ ...args, otpDelivery: effectOtpDelivery(args.email) })
}

function effectOtpDelivery(email: EmailChoice): OtpDelivery {
	const imports = [
		`import { MailerLive } from '@repo/mailer/effect'`,
		`import { runOtpDelivery, sendOtp } from './effect/otp-mailer.js'`
	]

	if (email === 'notifuse')
		return {
			imports,
			cfMailerLine: `\tconst mailerLayer = MailerLive({
\t\tapiKey: env.NOTIFUSE_API_KEY,
\t\tworkspaceId: env.NOTIFUSE_WORKSPACE_ID,
\t\tbaseUrl: env.NOTIFUSE_BASE_URL
\t})\n\n`,
			cfPlugin: `\t\temailOTP({
\t\t\totpLength: 6,
\t\t\texpiresIn: 600,
\t\t\tasync sendVerificationOTP({ email, otp }, ctx) {
\t\t\t\tif (!env.NOTIFUSE_API_KEY) {
\t\t\t\t\tconsole.log(\`[auth] OTP for \${email}: \${otp}\`)
\t\t\t\t\treturn
\t\t\t\t}
\t\t\t\tawait runOtpDelivery(
\t\t\t\t\tsendOtp({
\t\t\t\t\t\temail,
\t\t\t\t\t\totp,
\t\t\t\t\t\tlocale: pickLocale(ctx?.request?.headers)
\t\t\t\t\t}),
\t\t\t\t\tmailerLayer
\t\t\t\t)
\t\t\t}
\t\t})`,
			nodeMailerLine: `const mailerLayer = MailerLive({
\tapiKey: process.env.NOTIFUSE_API_KEY ?? '',
\tworkspaceId: process.env.NOTIFUSE_WORKSPACE_ID ?? '',
\tbaseUrl: process.env.NOTIFUSE_BASE_URL ?? ''
})\n\n`,
			nodePlugin: `\temailOTP({
\t\totpLength: 6,
\t\texpiresIn: 600,
\t\tasync sendVerificationOTP({ email, otp }, ctx) {
\t\t\tif (!process.env.NOTIFUSE_API_KEY) {
\t\t\t\tconsole.log(\`[auth] OTP for \${email}: \${otp}\`)
\t\t\t\treturn
\t\t\t}
\t\t\tawait runOtpDelivery(
\t\t\t\tsendOtp({
\t\t\t\t\temail,
\t\t\t\t\totp,
\t\t\t\t\tlocale: pickLocale(ctx?.request?.headers)
\t\t\t\t}),
\t\t\t\tmailerLayer
\t\t\t)
\t\t}
\t})`
		}

	return {
		imports: [...imports, `import type { Locale } from '@repo/mailer'`],
		cfMailerLine: `\tconst mailerLayer = MailerLive(env.RESEND_API_KEY)\n\n`,
		cfPlugin: `\t\temailOTP({
\t\t\totpLength: 6,
\t\t\texpiresIn: 600,
\t\t\tasync sendVerificationOTP({ email, otp }, ctx) {
\t\t\t\tif (!env.RESEND_API_KEY) {
\t\t\t\t\tconsole.log(\`[auth] OTP for \${email}: \${otp}\`)
\t\t\t\t\treturn
\t\t\t\t}
\t\t\t\tawait runOtpDelivery(
\t\t\t\t\tsendOtp({
\t\t\t\t\t\tfrom: env.FROM_EMAIL,
\t\t\t\t\t\temail,
\t\t\t\t\t\totp,
\t\t\t\t\t\tlocale: pickLocale(ctx?.request?.headers) as Locale
\t\t\t\t\t}),
\t\t\t\t\tmailerLayer
\t\t\t\t)
\t\t\t}
\t\t})`,
		nodeMailerLine: `const mailerLayer = MailerLive(process.env.RESEND_API_KEY ?? '')\n\n`,
		nodePlugin: `\temailOTP({
\t\totpLength: 6,
\t\texpiresIn: 600,
\t\tasync sendVerificationOTP({ email, otp }, ctx) {
\t\t\tif (!process.env.RESEND_API_KEY) {
\t\t\t\tconsole.log(\`[auth] OTP for \${email}: \${otp}\`)
\t\t\t\treturn
\t\t\t}
\t\t\tawait runOtpDelivery(
\t\t\t\tsendOtp({
\t\t\t\t\tfrom: process.env.FROM_EMAIL ?? '',
\t\t\t\t\temail,
\t\t\t\t\totp,
\t\t\t\t\tlocale: pickLocale(ctx?.request?.headers) as Locale
\t\t\t\t}),
\t\t\t\tmailerLayer
\t\t\t)
\t\t}
\t})`
	}
}

function otpMailerEffectTs(email: EmailChoice): string {
	if (email === 'notifuse')
		return `import { Cause, Effect, type Layer } from 'effect'
import { MailerService } from '@repo/mailer/effect'

export type SendOtpInput = {
\temail: string
\totp: string
\tlocale: string
}

export function sendOtp({ email, otp, locale }: SendOtpInput) {
\treturn Effect.gen(function* () {
\t\tconst mailer = yield* MailerService
\t\treturn yield* mailer.send({
\t\t\tto: { email, language: locale },
\t\t\ttemplate: 'otp-login',
\t\t\tdata: { code: otp, expiry_minutes: 10 }
\t\t})
\t})
}

export async function runOtpDelivery(
\tprogram: ReturnType<typeof sendOtp>,
\tmailerLayer: Layer.Layer<MailerService>
): Promise<void> {
\tconst exit = await Effect.runPromiseExit(program.pipe(Effect.provide(mailerLayer)))
\tif (exit._tag === 'Success') return

\tconsole.error('[auth] OTP delivery failed', { cause: Cause.pretty(exit.cause) })
\tthrow new Error('OTP delivery failed')
}
`

	return `import { Cause, Effect, type Layer } from 'effect'
import type { Locale } from '@repo/mailer'
import { MailerService } from '@repo/mailer/effect'

export type SendOtpInput = {
\tfrom: string
\temail: string
\totp: string
\tlocale: Locale
}

export function sendOtp({ from, email, otp, locale }: SendOtpInput) {
\treturn Effect.gen(function* () {
\t\tconst mailer = yield* MailerService
\t\treturn yield* mailer.sendTemplate({
\t\t\tfrom,
\t\t\tto: email,
\t\t\ttemplate: 'otp',
\t\t\tdata: { code: otp, expiryMinutes: 10, locale }
\t\t})
\t})
}

export async function runOtpDelivery(
\tprogram: ReturnType<typeof sendOtp>,
\tmailerLayer: Layer.Layer<MailerService>
): Promise<void> {
\tconst exit = await Effect.runPromiseExit(program.pipe(Effect.provide(mailerLayer)))
\tif (exit._tag === 'Success') return

\tconsole.error('[auth] OTP delivery failed', { cause: Cause.pretty(exit.cause) })
\tthrow new Error('OTP delivery failed')
}
`
}

function otpMailerEffectTestTs(email: EmailChoice): string {
	if (email === 'notifuse')
		return `import { Effect, Layer } from 'effect'
import { MailerError, type Mailer } from '@repo/mailer'
import { MailerService, makeMailerEffect } from '@repo/mailer/effect'
import { afterEach, describe, expect, test, vi } from 'vitest'

import { runOtpDelivery, sendOtp } from './otp-mailer.js'

afterEach(() => vi.restoreAllMocks())

describe('OTP mailer workflow', () => {
\ttest('delivers through MailerService', async () => {
\t\tconst sent: unknown[] = []
\t\tconst mailer: Mailer = {
\t\t\tasync send(input) {
\t\t\t\tsent.push(input)
\t\t\t\treturn { message_id: 'message-1' }
\t\t\t}
\t\t}
\t\tconst layer = Layer.succeed(MailerService, makeMailerEffect(mailer))

\t\tawait runOtpDelivery(
\t\t\tsendOtp({ email: 'ada@example.com', otp: '123456', locale: 'en' }),
\t\t\tlayer
\t\t)

\t\texpect(sent).toEqual([
\t\t\t{
\t\t\t\tto: { email: 'ada@example.com', language: 'en' },
\t\t\t\ttemplate: 'otp-login',
\t\t\t\tdata: { code: '123456', expiry_minutes: 10 }
\t\t\t}
\t\t])
\t})

\ttest('keeps provider failures typed and maps them safely at the boundary', async () => {
\t\tconst mailer: Mailer = {
\t\t\tasync send() {
\t\t\t\tthrow new MailerError('provider detail')
\t\t\t}
\t\t}
\t\tconst layer = Layer.succeed(MailerService, makeMailerEffect(mailer))
\t\tconst program = sendOtp({ email: 'ada@example.com', otp: '123456', locale: 'en' })
\t\tconst typedFailure = await Effect.runPromise(
\t\t\tprogram.pipe(Effect.provide(layer), Effect.flip)
\t\t)
\t\texpect(typedFailure).toBeInstanceOf(MailerError)

\t\tconst errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined)
\t\tawait expect(runOtpDelivery(program, layer)).rejects.toThrow('OTP delivery failed')
\t\texpect(errorLog).toHaveBeenCalledOnce()
\t\texpect(JSON.stringify(errorLog.mock.calls)).toContain('provider detail')
\t})
})
`

	return `import { Effect, Layer } from 'effect'
import { MailerError, type Mailer } from '@repo/mailer'
import { MailerService, makeMailerEffect } from '@repo/mailer/effect'
import { afterEach, describe, expect, test, vi } from 'vitest'

import { runOtpDelivery, sendOtp } from './otp-mailer.js'

afterEach(() => vi.restoreAllMocks())

describe('OTP mailer workflow', () => {
\ttest('delivers through MailerService', async () => {
\t\tconst sent: unknown[] = []
\t\tconst mailer: Mailer = {
\t\t\tasync send() {
\t\t\t\treturn { id: 'message-1' }
\t\t\t},
\t\t\tasync sendTemplate(input) {
\t\t\t\tsent.push(input)
\t\t\t\treturn { id: 'message-1' }
\t\t\t}
\t\t}
\t\tconst layer = Layer.succeed(MailerService, makeMailerEffect(mailer))

\t\tawait runOtpDelivery(
\t\t\tsendOtp({
\t\t\t\tfrom: 'auth@example.com',
\t\t\t\temail: 'ada@example.com',
\t\t\t\totp: '123456',
\t\t\t\tlocale: 'en'
\t\t\t}),
\t\t\tlayer
\t\t)

\t\texpect(sent).toEqual([
\t\t\t{
\t\t\t\tfrom: 'auth@example.com',
\t\t\t\tto: 'ada@example.com',
\t\t\t\ttemplate: 'otp',
\t\t\t\tdata: { code: '123456', expiryMinutes: 10, locale: 'en' }
\t\t\t}
\t\t])
\t})

\ttest('keeps provider failures typed and maps them safely at the boundary', async () => {
\t\tconst mailer: Mailer = {
\t\t\tasync send() {
\t\t\t\treturn { id: 'message-1' }
\t\t\t},
\t\t\tasync sendTemplate() {
\t\t\t\tthrow new MailerError('provider detail')
\t\t\t}
\t\t}
\t\tconst layer = Layer.succeed(MailerService, makeMailerEffect(mailer))
\t\tconst program = sendOtp({
\t\t\tfrom: 'auth@example.com',
\t\t\temail: 'ada@example.com',
\t\t\totp: '123456',
\t\t\tlocale: 'en'
\t\t})
\t\tconst typedFailure = await Effect.runPromise(
\t\t\tprogram.pipe(Effect.provide(layer), Effect.flip)
\t\t)
\t\texpect(typedFailure).toBeInstanceOf(MailerError)

\t\tconst errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined)
\t\tawait expect(runOtpDelivery(program, layer)).rejects.toThrow('OTP delivery failed')
\t\texpect(errorLog).toHaveBeenCalledOnce()
\t\texpect(JSON.stringify(errorLog.mock.calls)).toContain('provider detail')
\t})
})
`
}

function authTs({
	runtime,
	usesSqlite,
	wantsGoogle,
	auth,
	email,
	otpDelivery
}: {
	runtime: Runtime
	usesSqlite: boolean
	wantsGoogle: boolean
	auth: AuthChoice[]
	email: EmailChoice
	otpDelivery?: OtpDelivery
}): string {
	const wantsEmailOTP = auth.includes('emailOTP')
	const provider = usesSqlite ? 'sqlite' : 'pg'
	const ipHeader = runtime === 'cf-workers' ? 'cf-connecting-ip' : 'x-forwarded-for'
	const usesNotifuse = email === 'notifuse'

	const imports: string[] = [
		`import { betterAuth } from 'better-auth'`,
		`import { drizzleAdapter } from 'better-auth/adapters/drizzle'`
	]
	if (wantsEmailOTP) imports.push(`import { captcha, emailOTP } from 'better-auth/plugins'`)
	imports.push(`import type { BetterAuthPlugin } from 'better-auth/types'`)
	imports.push(`import { createDb } from '@repo/db/client'`)
	if (wantsEmailOTP)
		imports.push(
			...(otpDelivery
				? otpDelivery.imports
				: [
						usesNotifuse
							? `import { createMailer } from '@repo/mailer'`
							: `import { createMailer, type Locale } from '@repo/mailer'`
					])
		)
	imports.push(
		wantsEmailOTP
			? `import { parseTrustedOrigins, pickLocale } from './lib/utils.js'`
			: `import { parseTrustedOrigins } from './lib/utils.js'`
	)

	if (runtime === 'cf-workers') {
		const dbExpr = usesSqlite ? '{ DB: env.DB }' : '{ HYPERDRIVE: env.HYPERDRIVE }'

		const mailerLine = otpDelivery
			? otpDelivery.cfMailerLine
			: wantsEmailOTP
				? usesNotifuse
					? `\tconst mailer = createMailer({
\t\tapiKey: env.NOTIFUSE_API_KEY,
\t\tworkspaceId: env.NOTIFUSE_WORKSPACE_ID,
\t\tbaseUrl: env.NOTIFUSE_BASE_URL
\t})\n\n`
					: `\tconst mailer = createMailer(env.RESEND_API_KEY)\n\n`
				: ''

		const otpPlugin = otpDelivery
			? otpDelivery.cfPlugin
			: wantsEmailOTP
				? usesNotifuse
					? `\t\temailOTP({
\t\t\totpLength: 6,
\t\t\texpiresIn: 600,
\t\t\tasync sendVerificationOTP({ email, otp }, ctx) {
\t\t\t\tif (!env.NOTIFUSE_API_KEY) {
\t\t\t\t\tconsole.log(\`[auth] OTP for \${email}: \${otp}\`)
\t\t\t\t\treturn
\t\t\t\t}
\t\t\t\tawait mailer.send({
\t\t\t\t\tto: { email, language: pickLocale(ctx?.request?.headers) },
\t\t\t\t\ttemplate: 'otp-login',
\t\t\t\t\tdata: { code: otp, expiry_minutes: 10 }
\t\t\t\t})
\t\t\t}
\t\t})`
					: `\t\temailOTP({
\t\t\totpLength: 6,
\t\t\texpiresIn: 600,
\t\t\tasync sendVerificationOTP({ email, otp }, ctx) {
\t\t\t\tif (!env.RESEND_API_KEY) {
\t\t\t\t\tconsole.log(\`[auth] OTP for \${email}: \${otp}\`)
\t\t\t\t\treturn
\t\t\t\t}
\t\t\t\tawait mailer.sendTemplate({
\t\t\t\t\tfrom: env.FROM_EMAIL,
\t\t\t\t\tto: email,
\t\t\t\t\ttemplate: 'otp',
\t\t\t\t\tdata: {
\t\t\t\t\t\tcode: otp,
\t\t\t\t\t\texpiryMinutes: 10,
\t\t\t\t\t\tlocale: pickLocale(ctx?.request?.headers) as Locale
\t\t\t\t\t}
\t\t\t\t})
\t\t\t}
\t\t})`
				: ''

		const captchaPlugin = wantsEmailOTP
			? `\t\tcaptcha({
\t\t\tprovider: 'cloudflare-turnstile',
\t\t\tsecretKey: env.TURNSTILE_SECRET_KEY,
\t\t\tendpoints: ['/email-otp/send-verification-otp']
\t\t})`
			: ''

		const pluginParts = [otpPlugin, captchaPlugin].filter((p) => p !== '')
		const pluginsBlock =
			pluginParts.length > 0
				? `\tconst plugins: BetterAuthPlugin[] = [\n${pluginParts.join(',\n')}\n\t]\n\n`
				: `\tconst plugins: BetterAuthPlugin[] = []\n\n`

		const googleBlock = wantsGoogle
			? `\tconst socialProviders =
\t\tenv.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET
\t\t\t? { google: { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET } }
\t\t\t: undefined

`
			: ''

		const socialSpread = wantsGoogle ? `\n\t\t...(socialProviders ? { socialProviders } : {}),` : ''

		return `${imports.join('\n')}

export function getAuth(env: Env) {
\tconst db = createDb(${dbExpr})
${mailerLine}${pluginsBlock}${googleBlock}\treturn betterAuth({
\t\tsecret: env.BETTER_AUTH_SECRET,
\t\t...(env.BETTER_AUTH_URL ? { baseURL: env.BETTER_AUTH_URL } : {}),
\t\ttrustedOrigins: parseTrustedOrigins(env.BETTER_AUTH_TRUSTED_ORIGINS),
\t\tdatabase: drizzleAdapter(db, { provider: '${provider}' }),
\t\tplugins,${socialSpread}
\t\tadvanced: {
\t\t\tipAddress: { ipAddressHeaders: ['${ipHeader}'] },
\t\t\tdefaultCookieAttributes: { secure: true, sameSite: 'lax' }
\t\t}
\t})
}
`
	}

	const dbConstruction = usesSqlite
		? `createDb({ url: process.env.SQLITE_PATH ?? 'file:./local.db' })`
		: `createDb({ DATABASE_URL: process.env.DATABASE_URL ?? '' })`

	const mailerLine = otpDelivery
		? otpDelivery.nodeMailerLine
		: wantsEmailOTP
			? usesNotifuse
				? `const mailer = createMailer({
\tapiKey: process.env.NOTIFUSE_API_KEY ?? '',
\tworkspaceId: process.env.NOTIFUSE_WORKSPACE_ID ?? '',
\tbaseUrl: process.env.NOTIFUSE_BASE_URL ?? ''
})\n\n`
				: `const mailer = createMailer(process.env.RESEND_API_KEY ?? '')\n\n`
			: ''

	const otpPlugin = otpDelivery
		? otpDelivery.nodePlugin
		: wantsEmailOTP
			? usesNotifuse
				? `\temailOTP({
\t\totpLength: 6,
\t\texpiresIn: 600,
\t\tasync sendVerificationOTP({ email, otp }, ctx) {
\t\t\tif (!process.env.NOTIFUSE_API_KEY) {
\t\t\t\tconsole.log(\`[auth] OTP for \${email}: \${otp}\`)
\t\t\t\treturn
\t\t\t}
\t\t\tawait mailer.send({
\t\t\t\tto: { email, language: pickLocale(ctx?.request?.headers) },
\t\t\t\ttemplate: 'otp-login',
\t\t\t\tdata: { code: otp, expiry_minutes: 10 }
\t\t\t})
\t\t}
\t})`
				: `\temailOTP({
\t\totpLength: 6,
\t\texpiresIn: 600,
\t\tasync sendVerificationOTP({ email, otp }, ctx) {
\t\t\tif (!process.env.RESEND_API_KEY) {
\t\t\t\tconsole.log(\`[auth] OTP for \${email}: \${otp}\`)
\t\t\t\treturn
\t\t\t}
\t\t\tawait mailer.sendTemplate({
\t\t\t\tfrom: process.env.FROM_EMAIL ?? '',
\t\t\t\tto: email,
\t\t\t\ttemplate: 'otp',
\t\t\t\tdata: {
\t\t\t\t\tcode: otp,
\t\t\t\t\texpiryMinutes: 10,
\t\t\t\t\tlocale: pickLocale(ctx?.request?.headers) as Locale
\t\t\t\t}
\t\t\t})
\t\t}
\t})`
			: ''

	const captchaPlugin = wantsEmailOTP
		? `\tcaptcha({
\t\tprovider: 'cloudflare-turnstile',
\t\tsecretKey: process.env.TURNSTILE_SECRET_KEY ?? '',
\t\tendpoints: ['/email-otp/send-verification-otp']
\t})`
		: ''

	const pluginParts = [otpPlugin, captchaPlugin].filter((p) => p !== '')
	const pluginsBlock =
		pluginParts.length > 0
			? `const plugins: BetterAuthPlugin[] = [\n${pluginParts.join(',\n')}\n]\n\n`
			: `const plugins: BetterAuthPlugin[] = []\n\n`

	const googleBlock = wantsGoogle
		? `const socialProviders =
\tprocess.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET
\t\t? { google: { clientId: process.env.GOOGLE_CLIENT_ID, clientSecret: process.env.GOOGLE_CLIENT_SECRET } }
\t\t: undefined

`
		: ''

	const socialSpread = wantsGoogle ? `\n\t...(socialProviders ? { socialProviders } : {}),` : ''

	return `${imports.join('\n')}

const db = ${dbConstruction}

${mailerLine}${pluginsBlock}${googleBlock}export const auth = betterAuth({
\tsecret: process.env.BETTER_AUTH_SECRET ?? '',
\t...(process.env.BETTER_AUTH_URL ? { baseURL: process.env.BETTER_AUTH_URL } : {}),
\ttrustedOrigins: parseTrustedOrigins(process.env.BETTER_AUTH_TRUSTED_ORIGINS),
\tdatabase: drizzleAdapter(db, { provider: '${provider}' }),
\tplugins,${socialSpread}
\tadvanced: {
\t\tipAddress: { ipAddressHeaders: ['${ipHeader}'] },
\t\tdefaultCookieAttributes: { secure: process.env.NODE_ENV === 'production', sameSite: 'lax' }
\t}
})

export function getAuth(_env?: unknown) {
\treturn auth
}
`
}

function openapiTs(project: string): string {
	return `import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'

// Documents ONLY /internal/session. The public /api/auth/* surface is intentionally
// excluded — sibling services must use the binding/HTTP boundary, not a typed client.
const SessionResponse = z
	.object({
		userId: z.string(),
		sessionId: z.string(),
		expiresAt: z.string()
	})
	.openapi('Session')

export const sessionRoute = createRoute({
	method: 'get',
	path: '/internal/session',
	tags: ['internal'],
	responses: {
		200: {
			description: 'Resolved session for the caller',
			content: { 'application/json': { schema: SessionResponse } }
		},
		401: { description: 'No active session' }
	}
})

export function mountOpenApi(app: OpenAPIHono<{ Bindings: Env }>): void {
	app.doc('/openapi.json', {
		openapi: '3.0.0',
		info: { title: '${project}-auth (internal)', version: '0.0.0' }
	})
}
`
}

function openapiEffectTs(project: string): string {
	return `import { Schema } from 'effect'
import type { Env as HonoEnv, Hono } from 'hono'
import { describeRoute, openAPIRouteHandler, resolver } from 'hono-openapi'

const SessionResponseSchema = Schema.Struct({
	userId: Schema.String,
	sessionId: Schema.String,
	expiresAt: Schema.String
})

const ErrorResponseSchema = Schema.Struct({
	error: Schema.String,
	message: Schema.String,
	code: Schema.optional(Schema.String),
	tag: Schema.optional(Schema.String)
})

const SessionResponseStandard = Schema.standardSchemaV1(SessionResponseSchema)
const ErrorResponseStandard = Schema.standardSchemaV1(ErrorResponseSchema)

// Sibling services use the documented /internal/session boundary instead of /api/auth/*.
export const sessionRoute = describeRoute({
	operationId: 'getInternalSession',
	tags: ['internal'],
	summary: 'Resolve the caller session',
	responses: {
		200: {
			description: 'Resolved session for the caller',
			content: { 'application/json': { schema: resolver(SessionResponseStandard) } }
		},
		401: {
			description: 'No active session',
			content: { 'application/json': { schema: resolver(ErrorResponseStandard) } }
		},
		500: {
			description: 'Internal session resolution failure',
			content: { 'application/json': { schema: resolver(ErrorResponseStandard) } }
		}
	}
})

export function mountOpenApi<E extends HonoEnv>(app: Hono<E>): void {
	app.get(
		'/openapi.json',
		openAPIRouteHandler(app, {
			documentation: {
				servers: [{ url: 'https://auth.api.example.com' }],
				security: [],
				info: {
					title: '${project}-auth (internal)',
					version: '0.0.0',
					description: 'Internal auth boundary generated from Hono routes using Effect Schema',
					license: { name: 'MIT', identifier: 'MIT' }
				}
			}
		})
	)
}
`
}

function authSessionEffectTs(runtime: Runtime): string {
	const authImport =
		runtime === 'cf-workers'
			? `import { getAuth } from '../auth.js'`
			: `import { auth } from '../auth.js'`

	const workerEnvService =
		runtime === 'cf-workers'
			? `
export class WorkerEnvService extends Context.Tag('WorkerEnvService')<
\tWorkerEnvService,
\tEnv
>() {}
`
			: ''

	const makeAuth =
		runtime === 'cf-workers'
			? `const makeAuth = Effect.gen(function* () {
\tconst env = yield* WorkerEnvService
\treturn yield* Effect.try({
\t\ttry: () => getAuth(env),
\t\tcatch: (cause) =>
\t\t\tnew UnexpectedServiceError({
\t\t\t\tmessage: 'failed to initialize auth service',
\t\t\t\tcode: 'AUTH_INIT_FAILED',
\t\t\t\tcause
\t\t\t})
\t})
})`
			: `const makeAuth = Effect.succeed(auth)`

	return `import { Context, Effect } from 'effect'
${authImport}

import {
\ttryPromiseUnexpected,
\tUnauthorized,
\tUnexpectedServiceError
} from '@repo/backend/effect/errors'
${workerEnvService}

export type AuthSession = {
\tuserId: string
\tsessionId: string
\texpiresAt: string
}

export type AuthSessionServiceShape = {
\treadonly resolve: (
\t\theaders: Headers
\t) => Effect.Effect<AuthSession, Unauthorized | UnexpectedServiceError>
}

export class AuthSessionService extends Context.Tag('auth/AuthSessionService')<
\tAuthSessionService,
\tAuthSessionServiceShape
>() {}

type BetterAuthSessionLike = {
\tuser: { id: string }
\tsession: { id: string; expiresAt: Date }
}

export function resolveBetterAuthSession(
\tlookup: () => PromiseLike<BetterAuthSessionLike | null>
) {
\treturn tryPromiseUnexpected({
\t\ttry: lookup,
\t\tmessage: 'failed to resolve session',
\t\tcode: 'SESSION_LOOKUP_FAILED'
\t}).pipe(
\t\tEffect.flatMap((session) =>
\t\t\tsession
\t\t\t\t? Effect.succeed({
\t\t\t\t\t\tuserId: session.user.id,
\t\t\t\t\t\tsessionId: session.session.id,
\t\t\t\t\t\texpiresAt: session.session.expiresAt.toISOString()
\t\t\t\t\t})
\t\t\t\t: Effect.fail(new Unauthorized({ message: 'unauthorized', code: 'UNAUTHORIZED' }))
\t\t)
\t)
}

${makeAuth}

export const makeAuthSessionService = Effect.gen(function* () {
\tconst resolvedAuth = yield* makeAuth
\treturn {
\t\tresolve: (headers) =>
\t\t\tresolveBetterAuthSession(() => resolvedAuth.api.getSession({ headers }))
\t} satisfies AuthSessionServiceShape
})
`
}

function appTs(runtime: Runtime): string {
	if (runtime === 'cf-workers') {
		return `import { OpenAPIHono } from '@hono/zod-openapi'
import { cors } from 'hono/cors'

import { getAuth } from './auth.js'
import { parseTrustedOrigins } from './lib/utils.js'
import { mountOpenApi, sessionRoute } from './openapi.js'

const app = new OpenAPIHono<{ Bindings: Env }>()

app.get('/healthz', (c) => c.text('ok'))

// CORS shares the BETTER_AUTH_TRUSTED_ORIGINS allow-list with better-auth's
// own CSRF check — one env var, two consistent gates.
app.use('/api/auth/*', async (c, next) => {
	const mw = cors({
		origin: parseTrustedOrigins(c.env.BETTER_AUTH_TRUSTED_ORIGINS),
		credentials: true,
		allowHeaders: ['content-type', 'x-locale'],
		maxAge: 600
	})
	return mw(c, next)
})

app.all('/api/auth/*', async (c) => {
	const auth = getAuth(c.env)
	return auth.handler(c.req.raw)
})

app.openapi(sessionRoute, async (c) => {
	const auth = getAuth(c.env)
	const session = await auth.api.getSession({ headers: c.req.raw.headers })
	if (!session) return c.json({ error: 'unauthorized' }, 401)
	return c.json(
		{
			userId: session.user.id,
			sessionId: session.session.id,
			expiresAt: session.session.expiresAt.toISOString()
		},
		200
	)
})

mountOpenApi(app)

export default app
`
	}

	return `import { OpenAPIHono } from '@hono/zod-openapi'
import { cors } from 'hono/cors'

import { auth } from './auth.js'
import { parseTrustedOrigins } from './lib/utils.js'
import { mountOpenApi, sessionRoute } from './openapi.js'

const app = new OpenAPIHono<{ Bindings: Env }>()

app.get('/healthz', (c) => c.text('ok'))

// CORS shares the BETTER_AUTH_TRUSTED_ORIGINS allow-list with better-auth's
// own CSRF check — one env var, two consistent gates.
app.use(
	'/api/auth/*',
	cors({
		origin: parseTrustedOrigins(process.env.BETTER_AUTH_TRUSTED_ORIGINS),
		credentials: true,
		allowHeaders: ['content-type', 'x-locale'],
		maxAge: 600
	})
)

app.all('/api/auth/*', async (c) => auth.handler(c.req.raw))

app.openapi(sessionRoute, async (c) => {
	const session = await auth.api.getSession({ headers: c.req.raw.headers })
	if (!session) return c.json({ error: 'unauthorized' }, 401)
	return c.json(
		{
			userId: session.user.id,
			sessionId: session.session.id,
			expiresAt: session.session.expiresAt.toISOString()
		},
		200
	)
})

mountOpenApi(app)

export default app
`
}

function appEffectTs(runtime: Runtime): string {
	const httpBoundary = `type SessionError = Unauthorized | UnexpectedServiceError
type ErrorResponse = { error: string; message: string; tag: string; code?: string }

function mapSessionError(error: SessionError): EffectHttpResponse<ErrorResponse> {
	switch (error._tag) {
		case 'Unauthorized':
			return {
				status: 401,
				body: { error: error.message, message: error.message, tag: error._tag, code: error.code }
			}
		case 'UnexpectedServiceError':
			return {
				status: 500,
				body: {
					error: 'internal server error',
					message: 'internal server error',
					tag: error._tag,
					code: error.code
				}
			}
	}
}
`

	if (runtime === 'cf-workers')
		return `import { type EffectHttpResponse, runEffectJson } from '@repo/backend/effect/hono'
import { UnexpectedServiceError, Unauthorized } from '@repo/backend/effect/errors'
import { Effect } from 'effect'
import { Hono } from 'hono'
import { cors } from 'hono/cors'

import { getAuth } from './auth.js'
import {
\tAuthSessionService,
\tWorkerEnvService,
\tmakeAuthSessionService
} from './effect/auth-session.js'
import { parseTrustedOrigins } from './lib/utils.js'
import { mountOpenApi, sessionRoute } from './openapi.js'

${httpBoundary}
const app = new Hono<{ Bindings: Env }>()

app.get('/healthz', (c) => c.text('ok'))

// CORS and better-auth CSRF must share the trusted-origin allow-list.
app.use('/api/auth/*', async (c, next) => {
	const mw = cors({
		origin: parseTrustedOrigins(c.env.BETTER_AUTH_TRUSTED_ORIGINS),
		credentials: true,
		allowHeaders: ['content-type', 'x-locale', 'x-captcha-response'],
		maxAge: 600
	})
	return mw(c, next)
})

app.all('/api/auth/*', async (c) => {
	const auth = getAuth(c.env)
	return auth.handler(c.req.raw)
})

app.get('/internal/session', sessionRoute, (c) => {
	const program = Effect.gen(function* () {
		const authSession = yield* AuthSessionService
		return yield* authSession.resolve(c.req.raw.headers)
	}).pipe(
		Effect.provideServiceEffect(
			AuthSessionService,
			makeAuthSessionService.pipe(Effect.provideService(WorkerEnvService, c.env))
		)
	)
	return runEffectJson({
		c,
		program,
		onSuccess: (value) => ({ status: 200, body: value }),
		onFailure: mapSessionError
	})
})

mountOpenApi(app)

export default app
`

	return `import { type EffectHttpResponse, runEffectJson } from '@repo/backend/effect/hono'
import { UnexpectedServiceError, Unauthorized } from '@repo/backend/effect/errors'
import { Effect } from 'effect'
import { Hono } from 'hono'
import { cors } from 'hono/cors'

import { auth } from './auth.js'
import { AuthSessionService, makeAuthSessionService } from './effect/auth-session.js'
import { parseTrustedOrigins } from './lib/utils.js'
import { mountOpenApi, sessionRoute } from './openapi.js'

${httpBoundary}
const app = new Hono<{ Bindings: Env }>()

app.get('/healthz', (c) => c.text('ok'))

// CORS and better-auth CSRF must share the trusted-origin allow-list.
app.use(
	'/api/auth/*',
	cors({
		origin: parseTrustedOrigins(process.env.BETTER_AUTH_TRUSTED_ORIGINS),
		credentials: true,
		allowHeaders: ['content-type', 'x-locale', 'x-captcha-response'],
		maxAge: 600
	})
)

app.all('/api/auth/*', async (c) => auth.handler(c.req.raw))

app.get('/internal/session', sessionRoute, (c) => {
	const program = Effect.gen(function* () {
		const authSession = yield* AuthSessionService
		return yield* authSession.resolve(c.req.raw.headers)
	}).pipe(Effect.provideServiceEffect(AuthSessionService, makeAuthSessionService))
	return runEffectJson({
		c,
		program,
		onSuccess: (value) => ({ status: 200, body: value }),
		onFailure: mapSessionError
	})
})

mountOpenApi(app)

export default app
`
}

function utilsTs({ wantsEmailOTP }: { wantsEmailOTP: boolean }): string {
	const localeBlock = wantsEmailOTP
		? `

// Match a BCP-47-ish primary tag (2–3 letters) at the start of the value,
// stopping before any subtag, region, or quality qualifier — ignore the rest.
export const LOCALE_TAG = /^\\s*([a-z]{2,3})(?![a-z])/i

export function pickLocale(headers: Headers | undefined): string {
\tconst raw = headers?.get('x-locale') ?? headers?.get('accept-language') ?? ''
\tconst match = raw.match(LOCALE_TAG)
\treturn match ? match[1]!.toLowerCase() : 'en'
}`
		: ''

	return `export function parseTrustedOrigins(raw: string | undefined): string[] {
\tif (!raw) return []
\treturn raw.split(',').map((s) => s.trim()).filter(Boolean)
}${localeBlock}
`
}

function indexTs(runtime: Runtime): string {
	if (runtime === 'cf-workers') {
		return `import app from './app.js'

export default {
	fetch: app.fetch
} satisfies ExportedHandler<Env>
`
	}

	return `import { serve } from '@hono/node-server'

import app from './app.js'

const port = Number(process.env.PORT ?? 8787)
serve({ fetch: app.fetch, port })
console.log(\`auth listening on http://127.0.0.1:\${port}\`)
`
}

function readme({
	project,
	runtime,
	wantsGoogle,
	wantsEmailOTP,
	email
}: {
	project: string
	runtime: Runtime
	wantsGoogle: boolean
	wantsEmailOTP: boolean
	email: EmailChoice
}): string {
	const oauth = wantsGoogle
		? runtime === 'cf-workers'
			? `
### OAuth secrets
\`\`\`bash
wrangler secret put GOOGLE_CLIENT_ID
wrangler secret put GOOGLE_CLIENT_SECRET
\`\`\`
`
			: `
### OAuth secrets
Set in \`.env\` (dev) or your host platform (prod):
\`\`\`
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
\`\`\`
`
		: ''

	const usesNotifuse = email === 'notifuse'

	const emailSecretsBody = usesNotifuse
		? runtime === 'cf-workers'
			? `
Bind the self-hosted Notifuse instance. The API key is a workspace-scoped JWT
created in the Notifuse console (\`Settings → API keys\`); \`NOTIFUSE_BASE_URL\`
is the root of your Notifuse deployment (e.g. \`https://notifuse.example.com\`).
Sender address and integration are configured **inside Notifuse** — not here.

\`\`\`bash
wrangler secret put NOTIFUSE_API_KEY
wrangler secret put NOTIFUSE_WORKSPACE_ID
wrangler secret put NOTIFUSE_BASE_URL
\`\`\`

OTP delivery uses the transactional notification with ID \`otp-login\` — create
it in the Notifuse console with an \`email\` channel template that references
\`{{ code }}\` and \`{{ expiry_minutes }}\` in its MJML/Liquid body.
`
			: `
Bind the self-hosted Notifuse instance. The API key is a workspace-scoped JWT
created in the Notifuse console (\`Settings → API keys\`). Sender address and
integration are configured **inside Notifuse** — not here.

Set in \`.env\` (dev) or your host platform (prod):
\`\`\`
NOTIFUSE_API_KEY=...
NOTIFUSE_WORKSPACE_ID=...
NOTIFUSE_BASE_URL=https://notifuse.example.com
\`\`\`

OTP delivery uses the transactional notification with ID \`otp-login\` — create
it in the Notifuse console with an \`email\` channel template that references
\`{{ code }}\` and \`{{ expiry_minutes }}\` in its MJML/Liquid body.
`
		: runtime === 'cf-workers'
			? `
\`\`\`bash
wrangler secret put RESEND_API_KEY
wrangler secret put FROM_EMAIL
\`\`\`
`
			: `
Set in \`.env\` (dev) or your host platform (prod):
\`\`\`
RESEND_API_KEY=...
FROM_EMAIL=...
\`\`\`
`

	const emailSecrets = wantsEmailOTP ? `\n### Email secrets${emailSecretsBody}` : ''

	const captchaSecretsBody = wantsEmailOTP
		? runtime === 'cf-workers'
			? `
\`\`\`bash
wrangler secret put TURNSTILE_SECRET_KEY
\`\`\`

\`TURNSTILE_SECRET_KEY\` lives ONLY in this Worker. \`apps/web\` only holds the public \`PUBLIC_TURNSTILE_SITE_KEY\` (used to render the widget). The \`captcha\` plugin verifies the \`x-captcha-response\` header server-side against Cloudflare's siteverify on \`/email-otp/send-verification-otp\`.
`
			: `
Set in \`.env\` (dev) or your host platform (prod):
\`\`\`
TURNSTILE_SECRET_KEY=...
\`\`\`

\`TURNSTILE_SECRET_KEY\` lives ONLY in this service. \`apps/web\` only holds the public \`PUBLIC_TURNSTILE_SITE_KEY\` (used to render the widget). The \`captcha\` plugin verifies the \`x-captcha-response\` header server-side against Cloudflare's siteverify on \`/email-otp/send-verification-otp\`.
`
		: ''

	const captchaSecrets = wantsEmailOTP ? `\n### Captcha secret${captchaSecretsBody}` : ''

	const otpLocaleNote = wantsEmailOTP
		? usesNotifuse
			? `

## OTP locale

\`sendVerificationOTP\` resolves the recipient locale from request headers in
this order: \`x-locale\` → first language tag of \`accept-language\` →
\`'en'\`. The value is forwarded to Notifuse as \`contact.language\`, which
selects the right localized template if you maintain multiple language
variants in the console.`
			: `

## OTP locale

\`sendVerificationOTP\` resolves the recipient locale from request headers in
this order: \`x-locale\` → first language tag of \`accept-language\` →
\`'en'\`. Pass \`x-locale\` from the client when you already know the user's
preference; otherwise the browser's \`Accept-Language\` is used as a sensible
default.`
		: ''

	const trustedOriginsNote =
		runtime === 'cf-workers'
			? `

## Trusted origins

By default better-auth only trusts \`BETTER_AUTH_URL\`. To allow additional
origins (e.g. local frontend, preview deploys) set a comma-separated list:

\`\`\`bash
wrangler secret put BETTER_AUTH_TRUSTED_ORIGINS
# value: https://app.example.com,https://preview-*.example.com
\`\`\``
			: `

## Trusted origins

By default better-auth only trusts \`BETTER_AUTH_URL\`. To allow additional
origins (e.g. local frontend, preview deploys) set
\`BETTER_AUTH_TRUSTED_ORIGINS\` to a comma-separated list:

\`\`\`
BETTER_AUTH_TRUSTED_ORIGINS=https://app.example.com,https://preview.example.com
\`\`\``

	const setupBlock =
		runtime === 'cf-workers'
			? `## Setup

\`\`\`bash
wrangler secret put BETTER_AUTH_SECRET
\`\`\`
${emailSecrets}${captchaSecrets}${oauth}
Then edit \`wrangler.jsonc\` and replace \`<domain>\` with your apex domain.${trustedOriginsNote}${otpLocaleNote}

## Local dev

\`\`\`bash
pnpm dev
\`\`\`
`
			: `## Setup

Set \`BETTER_AUTH_SECRET\` in \`.env\` (dev) or your host platform's secret
manager (prod).
${emailSecrets}${captchaSecrets}${oauth}${trustedOriginsNote}${otpLocaleNote}

## Local dev

\`\`\`bash
pnpm dev
\`\`\`

The server listens on \`http://127.0.0.1:\${PORT ?? 8787}\`. Sibling services
(e.g. \`apps/api/users\`) reach it via the \`AUTH_URL\` environment variable.
`

	return `# ${project}-auth

The auth service. **Sole owner** of authentication state and secrets.

## What this service does

- Hosts the public better-auth surface at \`/api/auth/*\`
- Exposes \`/internal/session\` RPC for sibling services
- Owns the auth tables (sessions, accounts, verification) in \`packages/db\`

## What this service does NOT do

- Run business logic
- Call other services (no \`services\` bindings, no outbound HTTP)

Other services MUST call \`/internal/session\` ${
		runtime === 'cf-workers' ? 'through a CF service binding' : 'via HTTP using `AUTH_URL`'
	} —
**never** import this service's code or read its secrets.

${setupBlock}
## Schema regeneration

When auth plugins change, regenerate the auth schema from the repo root:

\`\`\`bash
npx @better-auth/cli@latest generate --adapter drizzle --output packages/db/src/schema/auth.ts
\`\`\`
`
}
