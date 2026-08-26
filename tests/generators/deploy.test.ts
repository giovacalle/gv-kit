import { describe, expect, test } from 'bun:test'
import { generateDeploy } from '../../src/generators/deploy.js'
import { runGenerators } from '../../src/generators/index.js'
import type { FileEntry } from '../../src/lib/files.js'
import type { Choices, GvKitConfig } from '../../src/schema/config.js'

const baseChoices: Choices = {
	name: 'demo',
	frontend: 'sveltekit',
	marketing: 'inside-web',
	backend: 'hono',
	i18n: 'skip',
	monitoring: [],
	db: 'postgres',
	apiClient: 'hey-api',
	auth: ['emailOTP'],
	email: 'resend',
	aiTooling: [],
	deploy: 'docker'
}

function makeCfg(overrides: Partial<Choices>): GvKitConfig {
	return {
		configVersion: 2,
		choices: { ...baseChoices, ...overrides }
	}
}

function findEntry(entries: FileEntry[], path: string): FileEntry | undefined {
	return entries.find((e) => e.path === path)
}

function compose(cfg: GvKitConfig): string {
	const entries = generateDeploy(cfg)
	return findEntry(entries, 'docker-compose.yml')!.content
}

describe('generateDeploy — gating', () => {
	test('deploy=skip returns empty array', () => {
		const entries = generateDeploy(makeCfg({ deploy: 'skip', auth: [], email: 'skip' }))
		expect(entries).toEqual([])
	})

	test('deploy=cf-workers emits 3 deploy workflows, no docker artifacts', () => {
		const entries = generateDeploy(makeCfg({ deploy: 'cf-workers' }))
		expect(findEntry(entries, '.github/workflows/deploy-production.yml')).toBeDefined()
		expect(findEntry(entries, '.github/workflows/deploy-staging.yml')).toBeDefined()
		expect(findEntry(entries, '.github/workflows/cleanup-staging.yml')).toBeDefined()
		expect(findEntry(entries, 'Dockerfile')).toBeUndefined()
		expect(findEntry(entries, 'docker-compose.yml')).toBeUndefined()
		expect(findEntry(entries, '.dockerignore')).toBeUndefined()
	})

	test('deploy=docker emits Dockerfile, Compose, dockerignore, and Hono ingress config', () => {
		const entries = generateDeploy(makeCfg({ deploy: 'docker' }))
		const paths = entries.map((e) => e.path).sort()
		expect(paths).toEqual([
			'.dockerignore',
			'Dockerfile',
			'docker-compose.yml',
			'docker/ingress.conf.template'
		])
	})
})

describe('generateDeploy — single-Dockerfile architecture', () => {
	test('no per-app Dockerfiles are emitted in any backend mode', () => {
		for (const backend of ['hono', 'inside-frontend'] as const) {
			const cfg = makeCfg(
				backend === 'inside-frontend'
					? { backend, apiClient: 'skip', auth: [], email: 'skip' }
					: { backend }
			)
			const entries = generateDeploy(cfg)
			expect(findEntry(entries, 'apps/web/Dockerfile')).toBeUndefined()
			expect(findEntry(entries, 'services/auth/Dockerfile')).toBeUndefined()
			expect(findEntry(entries, 'services/users/Dockerfile')).toBeUndefined()
		}
	})

	test('Dockerfile defines dedicated Hono application runtime targets', () => {
		const entries = generateDeploy(makeCfg({}))
		const dockerfile = findEntry(entries, 'Dockerfile')!.content
		for (const target of [
			'gateway-runtime',
			'web-runtime',
			'auth-runtime',
			'users-runtime',
			'migrate-runtime'
		]) {
			expect(dockerfile).toContain(`AS ${target}`)
		}
	})

	test('Dockerfile uses Node + pnpm via corepack (no Bun base image)', () => {
		const entries = generateDeploy(makeCfg({}))
		const dockerfile = findEntry(entries, 'Dockerfile')!.content
		expect(dockerfile).toContain('node:')
		expect(dockerfile).not.toContain('oven/bun:')
		expect(dockerfile).toContain('corepack')
	})
})

describe('generateDeploy — postgres compose', () => {
	test('emits postgres service with all credentials required (no :- defaults)', () => {
		const yaml = compose(makeCfg({ db: 'postgres' }))
		expect(yaml).toContain('  postgres:')
		expect(yaml).toContain('${POSTGRES_USER:?')
		expect(yaml).toContain('${POSTGRES_PASSWORD:?')
		expect(yaml).toContain('${POSTGRES_DB:?')
	})

	test('postgres port is bound to 127.0.0.1 (not exposed on LAN)', () => {
		const yaml = compose(makeCfg({ db: 'postgres' }))
		expect(yaml).toContain('"127.0.0.1:5432:5432"')
		expect(yaml).not.toMatch(/^\s+- "5432:5432"/m)
	})

	test('DATABASE_URL is required, has no default fallback', () => {
		const yaml = compose(makeCfg({ db: 'postgres' }))
		expect(yaml).toContain('${DATABASE_URL:?')
		expect(yaml).not.toContain('${DATABASE_URL:-')
	})

	test('postgres has a healthcheck', () => {
		const yaml = compose(makeCfg({ db: 'postgres' }))
		expect(yaml).toMatch(/postgres:[\s\S]*?healthcheck:[\s\S]*?pg_isready/)
	})
})

