import type { FileEntry } from '../lib/files.js'
import type { GvKitConfig } from '../schema/config.js'

/** Generator for the scaffolded project's root files (workspace + lint/format shims). */
export function generateRoot(cfg: GvKitConfig): FileEntry[] {
	return [
		{ path: 'package.json', content: renderRootPackageJson(cfg) },
		{ path: 'pnpm-workspace.yaml', content: PNPM_WORKSPACE_YAML },
		{ path: 'turbo.json', content: renderTurboJson(cfg) },
		{ path: 'tsconfig.json', content: TSCONFIG_ROOT },
		{ path: '.gitignore', content: GITIGNORE },
		{ path: 'prettier.config.js', content: PRETTIER_CONFIG_SHIM },
		{ path: '.prettierignore', content: PRETTIERIGNORE },
		{ path: 'eslint.config.js', content: ESLINT_CONFIG_SHIM },
		{ path: 'README.md', content: renderReadme(cfg) },
		{ path: '.env.example', content: renderEnvExample(cfg) },
		{ path: 'LICENSE', content: LICENSE_MIT }
	]
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
	const postinstall: string[] = []
	if (cfg.choices.i18n === 'paraglide') {
		postinstall.push(
			'test ! -f packages/i18n/project.inlang/settings.json || pnpm --filter @repo/i18n build'
		)
	}
	if (cfg.choices.apiClient === 'hey-api') {
		postinstall.push(
			'test ! -f packages/openapi-client/openapi-ts.config.ts || pnpm --filter @repo/openapi-client codegen'
		)
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

const PNPM_WORKSPACE_YAML = `packages:
  - 'apps/*'
  - 'apps/api/*'
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
	if (cfg.choices.auth.length > 0) publicBuildEnv.push('PUBLIC_AUTH_URL')
	if (cfg.choices.auth.includes('emailOTP')) publicBuildEnv.push('PUBLIC_TURNSTILE_SITE_KEY')
	const tasks: Record<string, unknown> = {
		build: {
			dependsOn: ['^build'],
			outputs: ['dist/**', '.svelte-kit/**', '.wrangler/**', 'src/paraglide/**'],
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
			cache: false,
			persistent: true
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

const TSCONFIG_ROOT = `{
	"extends": "@repo/tooling-typescript/base.json",
	"compilerOptions": {
		"noEmit": true
	},
	"include": ["apps/**/*", "apps/api/**/*", "packages/**/*"],
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

const GITIGNORE = `node_modules/
.pnpm-store/
dist/
.turbo/
.svelte-kit/
.wrangler/
**/worker-configuration.d.ts
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
		stackLines.push('- Backend: Hono workers (containerised under `apps/api/`)')
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
${cfg.choices.marketing === 'astro' ? '- `apps/marketing/` — static Astro marketing site and public SEO endpoints\n' : ''}${cfg.choices.backend === 'hono' ? '- `apps/api/<service>/` — independently deployable Hono workers\n' : ''}- \`packages/db/\` — Drizzle schema + client factory
- \`packages/backend/\` — shared backend helpers (logger, error helpers, middleware)
${cfg.choices.i18n === 'paraglide' ? '- `packages/i18n/` — Paraglide messages and runtime\n' : ''}${cfg.choices.apiClient === 'hey-api' ? '- `packages/openapi-client/` — generated TypeScript clients per service\n' : ''}${
		cfg.choices.aiTooling.length > 0
			? `\nSee \`.ai/rules/\` for architecture rules, in particular the service\nboundary policy.\n`
			: ''
	}
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
temporary connection strings into generated staging Wrangler configs.`
	}
	return `

Cloudflare SQLite uses D1. Configure \`CLOUDFLARE_API_TOKEN\` and
\`CLOUDFLARE_ACCOUNT_ID\` in GitHub Actions so staging can create preview D1 databases.`
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
		lines.push(
			`BETTER_AUTH_URL=${isHono && !isCf ? 'http://localhost:8787' : 'http://localhost:5173'}`
		)
		lines.push('BETTER_AUTH_TRUSTED_ORIGINS=http://localhost:5173')
		lines.push(
			`PUBLIC_AUTH_URL=${isHono && isCf ? 'http://localhost:5173' : 'http://localhost:8787'}`
		)
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
		lines.push('')
		if (isCf) {
			lines.push('# Local dev only — used by users-worker when AUTH service binding is unset')
			lines.push('AUTH_URL=http://localhost:8787')
		} else {
			lines.push('# Service URLs (apps/api/{auth,users} run as standalone Node/Bun servers)')
			lines.push('AUTH_URL=http://localhost:8787')
			lines.push('PUBLIC_API_URL=http://localhost:8788')
		}
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
