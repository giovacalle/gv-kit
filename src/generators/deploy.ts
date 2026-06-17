import type { FileEntry } from '../lib/files.js'
import type { GvKitConfig } from '../schema/config.js'

export function generateDeploy(cfg: GvKitConfig): FileEntry[] {
	switch (cfg.choices.deploy) {
		case 'skip':
			return []
		case 'cf-workers':
			return cfWorkersArtifacts(cfg)
		case 'docker':
			return dockerArtifacts(cfg)
		default: {
			const _exhaustive: never = cfg.choices.deploy
			return _exhaustive
		}
	}
}

/* ------------------------------------------------------------------ */
/*  cf-workers                                                         */
/* ------------------------------------------------------------------ */

function cfWorkersArtifacts(cfg: GvKitConfig): FileEntry[] {
	const opts = { project: cfg.choices.name }
	return [
		{ path: '.github/workflows/deploy-production.yml', content: deployProductionWorkflow(opts) },
		{ path: '.github/workflows/deploy-staging.yml', content: deployStagingWorkflow(opts) },
		{ path: '.github/workflows/cleanup-staging.yml', content: cleanupStagingWorkflow() }
	]
}

function deployProductionWorkflow({ project }: { project: string }): string {
	return `# Deploy ${project} to production on push to main.
#
# Required GitHub Secrets:
#   - CLOUDFLARE_API_TOKEN
#   - CLOUDFLARE_ACCOUNT_ID
#
# Add per-Worker secrets ahead of time via \`wrangler secret put\` — this
# workflow does not push secrets, only code.

name: deploy-production

on:
  push:
    branches: [main]
  workflow_dispatch:

jobs:
  db-migrations:
    runs-on: ubuntu-latest
    environment: production
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
          filter: blob:none
      - uses: pnpm/action-setup@v4
        with:
          version: 11.1.1
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'pnpm'
      - run: pnpm install --frozen-lockfile

      - id: scm
        name: Resolve migration range
        run: |
          base="\${{ github.event.before }}"
          if [ -z "$base" ] || [ "$base" = "0000000000000000000000000000000000000000" ]; then
            base="HEAD^1"
          fi
          echo "base=$base" >> "$GITHUB_OUTPUT"
          echo "head=\${GITHUB_SHA}" >> "$GITHUB_OUTPUT"

      - id: db_changes
        name: Check DB migration inputs
        run: |
          if git diff --name-only "\${{ steps.scm.outputs.base }}" "\${{ steps.scm.outputs.head }}" | grep -E '^packages/db/(migrations/|src/schema/|drizzle\\.config\\.ts)'; then
            echo "should_run=true" >> "$GITHUB_OUTPUT"
          else
            echo "should_run=false" >> "$GITHUB_OUTPUT"
          fi

      - name: Run production database migrations
        if: steps.db_changes.outputs.should_run == 'true'
        run: pnpm --filter @repo/db db:migrate:production
        env:
          DATABASE_URL: \${{ secrets.DATABASE_URL }}
          CLOUDFLARE_API_TOKEN: \${{ secrets.CLOUDFLARE_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: \${{ secrets.CLOUDFLARE_ACCOUNT_ID }}

      - name: Skip database migrations
        if: steps.db_changes.outputs.should_run != 'true'
        run: echo "No database migration inputs changed."

  deploy:
    needs: db-migrations
    runs-on: ubuntu-latest
    environment: production
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
          filter: blob:none
      - uses: pnpm/action-setup@v4
        with:
          version: 11.1.1
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'pnpm'
      - run: pnpm install --frozen-lockfile

      - id: scm
        name: Resolve affected range
        run: |
          base="\${{ github.event.before }}"
          if [ -z "$base" ] || [ "$base" = "0000000000000000000000000000000000000000" ]; then
            base="HEAD^1"
          fi
          echo "base=$base" >> "$GITHUB_OUTPUT"
          echo "head=\${GITHUB_SHA}" >> "$GITHUB_OUTPUT"

      - name: Deploy affected Workers
        run: pnpm turbo run deploy:production --affected
        env:
          CLOUDFLARE_API_TOKEN: \${{ secrets.CLOUDFLARE_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: \${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
          TURBO_SCM_BASE: \${{ steps.scm.outputs.base }}
          TURBO_SCM_HEAD: \${{ steps.scm.outputs.head }}
`
}