describe('generateDeploy — sqlite compose', () => {
	test('no postgres service when db=sqlite', () => {
		const yaml = compose(makeCfg({ db: 'sqlite' }))
		expect(yaml).not.toMatch(/^\s*postgres:/m)
		expect(yaml).not.toContain('postgres:16-alpine')
	})

	test('SQLITE_PATH uses libsql file: URL prefix', () => {
		const yaml = compose(makeCfg({ db: 'sqlite' }))
		expect(yaml).toContain('SQLITE_PATH: file:/data/local.db')
	})

	test('sqlite_data named volume is declared', () => {
		const yaml = compose(makeCfg({ db: 'sqlite' }))
		expect(yaml).toMatch(/^volumes:\s*\n\s+sqlite_data:/m)
	})

	test('no DATABASE_URL anywhere in sqlite mode', () => {
		const yaml = compose(makeCfg({ db: 'sqlite' }))
		expect(yaml).not.toContain('DATABASE_URL')
	})
})

describe('generateDeploy — auth env injection', () => {
	test('auth=[] → no BETTER_AUTH_SECRET, no email keys, no google keys', () => {
		const yaml = compose(makeCfg({ auth: [], email: 'skip' }))
		expect(yaml).not.toContain('BETTER_AUTH_SECRET')
		expect(yaml).not.toContain('GOOGLE_CLIENT_ID')
		expect(yaml).not.toContain('RESEND_API_KEY')
		expect(yaml).not.toContain('NOTIFUSE_API_KEY')
	})

	test('auth includes emailOTP → BETTER_AUTH_SECRET is required', () => {
		const yaml = compose(makeCfg({ auth: ['emailOTP'], email: 'resend' }))
		expect(yaml).toContain('${BETTER_AUTH_SECRET:?')
		expect(yaml).not.toContain('${BETTER_AUTH_SECRET:-')
	})

	test('auth includes google → GOOGLE_CLIENT_ID/SECRET are required', () => {
		const yaml = compose(makeCfg({ auth: ['google'], email: 'skip' }))
		expect(yaml).toContain('${GOOGLE_CLIENT_ID:?')
		expect(yaml).toContain('${GOOGLE_CLIENT_SECRET:?')
	})

	test('auth=[google] → no email keys', () => {
		const yaml = compose(makeCfg({ auth: ['google'], email: 'skip' }))
		expect(yaml).not.toContain('RESEND_API_KEY')
		expect(yaml).not.toContain('NOTIFUSE_API_KEY')
	})

	test('emailOTP + resend → optional local delivery and required CAPTCHA configuration', () => {
		const yaml = compose(makeCfg({ auth: ['emailOTP'], email: 'resend' }))
		expect(yaml).toContain('RESEND_API_KEY: ${RESEND_API_KEY:-}')
		expect(yaml).toContain('FROM_EMAIL: ${FROM_EMAIL:-}')
		expect(yaml).toContain('${TURNSTILE_SECRET_KEY:?')
		expect(yaml).not.toContain('NOTIFUSE_API_KEY')
	})

	test('emailOTP + notifuse → NOTIFUSE_API_KEY only', () => {
		const yaml = compose(makeCfg({ auth: ['emailOTP'], email: 'notifuse' }))
		expect(yaml).toContain('${NOTIFUSE_API_KEY:?')
		expect(yaml).not.toContain('RESEND_API_KEY')
	})
})

describe('generateDeploy — backend topology', () => {
	test('backend=hono → ingress + gateway + auth + users + web services', () => {
		const yaml = compose(makeCfg({ backend: 'hono' }))
		for (const name of ['ingress', 'gateway', 'auth', 'users', 'web']) {
			expect(yaml).toMatch(new RegExp(`^\\s+${name}:`, 'm'))
		}
	})

	test('backend=inside-frontend → no auth/users service blocks', () => {
		const yaml = compose(
			makeCfg({ backend: 'inside-frontend', apiClient: 'skip', auth: [], email: 'skip' })
		)
		expect(yaml).not.toMatch(/^\s+auth:/m)
		expect(yaml).not.toMatch(/^\s+users:/m)
		expect(yaml).toMatch(/^\s+web:/m)
	})

	test('inside-frontend + postgres → web has DATABASE_URL and depends_on postgres', () => {
		const yaml = compose(
			makeCfg({
				backend: 'inside-frontend',
				apiClient: 'skip',
				db: 'postgres',
				auth: [],
				email: 'skip'
			})
		)
		const webBlock = yaml.split(/^ {2}web:/m)[1]!
		expect(webBlock).toContain('DATABASE_URL')
		expect(webBlock).toMatch(/depends_on:[\s\S]*postgres:[\s\S]*condition: service_healthy/)
	})

	test('inside-frontend + sqlite → web has SQLITE_PATH and sqlite_data volume', () => {
		const yaml = compose(
			makeCfg({
				backend: 'inside-frontend',
				apiClient: 'skip',
				db: 'sqlite',
				auth: [],
				email: 'skip'
			})
		)
		const webBlock = yaml.split(/^ {2}web:/m)[1]!
		expect(webBlock).toContain('SQLITE_PATH: file:/data/local.db')
		expect(webBlock).toContain('sqlite_data:/data')
	})
})

