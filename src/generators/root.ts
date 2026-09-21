import type { FileEntry } from '../lib/files.js'
import type { GvKitConfig } from '../schema/config.js'
import {
	AUTH_SERVICE,
	developmentOrigin,
	hasLegacyHonoPublicRouteTable,
	HONO_GATEWAY,
	HONO_SERVICES,
	honoPackageIdentity,
	honoPublicRoutes,
	nodeDevelopmentOrigin,
	USERS_SERVICE,
	type HonoServiceTopology
} from './hono-topology.js'

const CLOUDFLARE_INCLUDE_PROCESS_ENV = 'CLOUDFLARE_INCLUDE_PROCESS_ENV'

/** Generator for the scaffolded project's root files (workspace + lint/format shims). */
export function generateRoot(cfg: GvKitConfig): FileEntry[] {
	const entries: FileEntry[] = [
		{ path: 'package.json', content: renderRootPackageJson(cfg) },
		{ path: 'pnpm-workspace.yaml', content: renderPnpmWorkspace(cfg) },
		{ path: 'turbo.json', content: renderTurboJson(cfg) },
		{ path: 'tsconfig.json', content: renderRootTsconfig(cfg) },
		{ path: '.gitignore', content: renderGitignore(cfg) },
		{ path: 'prettier.config.js', content: PRETTIER_CONFIG_SHIM },
		{ path: '.prettierignore', content: renderPrettierIgnore(cfg) },
		{ path: 'eslint.config.js', content: ESLINT_CONFIG_SHIM },
		{ path: 'README.md', content: renderReadme(cfg) },
		{ path: '.env.example', content: renderEnvExample(cfg) },
		{ path: 'LICENSE', content: LICENSE_MIT }
	]
	if (cfg.choices.backend === 'hono') entries.push({ path: 'scripts/local.mjs', content: renderLocalScript(cfg) })
	if (cfg.choices.backend === 'hono' && cfg.choices.deploy === 'cf-workers') entries.push({ path: '.env.cloudflare.example', content: renderCloudflareEnvExample(cfg) })
	return entries
}

function renderRootPackageJson(cfg: GvKitConfig): string {
	const scripts: Record<string, string> = {
		dev: cfg.choices.backend === 'hono' ? 'node scripts/local.mjs dev' : 'turbo run dev',
		build: cfg.choices.backend === 'hono' ? 'pnpm openapi:check && turbo run build' : 'turbo run build',
		test: 'turbo run test',
		typecheck: 'turbo run typecheck',
		lint: 'turbo run lint',
		format: 'prettier --write "**/*.{ts,tsx,svelte,astro,json,md}"',
		prepare: 'husky'
	}
	if (cfg.choices.backend === 'hono') {
		const gatewayPackage = honoPackageIdentity(cfg.choices.name, HONO_GATEWAY)
		scripts['local:prepare'] = 'node scripts/local.mjs prepare'
		scripts['openapi:compose'] = `pnpm --filter ${gatewayPackage} openapi:compose`
		scripts['openapi:check'] = `pnpm --filter ${gatewayPackage} openapi:check`
	}
	if (cfg.choices.apiClient === 'hey-api') scripts.codegen = 'pnpm openapi:check && pnpm --filter @repo/openapi-client codegen'

	const postinstall: string[] = []
	if (cfg.choices.i18n === 'paraglide') {
		postinstall.push(
			'test ! -f packages/i18n/project.inlang/settings.json || pnpm --filter @repo/i18n build'
		)
	}
	if (cfg.choices.apiClient === 'hey-api') postinstall.push('test ! -f packages/openapi-client/openapi-ts.config.ts || pnpm codegen')
	if (postinstall.length > 0) scripts.postinstall = postinstall.join(' && ')
	if (cfg.choices.deploy === 'cf-workers') {
		scripts['deploy:production'] = 'turbo run deploy:production --affected'
		scripts['deploy:staging'] = 'turbo run deploy:staging --affected'
	}

	const pkg = {
		name: cfg.choices.name,
		version: '0.0.0',
		private: true,
		type: 'module',
		packageManager: 'pnpm@11.1.1',
		scripts,
		devDependencies: {
			'@commitlint/cli': '^19.6.0',
			'@commitlint/config-conventional': '^19.6.0',
			'@ianvs/prettier-plugin-sort-imports': '^4.4.0',
			'@repo/tooling-eslint': 'workspace:*',
			'@repo/tooling-prettier': 'workspace:*',
			eslint: '^9.0.0',
			husky: '^9.1.7',
			'lint-staged': '^15.2.10',
			prettier: '^3.4.0',
			turbo: '^2.9.0',
			typescript: '~5.9.0'
		},
		'lint-staged': {
			'**/*.{ts,tsx,svelte,svelte.ts,svelte.js}': ['prettier --write', 'eslint --fix'],
			'**/*.{json,css,html,md,astro}': ['prettier --write']
		},
		engines: {
			node: '>=24.0.0 <25.0.0',
			pnpm: '>=11'
		}
	}
	return JSON.stringify(pkg, null, 2) + '\n'
}

function renderPnpmWorkspace(cfg: GvKitConfig): string {
	const deployables =
		cfg.choices.backend === 'hono'
			? "  - 'apps/*'\n  - 'services/*'"
			: "  - 'apps/*'\n  - 'apps/api/*'"
	const sharpOverride = cfg.choices.deploy === 'cf-workers'
		? "  'miniflare>sharp@>=0.35.0 <0.35.4': 0.35.4\n"
		: ''
	return `packages:
${deployables}
  - 'packages/*'
  - 'packages/tooling/*'

# pnpm 11 reads overrides here, not from package.json.
# Keep pre-1.0 API changes scoped to the consumers verified with these versions.
overrides:
  '@sveltejs/kit>cookie@<0.7.0': 0.7.2
  '@esbuild-kit/core-utils@3.3.2>esbuild': 0.25.12
  'tsup@8.5.1>esbuild': 0.28.2
  '@hey-api/json-schema-ref-parser@1.4.2>js-yaml': 4.3.2
${sharpOverride}  zod: ^4.3.0

# Pre-approve native build scripts so \`pnpm install\` never stops to prompt
# (pnpm 10+ otherwise writes a placeholder here that blocks subsequent commands).
allowBuilds:
  '@tailwindcss/oxide': true
  better-sqlite3: true
  core-js: false
  esbuild: true
  protobufjs: false
  sharp: true
  workerd: true
`
}