function deployStagingWorkflow({ project }: { project: string }): string {
	return `# Per-PR staging deploys. Every push to a PR gets isolated Workers named with
# the branch slug. Deployable packages derive their own Worker names from
# STAGING_ALIAS, so adding a new Worker package does not require editing this
# workflow.
# This workflow intentionally does not run database migrations; production
# migrations are a separate serial gate in deploy-production.yml.
# Tear-down lives in cleanup-staging.yml.
#
# Required GitHub Secrets:
#   - CLOUDFLARE_API_TOKEN
#   - CLOUDFLARE_ACCOUNT_ID

name: deploy-staging

on:
  pull_request:
    types: [opened, synchronize, reopened]
    paths-ignore:
      - '**.md'
      - '.github/**'
  workflow_dispatch:

concurrency:
  group: staging-\${{ github.event.pull_request.number || github.ref }}
  cancel-in-progress: true

jobs:
  deploy:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write
      actions: read
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
          filter: blob:none
          ref: \${{ github.event.pull_request.head.sha }}
      - id: meta
        run: |
          echo "alias=$(echo \${{ github.event.pull_request.head.ref }} | tr '/' '-' | tr '[:upper:]' '[:lower:]')" >> $GITHUB_OUTPUT
          echo "short_sha=\${GITHUB_SHA:0:7}" >> $GITHUB_OUTPUT
      - uses: pnpm/action-setup@v4
        with:
          version: 11.1.1
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'pnpm'
      - run: pnpm install --frozen-lockfile

      - name: Deploy affected Workers (staging)
        run: pnpm turbo run deploy:staging --affected
        env:
          CLOUDFLARE_API_TOKEN: \${{ secrets.CLOUDFLARE_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: \${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
          STAGING_ALIAS: \${{ steps.meta.outputs.alias }}
          TURBO_SCM_BASE: \${{ github.event.pull_request.base.sha }}
          TURBO_SCM_HEAD: \${{ github.event.pull_request.head.sha }}

      - uses: marocchino/sticky-pull-request-comment@v2
        with:
          header: staging-deploy
          message: |
            🚀 **Staging deployed**

            | Worker | URL |
            |---|---|
            | affected packages | \`${project}-<worker>-\${{ steps.meta.outputs.alias }}.<your-workers-subdomain>.workers.dev\` |

            **Commit**: \`\${{ steps.meta.outputs.short_sha }}\`
            **Updated**: \${{ github.event.pull_request.updated_at }}
`
}

function cleanupStagingWorkflow(): string {
	return `# Tear down a staging deploy when its PR closes (merged or rejected). Also
# deletes the remote branch — staging is ephemeral. Worker names are discovered
# from checked-in wrangler.jsonc files and suffixed with the branch alias.

name: cleanup-staging

on:
  pull_request:
    types: [closed]

jobs:
  cleanup:
    runs-on: ubuntu-latest
    permissions:
      contents: write
      pull-requests: write
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 1
          ref: \${{ github.event.pull_request.head.sha }}
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
      - id: branch
        run: echo "alias=$(echo \${{ github.event.pull_request.head.ref }} | tr '/' '-' | tr '[:upper:]' '[:lower:]')" >> $GITHUB_OUTPUT

      - name: Delete staging Workers
        run: |
          set -euo pipefail
          find apps -name wrangler.jsonc -print | while read -r config; do
            base_name=$(sed -n 's/.*"name"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p' "$config" | head -n 1)
            if [ -z "$base_name" ]; then
              echo "Skipping $config: no top-level name found"
              continue
            fi
            worker_name="$base_name-\${{ steps.branch.outputs.alias }}"
            echo "Deleting $worker_name"
            npx wrangler delete --name "$worker_name" --force || true
          done
        env:
          CLOUDFLARE_API_TOKEN: \${{ secrets.CLOUDFLARE_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: \${{ secrets.CLOUDFLARE_ACCOUNT_ID }}

      - name: Delete remote branch
        uses: actions/github-script@v7
        with:
          script: |
            const ref = context.payload.pull_request.head.ref
            try {
              await github.rest.git.deleteRef({
                owner: context.repo.owner,
                repo: context.repo.repo,
                ref: \`heads/\${ref}\`
              })
            } catch (err) {
              core.warning(\`Could not delete branch \${ref}: \${err.message}\`)
            }

      - uses: marocchino/sticky-pull-request-comment@v2
        if: always()
        with:
          header: staging-deploy
          message: |
            🧹 **Staging cleaned up**

            Workers and branch \`\${{ github.event.pull_request.head.ref }}\` removed.
`
}