describe('generateDeploy — orchestration', () => {
	test('every application service has a healthcheck', () => {
		const yaml = compose(makeCfg({ backend: 'hono', auth: ['emailOTP'], email: 'resend' }))
		for (const name of ['auth', 'users', 'gateway', 'web', 'ingress']) {
			const start = new RegExp(`^  ${name}:$`, 'm').exec(yaml)
			expect(start).not.toBeNull()
			const tail = yaml.slice(start!.index + start![0].length)
			const block = tail.split(/^ {2}[a-z][a-z0-9_-]*:$/m)[0]
			expect(block).toContain('healthcheck:')
			expect(block).toContain('/healthz')
		}
	})

	test('every service depends on migrate via service_completed_successfully', () => {
		const yaml = compose(makeCfg({ backend: 'hono', auth: ['emailOTP'], email: 'resend' }))
		const matches = yaml.match(/migrate:\s*\n\s+condition: service_completed_successfully/g)
		expect(matches?.length ?? 0).toBeGreaterThanOrEqual(2)
	})

	test('no plain depends_on arrays (every dependency declares a condition)', () => {
		const yaml = compose(makeCfg({}))
		expect(yaml).not.toMatch(/depends_on:\s*\n\s+- /)
	})
})

describe('generateDeploy — Dockerfile correctness', () => {
	test('Node service builds use the supported tsup output-directory flag', () => {
		const entries = runGenerators(
			makeCfg({ marketing: 'astro', db: 'sqlite', auth: [], email: 'skip' })
		)
		for (const path of ['services/auth/package.json', 'services/users/package.json']) {
			const pkg = JSON.parse(findEntry(entries, path)!.content) as {
				scripts: { build: string }
			}
			expect(pkg.scripts.build).toContain('--target=node24 --out-dir dist')
			expect(pkg.scripts.build).not.toContain('--outdir')
		}
	})

	test('uses BuildKit cache mount for pnpm store', () => {
		const entries = generateDeploy(makeCfg({}))
		const dockerfile = findEntry(entries, 'Dockerfile')!.content
		expect(dockerfile).toContain('--mount=type=cache')
		expect(dockerfile).toContain('/root/.local/share/pnpm/store')
	})

	test('runtime stages run as non-root user', () => {
		const entries = generateDeploy(makeCfg({}))
		const dockerfile = findEntry(entries, 'Dockerfile')!.content
		expect(dockerfile).toMatch(/AS web-runtime[\s\S]*?USER app/)
		for (const target of ['gateway', 'auth', 'users']) {
			expect(dockerfile).toMatch(new RegExp(`AS ${target}-runtime[\\s\\S]*?(?:USER app|FROM)`))
		}
	})

	test('every runtime stage uses tini as PID 1', () => {
		const entries = generateDeploy(makeCfg({}))
		const dockerfile = findEntry(entries, 'Dockerfile')!.content
		const tiniLines = dockerfile.match(/ENTRYPOINT \["\/sbin\/tini", "--"\]/g)
		expect(tiniLines?.length ?? 0).toBe(3)
	})
})

describe('generateDeploy — .dockerignore', () => {
	test('uses allowlist style with explicit excludes for build artifacts', () => {
		const entries = generateDeploy(makeCfg({}))
		const ignore = findEntry(entries, '.dockerignore')!.content
		expect(ignore.startsWith('*\n')).toBe(true)
		expect(ignore).toContain('!apps/')
		expect(ignore).toContain('!services/')
		expect(ignore).toContain('!packages/')
		expect(ignore).toContain('**/node_modules')
		expect(ignore).toContain('**/.turbo')
		expect(ignore).toContain('**/.svelte-kit')
	})
})