function renderTurboJson(cfg: GvKitConfig): string {
	const publicBuildEnv: string[] = []
	const buildOutputs = [
		'dist/**',
		...(cfg.choices.backend === 'hono' ? ['build/**'] : []),
		'.svelte-kit/**',
		'.wrangler/**',
		'src/paraglide/**'
	]
	if (cfg.choices.marketing === 'astro') {
		publicBuildEnv.push('PUBLIC_MARKETING_URL', 'PUBLIC_APP_URL')
		if (cfg.choices.monitoring.includes('umami')) publicBuildEnv.push('PUBLIC_UMAMI_HOST', 'PUBLIC_UMAMI_WEBSITE_ID')
		if (cfg.choices.monitoring.includes('posthog')) publicBuildEnv.push('PUBLIC_POSTHOG_KEY', 'PUBLIC_POSTHOG_HOST')
	}
	if (cfg.choices.auth.length > 0 && cfg.choices.backend === 'inside-frontend') publicBuildEnv.push('PUBLIC_AUTH_URL')
	if (cfg.choices.auth.includes('emailOTP')) publicBuildEnv.push('PUBLIC_TURNSTILE_SITE_KEY')
	const tasks: Record<string, unknown> = {
		build: {
			dependsOn: ['^build'],
			outputs: buildOutputs,
			...(publicBuildEnv.length > 0 ? { env: publicBuildEnv } : {})
		},
		typecheck: {
			dependsOn: ['^build']
		},
		test: {
			dependsOn: ['^build'],
			outputs: []
		},
		lint: {
			outputs: []
		},
		dev: {
			...(cfg.choices.backend === 'hono' ? { dependsOn: ['^build'] } : {}),
			cache: false,
			persistent: true
		},
		...(cfg.choices.backend === 'hono'
			? {
				...renderHonoDevTasks(cfg),
				[`${honoPackageIdentity(cfg.choices.name, HONO_GATEWAY)}#build`]: {
					dependsOn: ['^build'],
					inputs: ['$TURBO_DEFAULT$', '$TURBO_ROOT$/services/*/openapi.json'],
					outputs: buildOutputs
				}
			}
			: {})
	}

	if (cfg.choices.deploy === 'cf-workers') {
		tasks['deploy:production'] = {
			dependsOn: ['build'],
			cache: false
		}
		tasks['deploy:staging'] = {
			dependsOn: ['build'],
			cache: false
		}
	}

	return (
		JSON.stringify(
			{
				$schema: 'https://turbo.build/schema.json',
				ui: 'tui',
				tasks
			},
			null,
			2
		) + '\n'
	)
}

function renderHonoDevTasks(cfg: GvKitConfig) {
	const task = (env: string[]) => ({ dependsOn: ['^build'], cache: false, persistent: true, env })
	const cloudflareDevEnv =
		cfg.choices.deploy === 'cf-workers' ? [CLOUDFLARE_INCLUDE_PROCESS_ENV] : []
	const databaseEnv = cfg.choices.db === 'postgres' ? 'DATABASE_URL' : 'SQLITE_PATH'
	const authEnv = [databaseEnv]
	if (cfg.choices.auth.length > 0) authEnv.push('BETTER_AUTH_SECRET', 'BETTER_AUTH_ALLOWED_HOSTS', 'AUTH_CORS_ORIGINS')
	if (cfg.choices.auth.includes('google')) authEnv.push('GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET')
	if (cfg.choices.email === 'resend') authEnv.push('RESEND_API_KEY', 'FROM_EMAIL')
	if (cfg.choices.email === 'notifuse') authEnv.push('NOTIFUSE_API_KEY', 'NOTIFUSE_WORKSPACE_ID', 'NOTIFUSE_BASE_URL')
	if (cfg.choices.auth.includes('emailOTP')) authEnv.push('AUTH_OTP_CAPTURE', 'TURNSTILE_SECRET_KEY')
	authEnv.push(...cloudflareDevEnv)

	const webEnv: string[] = [HONO_GATEWAY.transport.node.targetEnvironmentVariable]
	if (cfg.choices.deploy !== 'cf-workers') webEnv.push('GATEWAY_TRUSTED_INGRESS_SECRET')
	if (cfg.choices.marketing === 'astro') webEnv.push('PUBLIC_APP_URL')
	if (cfg.choices.auth.includes('emailOTP')) webEnv.push('PUBLIC_TURNSTILE_SITE_KEY')

	const tasks: Record<string, ReturnType<typeof task>> = {
		[`${honoPackageIdentity(cfg.choices.name, HONO_GATEWAY)}#dev`]: task([
			'API_PUBLIC_ORIGIN',
			'GATEWAY_PUBLIC_ORIGINS',
			...(cfg.choices.deploy === 'cf-workers' ? [] : ['GATEWAY_TRUSTED_INGRESS_SECRET']),
			'API_CORS_ORIGINS',
			'GATEWAY_UPSTREAM_TIMEOUT_MS',
			AUTH_SERVICE.transport.node.targetEnvironmentVariable,
			USERS_SERVICE.transport.node.targetEnvironmentVariable,
			...cloudflareDevEnv
		]),
		[`${honoPackageIdentity(cfg.choices.name, AUTH_SERVICE)}#dev`]: task(authEnv),
		[`${honoPackageIdentity(cfg.choices.name, USERS_SERVICE)}#dev`]: task([
			databaseEnv,
			AUTH_SERVICE.transport.node.targetEnvironmentVariable,
			...cloudflareDevEnv
		]),
		[`${cfg.choices.name}-web#dev`]: task(webEnv)
	}
	if (cfg.choices.marketing === 'astro') tasks[`${cfg.choices.name}-marketing#dev`] = task(['PUBLIC_MARKETING_URL', 'PUBLIC_APP_URL'])
	return tasks
}

function renderLocalScript(cfg: GvKitConfig): string {
	const required = [
		'API_PUBLIC_ORIGIN',
		'GATEWAY_PUBLIC_ORIGINS',
		...(cfg.choices.deploy === 'cf-workers' ? [] : ['GATEWAY_TRUSTED_INGRESS_SECRET']),
		'API_CORS_ORIGINS',
		'GATEWAY_UPSTREAM_TIMEOUT_MS',
		HONO_GATEWAY.transport.node.targetEnvironmentVariable,
		AUTH_SERVICE.transport.node.targetEnvironmentVariable,
		USERS_SERVICE.transport.node.targetEnvironmentVariable
	]
	if (cfg.choices.db === 'postgres') required.push('DATABASE_URL')
	if (cfg.choices.auth.length > 0) required.push('BETTER_AUTH_SECRET', 'BETTER_AUTH_ALLOWED_HOSTS', 'AUTH_CORS_ORIGINS')
	if (cfg.choices.auth.includes('google')) required.push('GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET')
	if (cfg.choices.auth.includes('emailOTP')) required.push('TURNSTILE_SECRET_KEY')
	if (cfg.choices.marketing === 'astro') required.push('PUBLIC_MARKETING_URL', 'PUBLIC_APP_URL')
	if (cfg.choices.auth.includes('emailOTP')) required.push('PUBLIC_TURNSTILE_SITE_KEY')

	const prepareTask =
		cfg.choices.deploy === 'cf-workers' && cfg.choices.db === 'sqlite'
			? 'db:prepare:local'
			: 'db:push'
	const prepareArgs = [
		'--filter',
		'@repo/db',
		prepareTask,
		...(prepareTask === 'db:push' ? ['--force'] : [])
	]
	const cloudflareProcessEnvironment =
		cfg.choices.deploy === 'cf-workers'
			? `\nif (action === 'dev') process.env.${CLOUDFLARE_INCLUDE_PROCESS_ENV} = 'true'`
			: ''
	return `import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { loadEnvFile } from 'node:process'

const envPath = resolve('.env')
if (!existsSync(envPath)) {
	console.error('[local] Missing .env. Run \`cp .env.example .env\`, fill the required values, then retry.')
	process.exit(1)
}
loadEnvFile(resolve('.env'))

let localDatabasePath
if (process.env.SQLITE_PATH?.startsWith('file:./')) {
	localDatabasePath = resolve(process.env.SQLITE_PATH.slice(5))
	mkdirSync(dirname(localDatabasePath), { recursive: true })
	process.env.SQLITE_PATH = \`file:\${localDatabasePath}\`
}

const required = ${JSON.stringify(required)}
const missing = required.filter((name) => !process.env[name]?.trim())
if (missing.length > 0) {
	console.error(\`[local] Missing required values in .env: \${missing.join(', ')}. Fill them and retry.\`)
	process.exit(1)
}

const commands = {
	dev: ['exec', 'turbo', 'run', 'dev', '--filter=./apps/*', '--filter=./services/*'],
	prepare: ${JSON.stringify(prepareArgs)}
}
const action = process.argv[2]
const args = commands[action]
if (!args) {
	console.error('[local] Expected one command: dev or prepare.')
	process.exit(1)
}${cloudflareProcessEnvironment}

const result = spawnSync('pnpm', args, { env: process.env, stdio: 'inherit' })
if (result.error) throw result.error
if (action === 'prepare' && localDatabasePath && !existsSync(localDatabasePath)) {
	console.error('[local] Database preparation did not create the configured SQLite database.')
	process.exit(1)
}
process.exit(result.status ?? 1)
`
}