/* ------------------------------------------------------------------ */
/*  docker                                                             */
/* ------------------------------------------------------------------ */

interface DockerOpts {
	project: string
	isHono: boolean
	isPostgres: boolean
	hasAuth: boolean
	wantsGoogle: boolean
	wantsEmailOTP: boolean
	emailProvider: 'resend' | 'notifuse' | null
}

function dockerArtifacts(cfg: GvKitConfig): FileEntry[] {
	const opts: DockerOpts = {
		project: cfg.choices.name,
		isHono: cfg.choices.backend === 'hono',
		isPostgres: cfg.choices.db === 'postgres',
		hasAuth: cfg.choices.auth.length > 0,
		wantsGoogle: cfg.choices.auth.includes('google'),
		wantsEmailOTP: cfg.choices.auth.includes('emailOTP'),
		emailProvider: cfg.choices.email === 'skip' ? null : cfg.choices.email
	}

	return [
		{ path: '.dockerignore', content: dockerignore() },
		{ path: 'Dockerfile', content: dockerfile() },
		{ path: 'docker-compose.yml', content: dockerCompose(opts) }
	]
}

function dockerignore(): string {
	return `*

!apps/
!apps/**
!packages/
!packages/**
!package.json
!pnpm-lock.yaml
!pnpm-workspace.yaml
!turbo.json
!tsconfig.json

**/node_modules
**/.turbo
**/dist
**/build
**/.svelte-kit
**/.wrangler
**/.env
**/.env.*
!**/.env.example
**/coverage
**/*.log
**/*.tsbuildinfo
.git
.github
.vscode
.idea
.DS_Store
`
}