describe('generateDeploy — Astro marketing runtime', () => {
	test('inside-web preserves the previous Docker runtime and service set', () => {
		const entries = generateDeploy(makeCfg({ marketing: 'inside-web' }))
		const dockerfile = findEntry(entries, 'Dockerfile')!.content
		const yaml = findEntry(entries, 'docker-compose.yml')!.content
		expect(dockerfile).not.toContain('AS marketing-runtime')
		expect(yaml).not.toMatch(/^ {2}marketing:/m)
	})

	test('Astro shape adds the pinned unprivileged static runtime', () => {
		const entries = generateDeploy(makeCfg({ marketing: 'astro' }))
		const dockerfile = findEntry(entries, 'Dockerfile')!.content
		expect(dockerfile).toContain('AS marketing-runtime')
		expect(dockerfile).toContain('nginxinc/nginx-unprivileged:1.28.0-alpine@sha256:')
		expect(dockerfile).toContain('/repo/apps/marketing/dist')
		expect(dockerfile).toContain('EXPOSE 8080')
		expect(dockerfile).toContain('127.0.0.1:8080/healthz')
	})

	test('Astro Compose service is isolated, hardened, and maps local port 4321', () => {
		const yaml = compose(makeCfg({ marketing: 'astro' }))
		const marketing = yaml.split(/^ {2}marketing:/m)[1]!.split(/^ {2}[a-z][a-z0-9_-]*:$/m)[0]!
		expect(marketing).toContain('target: marketing-runtime')
		expect(marketing).toContain('"4321:8080"')
		expect(marketing).toContain('read_only: true')
		expect(marketing).toContain('no-new-privileges:true')
		expect(marketing).toContain('/tmp')
		expect(marketing).toContain('/healthz')
	})

	test('Astro Docker builds receive the app origin and selected monitoring values', () => {
		const entries = generateDeploy(
			makeCfg({ marketing: 'astro', monitoring: ['umami', 'posthog'] })
		)
		const dockerfile = findEntry(entries, 'Dockerfile')!.content
		const yaml = findEntry(entries, 'docker-compose.yml')!.content
		for (const key of [
			'PUBLIC_MARKETING_URL',
			'PUBLIC_APP_URL',
			'PUBLIC_UMAMI_HOST',
			'PUBLIC_UMAMI_WEBSITE_ID',
			'PUBLIC_POSTHOG_KEY',
			'PUBLIC_POSTHOG_HOST'
		]) {
			expect(dockerfile).toContain(`ARG ${key}`)
			expect(yaml).toContain(`${key}:`)
		}
		const web = yaml.split(/^ {2}web:/m)[1]!.split(/^ {2}[a-z][a-z0-9_-]*:$/m)[0]!
		expect(web).toContain('PUBLIC_APP_URL: ${PUBLIC_APP_URL:-http://localhost:3000}')
	})

	test('generated Docker build uses the Node 24 baseline', () => {
		const dockerfile = findEntry(
			generateDeploy(makeCfg({ marketing: 'astro' })),
			'Dockerfile'
		)!.content
		expect(dockerfile).toContain('ARG NODE_VERSION=24')
		expect(dockerfile).not.toContain('ARG NODE_VERSION=20')
	})
})