function renderRootTsconfig(cfg: GvKitConfig): string {
	const include =
		cfg.choices.backend === 'hono'
			? '["apps/**/*", "services/**/*", "packages/**/*"]'
			: '["apps/**/*", "apps/api/**/*", "packages/**/*"]'
	return `{
	"extends": "@repo/tooling-typescript/base.json",
	"compilerOptions": {
		"noEmit": true
	},
	"include": ${include},
	"exclude": [
		"node_modules",
		"dist",
		".svelte-kit",
		".wrangler",
		".turbo",
		"**/node_modules",
		"**/dist",
		"**/.svelte-kit",
		"**/.wrangler"
	]
}
`
}

function renderGitignore(cfg: GvKitConfig): string {
	const wranglerTypes =
		cfg.choices.backend === 'inside-frontend' ? '**/worker-configuration.d.ts\n' : ''
	return `node_modules/
.pnpm-store/
dist/
.turbo/
.svelte-kit/
.wrangler/
${wranglerTypes}.DS_Store
.env
.env.local
.env.*.local
**/.dev.vars
${cfg.choices.backend === 'hono' && cfg.choices.db === 'sqlite' && cfg.choices.deploy !== 'cf-workers' ? '.data/\n' : ''}*.local
*.tsbuildinfo
`
}

const PRETTIER_CONFIG_SHIM = `export { default } from '@repo/tooling-prettier'
`

function renderPrettierIgnore(cfg: GvKitConfig): string {
	return `node_modules/
dist/
.svelte-kit/
.wrangler/
.turbo/
pnpm-lock.yaml
**/openapi-client/src/*/
${cfg.choices.backend === 'hono' ? 'apps/api/openapi.json\n' : ''}`
}

const ESLINT_CONFIG_SHIM = `export { default } from '@repo/tooling-eslint'
`

function renderReadme(cfg: GvKitConfig): string {
	const { name } = cfg.choices
	const stackLines: string[] = []
	if (cfg.choices.marketing === 'astro') stackLines.push('- Marketing: Astro')
	stackLines.push(`- Application: SvelteKit`)
	if (cfg.choices.backend === 'hono') stackLines.push('- Backend: Hono gateway with private services')
	else stackLines.push('- Backend: SvelteKit endpoints (no separate API)')
	stackLines.push(`- Database: ${databaseLabel(cfg)} via Drizzle`)
	if (cfg.choices.auth.length > 0) {
		const methods = cfg.choices.auth.join(', ')
		stackLines.push(`- Auth: better-auth (${methods})`)
	}
	if (cfg.choices.i18n === 'paraglide') stackLines.push('- i18n: Paraglide')
	if (cfg.choices.email !== 'skip') stackLines.push(`- Email: ${cfg.choices.email}`)
	if (cfg.choices.deploy !== 'skip') {
		const deployLabel = cfg.choices.deploy === 'cf-workers' ? 'Cloudflare Workers' : 'Docker'
		stackLines.push(`- Deploy: ${deployLabel}`)
	}

	const environmentGuidance =
		cfg.choices.backend === 'hono'
			? cfg.choices.deploy === 'cf-workers'
				? 'Copy `.env.example` to `.env`, fill the required values, then run `pnpm local:prepare` once. Root `pnpm dev` loads this file and starts the complete local topology with Turbo strict environment filtering. Production Worker secrets go through `wrangler secret put <NAME>` rather than `.env`.'
				: 'Copy `.env.example` to `.env`, fill the required values, then run `pnpm local:prepare` once. Root `pnpm dev` loads this file and starts the complete local topology with Turbo strict environment filtering.'
			: cfg.choices.deploy === 'cf-workers'
				? 'Copy `.env.example` to `.env` and fill in any secrets your services need.\nFor Workers, secrets go through `wrangler secret put <NAME>` rather than `.env`.'
				: 'Copy `.env.example` to `.env` and fill in any secrets your services need.'
	const ambientTypeExample =
		cfg.choices.deploy === 'cf-workers'
			? '`@types/node` or `@cloudflare/workers-types`'
			: '`@types/node`'

	const quickstart =
		cfg.choices.backend === 'hono'
			? `### First run

\`\`\`bash
pnpm install
cp .env.example .env
# Fill the required values in .env.
pnpm local:prepare
pnpm dev
\`\`\`

### Subsequent runs

\`\`\`bash
pnpm dev
\`\`\``
			: `\`\`\`bash
pnpm install
pnpm dev
\`\`\``

	return `# ${name}

Type-safe full-stack monorepo with sensible defaults — install, run, ship.

## Quickstart

${quickstart}

## Common commands

| Command | What it does |
|---------|--------------|
| \`pnpm dev\` | Start every app and service in watch mode |
| \`pnpm build\` | Build every workspace package |
| \`pnpm test\` | Run all tests |
| \`pnpm typecheck\` | TypeScript check across the workspace |
| \`pnpm lint\` | ESLint across the workspace |
| \`pnpm format\` | Format with Prettier |

## Environment

${environmentGuidance}${renderEnvironmentSettingsGuidance(cfg)}
${renderPublicOrigins(cfg)}
${renderCloudflareDatabaseSetup(cfg)}${renderDeploymentGuidance(cfg)}

## Stack

${stackLines.join('\n')}

## Layout

- \`apps/web/\` — SvelteKit application
${cfg.choices.marketing === 'astro' ? '- `apps/marketing/` — static Astro marketing site and public SEO endpoints\n' : ''}${cfg.choices.backend === 'hono' ? '- `apps/api/` — Hono API gateway\n- `services/<service>/` — private Hono services\n' : ''}- \`packages/db/\` — Drizzle schema + client factory
- \`packages/backend/\` — shared backend application/core layer (data access, use cases, types, helpers, middleware)
${cfg.choices.i18n === 'paraglide' ? '- `packages/i18n/` — Paraglide messages and runtime\n' : ''}${cfg.choices.apiClient === 'hey-api' ? '- `packages/openapi-client/` — one flat client generated from the gateway contract\n' : ''}${
		cfg.choices.aiTooling.length > 0
			? `\nSee \`.ai/rules/\` for architecture rules, in particular the service\nboundary policy.\n`
			: ''
	}${renderApiTopology(cfg)}