function dockerfile(): string {
	return `# syntax=docker/dockerfile:1.7
#
# Build any service from the repo root:
#   docker build --target web-runtime --build-arg TURBO_FILTER=<project>-web -t web .
#   docker build --target api-runtime --build-arg APP_PATH=apps/api/auth --build-arg TURBO_FILTER=@<project>/auth-worker -t auth .
#
# Compose orchestrates these via \`target:\` and \`args:\`.

ARG NODE_VERSION=20
ARG PNPM_VERSION=11.1.1

FROM node:\${NODE_VERSION}-alpine AS base
ENV NODE_ENV=production \\
    TURBO_TELEMETRY_DISABLED=1 \\
    PNPM_HOME=/root/.local/share/pnpm \\
    PATH=/root/.local/share/pnpm:$PATH
WORKDIR /repo
RUN apk add --no-cache tini
ARG PNPM_VERSION
RUN corepack enable && corepack prepare pnpm@\${PNPM_VERSION} --activate

# Copy only package.json files into /pruned/ so the install layer is reused
# whenever source changes but manifests do not.
FROM base AS pruner
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json ./
COPY apps apps
COPY packages packages
RUN find apps packages \\( -name 'node_modules' -prune \\) -o \\( -name 'package.json' -print \\) \\
    | xargs -I{} sh -c 'mkdir -p "/pruned/$(dirname "{}")" && cp "{}" "/pruned/{}"' \\
 && cp package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json /pruned/

FROM base AS deps
COPY --from=pruner /pruned/ ./
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \\
    pnpm install --frozen-lockfile

FROM deps AS builder
ARG TURBO_FILTER
COPY . .
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \\
    --mount=type=cache,id=turbo,target=/repo/.turbo \\
    pnpm exec turbo run build --filter=\${TURBO_FILTER}

FROM node:\${NODE_VERSION}-alpine AS web-runtime
RUN apk add --no-cache tini wget \\
 && addgroup -S app && adduser -S app -G app
ENV NODE_ENV=production \\
    PORT=3000 \\
    HOST=0.0.0.0
WORKDIR /app
COPY --from=builder --chown=app:app /repo/apps/web/build ./build
COPY --from=builder --chown=app:app /repo/apps/web/package.json ./package.json
COPY --from=builder --chown=app:app /repo/node_modules ./node_modules
USER app
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=3s --start-period=15s --retries=3 \\
    CMD wget --quiet --tries=1 --spider http://127.0.0.1:3000/healthz || exit 1
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "build/index.js"]

FROM node:\${NODE_VERSION}-alpine AS api-runtime
RUN apk add --no-cache tini wget \\
 && addgroup -S app && adduser -S app -G app
ARG APP_PATH
ENV NODE_ENV=production \\
    HOST=0.0.0.0
WORKDIR /app
COPY --from=builder --chown=app:app /repo/\${APP_PATH}/dist ./dist
COPY --from=builder --chown=app:app /repo/\${APP_PATH}/package.json ./package.json
USER app
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \\
    CMD wget --quiet --tries=1 --spider http://127.0.0.1:$PORT/healthz || exit 1
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/index.js"]

# One-shot. Compose runs it with \`condition: service_completed_successfully\`
# so application services wait for migrations before starting.
FROM deps AS migrate-runtime
COPY --from=builder /repo/packages/db ./packages/db
WORKDIR /repo/packages/db
USER nobody
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["pnpm", "exec", "drizzle-kit", "migrate"]
`
}

/* ------------------------------------------------------------------ */
/*  docker-compose.yml                                                 */
/* ------------------------------------------------------------------ */

function dockerCompose(opts: DockerOpts): string {
	const services: string[] = []
	if (opts.isPostgres) services.push(postgresService())
	services.push(migrateService(opts))
	if (opts.isHono) {
		services.push(authService(opts))
		services.push(usersService(opts))
	}
	services.push(webService(opts))

	return (
		[
			'name: ' + opts.project,
			'services:\n' + services.join('\n\n'),
			composeVolumes(opts).join('\n'),
			`networks:\n  default:\n    name: ${opts.project}_internal`
		].join('\n\n') + '\n'
	)
}

function postgresService(): string {
	return `  postgres:
    image: postgres:16-alpine
    restart: unless-stopped
    environment:
      POSTGRES_USER: \${POSTGRES_USER:?set POSTGRES_USER in .env}
      POSTGRES_PASSWORD: \${POSTGRES_PASSWORD:?set POSTGRES_PASSWORD in .env}
      POSTGRES_DB: \${POSTGRES_DB:?set POSTGRES_DB in .env}
    ports:
      - "127.0.0.1:5432:5432"
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U $$POSTGRES_USER -d $$POSTGRES_DB"]
      interval: 5s
      timeout: 3s
      retries: 10
      start_period: 5s`
}

function migrateService(opts: DockerOpts): string {
	const lines = [
		'  migrate:',
		'    build:',
		'      context: .',
		'      target: migrate-runtime',
		'      args:',
		'        TURBO_FILTER: "@repo/db"',
		'    restart: "no"',
		'    environment:',
		...dbEnvLines(opts, '      '),
		...volumeMountLines(opts, '    ')
	]
	const deps = dependsOnDb(opts)
	if (deps.length > 0) lines.push(...deps)
	return lines.join('\n')
}

