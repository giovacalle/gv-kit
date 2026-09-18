import { cloudflareProductionWorkerName } from '../lib/cloudflare-worker-name.js'
import type { FileEntry } from '../lib/files.js'
import type { GvKitConfig } from '../schema/config.js'

export function generateIntegratedDeploy(cfg: GvKitConfig): FileEntry[] {
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

function cfWorkersArtifacts(cfg: GvKitConfig): FileEntry[] {
	const project = cfg.choices.name
	const db = cfg.choices.db
	return [
		{
			path: '.github/workflows/deploy-production.yml',
			content: renderProductionDeployWorkflow(project, cfg)
		},
		{
			path: '.github/workflows/deploy-staging.yml',
			content: renderStagingDeployWorkflow({ project, db, cfg })
		},
		{ path: '.github/workflows/cleanup-staging.yml', content: renderStagingCleanupWorkflow(cfg, db) }
	]
}

function marketingMonitoringEnvKeys(cfg: GvKitConfig): string[] {
	if (cfg.choices.marketing !== 'astro') return []
	const keys: string[] = []
	if (cfg.choices.monitoring.includes('umami')) keys.push('PUBLIC_UMAMI_HOST', 'PUBLIC_UMAMI_WEBSITE_ID')
	if (cfg.choices.monitoring.includes('posthog')) keys.push('PUBLIC_POSTHOG_KEY', 'PUBLIC_POSTHOG_HOST')
	return keys
}

function marketingPublicEnvKeys(cfg: GvKitConfig): string[] {
	const keys =
		cfg.choices.marketing === 'astro'
			? ['PUBLIC_MARKETING_URL', 'PUBLIC_APP_URL', ...marketingMonitoringEnvKeys(cfg)]
			: []
	if (cfg.choices.auth.length > 0) keys.push('PUBLIC_AUTH_URL')
	if (cfg.choices.auth.includes('emailOTP')) keys.push('PUBLIC_TURNSTILE_SITE_KEY')
	return keys
}

function renderWorkflowVariableEnvironment(keys: string[]): string {
	if (keys.length === 0) return ''
	return `\n${keys.map((key) => `          ${key}: \${{ vars.${key} }}`).join('\n')}`
}

function renderProductionDeployWorkflow(project: string, cfg: GvKitConfig): string {
	const publicKeys = marketingPublicEnvKeys(cfg)
	const publicOriginEnv = renderWorkflowVariableEnvironment(publicKeys)
	const publicVariableChecks = publicKeys.map((key) => `          test -n "$${key}"`).join('\n')
	return `name: deploy-production

on:
  push:
    branches: [main]
  workflow_dispatch:

jobs:
  deploy:
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
          node-version: '24'
          cache: 'pnpm'
      - run: pnpm install --frozen-lockfile

      - id: scm
        name: Resolve deployment range
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

      - name: Deploy affected Workers
        run: |
${publicVariableChecks ? `${publicVariableChecks}\n` : ''}          pnpm turbo run deploy:production --affected
        env:
          CLOUDFLARE_API_TOKEN: \${{ secrets.CLOUDFLARE_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: \${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
          TURBO_SCM_BASE: \${{ steps.scm.outputs.base }}
          TURBO_SCM_HEAD: \${{ steps.scm.outputs.head }}${publicOriginEnv}
`
}

function renderStagingDeployWorkflow({
	project,
	db,
	cfg
}: {
	project: string
	db: GvKitConfig['choices']['db']
	cfg: GvKitConfig
}): string {
	const hasMarketing = cfg.choices.marketing === 'astro'
	const previewDbJob =
		db === 'sqlite'
			? renderD1PreviewDatabaseJob(project)
			: renderNeonPreviewDatabaseJob(project)
	const stagingConfigStep = renderStagingWranglerConfigStep(db)
	const monitoringKeys = marketingMonitoringEnvKeys(cfg)
	const monitoringEnv = renderWorkflowVariableEnvironment(monitoringKeys)
	const publicOriginEnv = hasMarketing
		? `
          PUBLIC_MARKETING_URL: https://${project}-marketing-\${{ needs.preview-db.outputs.alias }}.\${{ vars.CLOUDFLARE_WORKERS_SUBDOMAIN }}.workers.dev
          PUBLIC_APP_URL: https://${project}-web-\${{ needs.preview-db.outputs.alias }}.\${{ vars.CLOUDFLARE_WORKERS_SUBDOMAIN }}.workers.dev${monitoringEnv}`
		: ''
	return `name: deploy-staging

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
${previewDbJob}

  deploy:
    needs: preview-db
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
          echo "alias=\${{ needs.preview-db.outputs.alias }}" >> $GITHUB_OUTPUT
          echo "short_sha=\${GITHUB_SHA:0:7}" >> $GITHUB_OUTPUT
      - uses: pnpm/action-setup@v4
        with:
          version: 11.1.1
      - uses: actions/setup-node@v4
        with:
          node-version: '24'
          cache: 'pnpm'
      - run: pnpm install --frozen-lockfile

${stagingConfigStep}

      - name: Run preview database migrations
        run: ${renderPreviewMigrationCommand(db)}
        env:
${renderPreviewMigrationEnvironment(db)}

      - name: Deploy affected Workers (staging)
        run: pnpm turbo run deploy:staging --affected
        env:
          CLOUDFLARE_API_TOKEN: \${{ secrets.CLOUDFLARE_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: \${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
          STAGING_ALIAS: \${{ needs.preview-db.outputs.alias }}
          STAGING_WRANGLER_CONFIG: wrangler.staging.jsonc
          TURBO_SCM_BASE: \${{ github.event.pull_request.base.sha }}
          TURBO_SCM_HEAD: \${{ github.event.pull_request.head.sha }}${publicOriginEnv}

      - uses: marocchino/sticky-pull-request-comment@v2
        with:
          header: staging-deploy
          message: |
            🚀 **Staging deployed**

            | Worker | URL |
            |---|---|
            | affected packages | \`${project}-<worker>-\${{ needs.preview-db.outputs.alias }}.<your-workers-subdomain>.workers.dev\` |

            **Commit**: \`\${{ steps.meta.outputs.short_sha }}\`
            **Updated**: \${{ github.event.pull_request.updated_at }}
`
}

function renderStagingWranglerConfigStep(db: GvKitConfig['choices']['db']): string {
	const envLines =
		db === 'sqlite'
			? `          PREVIEW_DB_KIND: d1
          STAGING_D1_DATABASE_NAME: \${{ needs.preview-db.outputs.d1_database_name }}
          STAGING_D1_DATABASE_ID: \${{ needs.preview-db.outputs.d1_database_id }}`
			: `          PREVIEW_DB_KIND: neon
          STAGING_DATABASE_URL: \${{ needs.preview-db.outputs.database_url }}`

	return `      - name: Write temporary staging Wrangler configs
        run: |
          node <<'NODE'
          const fs = require('node:fs')
          const path = require('node:path')
          const { execFileSync } = require('node:child_process')

          function stripJsonc(input) {
            let output = ''
            let inString = false
            let quote = ''
            let escaped = false
            let inLineComment = false
            let inBlockComment = false
            for (let i = 0; i < input.length; i++) {
              const ch = input[i]
              const next = input[i + 1]
              if (inLineComment) {
                if (ch === '\\n') {
                  inLineComment = false
                  output += ch
                }
                continue
              }
              if (inBlockComment) {
                if (ch === '*' && next === '/') {
                  inBlockComment = false
                  i++
                }
                continue
              }
              if (inString) {
                output += ch
                if (escaped) {
                  escaped = false
                } else if (ch === '\\\\') {
                  escaped = true
                } else if (ch === quote) {
                  inString = false
                }
                continue
              }
              if (ch === '"' || ch === "'") {
                inString = true
                quote = ch
                output += ch
                continue
              }
              if (ch === '/' && next === '/') {
                inLineComment = true
                i++
                continue
              }
              if (ch === '/' && next === '*') {
                inBlockComment = true
                i++
                continue
              }
              output += ch
            }
            return output
          }

          const configs = execFileSync('find', ['apps', '-name', 'wrangler.jsonc'], {
            encoding: 'utf8'
          })
            .trim()
            .split('\\n')
            .filter(Boolean)

          for (const configPath of configs) {
            const config = JSON.parse(stripJsonc(fs.readFileSync(configPath, 'utf8')))
            if (process.env.PREVIEW_DB_KIND === 'd1' && Array.isArray(config.d1_databases)) {
              config.d1_databases = config.d1_databases.map((database) =>
                database.binding === 'DB'
                  ? {
                      ...database,
                      database_name: process.env.STAGING_D1_DATABASE_NAME,
                      database_id: process.env.STAGING_D1_DATABASE_ID
                    }
                  : database
              )
            }
            if (process.env.PREVIEW_DB_KIND === 'neon') {
              config.vars = {
                ...(config.vars ?? {}),
                DATABASE_URL: process.env.STAGING_DATABASE_URL
              }
            }
            if (Array.isArray(config.services)) {
              config.services = config.services.map((service) => ({
                ...service,
                service: \`\${service.service}-\${process.env.STAGING_ALIAS}\`
              }))
            }
            fs.writeFileSync(
              path.join(path.dirname(configPath), 'wrangler.staging.jsonc'),
              JSON.stringify(config, null, 2) + '\\n'
            )
          }
          NODE
        env:
          STAGING_ALIAS: \${{ needs.preview-db.outputs.alias }}
${envLines}`
}

function renderPreviewMigrationCommand(db: GvKitConfig['choices']['db']): string {
	return db === 'sqlite'
		? 'pnpm --filter @repo/db exec wrangler d1 migrations apply "${{ needs.preview-db.outputs.d1_database_name }}" --remote'
		: 'pnpm --filter @repo/db db:migrate:production'
}

function renderPreviewMigrationEnvironment(db: GvKitConfig['choices']['db']): string {
	return db === 'sqlite'
		? `          CLOUDFLARE_API_TOKEN: \${{ secrets.CLOUDFLARE_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: \${{ secrets.CLOUDFLARE_ACCOUNT_ID }}`
		: `          DATABASE_URL: \${{ needs.preview-db.outputs.database_url }}`
}

const PREVIEW_ALIAS_SCRIPT = `raw="\${{ github.event.pull_request.head.ref }}"
          alias=$(printf '%s' "$raw" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9-]+/-/g; s/^-+//; s/-+$//; s/-{2,}/-/g' | cut -c1-48)
          if [ -z "$alias" ]; then
            alias="pr-\${{ github.event.pull_request.number }}"
          fi
          echo "alias=$alias" >> "$GITHUB_OUTPUT"`

function renderD1PreviewDatabaseJob(project: string): string {
	return `  preview-db:
    runs-on: ubuntu-latest
    outputs:
      alias: \${{ steps.meta.outputs.alias }}
      d1_database_name: \${{ steps.d1.outputs.database_name }}
      d1_database_id: \${{ steps.d1.outputs.database_id }}
    permissions:
      contents: read
    steps:
      - id: meta
        run: |
          ${PREVIEW_ALIAS_SCRIPT}
      - uses: actions/setup-node@v4
        with:
          node-version: '24'
      - id: d1
        name: Create or reuse D1 preview database
        run: |
          set -euo pipefail
          db_name="${project}-db-\${{ steps.meta.outputs.alias }}"
          db_id=$(npx wrangler d1 list --json | jq -r --arg name "$db_name" '.[] | select(.name == $name) | (.uuid // .id // "")' | head -n 1)
          if [ -z "$db_id" ]; then
            npx wrangler d1 create "$db_name"
            db_id=$(npx wrangler d1 list --json | jq -r --arg name "$db_name" '.[] | select(.name == $name) | (.uuid // .id // "")' | head -n 1)
          fi
          if [ -z "$db_id" ]; then
            echo "Could not resolve D1 database id for $db_name" >&2
            exit 1
          fi
          echo "database_name=$db_name" >> "$GITHUB_OUTPUT"
          echo "database_id=$db_id" >> "$GITHUB_OUTPUT"
        env:
          CLOUDFLARE_API_TOKEN: \${{ secrets.CLOUDFLARE_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: \${{ secrets.CLOUDFLARE_ACCOUNT_ID }}`
}

function renderNeonPreviewDatabaseJob(project: string): string {
	return `  preview-db:
    runs-on: ubuntu-latest
    outputs:
      alias: \${{ steps.meta.outputs.alias }}
      neon_branch_name: \${{ steps.meta.outputs.neon_branch_name }}
      neon_branch_id: \${{ steps.create_neon_branch.outputs.branch_id }}
      database_url: \${{ steps.create_neon_branch.outputs.db_url_pooled }}
    permissions:
      contents: read
    steps:
      - id: meta
        run: |
          ${PREVIEW_ALIAS_SCRIPT}
          echo "neon_branch_name=${project}-db-$alias" >> "$GITHUB_OUTPUT"
      - id: expiration
        run: echo "expires_at=$(date -u --date '+14 days' +'%Y-%m-%dT%H:%M:%SZ')" >> "$GITHUB_OUTPUT"
      - id: create_neon_branch
        name: Create or reuse Neon preview branch
        uses: neondatabase/create-branch-action@v6
        with:
          project_id: \${{ vars.NEON_PROJECT_ID }}
          branch_name: \${{ steps.meta.outputs.neon_branch_name }}
          api_key: \${{ secrets.NEON_API_KEY }}
          expires_at: \${{ steps.expiration.outputs.expires_at }}`
}

function renderStagingCleanupWorkflow(cfg: GvKitConfig, db: GvKitConfig['choices']['db']): string {
	const project = cfg.choices.name
	const previewDbCleanupStep =
		db === 'sqlite'
			? renderD1PreviewDatabaseCleanupStep(project)
			: renderNeonPreviewDatabaseCleanupStep(project)
	const productionNameAliases = ['web', ...(cfg.choices.marketing === 'astro' ? ['marketing'] : [])]
		.map((service) => {
			const legacyName = `${project}-${service}`
			const boundedName = cloudflareProductionWorkerName({ project, service })
			return [boundedName, legacyName] as const
		})
		.filter(([boundedName, legacyName]) => boundedName !== legacyName)
	const previewBaseNameAliases =
		productionNameAliases.length === 0
			? ''
			: `            case "$base_name" in
${productionNameAliases.map(([boundedName, legacyName]) => `              ${boundedName}) base_name=${legacyName} ;;`).join('\n')}
            esac
`
	return `# Cleanup deletes preview resources and the PR branch.

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
      - id: checkout_head
        uses: actions/checkout@v4
        continue-on-error: true
        with:
          fetch-depth: 1
          ref: \${{ github.event.pull_request.head.sha }}
      - id: checkout_base
        if: steps.checkout_head.outcome != 'success'
        uses: actions/checkout@v4
        continue-on-error: true
        with:
          fetch-depth: 1
          ref: \${{ github.event.pull_request.base.sha }}
      - uses: actions/setup-node@v4
        with:
          node-version: '24'
      - id: branch
        run: |
          ${PREVIEW_ALIAS_SCRIPT}

      - name: Delete staging Workers
        if: steps.checkout_head.outcome == 'success' || steps.checkout_base.outcome == 'success'
        run: |
          set -euo pipefail
          find apps -name wrangler.jsonc -print | while read -r config; do
            base_name=$(sed -n 's/.*"name"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p' "$config" | head -n 1)
            if [ -z "$base_name" ]; then
              echo "Skipping $config: no top-level name found"
              continue
            fi
${previewBaseNameAliases}            worker_name="$base_name-\${{ steps.branch.outputs.alias }}"
            echo "Deleting $worker_name"
            npx wrangler delete --name "$worker_name" --force || true
          done
        env:
          CLOUDFLARE_API_TOKEN: \${{ secrets.CLOUDFLARE_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: \${{ secrets.CLOUDFLARE_ACCOUNT_ID }}

      - name: Skip staging Worker cleanup
        if: steps.checkout_head.outcome != 'success' && steps.checkout_base.outcome != 'success'
        run: echo "Could not check out PR head or base; skipping dynamic Worker cleanup."

${previewDbCleanupStep}

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

function renderD1PreviewDatabaseCleanupStep(project: string): string {
	return `      - name: Delete preview D1 database
        run: |
          set -uo pipefail
          db_name="${project}-db-\${{ steps.branch.outputs.alias }}"
          db_id=$(npx wrangler d1 list --json | jq -r --arg name "$db_name" '.[] | select(.name == $name) | (.uuid // .id // "")' | head -n 1)
          if [ -z "$db_id" ]; then
            echo "Preview D1 database $db_name is missing or already deleted."
            exit 0
          fi
          if npx wrangler d1 delete "$db_name" --skip-confirmation; then
            echo "Deleted preview D1 database $db_name."
          else
            echo "Could not delete preview D1 database $db_name; continuing cleanup."
          fi
        env:
          CLOUDFLARE_API_TOKEN: \${{ secrets.CLOUDFLARE_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: \${{ secrets.CLOUDFLARE_ACCOUNT_ID }}`
}

function renderNeonPreviewDatabaseCleanupStep(project: string): string {
	return `      - name: Delete preview Neon branch
        run: |
          set -uo pipefail
          branch_name="${project}-db-\${{ steps.branch.outputs.alias }}"
          branches_json=$(curl -fsS -H "Authorization: Bearer $NEON_API_KEY" "https://console.neon.tech/api/v2/projects/$NEON_PROJECT_ID/branches") || {
              echo "Could not list Neon branches; continuing cleanup."
              exit 0
            }
          branch_id=$(printf '%s' "$branches_json" | jq -r --arg name "$branch_name" '.branches[]? | select(.name == $name) | .id' | head -n 1)
          if [ -z "$branch_id" ]; then
            echo "Preview Neon branch $branch_name is missing or already deleted."
            exit 0
          fi
          if curl -fsS -X DELETE -H "Authorization: Bearer $NEON_API_KEY" "https://console.neon.tech/api/v2/projects/$NEON_PROJECT_ID/branches/$branch_id" >/dev/null; then
            echo "Deleted preview Neon branch $branch_name."
          else
            echo "Could not delete preview Neon branch $branch_name; continuing cleanup."
          fi
        env:
          NEON_PROJECT_ID: \${{ vars.NEON_PROJECT_ID }}
          NEON_API_KEY: \${{ secrets.NEON_API_KEY }}`
}

interface DockerOpts {
	project: string
	isHono: boolean
	isPostgres: boolean
	hasMarketing: boolean
	hasAuth: boolean
	wantsGoogle: boolean
	wantsEmailOTP: boolean
	wantsUmami: boolean
	wantsPosthog: boolean
	emailProvider: Exclude<GvKitConfig['choices']['email'], 'skip'> | null
}

function integratedEmailProvider(
	email: GvKitConfig['choices']['email']
): Exclude<GvKitConfig['choices']['email'], 'skip'> | null {
	switch (email) {
		case 'skip':
			return null
		case 'resend':
		case 'notifuse':
			return email
		default: {
			const _exhaustive: never = email
			return _exhaustive
		}
	}
}

function dockerArtifacts(cfg: GvKitConfig): FileEntry[] {
	const opts: DockerOpts = {
		project: cfg.choices.name,
		isHono: cfg.choices.backend === 'hono',
		isPostgres: cfg.choices.db === 'postgres',
		hasMarketing: cfg.choices.marketing === 'astro',
		hasAuth: cfg.choices.auth.length > 0,
		wantsGoogle: cfg.choices.auth.includes('google'),
		wantsEmailOTP: cfg.choices.auth.includes('emailOTP'),
		wantsUmami: cfg.choices.monitoring.includes('umami'),
		wantsPosthog: cfg.choices.monitoring.includes('posthog'),
		emailProvider: integratedEmailProvider(cfg.choices.email)
	}

	return [
		{ path: '.dockerignore', content: renderDockerignore() },
		{ path: 'Dockerfile', content: renderDockerfile(opts) },
		{ path: 'docker-compose.yml', content: renderDockerCompose(opts) }
	]
}

function renderDockerignore(): string {
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

function renderDockerfile(opts: DockerOpts): string {
	const marketingRuntime = opts.hasMarketing
		? `
FROM nginxinc/nginx-unprivileged:1.28.0-alpine@sha256:c97ff0bf7cbae369953c6da1232ec14ad9f971d66360c5698db0856a4cd657a0 AS marketing-runtime
COPY --chown=101:101 apps/marketing/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=builder --chown=101:101 /repo/apps/marketing/dist/ /usr/share/nginx/html/
EXPOSE 8080
HEALTHCHECK --interval=5s --timeout=2s --start-period=2s --retries=5 \\
    CMD wget --quiet --spider http://127.0.0.1:8080/healthz || exit 1
ENTRYPOINT ["nginx", "-g", "daemon off;"]
`
		: ''
	const publicBuildKeys = opts.hasMarketing
		? [
				'PUBLIC_MARKETING_URL',
				'PUBLIC_APP_URL',
				...(opts.wantsUmami ? ['PUBLIC_UMAMI_HOST', 'PUBLIC_UMAMI_WEBSITE_ID'] : []),
				...(opts.wantsPosthog ? ['PUBLIC_POSTHOG_KEY', 'PUBLIC_POSTHOG_HOST'] : [])
			]
		: []
	const publicBuildArgs = publicBuildKeys.map((key) => `ARG ${key}`).join('\n')
	const publicBuildEnv =
		publicBuildKeys.length > 0
			? `ENV ${publicBuildKeys.map((key) => `${key}=\${${key}}`).join(' \\\n    ')}`
			: ''

	return `# syntax=docker/dockerfile:1.7

ARG NODE_VERSION=24
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
${publicBuildArgs}
${publicBuildEnv}
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

# Compose gates application startup on successful migrations.
FROM deps AS migrate-runtime
COPY --from=builder /repo/packages/db ./packages/db
WORKDIR /repo/packages/db
USER nobody
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["pnpm", "exec", "drizzle-kit", "migrate"]
${marketingRuntime}
`
}

function renderDockerCompose(opts: DockerOpts): string {
	const services: string[] = []
	if (opts.isPostgres) services.push(renderPostgresService())
	services.push(renderMigrateService(opts))
	if (opts.isHono) {
		services.push(renderAuthService(opts))
		services.push(renderUsersService(opts))
	}
	services.push(renderWebService(opts))
	if (opts.hasMarketing) services.push(renderMarketingService(opts))

	return (
		[
			'name: ' + opts.project,
			'services:\n' + services.join('\n\n'),
			composeVolumes(opts).join('\n'),
			`networks:\n  default:\n    name: ${opts.project}_internal`
		].join('\n\n') + '\n'
	)
}

function renderPostgresService(): string {
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

function renderMigrateService(opts: DockerOpts): string {
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

function renderAuthService(opts: DockerOpts): string {
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
	if (opts.wantsEmailOTP && opts.emailProvider === 'resend') env.push('      RESEND_API_KEY: ${RESEND_API_KEY:?set RESEND_API_KEY in .env}')
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

function renderUsersService(opts: DockerOpts): string {
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

function renderWebService(opts: DockerOpts): string {
	const env: string[] = ['      ORIGIN: ${ORIGIN:-http://localhost:3000}']
	const buildArgs = [`        TURBO_FILTER: "${opts.project}-web"`]
	if (opts.hasMarketing) buildArgs.push('        PUBLIC_APP_URL: ${PUBLIC_APP_URL:-http://localhost:3000}')

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
		if (opts.wantsEmailOTP && opts.emailProvider === 'resend') env.push('      RESEND_API_KEY: ${RESEND_API_KEY:?set RESEND_API_KEY in .env}')
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
		...buildArgs,
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

function renderMarketingService(opts: DockerOpts): string {
	const monitoringArgs: string[] = []
	if (opts.wantsUmami) {
		monitoringArgs.push(
			'        PUBLIC_UMAMI_HOST: ${PUBLIC_UMAMI_HOST:-}',
			'        PUBLIC_UMAMI_WEBSITE_ID: ${PUBLIC_UMAMI_WEBSITE_ID:-}'
		)
	}
	if (opts.wantsPosthog) {
		monitoringArgs.push(
			'        PUBLIC_POSTHOG_KEY: ${PUBLIC_POSTHOG_KEY:-}',
			'        PUBLIC_POSTHOG_HOST: ${PUBLIC_POSTHOG_HOST:-}'
		)
	}
	return `  marketing:
    build:
      context: .
      target: marketing-runtime
      args:
        TURBO_FILTER: "${opts.project}-marketing"
        PUBLIC_MARKETING_URL: \${PUBLIC_MARKETING_URL:-http://localhost:4321}
        PUBLIC_APP_URL: \${PUBLIC_APP_URL:-http://localhost:3000}${monitoringArgs.length > 0 ? `\n${monitoringArgs.join('\n')}` : ''}
    image: ${opts.project}-marketing:latest
    restart: unless-stopped
    ports:
      - "4321:8080"
    read_only: true
    tmpfs:
      - /tmp:size=16m,mode=1777
    security_opt:
      - no-new-privileges:true
    healthcheck:
      test: ["CMD", "wget", "--quiet", "--spider", "http://127.0.0.1:8080/healthz"]
      interval: 5s
      timeout: 2s
      retries: 5
      start_period: 2s`
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