## Workspace

\`pnpm-workspace.yaml\` lists the packages. \`pnpm install\` uses strict mode by default, so each package only sees the dependencies declared in its own \`package.json\` — there is no hoisted root \`node_modules\` to lean on.

Every runtime and type-only import must be declared explicitly in the importing package's \`package.json\` (including ambient types from \`@repo/tooling-typescript\` such as ${ambientTypeExample}). ESLint's \`import/no-extraneous-dependencies\` rule catches anything that slips through (\`pnpm lint\`).
`
}

function renderEnvironmentSettingsGuidance(cfg: GvKitConfig): string {
	if (cfg.choices.backend !== 'hono') return ''

	const localWebAliasPort = cfg.choices.deploy === 'docker' ? 3000 : 5173
	const privateTransportSettings = '`GATEWAY_URL`, `AUTH_URL`, and `USERS_URL`'
	const localSettings = [
		`\`API_PUBLIC_ORIGIN\` sets the canonical local API origin advertised by \`/api/openapi.json\`.${cfg.choices.deploy === 'docker' ? '' : ' The `api.localhost` hostname resolves to loopback in browsers without a hosts-file entry.'}`,
		'`GATEWAY_PUBLIC_ORIGINS` lists the complete local origins accepted by the gateway boundary.',
		`\`API_CORS_ORIGINS\` lists the complete browser origins allowed to call the canonical API with credentials. Browser calls use the same-origin \`http://localhost:${localWebAliasPort}/api/*\` alias.`,
		'`GATEWAY_UPSTREAM_TIMEOUT_MS` bounds private-service requests in milliseconds.',
		`${privateTransportSettings} are private local transport targets. They are not public service origins.`
	]
	if (cfg.choices.deploy === 'docker') localSettings.push('`GATEWAY_TRUSTED_INGRESS_SECRET` is shared only by the gateway, generated Nginx ingress, and private Node SSR transport.')
	else if (cfg.choices.deploy !== 'cf-workers') localSettings.push('`GATEWAY_TRUSTED_INGRESS_SECRET` is shared only by the private Node SSR transport and gateway.')
	if (cfg.choices.marketing === 'astro') localSettings.push('`PUBLIC_MARKETING_URL` and `PUBLIC_APP_URL` set the local build-time frontend origins.')
	if (cfg.choices.auth.length > 0) localSettings.push('`BETTER_AUTH_SECRET` is private. Each `BETTER_AUTH_ALLOWED_HOSTS` entry is a host and optional port without a scheme. `AUTH_CORS_ORIGINS` uses complete browser origins.')
	if (cfg.choices.db === 'postgres') localSettings.push('`DATABASE_URL` connects local services to PostgreSQL.')
	else if (cfg.choices.deploy !== 'cf-workers') localSettings.push('`SQLITE_PATH` points every local service at the same root-relative database.')
	if (cfg.choices.auth.includes('google')) localSettings.push('`GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` configure Google OAuth.')
	if (cfg.choices.email === 'resend') localSettings.push('`RESEND_API_KEY` and `FROM_EMAIL` configure Resend delivery.')
	else if (cfg.choices.email === 'notifuse') localSettings.push('`NOTIFUSE_API_KEY`, `NOTIFUSE_WORKSPACE_ID`, and `NOTIFUSE_BASE_URL` configure Notifuse delivery.')
	if (cfg.choices.auth.includes('emailOTP')) localSettings.push('`TURNSTILE_SECRET_KEY` stays in the auth service. `PUBLIC_TURNSTILE_SITE_KEY` is safe for the web app.')
	if (cfg.choices.monitoring.includes('umami')) localSettings.push('`PUBLIC_UMAMI_WEBSITE_ID` and `PUBLIC_UMAMI_HOST` configure the Umami browser client.')
	if (cfg.choices.monitoring.includes('posthog')) localSettings.push('`PUBLIC_POSTHOG_KEY` and `PUBLIC_POSTHOG_HOST` configure the PostHog browser client.')

	const cloudflareSettings =
		cfg.choices.deploy === 'cf-workers'
			? `

### Cloudflare production and preview settings

\`.env.cloudflare.example\` is a reference for non-secret production values. Replace every
\`<domain>\` placeholder, then apply each active value to its destination:

- Update \`API_PUBLIC_ORIGIN\`, \`GATEWAY_PUBLIC_ORIGINS\`, \`API_CORS_ORIGINS\`, and
  \`GATEWAY_UPSTREAM_TIMEOUT_MS\` in \`apps/api/wrangler.jsonc\`. These are gateway Worker variables.
${
	cfg.choices.marketing === 'astro'
		? '- Set `PUBLIC_APP_URL` as a GitHub Actions repository variable. The production workflow passes it to the Astro deployment/build; it is not a Wrangler runtime variable.\n'
		: '- `PUBLIC_APP_URL` is retained for a stable production example but is inactive when marketing stays inside the web app. Do not copy it to a Wrangler configuration.\n'
}${
					cfg.choices.auth.length > 0
						? '- Update `BETTER_AUTH_ALLOWED_HOSTS` and `AUTH_CORS_ORIGINS` in `services/auth/wrangler.jsonc`. The first contains hosts without schemes; the second contains complete origins.\n'
						: '- `BETTER_AUTH_ALLOWED_HOSTS` and `AUTH_CORS_ORIGINS` are retained for a stable production example but are inactive without a selected auth provider. Do not copy them to a Wrangler configuration.\n'
				}
Private services use Service Bindings in Cloudflare and have no public service URLs. Preview
workflows derive PR-specific origins from \`CLOUDFLARE_PREVIEW_WEB_DOMAIN\` and
\`CLOUDFLARE_PREVIEW_API_DOMAIN\`. \`CLOUDFLARE_PREVIEW_ZONE_NAME\` identifies the active zone and
bounds both domains. Configure all three as the GitHub Actions variables listed below. The provider
credentials and application secrets used by production and trusted preview jobs are listed in the
Cloudflare deployment section.`
			: ''

	return `

### Local runtime settings

\`.env.example\` contains local development values. Keep \`.env\` out of version control.

${localSettings.map((setting) => `- ${setting}`).join('\n')}${cloudflareSettings}`
}

