import type { FileEntry } from '../../lib/files.js'
import { HONO_WORKERS_COMPAT_DATE } from '../../lib/workers.js'
import type { GvKitConfig } from '../../schema/config.js'
import {
	CLOUDFLARE_TYPEGEN_SCRIPT,
	CLOUDFLARE_TYPES_BOOTSTRAP_FILE,
	renderCloudflareBootstrapTypes
} from '../cloudflare-worker-types.js'
import {
	AUTH_SERVICE,
	honoPackageIdentity,
	honoServiceName,
	honoServicePath,
	USERS_SERVICE
} from '../hono-topology.js'

const PUBLIC_AUTH_PREFIX = AUTH_SERVICE.publicPrefixes[0]

type Runtime = 'cf-workers' | 'node'
type AuthChoice = GvKitConfig['choices']['auth'][number]
type EmailChoice = GvKitConfig['choices']['email']

function deriveRuntime(deploy: GvKitConfig['choices']['deploy']): Runtime {
	return deploy === 'cf-workers' ? 'cf-workers' : 'node'
}

export function generateAuthService(cfg: GvKitConfig): FileEntry[] {
	const project = cfg.choices.name
	const usesSqlite = cfg.choices.db === 'sqlite'
	const auth = cfg.choices.auth
	const email = cfg.choices.email
	const wantsGoogle = auth.includes('google')
	const wantsEmailOTP = auth.includes('emailOTP')
	const runtime = deriveRuntime(cfg.choices.deploy)

	const entries: FileEntry[] = [
		{
			path: honoServicePath(AUTH_SERVICE, 'package.json'),
			content: pkgJson({ project, runtime, auth, usesSqlite })
		},
		{
			path: honoServicePath(AUTH_SERVICE, 'tsconfig.json'),
			content: tsconfig({ runtime, usesSqlite })
		},
		{
			path: honoServicePath(AUTH_SERVICE, 'src/lib/utils.ts'),
			content: utilsTs({ wantsEmailOTP })
		},
		{
			path: honoServicePath(AUTH_SERVICE, 'src/auth.ts'),
			content: authTs({ runtime, usesSqlite, wantsGoogle, auth, email })
		},
		{
			path: honoServicePath(AUTH_SERVICE, 'src/openapi.ts'),
			content: openapiTs(project)
		},
		{
			path: honoServicePath(AUTH_SERVICE, 'src/app.ts'),
			content: appTs(runtime)
		},
		{
			path: honoServicePath(AUTH_SERVICE, 'src/index.ts'),
			content: indexTs(runtime)
		},
		{
			path: honoServicePath(AUTH_SERVICE, 'README.md'),
			content: readme({ project, runtime, wantsGoogle, wantsEmailOTP, email })
		}
	]

	if (runtime === 'cf-workers') {
		const webHost = cfg.choices.marketing === 'astro' ? 'app.<domain>' : '<domain>'
		const wrangler = wranglerJsonc({
			project,
			usesSqlite,
			wantsGoogle,
			wantsEmailOTP,
			email,
			webHost
		})
		entries.push(
			{
				path: honoServicePath(AUTH_SERVICE, 'wrangler.jsonc'),
				content: wrangler
			},
			{
				path: honoServicePath(AUTH_SERVICE, CLOUDFLARE_TYPES_BOOTSTRAP_FILE),
				content: renderCloudflareBootstrapTypes(wrangler)
			}
		)
	} else {
		entries.push(
			{
				path: honoServicePath(AUTH_SERVICE, 'env.d.ts'),
				content: envDts({ usesSqlite, wantsGoogle, auth, email })
			},
			{
				path: honoServicePath(AUTH_SERVICE, 'tsup.config.ts'),
				content: tsupConfig(usesSqlite)
			}
		)
	}

	if (runtime === 'cf-workers') {
		entries.push({
			path: honoServicePath(AUTH_SERVICE, '.dev.vars'),
			content: devVars({ usesSqlite, wantsGoogle, wantsEmailOTP, email })
		})
	}

	return entries
}

