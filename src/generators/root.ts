import type { FileEntry } from '../lib/files.js'
import type { GvKitConfig } from '../schema/config.js'
import {
	AUTH_SERVICE,
	developmentOrigin,
	HONO_GATEWAY,
	honoPackageIdentity,
	nodeDevelopmentOrigin,
	USERS_SERVICE
} from './hono-topology.js'

/** Generator for the scaffolded project's root files (workspace + lint/format shims). */
export function generateRoot(cfg: GvKitConfig): FileEntry[] {
	const entries: FileEntry[] = [
		{ path: 'package.json', content: renderRootPackageJson(cfg) },
		{ path: 'pnpm-workspace.yaml', content: renderPnpmWorkspace(cfg) },
		{ path: 'turbo.json', content: renderTurboJson(cfg) },
		{ path: 'tsconfig.json', content: renderRootTsconfig(cfg) },
		{ path: '.gitignore', content: GITIGNORE },
		{ path: 'prettier.config.js', content: PRETTIER_CONFIG_SHIM },
		{ path: '.prettierignore', content: PRETTIERIGNORE },
		{ path: 'eslint.config.js', content: ESLINT_CONFIG_SHIM },
		{ path: 'README.md', content: renderReadme(cfg) },
		{ path: '.env.example', content: renderEnvExample(cfg) },
		{ path: 'LICENSE', content: LICENSE_MIT }
	]
	if (cfg.choices.backend === 'hono' && cfg.choices.deploy === 'cf-workers') {
		entries.push({ path: '.env.cloudflare.example', content: renderCloudflareEnvExample(cfg) })
	}
	return entries
}