describe('generateDeploy — cf-workers workflows', () => {
	test('Astro production and staging forward selected public monitoring variables', () => {
		const entries = generateDeploy(
			makeCfg({ deploy: 'cf-workers', marketing: 'astro', monitoring: ['umami', 'posthog'] })
		)
		for (const path of [
			'.github/workflows/deploy-production.yml',
			'.github/workflows/deploy-staging.yml'
		]) {
			const yml = findEntry(entries, path)!.content
			for (const key of [
				'PUBLIC_UMAMI_HOST',
				'PUBLIC_UMAMI_WEBSITE_ID',
				'PUBLIC_POSTHOG_KEY',
				'PUBLIC_POSTHOG_HOST'
			]) {
				expect(yml).toContain(`#   - ${key}`)
				expect(yml).toContain(`${key}: \${{ vars.${key} }}`)
			}
		}
	})

	test('Hono production forwards Turnstile without a public auth URL', () => {
		const entries = generateDeploy(
			makeCfg({ deploy: 'cf-workers', marketing: 'inside-web', auth: ['emailOTP'] })
		)
		const yml = findEntry(entries, '.github/workflows/deploy-production.yml')!.content
		expect(yml).not.toContain('PUBLIC_AUTH_URL')
		expect(yml).toContain('#   - PUBLIC_TURNSTILE_SITE_KEY')
		expect(yml).toContain('PUBLIC_TURNSTILE_SITE_KEY: ${{ vars.PUBLIC_TURNSTILE_SITE_KEY }}')
		expect(yml).toContain('test -n "$PUBLIC_TURNSTILE_SITE_KEY"')
		const workflow = Bun.YAML.parse(yml) as {
			jobs: { deploy: { steps: Array<{ name?: string; env?: Record<string, string> }> } }
		}
		const validation = workflow.jobs.deploy.steps.find(
			(step) => step.name === 'Validate public deployment variables'
		)
		expect(validation?.env).toEqual({
			PUBLIC_TURNSTILE_SITE_KEY: '${{ vars.PUBLIC_TURNSTILE_SITE_KEY }}'
		})
	})

	test('generated workflows do not contain YAML tab indentation', () => {
		const entries = generateDeploy(makeCfg({ deploy: 'cf-workers' }))
		for (const entry of entries.filter((entry) => entry.path.endsWith('.yml'))) {
			expect(entry.content, entry.path).not.toContain('\t')
		}
	})

	test('deploy-production.yml triggers on push to main and deploys affected Workers via turbo', () => {
		const entries = generateDeploy(makeCfg({ deploy: 'cf-workers' }))
		const yml = findEntry(entries, '.github/workflows/deploy-production.yml')!.content
		expect(yml).toMatch(/on:\s*\n\s+push:\s*\n\s+branches:\s*\[main\]/)
		expect(yml).toContain('pnpm turbo run deploy:production --affected')
		expect(yml).toContain('Run production database migrations')
		expect(yml).toContain('pnpm --filter @repo/db db:migrate:production')
		expect(yml).toContain('DATABASE_URL: ${{ secrets.DATABASE_URL }}')
		expect(yml).toContain('TURBO_SCM_BASE')
		expect(yml).toContain('TURBO_SCM_HEAD')
		expect(yml).toContain('fetch-depth: 0')
		expect(yml.match(/pnpm install --frozen-lockfile/g)).toHaveLength(1)
		expect(yml).not.toContain('working-directory: apps/web')
		expect(yml).not.toContain('working-directory: services/auth')
		expect(yml).not.toContain('working-directory: services/users')
		expect(yml).not.toContain('wrangler deploy --name')
	})

	test('staging rewrites Service Bindings to the same preview alias', () => {
		const entries = generateDeploy(makeCfg({ deploy: 'cf-workers' }))
		const yml = findEntry(entries, '.github/workflows/deploy-staging.yml')!.content
		const preparation = findEntry(entries, 'scripts/prepare-cloudflare-preview.mjs')!.content
		expect(yml).toContain('STAGING_ALIAS: ${{ needs.preview-db.outputs.alias }}')
		expect(preparation).toContain('cloudflarePreviewName(service.service, alias)')
	})

	test('staging writes preview-specific public origins into explicit configuration', () => {
		const entries = generateDeploy(makeCfg({ deploy: 'cf-workers' }))
		const yml = findEntry(entries, '.github/workflows/deploy-staging.yml')!.content
		const preparation = findEntry(entries, 'scripts/prepare-cloudflare-preview.mjs')!.content
		expect(yml).toContain('id: preview_config')
		for (const variable of [
			'CLOUDFLARE_PREVIEW_WEB_DOMAIN',
			'CLOUDFLARE_PREVIEW_API_DOMAIN',
			'CLOUDFLARE_PREVIEW_ZONE_NAME'
		]) {
			expect(yml).toContain(`${variable}: \${{ vars.${variable} }}`)
		}
		expect(yml).toContain('${{ steps.preview_config.outputs.api_origin }}')
		expect(yml).toContain('${{ steps.preview_config.outputs.web_origin }}')
		expect(preparation).toContain('API_PUBLIC_ORIGIN: apiOrigin.origin')
		expect(preparation).toContain("normalizedPath === 'apps/api/wrangler.jsonc'")
		expect(preparation).toContain("api_origin=' + apiOrigin.origin")
	})

	test('deploy-staging.yml triggers on pull_request open/sync/reopen with paths-ignore', () => {
		const entries = generateDeploy(makeCfg({ deploy: 'cf-workers' }))
		const yml = findEntry(entries, '.github/workflows/deploy-staging.yml')!.content
		expect(yml).toMatch(
			/on:\s*\n\s+pull_request:\s*\n\s+types:\s*\[opened, synchronize, reopened\]/
		)
		expect(yml).toMatch(/paths-ignore:[\s\S]*?'\*\*\.md'/)
		expect(yml).toMatch(/paths-ignore:[\s\S]*?'\.github\/\*\*'/)
	})

	test('deploy-staging.yml has concurrency keyed on PR number', () => {
		const entries = generateDeploy(makeCfg({ deploy: 'cf-workers' }))
		const yml = findEntry(entries, '.github/workflows/deploy-staging.yml')!.content
		expect(yml).toMatch(/concurrency:[\s\S]*?github\.event\.pull_request\.number/)
	})

	test('deploy-staging.yml grants pull-requests: write and uses sticky comment action', () => {
		const entries = generateDeploy(makeCfg({ deploy: 'cf-workers' }))
		const yml = findEntry(entries, '.github/workflows/deploy-staging.yml')!.content
		expect(yml).toContain('pull-requests: write')
		expect(yml).toContain('marocchino/sticky-pull-request-comment@v2')
		expect(yml).toContain('header: staging-deploy')
	})

	test('deploy-staging.yml derives a stable sanitized alias from the PR number', () => {
		const entries = generateDeploy(makeCfg({ deploy: 'cf-workers' }))
		const yml = findEntry(entries, '.github/workflows/deploy-staging.yml')!.content
		expect(yml).toContain('github.event.pull_request.number || github.run_id')
		expect(yml).toContain("sed -E 's/[^a-z0-9-]+/-/g")
		expect(yml).toContain("grep -Eq '^[a-z][a-z0-9-]{0,47}$'")
		expect(yml).toContain('STAGING_ALIAS')
		expect(yml).toContain('pnpm turbo run deploy:staging --affected')
	})

	test('deploy-staging.yml provisions a Neon preview branch for postgres projects', () => {
		const entries = generateDeploy(makeCfg({ deploy: 'cf-workers', db: 'postgres' }))
		const yml = findEntry(entries, '.github/workflows/deploy-staging.yml')!.content
		expect(yml).toContain('preview-db:')
		expect(yml).toContain('needs: preview-db')
		expect(yml).toContain('neondatabase/create-branch-action@v6')
		expect(yml).toContain('branch_name: ${{ steps.meta.outputs.neon_branch_name }}')
		expect(yml).toContain('expires_at: ${{ steps.expiration.outputs.expires_at }}')
		expect(yml).toContain('NEON_API_KEY')
		expect(yml).toContain('NEON_PROJECT_ID')
		expect(yml).toContain('database_url: ${{ steps.create_neon_branch.outputs.db_url_pooled }}')
		expect(yml).toContain('DATABASE_URL: ${{ needs.preview-db.outputs.database_url }}')
		expect(yml).toContain('STAGING_DATABASE_URL: ${{ needs.preview-db.outputs.database_url }}')
		expect(yml).toContain('pnpm --filter @repo/db db:migrate:production')
		expect(yml).toContain('wrangler.staging.jsonc')
		expect(yml.match(/pnpm install --frozen-lockfile/g)).toHaveLength(1)
		expect(yml).not.toContain('wrangler d1 create')
	})

	test('deploy-staging.yml provisions a D1 preview database for sqlite projects', () => {
		const entries = generateDeploy(makeCfg({ deploy: 'cf-workers', db: 'sqlite' }))
		const yml = findEntry(entries, '.github/workflows/deploy-staging.yml')!.content
		expect(yml).toContain('preview-db:')
		expect(yml).toContain('needs: preview-db')
		expect(yml).toContain('Create or reuse D1 preview database')
		expect(yml).toContain('npx wrangler@4.125.0 d1 list --json')
		expect(yml).toContain('npx wrangler@4.125.0 d1 create "$db_name"')
		expect(yml).toContain('d1_database_name: ${{ steps.d1.outputs.database_name }}')
		expect(yml).toContain('d1_database_id: ${{ steps.d1.outputs.database_id }}')
		expect(yml).toContain(
			'pnpm --filter @repo/db exec wrangler d1 migrations apply "${{ needs.preview-db.outputs.d1_database_name }}" --remote'
		)
		expect(yml).toContain(
			'STAGING_D1_DATABASE_NAME: ${{ needs.preview-db.outputs.d1_database_name }}'
		)
		expect(yml).toContain('STAGING_D1_DATABASE_ID: ${{ needs.preview-db.outputs.d1_database_id }}')
		expect(yml).toContain('wrangler.staging.jsonc')
		expect(yml.match(/pnpm install --frozen-lockfile/g)).toHaveLength(1)
		expect(yml).not.toContain('neondatabase/create-branch-action')
	})

	test('cleanup-staging.yml triggers on PR closed and requires complete Worker cleanup', () => {
		const entries = generateDeploy(makeCfg({ deploy: 'cf-workers' }))
		const yml = findEntry(entries, '.github/workflows/cleanup-staging.yml')!.content
		const script = findEntry(entries, 'scripts/cleanup-cloudflare-preview-workers.sh')!.content
		expect(yml).toMatch(/on:\s*\n\s+pull_request:\s*\n\s+types:\s*\[closed\]/)
		expect(yml).toContain('id: checkout_head')
		expect(yml).toContain('ref: ${{ github.event.pull_request.head.sha }}')
		expect(yml).toContain('id: checkout_base')
		expect(yml).toContain('ref: ${{ github.event.pull_request.base.sha }}')
		expect(yml).toContain("if: steps.checkout_head.outcome != 'success'")
		expect(yml).toContain('preview cleanup cannot inventory resources')
		expect(yml).toContain(
			'sh scripts/cleanup-cloudflare-preview-workers.sh "${{ steps.branch.outputs.alias }}"'
		)
		expect(script).toContain('find "$@" -name wrangler.jsonc')
		expect(script).toContain('wrangler@4.125.0 deployments list --name')
		expect(script).toContain('wrangler@4.125.0 delete --name')
		expect(script).not.toContain('|| true')
		expect(yml).not.toContain('deleteRef')
		expect(yml).not.toContain(`${baseChoices.name}-auth-\${{ steps.branch.outputs.alias }}`)
		expect(yml).not.toContain(`${baseChoices.name}-users-\${{ steps.branch.outputs.alias }}`)
	})

	test('cleanup-staging.yml deletes Neon preview branch for postgres projects', () => {
		const entries = generateDeploy(makeCfg({ deploy: 'cf-workers', db: 'postgres' }))
		const yml = findEntry(entries, '.github/workflows/cleanup-staging.yml')!.content
		expect(yml).toContain('branch_name="demo-db-${{ steps.branch.outputs.alias }}"')
		expect(yml).toContain('https://console.neon.tech/api/v2/projects/$NEON_PROJECT_ID/branches')
		expect(yml).toContain('Preview Neon branch $branch_name is missing or already deleted.')
		expect(yml).toContain('Could not list Neon branches.')
		expect(yml).not.toContain('continuing cleanup')
		expect(yml).toContain('NEON_PROJECT_ID')
		expect(yml).toContain('NEON_API_KEY')
		expect(yml).not.toContain('wrangler d1 delete')
	})

	test('cleanup-staging.yml deletes D1 preview database for sqlite projects', () => {
		const entries = generateDeploy(makeCfg({ deploy: 'cf-workers', db: 'sqlite' }))
		const yml = findEntry(entries, '.github/workflows/cleanup-staging.yml')!.content
		expect(yml).toContain('Delete preview D1 database')
		expect(yml).toContain('db_name="demo-db-${{ steps.branch.outputs.alias }}"')
		expect(yml).toContain('npx wrangler@4.125.0 d1 list --json')
		expect(yml).toContain('Preview D1 database $db_name is missing or already deleted.')
		expect(yml).toContain('npx wrangler@4.125.0 d1 delete "$db_name" --skip-confirmation')
		expect(yml).not.toContain('continuing cleanup')
		expect(yml).not.toContain('neondatabase/delete-branch-by-name-action')
	})

	test('cleanup-staging.yml overwrites the staging-deploy sticky comment', () => {
		const entries = generateDeploy(makeCfg({ deploy: 'cf-workers' }))
		const yml = findEntry(entries, '.github/workflows/cleanup-staging.yml')!.content
		expect(yml).toContain('marocchino/sticky-pull-request-comment@v2')
		expect(yml).toContain('header: staging-deploy')
	})

	test('cleanup-staging.yml can report cleanup without source-write permission', () => {
		const entries = generateDeploy(makeCfg({ deploy: 'cf-workers' }))
		const yml = findEntry(entries, '.github/workflows/cleanup-staging.yml')!.content
		expect(yml).toContain('contents: read')
		expect(yml).not.toContain('contents: write')
		expect(yml).toContain('pull-requests: write')
	})

	test('pnpm version is pinned, not "latest" (production + staging)', () => {
		const entries = generateDeploy(makeCfg({ deploy: 'cf-workers' }))
		for (const path of [
			'.github/workflows/deploy-production.yml',
			'.github/workflows/deploy-staging.yml'
		]) {
			const yml = findEntry(entries, path)!.content
			expect(yml).not.toContain('version: latest')
			expect(yml).toMatch(/version: \d+\.\d+\.\d+/)
		}
	})

	test('hono backend sequences private package tasks before gateway and web tasks', () => {
		const entries = generateDeploy(makeCfg({ deploy: 'cf-workers', backend: 'hono' }))
		for (const path of [
			'.github/workflows/deploy-production.yml',
			'.github/workflows/deploy-staging.yml'
		]) {
			const workflow = findEntry(entries, path)!.content
			expect(workflow.indexOf('Deploy auth Worker')).toBeLessThan(
				workflow.indexOf('Deploy users Worker')
			)
			expect(workflow.indexOf('Deploy users Worker')).toBeLessThan(
				workflow.indexOf('Deploy gateway Worker')
			)
			expect(workflow.indexOf('Deploy gateway Worker')).toBeLessThan(
				workflow.indexOf('Deploy web Worker')
			)
		}
	})

	test('inside-frontend mode emits no api deploy steps', () => {
		const entries = generateDeploy(
			makeCfg({ deploy: 'cf-workers', backend: 'inside-frontend', apiClient: 'skip' })
		)
		for (const path of [
			'.github/workflows/deploy-production.yml',
			'.github/workflows/deploy-staging.yml',
			'.github/workflows/cleanup-staging.yml'
		]) {
			const yml = findEntry(entries, path)!.content
			expect(yml).not.toContain('services/auth')
			expect(yml).not.toContain('services/users')
		}
	})
})

