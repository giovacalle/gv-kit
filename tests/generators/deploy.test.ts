import { describe, expect, test } from 'bun:test'
import { generateDeploy } from '../../src/generators/deploy.js'
import { runGenerators } from '../../src/generators/index.js'
import type { FileEntry } from '../../src/lib/files.js'
import type { Choices, GvKitConfig } from '../../src/schema/config.js'

const baseChoices: Choices = {
	name: 'demo',
	frontend: 'sveltekit',
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
		configVersion: 1,
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

	test('deploy=docker emits exactly Dockerfile + compose + dockerignore', () => {
		const entries = generateDeploy(makeCfg({ deploy: 'docker' }))
		const paths = entries.map((e) => e.path).sort()
		expect(paths).toEqual(['.dockerignore', 'Dockerfile', 'docker-compose.yml'])
	})
})

describe('generateDeploy — single-Dockerfile architecture', () => {
	test('no per-app Dockerfiles are emitted in any backend mode', () => {
		for (const backend of ['hono', 'inside-frontend'] as const) {
			const cfg = makeCfg(
				backend === 'inside-frontend' ? { backend, apiClient: 'skip' } : { backend }
			)
			const entries = generateDeploy(cfg)
			expect(findEntry(entries, 'apps/web/Dockerfile')).toBeUndefined()
			expect(findEntry(entries, 'apps/api/auth/Dockerfile')).toBeUndefined()
			expect(findEntry(entries, 'apps/api/users/Dockerfile')).toBeUndefined()
		}
	})

	test('Dockerfile defines all three runtime targets', () => {
		const entries = generateDeploy(makeCfg({}))
		const dockerfile = findEntry(entries, 'Dockerfile')!.content
		expect(dockerfile).toContain('AS web-runtime')
		expect(dockerfile).toContain('AS api-runtime')
		expect(dockerfile).toContain('AS migrate-runtime')
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

	test('emailOTP + resend → RESEND_API_KEY only', () => {
		const yaml = compose(makeCfg({ auth: ['emailOTP'], email: 'resend' }))
		expect(yaml).toContain('${RESEND_API_KEY:?')
		expect(yaml).not.toContain('NOTIFUSE_API_KEY')
	})

	test('emailOTP + notifuse → NOTIFUSE_API_KEY only', () => {
		const yaml = compose(makeCfg({ auth: ['emailOTP'], email: 'notifuse' }))
		expect(yaml).toContain('${NOTIFUSE_API_KEY:?')
		expect(yaml).not.toContain('RESEND_API_KEY')
	})
})

describe('generateDeploy — backend topology', () => {
	test('backend=hono → auth + users + web services', () => {
		const yaml = compose(makeCfg({ backend: 'hono' }))
		expect(yaml).toMatch(/^\s+auth:/m)
		expect(yaml).toMatch(/^\s+users:/m)
		expect(yaml).toMatch(/^\s+web:/m)
	})

	test('backend=inside-frontend → no auth/users service blocks', () => {
		const yaml = compose(makeCfg({ backend: 'inside-frontend', apiClient: 'skip' }))
		expect(yaml).not.toMatch(/^\s+auth:/m)
		expect(yaml).not.toMatch(/^\s+users:/m)
		expect(yaml).toMatch(/^\s+web:/m)
	})

	test('inside-frontend + postgres → web has DATABASE_URL and depends_on postgres', () => {
		const yaml = compose(makeCfg({ backend: 'inside-frontend', apiClient: 'skip', db: 'postgres' }))
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

	test('inside-frontend + auth → web has BETTER_AUTH_SECRET (not auth service)', () => {
		const yaml = compose(
			makeCfg({
				backend: 'inside-frontend',
				apiClient: 'skip',
				auth: ['emailOTP'],
				email: 'resend'
			})
		)
		const webBlock = yaml.split(/^ {2}web:/m)[1]!
		expect(webBlock).toContain('${BETTER_AUTH_SECRET:?')
	})
})

describe('generateDeploy — orchestration', () => {
	test('every application service has a healthcheck', () => {
		const yaml = compose(makeCfg({ backend: 'hono', auth: ['emailOTP'], email: 'resend' }))
		for (const name of ['auth', 'users', 'web']) {
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
		expect(dockerfile).toMatch(/AS api-runtime[\s\S]*?USER app/)
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
		expect(ignore).toContain('!packages/')
		expect(ignore).toContain('**/node_modules')
		expect(ignore).toContain('**/.turbo')
		expect(ignore).toContain('**/.svelte-kit')
	})
})

describe('generateDeploy — cf-workers workflows', () => {
	test('deploy-production.yml triggers on push to main and deploys affected Workers via turbo', () => {
		const entries = generateDeploy(makeCfg({ deploy: 'cf-workers' }))
		const yml = findEntry(entries, '.github/workflows/deploy-production.yml')!.content
		expect(yml).toMatch(/on:\s*\n\s+push:\s*\n\s+branches:\s*\[main\]/)
		expect(yml).toContain('pnpm turbo run deploy:production --affected')
		expect(yml).toContain('db-migrations:')
		expect(yml).toContain('needs: db-migrations')
		expect(yml).toContain('pnpm --filter @repo/db db:migrate:production')
		expect(yml).toContain('DATABASE_URL: ${{ secrets.DATABASE_URL }}')
		expect(yml).toContain('TURBO_SCM_BASE')
		expect(yml).toContain('TURBO_SCM_HEAD')
		expect(yml).toContain('fetch-depth: 0')
		expect(yml).not.toContain('working-directory: apps/web')
		expect(yml).not.toContain('working-directory: apps/api/auth')
		expect(yml).not.toContain('working-directory: apps/api/users')
		expect(yml).not.toContain('wrangler deploy --name')
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

	test('deploy-staging.yml derives branch alias from PR head ref', () => {
		const entries = generateDeploy(makeCfg({ deploy: 'cf-workers' }))
		const yml = findEntry(entries, '.github/workflows/deploy-staging.yml')!.content
		expect(yml).toContain('github.event.pull_request.head.ref')
		expect(yml).toContain('STAGING_ALIAS')
		expect(yml).toContain('pnpm turbo run deploy:staging --affected')
		expect(yml).toContain('intentionally does not run database migrations')
		expect(yml).not.toContain('db:migrate:production')
		expect(yml).not.toContain('working-directory: apps/api/auth')
		expect(yml).not.toContain('working-directory: apps/api/users')
	})

	test('cleanup-staging.yml triggers on PR closed, discovers Workers, and deletes branch', () => {
		const entries = generateDeploy(makeCfg({ deploy: 'cf-workers' }))
		const yml = findEntry(entries, '.github/workflows/cleanup-staging.yml')!.content
		expect(yml).toMatch(/on:\s*\n\s+pull_request:\s*\n\s+types:\s*\[closed\]/)
		expect(yml).toContain('find apps -name wrangler.jsonc')
		expect(yml).toContain('wrangler delete --name')
		expect(yml).toContain('deleteRef')
		expect(yml).not.toContain(`${baseChoices.name}-auth-\${{ steps.branch.outputs.alias }}`)
		expect(yml).not.toContain(`${baseChoices.name}-users-\${{ steps.branch.outputs.alias }}`)
	})

	test('cleanup-staging.yml overwrites the staging-deploy sticky comment', () => {
		const entries = generateDeploy(makeCfg({ deploy: 'cf-workers' }))
		const yml = findEntry(entries, '.github/workflows/cleanup-staging.yml')!.content
		expect(yml).toContain('marocchino/sticky-pull-request-comment@v2')
		expect(yml).toContain('header: staging-deploy')
	})

	test('cleanup-staging.yml grants pull-requests: write in addition to contents: write', () => {
		const entries = generateDeploy(makeCfg({ deploy: 'cf-workers' }))
		const yml = findEntry(entries, '.github/workflows/cleanup-staging.yml')!.content
		expect(yml).toContain('contents: write')
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

	test('hono backend → production + staging do not enumerate auth/users Workers', () => {
		const entries = generateDeploy(makeCfg({ deploy: 'cf-workers', backend: 'hono' }))
		const prod = findEntry(entries, '.github/workflows/deploy-production.yml')!.content
		const staging = findEntry(entries, '.github/workflows/deploy-staging.yml')!.content
		expect(prod).not.toContain('apps/api/auth')
		expect(prod).not.toContain('apps/api/users')
		expect(staging).not.toContain('apps/api/auth')
		expect(staging).not.toContain('apps/api/users')
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
			expect(yml).not.toContain('apps/api/auth')
			expect(yml).not.toContain('apps/api/users')
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
			'apps/web/package.json',
			'apps/api/auth/package.json',
			'apps/api/users/package.json'
		]) {
			const pkg = JSON.parse(findEntry(entries, path)!.content) as {
				scripts: Record<string, string>
			}
			expect(pkg.scripts['deploy:production']).toContain('wrangler deploy')
			expect(pkg.scripts['deploy:staging']).toContain('STAGING_ALIAS')
			expect(pkg.scripts['deploy:staging']).toContain('wrangler deploy --name')
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
		expect(findEntry(postgresEntries, 'packages/db/README.md')!.content).toContain('Neon Postgres')
		expect(findEntry(postgresEntries, 'packages/db/README.md')!.content).toContain(
			'PR previews can use Neon branches'
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