function cloudflareWorkflowSecretKeys(cfg: GvKitConfig): string[] {
	const keys = ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID']
	if (cfg.choices.db === 'postgres') keys.push('DATABASE_URL', 'NEON_API_KEY')
	if (cfg.choices.backend !== 'hono' || cfg.choices.auth.length === 0) return keys
	keys.push('BETTER_AUTH_SECRET')
	if (cfg.choices.auth.includes('google')) keys.push('GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET')
	if (cfg.choices.auth.includes('emailOTP')) {
		keys.push('TURNSTILE_SECRET_KEY')
		if (cfg.choices.email === 'resend') keys.push('RESEND_API_KEY', 'FROM_EMAIL')
		if (cfg.choices.email === 'notifuse') keys.push('NOTIFUSE_API_KEY', 'NOTIFUSE_WORKSPACE_ID', 'NOTIFUSE_BASE_URL')
	}
	return keys
}

function cloudflareWorkflowVariableKeys(cfg: GvKitConfig): string[] {
	const keys: string[] = []
	if (cfg.choices.db === 'postgres') keys.push('NEON_PROJECT_ID')
	if (cfg.choices.backend === 'hono') {
		keys.push(
			'CLOUDFLARE_PREVIEW_WEB_DOMAIN',
			'CLOUDFLARE_PREVIEW_API_DOMAIN',
			'CLOUDFLARE_PREVIEW_ZONE_NAME'
		)
	} else {
		if (cfg.choices.marketing === 'astro') keys.push('CLOUDFLARE_WORKERS_SUBDOMAIN')
		if (cfg.choices.auth.length > 0) keys.push('PUBLIC_AUTH_URL')
	}
	if (cfg.choices.marketing === 'astro') {
		keys.push('PUBLIC_MARKETING_URL', 'PUBLIC_APP_URL')
		if (cfg.choices.monitoring.includes('umami')) keys.push('PUBLIC_UMAMI_HOST', 'PUBLIC_UMAMI_WEBSITE_ID')
		if (cfg.choices.monitoring.includes('posthog')) keys.push('PUBLIC_POSTHOG_KEY', 'PUBLIC_POSTHOG_HOST')
	}
	if (cfg.choices.auth.includes('emailOTP')) keys.push('PUBLIC_TURNSTILE_SITE_KEY')
	return keys
}

function markdownList(values: string[]): string {
	return values.map((value) => `- \`${value}\``).join('\n')
}

function renderDeploymentGuidance(cfg: GvKitConfig): string {
	if (cfg.choices.deploy === 'skip') return ''
	if (cfg.choices.deploy === 'docker') {
		return `

## Docker deployment

Compose builds the named Dockerfile targets and waits for the one-shot migration container before
starting application services. Start the generated stack with \`docker compose up --build\`.
To build individual images from the repository root, select the same targets explicitly:

\`\`\`bash
docker build --target web-runtime --build-arg TURBO_FILTER=${cfg.choices.name}-web -t web .
${cfg.choices.backend === 'hono' ? `docker build --target auth-runtime --build-arg TURBO_FILTER=${honoPackageIdentity(cfg.choices.name, AUTH_SERVICE)} -t ${AUTH_SERVICE.identity} .\n` : ''}docker build --target migrate-runtime --build-arg TURBO_FILTER=@repo/db -t migrate .
\`\`\``
	}

	const secrets = cloudflareWorkflowSecretKeys(cfg)
	const variables = cloudflareWorkflowVariableKeys(cfg)
	const credentialScope =
		cfg.choices.db === 'sqlite'
			? 'The Cloudflare API token must cover generated Worker and D1 database operations.'
			: [
					'The Cloudflare API token must cover generated Worker operations.',
					'`NEON_API_KEY` authorizes PostgreSQL preview branch creation and cleanup.',
					'Production migrations connect with `DATABASE_URL`.'
				].join('\n')
	const previewDatabaseSecretGuidance =
		cfg.choices.backend === 'hono' && cfg.choices.db === 'postgres'
			? [
					" PostgreSQL previews inject the generated preview branch URL under each private Worker's",
					'`DATABASE_URL` key without copying the production `DATABASE_URL` secret.'
				].join('\n')
			: ''
	const previewSecretGuidance =
		cfg.choices.backend === 'hono' && (cfg.choices.auth.length > 0 || cfg.choices.db === 'postgres')
			? ` Trusted Hono preview jobs copy required private Worker application secrets through temporary
secret files and remove those files after publication.${previewDatabaseSecretGuidance}`
			: ''
	const previewSafety =
		cfg.choices.backend === 'hono'
			? `Preview builds run without provider credentials. Trusted jobs apply migrations and publish
passive bundles with pinned tools. Cleanup inventories only validated preview resources from the
trusted default branch and preserves production resources and shared wildcard DNS records.`
			: `Preview deployments use PR-scoped database resources and temporary Wrangler configurations.
Cleanup removes the preview Workers and database resources, then deletes the PR branch.`
	return `

## Cloudflare deployment

${cfg.choices.backend === 'hono' ? 'Configure the protected GitHub Actions environments below before enabling deployment. Do not store provider or application credentials in repository or shared organization secrets.' : 'Configure these GitHub Actions repository settings before enabling the generated deployment workflows.'}
${credentialScope}${
		cfg.choices.backend === 'hono'
			? ' It also needs Zone Read and DNS Read for managed preview ingress validation.'
			: ''
	}

${cfg.choices.backend === 'hono' ? `### Production environment secrets

Keep production values only in the existing \`production\` environment, separately protected against
branch/PR execution. Never copy them into preview settings. Restrict every credential-bearing
environment to trusted default-branch execution, including existing environments with other names.

${markdownList(secrets.filter((key) => ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID', 'DATABASE_URL'].includes(key)))}

### Preview environment secrets

Store exactly these preview-only names in \`cloudflare-preview\`, not repository or organization secrets:

${markdownList(secrets.filter((key) => key !== 'DATABASE_URL').map((key) => 'PREVIEW_' + key))}

The workflows map these names to the provider and application variables at execution time.
There is no legacy-name fallback. Preview connection strings come from the preview database job.

### Required external credential protection

An environment name alone is not a security boundary. Before installing any preview values:

1. Use an organization repository and a GitHub plan that supports environment secrets, selected
   deployment branches, and protected-branch push restrictions. Unsupported plans or personal
   repositories fail closed. This verifier supports classic branch protection, not rulesets alone.
2. Audit and trust the default-branch workflow history before activation. On the default branch,
   enforce protection for administrators, disable force pushes and deletion, and restrict pushes
   to an explicit list of built-in maintain/admin users. No teams or apps are supported. GitHub
   administrators retain control of these settings and are trusted operators. Do not allow writers
   to merge or push changes to trusted workflow code. Review it before merging.
3. Create an empty \`cloudflare-preview\` environment. Choose selected deployment branches and add
   exactly the literal default branch as a branch rule. Do not add tags, wildcards, PR refs, or
   select "protected branches only". No second approver is required; maintainers may self-authorize.
4. Remove all repository and shared organization secrets except \`PREVIEW_POLICY_TOKEN\`. Move
   production values to the separately protected \`production\` environment. Remove accessible
   copies from other environments, rotate formerly exposed credentials, and cancel old queued
   runs before activation. A source-code check cannot protect secrets left in an unsafe scope.
5. Create a repository-scoped fine-grained read-only token with Administration, Environments,
   Secrets, and Metadata read access. Store it as repository secret \`PREVIEW_POLICY_TOKEN\`.
   Do not use a classic PAT or grant write, provider, application, or secret-value access. Writers
   can read this token; it must expose metadata only. The ordinary workflow token cannot be
   assumed to have the administration/secret-metadata permissions needed for this audit.
6. From audited default-branch source, supply \`PREVIEW_POLICY_TOKEN\`, \`GITHUB_REPOSITORY\`,
   \`GITHUB_REPOSITORY_ID\`, and \`GITHUB_REF=refs/heads/<default-branch>\` in a private local
   environment. Run \`node scripts/verify-cloudflare-preview-policy.mjs --check-protection\`.
   This read-only check must pass before secret installation. Install the preview-only values
   through your approved secret tool, then run the same script with \`--verify\`.

Authorization and every privileged deployment recheck audit the live environment branch rules,
default-branch push permissions, and complete secret-name inventories through GitHub. Missing,
unsafe, revoked, incomplete, or unavailable checks deny work. The metadata token itself grants no
preview credentials. GitHub, not branch-owned workflow code, withholds environment secrets from
branch dispatches and same-repository PR jobs, even if a writer removes the authorization job or
adds an independent job. Only trusted default-branch jobs can request the environment.

Cleanup uses the same protected environment and prerequisite audit before alias validation. It
retains automatic closed-PR cleanup from trusted default-branch code and manual default-branch
cleanup. Cleanup does not require the PR to remain open or an earlier deployment actor to retain
permission. Inventory and namespace checks still constrain deletion.

Do not enable previews until the audit succeeds. Re-run it after any access or protection change.
Changing external protections or leaving accessible credential copies can invalidate this boundary;
workflow code cannot repair an administrator's unsafe secret installation.` : `### Secrets

${markdownList(secrets)}`}

