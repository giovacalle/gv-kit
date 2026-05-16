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
	const project = cfg.choices.name
	const usesSqlite = cfg.choices.db === 'sqlite'
	const auth = cfg.choices.auth
	const email = cfg.choices.email
	const wantsGoogle = auth.includes('google')
	const wantsEmailOTP = auth.includes('emailOTP')
	const runtime = deriveRuntime(cfg.choices.deploy)

	// `wrangler types` owns `worker-configuration.d.ts` and refuses to overwrite
	// non-wrangler files with that name; our own declaration is at `env.d.ts`.
	const envDeclPath = 'apps/api/auth/env.d.ts'

	const entries: FileEntry[] = [
		{
			path: 'apps/api/auth/package.json',
			content: pkgJson({ project, runtime, auth })
		},
		{
			path: 'apps/api/auth/tsconfig.json',
			content: tsconfig({ runtime, usesSqlite })
		},
		{
			path: envDeclPath,
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
			content: wranglerJsonc({ project, usesSqlite, wantsEmailOTP, email })
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

function pkgJson({
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

	const devDependencies: Record<string, string> = {
		'@repo/tooling-typescript': 'workspace:*',
		typescript: '~5.9.0'
	}

	const scripts: Record<string, string> = {
		typecheck: 'tsc --noEmit',
		lint: 'eslint .'
	}

	if (runtime === 'cf-workers') {
		devDependencies.wrangler = '^4.0.0'
		devDependencies['@cloudflare/workers-types'] = '^4.20251101.0'
		devDependencies['@types/node'] = '^22.10.0'
		// `cf-typegen` must run before tsc/wrangler so `Env` matches wrangler.jsonc.
		scripts['cf-typegen'] = 'wrangler types'
		scripts.dev = 'pnpm cf-typegen && wrangler dev'
		scripts.build = 'pnpm cf-typegen && wrangler deploy --dry-run --outdir=dist'
		scripts.deploy = 'pnpm cf-typegen && wrangler deploy'
		scripts.typecheck = 'pnpm cf-typegen && tsc --noEmit'
	} else {
		dependencies['@hono/node-server'] = '^1.13.0'
		devDependencies.tsup = '^8.3.0'
		devDependencies.tsx = '^4.19.0'
		devDependencies['@types/node'] = '^22.10.0'
		scripts.dev = 'tsx watch src/index.ts'
		scripts.build = 'tsup src/index.ts --format esm --target=node20 --outdir dist'
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

function tsconfig({ runtime, usesSqlite: _usesSqlite }: { runtime: Runtime; usesSqlite: boolean }): string {
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
	wantsEmailOTP,
	email
}: {
	project: string
	usesSqlite: boolean
	wantsEmailOTP: boolean
	email: EmailChoice
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
		wantsEmailOTP
			? '\n\t// SECRET: TURNSTILE_SECRET_KEY — required when emailOTP is enabled.'
			: ''
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
			? `import { parseTrustedOrigins, pickLocale } from './lib/utils.js'`
			: `import { parseTrustedOrigins } from './lib/utils.js'`
	)

	if (runtime === 'cf-workers') {
		const dbExpr = usesSqlite ? '{ DB: env.DB }' : '{ HYPERDRIVE: env.HYPERDRIVE }'

		const mailerLine = wantsEmailOTP
			? usesNotifuse
				? `\tconst mailer = createMailer({
\t\tapiKey: env.NOTIFUSE_API_KEY,
\t\tworkspaceId: env.NOTIFUSE_WORKSPACE_ID,
\t\tbaseUrl: env.NOTIFUSE_BASE_URL
\t})\n\n`
				: `\tconst mailer = createMailer(env.RESEND_API_KEY)\n\n`
			: ''

		const otpPlugin = wantsEmailOTP
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

	const mailerLine = wantsEmailOTP
		? usesNotifuse
			? `const mailer = createMailer({
\tapiKey: process.env.NOTIFUSE_API_KEY ?? '',
\tworkspaceId: process.env.NOTIFUSE_WORKSPACE_ID ?? '',
\tbaseUrl: process.env.NOTIFUSE_BASE_URL ?? ''
})\n\n`
			: `const mailer = createMailer(process.env.RESEND_API_KEY ?? '')\n\n`
		: ''

	const otpPlugin = wantsEmailOTP
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

	const trustedOriginsNote = runtime === 'cf-workers'
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
		runtime === 'cf-workers'
			? 'through a CF service binding'
			: 'via HTTP using `AUTH_URL`'
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