function tsupConfig(usesSqlite: boolean): string {
	return `import { defineConfig } from 'tsup'

export default defineConfig({
	noExternal: [/^@repo\\/(?!mailer$)/],
	external: ['@repo/mailer'${usesSqlite ? ", '@libsql/client'" : ''}]
})
`
}

function pkgJson({
	project,
	runtime,
	auth,
	usesSqlite
}: {
	project: string
	runtime: Runtime
	auth: AuthChoice[]
	usesSqlite: boolean
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
	if (runtime === 'node' && usesSqlite) dependencies['@libsql/client'] = '^0.14.0'

	const devDependencies: Record<string, string> = {
		'@repo/tooling-typescript': 'workspace:*',
		typescript: '~5.9.0'
	}

	const scripts: Record<string, string> = {
		typecheck: 'tsc --noEmit',
		lint: 'eslint .'
	}

	const prepareMailer = auth.includes('emailOTP')
		? '(test -f ../../packages/mailer/dist/index.js || pnpm --filter @repo/mailer build) && '
		: ''

	if (runtime === 'cf-workers') {
		devDependencies.wrangler = '^4.125.0'
		devDependencies['@cloudflare/workers-types'] = '^5.20260825.1'
		devDependencies['@types/node'] = '^24.0.0'
		scripts['cf-typegen'] = CLOUDFLARE_TYPEGEN_SCRIPT
		scripts.dev = `${prepareMailer}pnpm cf-typegen && wrangler dev`
		scripts.build = 'wrangler deploy --dry-run --outdir=dist'
		scripts.deploy = 'pnpm cf-typegen && wrangler deploy'
		scripts['deploy:production'] = 'pnpm cf-typegen && wrangler deploy'
		scripts['deploy:staging'] =
			'pnpm cf-typegen && test -n "$STAGING_ALIAS" && test -n "$STAGING_SECRETS_FILE" && wrangler deploy --config "${STAGING_WRANGLER_CONFIG:-wrangler.jsonc}" --secrets-file "$STAGING_SECRETS_FILE"'
		scripts.typecheck = 'tsc --noEmit'
	} else {
		dependencies['@hono/node-server'] = '^1.13.0'
		devDependencies.tsup = '^8.3.0'
		devDependencies.tsx = '^4.19.0'
		devDependencies['@types/node'] = '^24.0.0'
		scripts.dev = `${prepareMailer}tsx watch src/index.ts`
		scripts.build = 'tsup src/index.ts --format esm --target=node24 --out-dir dist'
		scripts.start = 'node dist/index.js'
	}

	return (
		JSON.stringify(
			{
				name: honoPackageIdentity(project, AUTH_SERVICE),
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

function wranglerJsonc({
	project,
	usesSqlite,
	wantsGoogle,
	wantsEmailOTP,
	email,
	webHost
}: {
	project: string
	usesSqlite: boolean
	wantsGoogle: boolean
	wantsEmailOTP: boolean
	email: EmailChoice
	webHost: string
}): string {
	const dbBlock = usesSqlite
		? `,
	"d1_databases": [
		{
			"binding": "DB",
			"database_name": "${project}-db",
			"database_id": "<run: wrangler d1 create ${project}-db>"
		}
	]`
		: ''

	const requiredSecrets = ['BETTER_AUTH_SECRET']
	if (!usesSqlite) requiredSecrets.push('DATABASE_URL')
	if (wantsGoogle) requiredSecrets.push('GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET')
	if (wantsEmailOTP) {
		requiredSecrets.push('TURNSTILE_SECRET_KEY')
		if (email === 'resend') requiredSecrets.push('RESEND_API_KEY', 'FROM_EMAIL')
		if (email === 'notifuse')
			requiredSecrets.push('NOTIFUSE_API_KEY', 'NOTIFUSE_WORKSPACE_ID', 'NOTIFUSE_BASE_URL')
	}

	return `{
	"$schema": "node_modules/wrangler/config-schema.json",
	"name": "${honoServiceName(project, AUTH_SERVICE)}",
	"main": "src/index.ts",
	"tsconfig": "tsconfig.json",
	"compatibility_date": "${HONO_WORKERS_COMPAT_DATE}",
	"compatibility_flags": ["nodejs_compat"],
	"workers_dev": false,
	"preview_urls": false,
	"services": [],
	"vars": {
		"BETTER_AUTH_ALLOWED_HOSTS": "${webHost},api.<domain>",
		"AUTH_CORS_ORIGINS": "https://${webHost}"
	},
	"secrets": { "required": ${JSON.stringify(requiredSecrets)} },
	"dev": {
		"ip": "${AUTH_SERVICE.development.ip}",
		"port": ${AUTH_SERVICE.development.port},
		"host": "${AUTH_SERVICE.development.hostname}",
		"inspector_port": ${AUTH_SERVICE.development.inspectorPort}
	},
	"observability": { "enabled": true }${dbBlock}
}
`
}

function devVars({
	usesSqlite,
	wantsGoogle,
	wantsEmailOTP,
	email
}: {
	usesSqlite: boolean
	wantsGoogle: boolean
	wantsEmailOTP: boolean
	email: EmailChoice
}): string {
	const lines = [
		'# Local-only placeholders. Wrangler reads this ignored file for `wrangler dev`.',
		'# Install real secret values with `wrangler secret put <NAME>` before deployment.',
		'BETTER_AUTH_ALLOWED_HOSTS=localhost:3000,localhost:5173,localhost:8786,127.0.0.1:8786',
		'AUTH_CORS_ORIGINS=http://localhost:3000,http://localhost:5173',
		'BETTER_AUTH_SECRET=local-only-better-auth-secret-at-least-32-characters'
	]
	if (!usesSqlite) lines.push('DATABASE_URL=postgres://user:pass@localhost:5432/local')
	if (wantsGoogle) {
		lines.push('GOOGLE_CLIENT_ID=local-only-google-client-id')
		lines.push('GOOGLE_CLIENT_SECRET=local-only-google-client-secret')
	}
	if (wantsEmailOTP) {
		lines.push('TURNSTILE_SECRET_KEY=1x0000000000000000000000000000000AA')
		if (email === 'resend') {
			lines.push('RESEND_API_KEY=local-only-resend-api-key')
			lines.push('FROM_EMAIL=local@example.test')
		}
		if (email === 'notifuse') {
			lines.push('NOTIFUSE_API_KEY=local-only-notifuse-api-key')
			lines.push('NOTIFUSE_WORKSPACE_ID=local-only-notifuse-workspace')
			lines.push('NOTIFUSE_BASE_URL=http://127.0.0.1:3000')
		}
	}
	return `${lines.join('\n')}\n`
}

function envDts({
	usesSqlite,
	wantsGoogle,
	auth,
	email
}: {
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

	const nodeDb = usesSqlite ? '\t\tSQLITE_PATH?: string' : '\t\tDATABASE_URL: string'

	return `// Ambient \`Env\` for OpenAPIHono<{ Bindings: Env }>; values are read from \`process.env\` at runtime.
// Other services MUST NOT read these secrets — they call /internal/session via \`AUTH_URL\`.
declare global {
	interface Env {
		BETTER_AUTH_SECRET: string
		BETTER_AUTH_ALLOWED_HOSTS?: string
		AUTH_CORS_ORIGINS?: string
${oauthLines}${emailLines}${turnstileLine}${nodeDb}
	}
}
export {}
`
}

function authTs({
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
	if (wantsEmailOTP) {
		imports.push(
			usesNotifuse
				? `import { createMailer } from '@repo/mailer'`
				: `import { createMailer, type Locale } from '@repo/mailer'`
		)
	}
	imports.push(
		wantsEmailOTP
			? `import { parseAllowedHosts, pickLocale } from './lib/utils.js'`
			: `import { parseAllowedHosts } from './lib/utils.js'`
	)

	if (runtime === 'cf-workers') {
		const dbExpr = usesSqlite ? '{ DB: env.DB }' : '{ DATABASE_URL: env.DATABASE_URL }'

		const mailerLine = wantsEmailOTP
			? usesNotifuse
				? `\tconst mailer = env.NOTIFUSE_API_KEY
\t\t? createMailer({
\t\t\tapiKey: env.NOTIFUSE_API_KEY,
\t\t\tworkspaceId: env.NOTIFUSE_WORKSPACE_ID,
\t\t\tbaseUrl: env.NOTIFUSE_BASE_URL
\t\t})
\t\t: null\n\n`
				: `\tconst mailer = env.RESEND_API_KEY ? createMailer(env.RESEND_API_KEY) : null\n\n`
			: ''

		const otpPlugin = wantsEmailOTP
			? usesNotifuse
				? `\t\temailOTP({
\t\t\totpLength: 6,
\t\t\texpiresIn: 600,
\t\t\tasync sendVerificationOTP({ email, otp }, ctx) {
\t\t\t\tif (!mailer) {
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
\t\t\t\tif (!mailer) {
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
\t\tbaseURL: { allowedHosts: parseAllowedHosts(env.BETTER_AUTH_ALLOWED_HOSTS) },
\t\tdatabase: drizzleAdapter(db, { provider: '${provider}' }),
\t\tplugins,${socialSpread}
\t\tadvanced: {
\t\t\ttrustedProxyHeaders: true,
\t\t\tipAddress: { ipAddressHeaders: ['${ipHeader}'] },
\t\t\tcrossSubDomainCookies: { enabled: false },
\t\t\tdefaultCookieAttributes: { secure: true, sameSite: 'lax' }
\t\t}
\t})
}
`
	}

	const dbConstruction = usesSqlite
		? `createDb({ url: process.env.SQLITE_PATH ?? 'file:./local.db' })`
		: `createDb({ DATABASE_URL: process.env.DATABASE_URL ?? '' })`

	const mailerLine = wantsEmailOTP
		? usesNotifuse
			? `const mailer = process.env.NOTIFUSE_API_KEY
\t? createMailer({
\t\tapiKey: process.env.NOTIFUSE_API_KEY,
\t\tworkspaceId: process.env.NOTIFUSE_WORKSPACE_ID ?? '',
\t\tbaseUrl: process.env.NOTIFUSE_BASE_URL ?? ''
\t})
\t: null\n\n`
			: `const mailer = process.env.RESEND_API_KEY
\t? createMailer(process.env.RESEND_API_KEY)
\t: null\n\n`
		: ''

	const otpPlugin = wantsEmailOTP
		? usesNotifuse
			? `\temailOTP({
\t\totpLength: 6,
\t\texpiresIn: 600,
\t\tasync sendVerificationOTP({ email, otp }, ctx) {
\t\t\tif (!mailer) {
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
\t\t\tif (!mailer) {
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
\tbaseURL: { allowedHosts: parseAllowedHosts(process.env.BETTER_AUTH_ALLOWED_HOSTS) },
\tdatabase: drizzleAdapter(db, { provider: '${provider}' }),
\tplugins,${socialSpread}
\tadvanced: {
\t\ttrustedProxyHeaders: true,
\t\tipAddress: { ipAddressHeaders: ['${ipHeader}'] },
\t\tcrossSubDomainCookies: { enabled: false },
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

// Documents ONLY /internal/session. The gateway-forwarded ${PUBLIC_AUTH_PREFIX}/* contract is
// excluded because sibling services use the private binding or HTTP boundary, not a typed client.
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
		info: { title: '${honoServiceName(project, AUTH_SERVICE)} (internal)', version: '0.0.0' }
	})
}
`
}

function appTs(runtime: Runtime): string {
	if (runtime === 'cf-workers') {
		return `import { OpenAPIHono } from '@hono/zod-openapi'
import { cors } from 'hono/cors'

import { getAuth } from './auth.js'
import { resolveCorsOrigin } from './lib/utils.js'
import { mountOpenApi, sessionRoute } from './openapi.js'

const app = new OpenAPIHono<{ Bindings: Env }>()

app.get('/healthz', (c) => c.text('ok'))

app.use('${PUBLIC_AUTH_PREFIX}/*', async (c, next) => {
	const mw = cors({
		origin: (origin) => resolveCorsOrigin(origin, c.env.AUTH_CORS_ORIGINS),
		credentials: true,
		allowHeaders: ['content-type', 'x-locale', 'x-captcha-response'],
		maxAge: 600
	})
	return mw(c, next)
})

app.all('${PUBLIC_AUTH_PREFIX}/*', async (c) => {
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
import { resolveCorsOrigin } from './lib/utils.js'
import { mountOpenApi, sessionRoute } from './openapi.js'

const app = new OpenAPIHono<{ Bindings: Env }>()

app.get('/healthz', (c) => c.text('ok'))

app.use(
	'${PUBLIC_AUTH_PREFIX}/*',
	cors({
		origin: (origin) => resolveCorsOrigin(origin, process.env.AUTH_CORS_ORIGINS),
		credentials: true,
		allowHeaders: ['content-type', 'x-locale', 'x-captcha-response'],
		maxAge: 600
	})
)

app.all('${PUBLIC_AUTH_PREFIX}/*', async (c) => auth.handler(c.req.raw))

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

	return `const LOCAL_ALLOWED_HOSTS = [
\t'localhost:3000',
\t'localhost:5173',
\t'localhost:8786',
\t'127.0.0.1:8786'
]

const LOCAL_CORS_ORIGINS = ['http://localhost:3000', 'http://localhost:5173']

function parseList(raw: string | undefined, fallback: string[]): string[] {
\treturn (raw ? raw.split(',') : fallback).map((value) => value.trim()).filter(Boolean)
}

export function parseAllowedHosts(raw: string | undefined): string[] {
\treturn parseList(raw, LOCAL_ALLOWED_HOSTS)
}

export function resolveCorsOrigin(origin: string, raw: string | undefined): string {
\treturn parseList(raw, LOCAL_CORS_ORIGINS).includes(origin) ? origin : ''
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

const hostname = process.env.HOST ?? '${AUTH_SERVICE.development.ip}'
const port = Number(process.env.AUTH_PORT ?? process.env.PORT ?? ${AUTH_SERVICE.development.port})
serve({ fetch: app.fetch, port, hostname })
console.log(\`${AUTH_SERVICE.identity} listening on http://\${hostname}:\${port}\`)
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

Set \`BETTER_AUTH_ALLOWED_HOSTS\` to the comma-separated web, API, and preview
hosts that may terminate auth requests. Host entries omit the protocol. Set
\`AUTH_CORS_ORIGINS\` to the complete browser origins allowed to call the
independent API origin with credentials. Unknown hosts and origins are rejected.`
			: `

## Trusted origins

Set \`BETTER_AUTH_ALLOWED_HOSTS\` to the comma-separated web, API, and preview
hosts that may terminate auth requests. Host entries omit the protocol. Set
\`AUTH_CORS_ORIGINS\` to the complete browser origins allowed to call the
independent API origin with credentials. Unknown hosts and origins are rejected.`

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

The server listens on \`http://127.0.0.1:\${PORT ?? ${AUTH_SERVICE.development.port}}\`. Sibling services
(e.g. \`${USERS_SERVICE.workspacePath}\`) reach it via the \`${AUTH_SERVICE.transport.node.targetEnvironmentVariable}\` environment variable.
`

	return `# ${honoServiceName(project, AUTH_SERVICE)}

The auth service is a private service and the sole owner of authentication state and secrets.
It is reachable externally only through the gateway. Do not add a direct route, public hostname,
or browser-facing service URL.

## What this service does

- Owns the gateway-forwarded Better Auth route implementation at \`${PUBLIC_AUTH_PREFIX}/*\`
- Exposes \`/internal/session\` RPC for sibling services
- Owns the auth tables (sessions, accounts, verification) in \`packages/db\`

## What this service does not do

- Expose independent public ingress
- Run domain business logic
- Call other services (no \`services\` bindings, no outbound HTTP)

Other services MUST call \`/internal/session\` ${
		runtime === 'cf-workers'
			? 'through a CF service binding'
			: `via HTTP using \`${AUTH_SERVICE.transport.node.targetEnvironmentVariable}\``
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