### Variables

${variables.length > 0 ? markdownList(variables) : 'No repository variables are required.'}

The workflows do not copy production Worker secret values.
Install them separately with \`wrangler secret put <NAME>\`.${previewSecretGuidance} ${previewSafety}`
}

function renderPublicOrigins(cfg: GvKitConfig): string {
	if (cfg.choices.marketing !== 'astro') return ''
	const localAppPort = cfg.choices.deploy === 'docker' ? '3000' : '5173'
	return `

The split frontend uses complete build-time origins. Local development defaults to
\`PUBLIC_MARKETING_URL=http://localhost:4321\` and
\`PUBLIC_APP_URL=http://localhost:${localAppPort}\`. For production, replace them with real
origins such as \`https://example.com\` and \`https://app.example.com\`.
The marketing site only uses the application origin for navigation; it is not an
authentication trusted origin.`
}
function renderOwnedPublicPrefixes(services: readonly HonoServiceTopology[]): string {
	if (hasLegacyHonoPublicRouteTable(services)) return ''
	return `\n\nOwned public prefixes:\n\n${honoPublicRoutes(services)
		.map((route) => `- \`${route.prefix}/*\` -> \`${route.target}\``)
		.join('\n')}`
}

export function renderApiTopology(
	cfg: GvKitConfig,
	services: readonly HonoServiceTopology[] = HONO_SERVICES
): string {
	if (cfg.choices.backend !== 'hono') return ''

	const client =
		cfg.choices.apiClient === 'hey-api'
			? `The gateway also feeds one flat generated client in \`packages/openapi-client\`. Better Auth uses its own client and stays outside the composed document.`
			: `The composed document remains available for contract checks and integrations. This workspace does not generate an API client package, client scripts, imports, or exports.`
	const privacy =
		cfg.choices.deploy === 'cf-workers'
			? `- Cloudflare Workers: private services declare no routes, disable workers.dev and preview URLs, and receive calls only through Service Bindings. The web Worker binds only to \`GATEWAY\`.`
			: cfg.choices.deploy === 'docker'
				? `- Docker: ingress publishes the web alias and canonical API. Private services have no host ports; the gateway and SSR use Compose-network URLs.`
				: `- Local Node: the normal application path uses the gateway. Loopback service ports exist only for debugging, and SSR uses the private \`GATEWAY_URL\`.`
	const ssrTransport =
		cfg.choices.deploy === 'cf-workers'
			? 'the `GATEWAY` Service Binding'
			: 'the private `GATEWAY_URL`'
	const previewCleanup =
		cfg.choices.deploy === 'cf-workers'
			? `
\`scripts/cleanup-cloudflare-preview-workers.sh\` inventories account Workers so source additions,
removals, and renames do not hide stale previews. It validates each name against the project namespace
and preview alias before deletion. Database cleanup combines bounded provider inventory with exact
90-day deployment records, including records from the earlier \`<project>-db-<alias>\` convention. It validates
recorded names and provider IDs against the repository and preview alias before deletion. Preview
builds run without provider credentials; trusted jobs apply migrations and upload passive bundles.

Normal pull-request CI remains automatic and unprivileged. To publish a preview, a repository
maintainer must run \`deploy-staging.yml\` on the default branch with \`pr_number\` and the full
40-character \`head_sha\` they reviewed. This includes same-repository PRs. The actor must have the
built-in repository \`maintain\` or \`admin\` role; write and custom roles are denied. Self-approval is
allowed. Every credentialed phase checks the current PR head, repository identity, trusted workflow
revision, and actor permission through GitHub. Missing or unavailable checks fail closed.

Reruns are allowed only for the original actor, with the same actor ID, dispatch inputs, and pinned
workflow SHA. Both GitHub's original actor and triggering actor must match. Revoked permission or a
changed head blocks the rerun. New commits need a new dispatch; no check substitutes a newer head.
A head or permission change cannot undo operations already completed before that change.

Authorization permits the application code to read its configured preview credentials and database
data. Exact configuration validation does not make arbitrary application code trustworthy. Use only
operator-safe preview values, sandboxed integrations, and sanitized data. Never configure production
credentials for previews. A cloned Neon branch is not automatically sanitized. Preview connection
strings and auth secrets travel through private temporary secret files and runtime bindings, never
Wrangler variables or build artifacts. The files are removed after publication.

The \`authorize\` job emits a versioned \`revision\` JSON contract with repository and head repository
IDs/names, PR number, head SHA, trusted SHA/ref, actor ID/name, run ID, and canonical \`pr-<number>\`
alias. Downstream jobs compare this contract on each recheck; inventory records retain it for audit.
The trusted migration runner fetches SQL and metadata directly from that immutable head through
GitHub's Git objects API. It never reads migration files or scripts from the build workspace or falls
back to base migrations. Commit generated \`packages/db/migrations/*.sql\` files before dispatch;
Neon also requires the matching \`meta/_journal.json\`. Supported input is the flat numbered SQL
layout emitted by Drizzle Kit 0.31, with optional JSON snapshots. Empty inputs, malformed metadata,
symlinks, executable files, path escapes, truncated Git trees, and revision mismatches block publication.
The runner accepts at most 256 migration files, 1 MiB per file, and 8 MiB total.

Before invocation it verifies the repository/alias-scoped D1 name and ID against Cloudflare, or the
non-default Neon branch name, ID, project, and connection hostname against its read-write endpoints.
The preview Neon key needs read access to branch/endpoint metadata as well as provisioning access.
The runner creates its own configuration and isolated temporary tool installation. Wrangler 4.125.0
or Drizzle Kit 0.31.8 with Drizzle ORM 0.45.0 and postgres 3.4.7 runs before Worker publication.
Installation disables lifecycle scripts and receives no provider credentials. Migration failures block
publication; successful migrations are not rolled back if a later Worker publication fails. Use
expand/contract migrations compatible with adjacent deployed versions. Temporary inputs and tooling
are removed after the runner exits. No PR-owned package script or configuration runs with credentials.

Package \`deploy:staging\` commands are for trusted operators, not an alternative authorization
mechanism. Shared preview credentials still require the exact-SHA workflow above. Each command
requires \`STAGING_ALIAS=pr-<positive integer>\` and an explicit \`STAGING_WRANGLER_CONFIG\` path,
resolved from that package's directory. Use the JSON document emitted by
\`node scripts/prepare-cloudflare-preview.mjs\`, normally \`wrangler.staging.jsonc\`. There is no
production fallback and command-line overrides are rejected. Unset \`WRANGLER_CI_OVERRIDE_NAME\`
and \`CLOUDFLARE_ENV\`, and remove those keys from the package's \`.env\` and \`.env.local\` files.
Their presence is rejected even when empty or matching the preview. Wrangler receives an explicit
top-level environment and an empty temporary dotenv file, removed after the command exits.
Other dotenv values are not loaded. Supply provider authentication through the process environment,
not dotenv files. Only standard Cloudflare authentication/account variables, OS execution paths,
and \`CI\` are forwarded; legacy \`CF_*\` authentication names remain supported. Runtime secrets
still come only from the selected secret file. Node options, API endpoint overrides, unrelated
variables, and implicit Wrangler settings are not forwarded. Metrics and error reporting are disabled.

Keep the preparation inputs available when invoking the package command:
\`CLOUDFLARE_PREVIEW_ZONE_NAME\`, \`CLOUDFLARE_PREVIEW_WEB_DOMAIN\`, and
\`CLOUDFLARE_PREVIEW_API_DOMAIN\`. Packages with a D1 binding also require
\`GITHUB_REPOSITORY_ID\`, \`STAGING_D1_DATABASE_NAME=preview-<repository-id>-d1-<alias>\`, and
\`STAGING_D1_DATABASE_ID\`. These must be operator-verified preview resource values. This local
check compares configuration to the supplied ID; it does not query provider ownership. Auth-enabled
auth packages and Postgres users packages require an existing private \`STAGING_SECRETS_FILE\`.
Secret values and database contents remain the operator's responsibility.

\`scripts/deploy-cloudflare-staging.mjs\` checks the complete package configuration against its
embedded policy, with only the expected preview names, routes, bindings, and origins substituted.
Unknown fields, public development URLs, and production or other-preview targets are rejected.
If you intentionally change supported Worker configuration, review and update the embedded policy
as well as the package configuration before preparing a preview. Production commands are unchanged.

Deleting a preview Worker also removes its PR-scoped routes. Shared wildcard DNS records are
prerequisites and remain in place.
`
			: ''

	return `
## API topology

\`packages/backend/\` is the shared backend application/core layer for reusable data access,
use cases, types, helpers, and middleware. Independently deployable \`services/<service>/\`
packages are transport/runtime adapters and may import the application modules they need.

${
	cfg.choices.auth.length > 0
		? `Better Auth configuration and secrets stay private to \`services/auth/\`. \`packages/backend/\`
owns reusable data access and use cases, including the generated users data access that reads
\`authSchema.user\` for domain use cases. \`services/users/\` invokes that shared users use case as
a transport/runtime adapter; it does not gain access to Better Auth secrets or permission to
embed ad hoc database queries.`
		: `No authentication schema or users use case is generated without a selected provider.
Service adapters still keep reusable data access in \`packages/backend/\` instead of embedding
ad hoc database queries.`
}