function authService(opts: DockerOpts): string {
	const env = ['      PORT: "8787"', ...dbEnvLines(opts, '      ')]
	if (opts.hasAuth) {
		env.push('      BETTER_AUTH_SECRET: ${BETTER_AUTH_SECRET:?set BETTER_AUTH_SECRET in .env}')
		env.push('      BETTER_AUTH_URL: ${BETTER_AUTH_URL:-http://localhost:8787}')
		env.push(
			'      BETTER_AUTH_TRUSTED_ORIGINS: ${BETTER_AUTH_TRUSTED_ORIGINS:-http://localhost:3000}'
		)
	}
	if (opts.wantsGoogle) {
		env.push('      GOOGLE_CLIENT_ID: ${GOOGLE_CLIENT_ID:?set GOOGLE_CLIENT_ID in .env}')
		env.push(
			'      GOOGLE_CLIENT_SECRET: ${GOOGLE_CLIENT_SECRET:?set GOOGLE_CLIENT_SECRET in .env}'
		)
	}
	if (opts.wantsEmailOTP && opts.emailProvider === 'resend') {
		env.push('      RESEND_API_KEY: ${RESEND_API_KEY:?set RESEND_API_KEY in .env}')
	}
	if (opts.wantsEmailOTP && opts.emailProvider === 'notifuse') {
		env.push('      NOTIFUSE_API_KEY: ${NOTIFUSE_API_KEY:?set NOTIFUSE_API_KEY in .env}')
		env.push(
			'      NOTIFUSE_WORKSPACE_ID: ${NOTIFUSE_WORKSPACE_ID:?set NOTIFUSE_WORKSPACE_ID in .env}'
		)
		env.push('      NOTIFUSE_BASE_URL: ${NOTIFUSE_BASE_URL:?set NOTIFUSE_BASE_URL in .env}')
	}

	const lines = [
		'  auth:',
		'    build:',
		'      context: .',
		'      target: api-runtime',
		'      args:',
		'        APP_PATH: apps/api/auth',
		`        TURBO_FILTER: "@${opts.project}/auth-worker"`,
		`    image: ${opts.project}-auth:latest`,
		'    restart: unless-stopped',
		'    ports:',
		'      - "8787:8787"',
		'    environment:',
		...env,
		...volumeMountLines(opts, '    '),
		...dependsOnDbAndMigrate(opts),
		...healthcheckLines(8787)
	]
	return lines.join('\n')
}

function usersService(opts: DockerOpts): string {
	const env = [
		'      PORT: "8788"',
		...dbEnvLines(opts, '      '),
		'      AUTH_URL: http://auth:8787'
	]

	const lines = [
		'  users:',
		'    build:',
		'      context: .',
		'      target: api-runtime',
		'      args:',
		'        APP_PATH: apps/api/users',
		`        TURBO_FILTER: "@${opts.project}/users-worker"`,
		`    image: ${opts.project}-users:latest`,
		'    restart: unless-stopped',
		'    ports:',
		'      - "8788:8788"',
		'    environment:',
		...env,
		...volumeMountLines(opts, '    '),
		'    depends_on:',
		'      auth:',
		'        condition: service_healthy',
		'      migrate:',
		'        condition: service_completed_successfully',
		...healthcheckLines(8788)
	]
	return lines.join('\n')
}