function renderRootPackageJson(cfg: GvKitConfig): string {
	const scripts: Record<string, string> = {
		dev: 'turbo run dev',
		build: 'turbo run build',
		test: 'turbo run test',
		typecheck: 'turbo run typecheck',
		lint: 'turbo run lint',
		format: 'prettier --write "**/*.{ts,tsx,svelte,astro,json,md}"',
		prepare: 'husky'
	}
	if (cfg.choices.backend === 'hono') {
		const gatewayPackage = honoPackageIdentity(cfg.choices.name, HONO_GATEWAY)
		scripts['openapi:compose'] = `pnpm --filter ${gatewayPackage} openapi:compose`
		scripts['openapi:check'] = `pnpm --filter ${gatewayPackage} openapi:check`
	}
	if (cfg.choices.apiClient === 'hey-api') {
		scripts.codegen = 'pnpm openapi:check && pnpm --filter @repo/openapi-client codegen'
	}

	const postinstall: string[] = []
	if (cfg.choices.i18n === 'paraglide') {
		postinstall.push(
			'test ! -f packages/i18n/project.inlang/settings.json || pnpm --filter @repo/i18n build'
		)
	}
	if (cfg.choices.apiClient === 'hey-api') {
		postinstall.push('test ! -f packages/openapi-client/openapi-ts.config.ts || pnpm codegen')
	}
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
		overrides: {
			zod: '^4.3.0'
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
	return `packages:
${deployables}
  - 'packages/*'
  - 'packages/tooling/*'

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
	if (cfg.choices.marketing === 'astro') {
		publicBuildEnv.push('PUBLIC_MARKETING_URL', 'PUBLIC_APP_URL')
		if (cfg.choices.monitoring.includes('umami')) {
			publicBuildEnv.push('PUBLIC_UMAMI_HOST', 'PUBLIC_UMAMI_WEBSITE_ID')
		}
		if (cfg.choices.monitoring.includes('posthog')) {
			publicBuildEnv.push('PUBLIC_POSTHOG_KEY', 'PUBLIC_POSTHOG_HOST')
		}
	}
	if (cfg.choices.auth.length > 0 && cfg.choices.backend === 'inside-frontend') {
		publicBuildEnv.push('PUBLIC_AUTH_URL')
	}
	if (cfg.choices.auth.includes('emailOTP')) publicBuildEnv.push('PUBLIC_TURNSTILE_SITE_KEY')
	const tasks: Record<string, unknown> = {
		build: {
			dependsOn: ['^build'],
			outputs: ['dist/**', 'build/**', '.svelte-kit/**', '.wrangler/**', 'src/paraglide/**'],
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
			dependsOn: ['^build'],
			cache: false,
			persistent: true,
			...(cfg.choices.backend === 'hono' ? { env: ['API_PUBLIC_ORIGIN'] } : {})
		}
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

const GITIGNORE = `node_modules/
.pnpm-store/
dist/
.turbo/
.svelte-kit/
.wrangler/
.DS_Store
.env
.env.local
.env.*.local
**/.dev.vars
*.local
*.tsbuildinfo
`

const PRETTIER_CONFIG_SHIM = `export { default } from '@repo/tooling-prettier'
`

const PRETTIERIGNORE = `node_modules/
dist/
.svelte-kit/
.wrangler/
.turbo/
pnpm-lock.yaml
**/openapi-client/src/*/
`

const ESLINT_CONFIG_SHIM = `export { default } from '@repo/tooling-eslint'
`

function renderReadme(cfg: GvKitConfig): string {
	const { name } = cfg.choices
	const stackLines: string[] = []
	if (cfg.choices.marketing === 'astro') stackLines.push('- Marketing: Astro')
	stackLines.push(`- Application: SvelteKit`)
	if (cfg.choices.backend === 'hono') {
		stackLines.push('- Backend: Hono gateway with private services')
	} else {
		stackLines.push('- Backend: SvelteKit endpoints (no separate API)')
	}
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

	return `# ${name}

Type-safe full-stack monorepo with sensible defaults — install, run, ship.

## Quickstart

\`\`\`bash
pnpm install
pnpm dev
\`\`\`

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

Copy \`.env.example\` to \`.env\` and fill in any secrets your services need.
For workers, secrets go through \`wrangler secret put <NAME>\` rather than \`.env\`.
${renderPublicOrigins(cfg)}
${renderCloudflareDatabaseSetup(cfg)}

## Stack

${stackLines.join('\n')}

## Layout

- \`apps/web/\` — SvelteKit application
${cfg.choices.marketing === 'astro' ? '- `apps/marketing/` — static Astro marketing site and public SEO endpoints\n' : ''}${cfg.choices.backend === 'hono' ? '- `apps/api/` — Hono API gateway\n- `services/<service>/` — private Hono services\n' : ''}- \`packages/db/\` — Drizzle schema + client factory
- \`packages/backend/\` — shared backend helpers (logger, error helpers, middleware)
${cfg.choices.i18n === 'paraglide' ? '- `packages/i18n/` — Paraglide messages and runtime\n' : ''}${cfg.choices.apiClient === 'hey-api' ? '- `packages/openapi-client/` — one flat client generated from the gateway contract\n' : ''}${
		cfg.choices.aiTooling.length > 0
			? `\nSee \`.ai/rules/\` for architecture rules, in particular the service\nboundary policy.\n`
			: ''
	}${renderApiTopology(cfg)}
## Workspace

\`pnpm-workspace.yaml\` lists the packages. \`pnpm install\` uses strict mode by default, so each package only sees the dependencies declared in its own \`package.json\` — there is no hoisted root \`node_modules\` to lean on.

Every runtime and type-only import must be declared explicitly in the importing package's \`package.json\` (including ambient types from \`@repo/tooling-typescript\` such as \`@types/node\` or \`@cloudflare/workers-types\`). ESLint's \`import/no-extraneous-dependencies\` rule catches anything that slips through (\`pnpm lint\`).
`
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
function renderApiTopology(cfg: GvKitConfig): string {
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

	return `
## API topology

\`apps/api/\` is the only public API application. Both ingress paths reach the same gateway contract:

- the web origin's \`/api/*\` alias for browser traffic
- the canonical API origin for integrations and independent clients

Better Auth stays at \`/api/auth/*\`. Domain routes are versioned under \`/api/v1/*\`.
Gateway liveness and the composed contract are available at \`/api/healthz\` and
\`/api/openapi.json\`.

Browser calls stay same-origin. Server loads and actions use a request-scoped SSR transport:
the \`GATEWAY\` Service Binding on Cloudflare or private \`GATEWAY_URL\` on Node and Docker.
Private services call one another directly instead of routing internal traffic back through the
gateway.

Each domain service owns a deterministic OpenAPI fragment. The gateway composes those fragments
into \`apps/api/openapi.json\`. ${client}

${privacy}

Deploy in this order: database migration, private services, gateway, then web. Deployments are not
atomic, so adjacent versions must remain compatible during rollout.

`
}

function databaseLabel(cfg: GvKitConfig): string {
	if (cfg.choices.db === 'postgres') {
		return cfg.choices.deploy === 'cf-workers' ? 'PostgreSQL (Neon)' : 'PostgreSQL'
	}
	return cfg.choices.deploy === 'cf-workers' ? 'SQLite (Cloudflare D1)' : 'SQLite'
}

function renderCloudflareDatabaseSetup(cfg: GvKitConfig): string {
	if (cfg.choices.deploy !== 'cf-workers') return ''
	if (cfg.choices.db === 'postgres') {
		return `

Cloudflare Postgres uses Neon. Configure GitHub Actions before enabling staging deploys:

- Secret: \`NEON_API_KEY\`
- Variable: \`NEON_PROJECT_ID\`

Production deploys use \`DATABASE_URL\`. Preview deploys create Neon branches and inject their
temporary connection strings into generated staging Wrangler configs. Copy the non-secret
production origins and auth allowlists from \`.env.cloudflare.example\` into the corresponding
Wrangler configurations before deployment.`
	}
	return `

Cloudflare SQLite uses D1. Configure \`CLOUDFLARE_API_TOKEN\` and
\`CLOUDFLARE_ACCOUNT_ID\` in GitHub Actions so staging can create preview D1 databases. Copy the
non-secret production origins and auth allowlists from \`.env.cloudflare.example\` into the
corresponding Wrangler configurations before deployment.`
}

function renderCloudflareEnvExample(cfg: GvKitConfig): string {
	const webHost = cfg.choices.marketing === 'astro' ? 'app.<domain>' : '<domain>'
	return `# Cloudflare production settings. Replace <domain> before deployment.
# Canonical API origin advertised by /api/openapi.json.
API_PUBLIC_ORIGIN=https://api.<domain>
# Web application origin. Browser API calls use ${webHost}/api/* as the same-origin alias.
PUBLIC_APP_URL=https://${webHost}
# Private services have no public URLs. Cloudflare callers use Service Bindings.
# Allowed request hosts omit the scheme; CORS entries are complete origins.
BETTER_AUTH_ALLOWED_HOSTS=${webHost},api.<domain>
AUTH_CORS_ORIGINS=https://${webHost}
`
}

function renderEnvExample(cfg: GvKitConfig): string {
	const lines: string[] = []
	lines.push('# Copy to .env and fill in. NEVER commit .env.')

	const isHono = cfg.choices.backend === 'hono'
	const isCf = cfg.choices.deploy === 'cf-workers'

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
		lines.push('# Auth (better-auth)')
		lines.push('BETTER_AUTH_SECRET=')
		if (isHono) {
			const productionWebHost = cfg.choices.marketing === 'astro' ? 'app.<domain>' : '<domain>'
			lines.push(
				`BETTER_AUTH_ALLOWED_HOSTS=localhost:3000,localhost:5173,localhost:8786,127.0.0.1:8786,${productionWebHost},api.<domain>,<preview-web-host>,<preview-api-host>`
			)
			lines.push(
				`AUTH_CORS_ORIGINS=http://localhost:3000,http://localhost:5173,https://${productionWebHost},https://<preview-web-host>`
			)
		} else {
			lines.push('BETTER_AUTH_URL=http://localhost:5173')
			lines.push('BETTER_AUTH_TRUSTED_ORIGINS=http://localhost:5173')
			lines.push(`PUBLIC_AUTH_URL=${developmentOrigin(AUTH_SERVICE)}`)
		}
	}

	if (cfg.choices.auth.includes('google')) {
		lines.push('')
		lines.push('# Google OAuth')
		lines.push('GOOGLE_CLIENT_ID=')
		lines.push('GOOGLE_CLIENT_SECRET=')
	}

	if (cfg.choices.db === 'postgres') {
		lines.push('')
		lines.push('# PostgreSQL')
		lines.push('DATABASE_URL=postgres://user:pass@localhost:5432/' + cfg.choices.name)
	} else if (cfg.choices.db === 'sqlite' && isHono && !isCf) {
		lines.push('')
		lines.push('# SQLite (services use libsql — defaults to file:./local.db each)')
		lines.push('# SQLITE_PATH=file:./local.db')
	}

	if (cfg.choices.email === 'resend') {
		lines.push('')
		lines.push('# Resend')
		lines.push('RESEND_API_KEY=')
		lines.push('FROM_EMAIL=')
	} else if (cfg.choices.email === 'notifuse') {
		lines.push('')
		lines.push('# Notifuse (self-hosted instance)')
		lines.push('NOTIFUSE_API_KEY=')
		lines.push('NOTIFUSE_WORKSPACE_ID=')
		lines.push('NOTIFUSE_BASE_URL=https://notifuse.example.com')
	}

	if (cfg.choices.auth.includes('emailOTP')) {
		lines.push('')
		lines.push('# Cloudflare Turnstile (auth Worker only — apps/web holds the public site key)')
		lines.push('TURNSTILE_SECRET_KEY=')
		lines.push('PUBLIC_TURNSTILE_SITE_KEY=1x00000000000000000000AA')
	}

	if (cfg.choices.monitoring.includes('umami')) {
		lines.push('')
		lines.push('# Umami')
		lines.push('PUBLIC_UMAMI_WEBSITE_ID=')
		lines.push('PUBLIC_UMAMI_HOST=')
	}
	if (cfg.choices.monitoring.includes('posthog')) {
		lines.push('')
		lines.push('# PostHog')
		lines.push('PUBLIC_POSTHOG_KEY=')
		lines.push('PUBLIC_POSTHOG_HOST=https://eu.i.posthog.com')
	}

	if (isHono) {
		const webAliasPort = cfg.choices.deploy === 'docker' ? 3000 : 5173
		lines.push('')
		lines.push('# Public gateway ingress')
		lines.push('# Canonical API origin advertised by the gateway OpenAPI endpoint')
		lines.push('API_PUBLIC_ORIGIN=http://localhost:8786')
		lines.push(`# Browser API alias: http://localhost:${webAliasPort}/api/*`)
		lines.push('')
		lines.push('# Private gateway and service targets')
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