\`apps/api/\` is the only public API application. It handles ingress, routing, operational
middleware, OpenAPI delivery, and transparent forwarding. It does not import application use
cases or orchestrate business workflows. Both ingress paths reach the same gateway contract:

- the web origin's \`/api/*\` alias for browser traffic
- the canonical API origin for integrations and independent clients

Better Auth stays at \`/api/auth/*\`. Domain routes are versioned under \`/api/v1/*\`.${renderOwnedPublicPrefixes(services)}
Gateway liveness and the composed contract are available at \`/api/healthz\` and
\`/api/openapi.json\`.

Browser calls stay same-origin. Server loads and actions use a request-scoped SSR transport:
${ssrTransport}.
Private services call one another directly instead of routing internal traffic back through the
gateway.

Each domain service owns a deterministic OpenAPI fragment. The gateway composes those fragments
into \`apps/api/openapi.json\`. ${client}

${privacy}
${previewCleanup}
Deploy in this order: database migration, private services, gateway, then web. Deployments are not
atomic, so adjacent versions must remain compatible during rollout.

`
}

function databaseLabel(cfg: GvKitConfig): string {
	if (cfg.choices.db === 'postgres') return cfg.choices.deploy === 'cf-workers' ? 'PostgreSQL (Neon)' : 'PostgreSQL'
	return cfg.choices.deploy === 'cf-workers' ? 'SQLite (Cloudflare D1)' : 'SQLite'
}