describe('generated cf-workers deploy task contract', () => {
	test('root package and turbo config expose non-cacheable deploy tasks only for cf-workers', () => {
		const cfEntries = runGenerators(makeCfg({ deploy: 'cf-workers' }))
		const cfRootPkg = JSON.parse(findEntry(cfEntries, 'package.json')!.content) as {
			scripts: Record<string, string>
		}
		const cfTurbo = JSON.parse(findEntry(cfEntries, 'turbo.json')!.content) as {
			tasks: Record<string, { cache?: boolean; dependsOn?: string[] }>
		}

		expect(cfRootPkg.scripts['deploy:production']).toBe('turbo run deploy:production --affected')
		expect(cfRootPkg.scripts['deploy:staging']).toBe('turbo run deploy:staging --affected')
		expect(cfTurbo.tasks['deploy:production']).toEqual({ dependsOn: ['build'], cache: false })
		expect(cfTurbo.tasks['deploy:staging']).toEqual({ dependsOn: ['build'], cache: false })

		const dockerEntries = runGenerators(makeCfg({ deploy: 'docker' }))
		const dockerRootPkg = JSON.parse(findEntry(dockerEntries, 'package.json')!.content) as {
			scripts: Record<string, string>
		}
		const dockerTurbo = JSON.parse(findEntry(dockerEntries, 'turbo.json')!.content) as {
			tasks: Record<string, unknown>
		}
		expect(dockerRootPkg.scripts['deploy:production']).toBeUndefined()
		expect(dockerRootPkg.scripts['deploy:staging']).toBeUndefined()
		expect(dockerTurbo.tasks['deploy:production']).toBeUndefined()
		expect(dockerTurbo.tasks['deploy:staging']).toBeUndefined()
	})

	test('deployable cf-workers packages expose production and staging deploy scripts', () => {
		const entries = runGenerators(makeCfg({ deploy: 'cf-workers', backend: 'hono' }))
		for (const path of [
			'apps/api/package.json',
			'apps/web/package.json',
			'services/auth/package.json',
			'services/users/package.json'
		]) {
			const pkg = JSON.parse(findEntry(entries, path)!.content) as {
				scripts: Record<string, string>
			}
			expect(pkg.scripts['deploy:production']).toContain('wrangler deploy')
			expect(pkg.scripts['deploy:staging']).toContain('STAGING_ALIAS')
			expect(pkg.scripts['deploy:staging']).toContain('--config')
			expect(pkg.scripts['deploy:staging']).toContain('STAGING_WRANGLER_CONFIG')
			expect(pkg.scripts['deploy:staging']).not.toContain('--name')
		}
	})

	test('cf-workers db package exposes one-shot production migration scripts', () => {
		const postgresEntries = runGenerators(makeCfg({ deploy: 'cf-workers', db: 'postgres' }))
		const postgresPkg = JSON.parse(
			findEntry(postgresEntries, 'packages/db/package.json')!.content
		) as {
			devDependencies: Record<string, string>
			scripts: Record<string, string>
		}
		expect(postgresPkg.scripts['db:migrate:production']).toBe('drizzle-kit migrate')
		expect(postgresPkg.devDependencies.wrangler).toBeUndefined()

		const sqliteEntries = runGenerators(makeCfg({ deploy: 'cf-workers', db: 'sqlite' }))
		const sqlitePkg = JSON.parse(findEntry(sqliteEntries, 'packages/db/package.json')!.content) as {
			devDependencies: Record<string, string>
			scripts: Record<string, string>
		}
		expect(sqlitePkg.scripts['db:migrate:production']).toBe(
			'wrangler d1 migrations apply demo-db --remote'
		)
		expect(sqlitePkg.scripts['db:migrate:local']).toBe(
			'wrangler d1 migrations apply demo-db --local'
		)
		expect(sqlitePkg.devDependencies.wrangler).toBeDefined()

		const dockerEntries = runGenerators(makeCfg({ deploy: 'docker', db: 'postgres' }))
		const dockerPkg = JSON.parse(findEntry(dockerEntries, 'packages/db/package.json')!.content) as {
			scripts: Record<string, string>
		}
		expect(dockerPkg.scripts['db:migrate:production']).toBeUndefined()
	})

	test('cf-workers generated docs name D1 and Neon provider semantics', () => {
		const postgresEntries = runGenerators(makeCfg({ deploy: 'cf-workers', db: 'postgres' }))
		expect(findEntry(postgresEntries, 'README.md')!.content).toContain(
			'Database: PostgreSQL (Neon) via Drizzle'
		)
		expect(findEntry(postgresEntries, 'README.md')!.content).toContain('NEON_API_KEY')
		expect(findEntry(postgresEntries, 'README.md')!.content).toContain('NEON_PROJECT_ID')
		expect(findEntry(postgresEntries, 'packages/db/README.md')!.content).toContain('Neon Postgres')
		expect(findEntry(postgresEntries, 'packages/db/README.md')!.content).toContain(
			'PR previews can use Neon branches'
		)
		expect(findEntry(postgresEntries, 'packages/db/README.md')!.content).not.toContain(
			'this scaffold'
		)

		const sqliteEntries = runGenerators(makeCfg({ deploy: 'cf-workers', db: 'sqlite' }))
		expect(findEntry(sqliteEntries, 'README.md')!.content).toContain(
			'Database: SQLite (Cloudflare D1) via Drizzle'
		)
		expect(findEntry(sqliteEntries, 'packages/db/README.md')!.content).toContain('Cloudflare D1')

		const dockerEntries = runGenerators(makeCfg({ deploy: 'docker', db: 'postgres' }))
		expect(findEntry(dockerEntries, 'README.md')!.content).toContain(
			'Database: PostgreSQL via Drizzle'
		)
		expect(findEntry(dockerEntries, 'README.md')!.content).not.toContain('Neon')
	})
})