function webService(opts: DockerOpts): string {
	const env: string[] = ['      ORIGIN: ${ORIGIN:-http://localhost:3000}']

	if (opts.isHono) {
		env.push(
			'      PUBLIC_AUTH_URL: ${PUBLIC_AUTH_URL:-http://localhost:8787/api/auth}',
			'      PUBLIC_API_URL: ${PUBLIC_API_URL:-http://localhost:8788}'
		)
	} else {
		env.push(...dbEnvLines(opts, '      '))
		if (opts.hasAuth) {
			env.push(
				'      BETTER_AUTH_SECRET: ${BETTER_AUTH_SECRET:?set BETTER_AUTH_SECRET in .env}',
				'      BETTER_AUTH_URL: ${BETTER_AUTH_URL:-http://localhost:3000}',
				'      BETTER_AUTH_TRUSTED_ORIGINS: ${BETTER_AUTH_TRUSTED_ORIGINS:-http://localhost:3000}'
			)
		}
		if (opts.wantsGoogle) {
			env.push(
				'      GOOGLE_CLIENT_ID: ${GOOGLE_CLIENT_ID:?set GOOGLE_CLIENT_ID in .env}',
				'      GOOGLE_CLIENT_SECRET: ${GOOGLE_CLIENT_SECRET:?set GOOGLE_CLIENT_SECRET in .env}'
			)
		}
		if (opts.wantsEmailOTP && opts.emailProvider === 'resend') {
			env.push('      RESEND_API_KEY: ${RESEND_API_KEY:?set RESEND_API_KEY in .env}')
		}
		if (opts.wantsEmailOTP && opts.emailProvider === 'notifuse') {
			env.push(
				'      NOTIFUSE_API_KEY: ${NOTIFUSE_API_KEY:?set NOTIFUSE_API_KEY in .env}',
				'      NOTIFUSE_WORKSPACE_ID: ${NOTIFUSE_WORKSPACE_ID:?set NOTIFUSE_WORKSPACE_ID in .env}',
				'      NOTIFUSE_BASE_URL: ${NOTIFUSE_BASE_URL:?set NOTIFUSE_BASE_URL in .env}'
			)
		}
	}

	const dependsOn: string[] = ['    depends_on:']
	if (opts.isHono) {
		dependsOn.push(
			'      auth:',
			'        condition: service_healthy',
			'      users:',
			'        condition: service_healthy'
		)
	} else {
		if (opts.isPostgres) dependsOn.push('      postgres:', '        condition: service_healthy')
		dependsOn.push('      migrate:', '        condition: service_completed_successfully')
	}

	const volumes = opts.isHono ? [] : volumeMountLines(opts, '    ')

	const lines = [
		'  web:',
		'    build:',
		'      context: .',
		'      target: web-runtime',
		'      args:',
		`        TURBO_FILTER: "${opts.project}-web"`,
		`    image: ${opts.project}-web:latest`,
		'    restart: unless-stopped',
		'    ports:',
		'      - "3000:3000"',
		'    environment:',
		...env,
		...volumes,
		...dependsOn,
		...healthcheckLines(3000)
	]
	return lines.join('\n')
}

function dbEnvLines(opts: DockerOpts, indent: string): string[] {
	if (opts.isPostgres) return [`${indent}DATABASE_URL: \${DATABASE_URL:?set DATABASE_URL in .env}`]
	return [`${indent}SQLITE_PATH: file:/data/local.db`]
}

function volumeMountLines(opts: DockerOpts, indent: string): string[] {
	if (opts.isPostgres) return []
	return [`${indent}volumes:`, `${indent}  - sqlite_data:/data`]
}

function dependsOnDb(opts: DockerOpts): string[] {
	if (!opts.isPostgres) return []
	return ['    depends_on:', '      postgres:', '        condition: service_healthy']
}

function dependsOnDbAndMigrate(opts: DockerOpts): string[] {
	const lines = ['    depends_on:']
	if (opts.isPostgres) lines.push('      postgres:', '        condition: service_healthy')
	lines.push('      migrate:', '        condition: service_completed_successfully')
	return lines
}

function healthcheckLines(port: number): string[] {
	return [
		'    healthcheck:',
		`      test: ["CMD", "wget", "--quiet", "--tries=1", "--spider", "http://127.0.0.1:${port}/healthz"]`,
		'      interval: 15s',
		'      timeout: 3s',
		'      retries: 3',
		'      start_period: 10s'
	]
}

function composeVolumes(opts: DockerOpts): string[] {
	return ['volumes:', opts.isPostgres ? '  pgdata:' : '  sqlite_data:']
}