function renderCloudflareDatabaseSetup(cfg: GvKitConfig): string {
	if (cfg.choices.deploy !== 'cf-workers') return ''
	if (cfg.choices.db === 'postgres') {
		return `

Cloudflare Postgres uses Neon. ${cfg.choices.backend === 'hono' ? `Complete the required external credential protection audit below before installing
preview-only secrets in the protected \`cloudflare-preview\` environment:

- \`PREVIEW_NEON_API_KEY\`
- \`PREVIEW_CLOUDFLARE_API_TOKEN\`
- \`PREVIEW_CLOUDFLARE_ACCOUNT_ID\`

Set the nonsecret GitHub Actions variable \`NEON_PROJECT_ID\` to an operator-safe preview project.
Keep production \`DATABASE_URL\` only in the separately protected \`production\` environment.` : `Configure GitHub Actions before enabling staging deploys:

- Secret: \`NEON_API_KEY\`
- Variable: \`NEON_PROJECT_ID\`

Production deploys use \`DATABASE_URL\`.`} Preview deploys create Neon branches and ${
			cfg.choices.backend === 'hono'
				? 'deliver temporary connection strings through private secret files to runtime bindings, never Wrangler configuration.'
				: 'inject their\ntemporary connection strings into generated staging Wrangler configs.'
		}${
			cfg.choices.backend === 'hono'
				? ' Apply non-secret production values only to the capability-specific destinations listed\nin the Cloudflare production and preview settings section.'
				: ''
		}`
	}
	return `

Cloudflare SQLite uses D1. ${cfg.choices.backend === 'hono' ? `Complete the required external credential protection audit below before installing
\`PREVIEW_CLOUDFLARE_API_TOKEN\` and \`PREVIEW_CLOUDFLARE_ACCOUNT_ID\` in the protected
\`cloudflare-preview\` environment so staging can create preview D1 databases.
Keep production credentials only in the separately protected \`production\` environment.` : `Configure \`CLOUDFLARE_API_TOKEN\` and
\`CLOUDFLARE_ACCOUNT_ID\` in GitHub Actions so staging can create preview D1 databases.`}${
		cfg.choices.backend === 'hono'
			? ' Apply non-secret production values only to the capability-specific destinations listed\nin the Cloudflare production and preview settings section.'
			: ''
	}`
}

function renderCloudflareEnvExample(cfg: GvKitConfig): string {
	const webHost = cfg.choices.marketing === 'astro' ? 'app.<domain>' : '<domain>'
	const isHono = cfg.choices.backend === 'hono'
	return `${isHono ? '' : '# Production gateway\n'}API_PUBLIC_ORIGIN=https://api.<domain>
${
	isHono
		? `GATEWAY_PUBLIC_ORIGINS=https://${webHost},https://api.<domain>
API_CORS_ORIGINS=https://${webHost}
GATEWAY_UPSTREAM_TIMEOUT_MS=10000
`
		: ''
}
${isHono ? '' : '# Production web and host policy\n'}PUBLIC_APP_URL=https://${webHost}
BETTER_AUTH_ALLOWED_HOSTS=${webHost},api.<domain>
AUTH_CORS_ORIGINS=https://${webHost}
`
}

function renderEnvExample(cfg: GvKitConfig): string {
	const lines: string[] = []
	const isHono = cfg.choices.backend === 'hono'
	const isCf = cfg.choices.deploy === 'cf-workers'
	if (!isHono) lines.push('# Copy to .env and fill in. NEVER commit .env.')

	if (cfg.choices.marketing === 'astro') {
		lines.push('')
		lines.push('# Public build-time origins (complete URLs)')
		lines.push('PUBLIC_MARKETING_URL=http://localhost:4321')
		lines.push(
			`PUBLIC_APP_URL=http://localhost:${cfg.choices.deploy === 'docker' ? '3000' : '5173'}`
		)
	}

	if (cfg.choices.auth.length > 0) {
		lines.push('')
		if (!isHono) lines.push('# Auth (better-auth)')
		lines.push('BETTER_AUTH_SECRET=')
		if (isHono) {
			if (cfg.choices.deploy === 'docker') {
				lines.push(
					'BETTER_AUTH_ALLOWED_HOSTS=localhost:3000,api.localhost:3000,localhost:8786,127.0.0.1:8786'
				)
				lines.push('AUTH_CORS_ORIGINS=http://localhost:3000,http://api.localhost:3000')
			} else {
				lines.push('BETTER_AUTH_ALLOWED_HOSTS=localhost:5173,api.localhost:8786')
				lines.push('AUTH_CORS_ORIGINS=http://localhost:5173,http://api.localhost:8786')
			}
		} else {
			lines.push('BETTER_AUTH_URL=http://localhost:5173')
			lines.push('BETTER_AUTH_TRUSTED_ORIGINS=http://localhost:5173')
			lines.push(`PUBLIC_AUTH_URL=${developmentOrigin(AUTH_SERVICE)}`)
		}
	}

	if (cfg.choices.auth.includes('google')) {
		lines.push('')
		if (!isHono) lines.push('# Google OAuth')
		lines.push('GOOGLE_CLIENT_ID=')
		lines.push('GOOGLE_CLIENT_SECRET=')
	}

	if (cfg.choices.db === 'postgres') {
		lines.push('')
		if (!isHono) lines.push('# PostgreSQL')
		lines.push('DATABASE_URL=postgres://user:pass@localhost:5432/' + cfg.choices.name)
	} else if (cfg.choices.db === 'sqlite' && isHono && !isCf) {
		lines.push('')
		lines.push('# SQLite (one root-relative database shared by local services)')
		lines.push('SQLITE_PATH=file:./.data/local.db')
	}

	if (cfg.choices.email === 'resend') {
		lines.push('')
		if (!isHono) lines.push('# Resend')
		lines.push('RESEND_API_KEY=')
		lines.push('FROM_EMAIL=')
	} else if (cfg.choices.email === 'notifuse') {
		lines.push('')
		if (!isHono) lines.push('# Notifuse (self-hosted instance)')
		lines.push('NOTIFUSE_API_KEY=')
		lines.push('NOTIFUSE_WORKSPACE_ID=')
		lines.push('NOTIFUSE_BASE_URL=https://notifuse.example.com')
	}

	if (cfg.choices.auth.includes('emailOTP')) {
		lines.push('')
		lines.push('# Cloudflare Turnstile (auth service only; apps/web holds the public site key)')
		lines.push('TURNSTILE_SECRET_KEY=')
		lines.push('PUBLIC_TURNSTILE_SITE_KEY=1x00000000000000000000AA')
	}

	if (cfg.choices.monitoring.includes('umami')) {
		lines.push('')
		if (!isHono) lines.push('# Umami')
		lines.push('PUBLIC_UMAMI_WEBSITE_ID=')
		lines.push('PUBLIC_UMAMI_HOST=')
	}
	if (cfg.choices.monitoring.includes('posthog')) {
		lines.push('')
		if (!isHono) lines.push('# PostHog')
		lines.push('PUBLIC_POSTHOG_KEY=')
		lines.push('PUBLIC_POSTHOG_HOST=https://eu.i.posthog.com')
	}

	if (isHono) {
		const webAliasPort = cfg.choices.deploy === 'docker' ? 3000 : 5173
		lines.push('')
		lines.push(
			cfg.choices.deploy === 'docker'
				? 'API_PUBLIC_ORIGIN=http://api.localhost:3000'
				: 'API_PUBLIC_ORIGIN=http://api.localhost:8786'
		)
		lines.push(
			cfg.choices.deploy === 'docker'
				? 'GATEWAY_PUBLIC_ORIGINS=http://localhost:3000,http://api.localhost:3000,http://localhost:8786,http://127.0.0.1:8786'
				: `GATEWAY_PUBLIC_ORIGINS=http://localhost:${webAliasPort},http://api.localhost:8786`
		)
		if (!isCf) lines.push('GATEWAY_TRUSTED_INGRESS_SECRET=')
		lines.push(`API_CORS_ORIGINS=http://localhost:${webAliasPort}`)
		lines.push('GATEWAY_UPSTREAM_TIMEOUT_MS=10000')
		lines.push('')
		lines.push(
			`${HONO_GATEWAY.transport.node.targetEnvironmentVariable}=${nodeDevelopmentOrigin(HONO_GATEWAY)}`
		)
		lines.push(
			`${AUTH_SERVICE.transport.node.targetEnvironmentVariable}=${nodeDevelopmentOrigin(AUTH_SERVICE)}`
		)
		lines.push(
			`${USERS_SERVICE.transport.node.targetEnvironmentVariable}=${nodeDevelopmentOrigin(USERS_SERVICE)}`
		)
	}

	if (lines[0] === '') lines.shift()
	return lines.join('\n') + '\n'
}

const LICENSE_MIT = `MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`
