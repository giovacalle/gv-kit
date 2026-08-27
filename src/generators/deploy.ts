import type { FileEntry } from '../lib/files.js'
import type { GvKitConfig } from '../schema/config.js'
import {
	AUTH_SERVICE,
	dockerServiceOrigin,
	HONO_GATEWAY,
	honoPackageIdentity,
	honoServiceName,
	USERS_SERVICE
} from './hono-topology.js'
import { generateIntegratedDeploy } from './integrated-deploy.js'

export function generateDeploy(cfg: GvKitConfig): FileEntry[] {
	if (cfg.choices.backend === 'inside-frontend') return generateIntegratedDeploy(cfg)

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

const WRANGLER_VERSION = '4.125.0'

function cfWorkersArtifacts(cfg: GvKitConfig): FileEntry[] {
	const project = cfg.choices.name
	const db = cfg.choices.db
	return [
		{
			path: '.github/workflows/deploy-production.yml',
			content: deployProductionWorkflow(project, cfg)
		},
		{
			path: '.github/workflows/deploy-staging.yml',
			content: deployStagingWorkflow({ project, db, cfg })
		},
		{ path: '.github/workflows/cleanup-staging.yml', content: cleanupStagingWorkflow(project, db) },
		{
			path: 'scripts/cloudflare-preview-name.mjs',
			content: cloudflarePreviewNameScript()
		},
		{
			path: 'scripts/verify-cloudflare-preview-ingress.mjs',
			content: verifyCloudflarePreviewIngressScript()
		},
		{
			path: 'scripts/prepare-cloudflare-preview.mjs',
			content: prepareCloudflarePreviewScript()
		},
		{
			path: 'scripts/cleanup-cloudflare-preview-workers.sh',
			content: cleanupCloudflarePreviewWorkersScript()
		},
		...(cfg.choices.backend === 'hono'
			? [
					{
						path: 'scripts/write-cloudflare-preview-secrets.mjs',
						content: writeCloudflarePreviewSecretsScript(cfg, db)
					}
				]
			: []),
		{
			path: 'scripts/resolve-cloudflare-deploy-range.sh',
			content: resolveCloudflareDeployRangeScript()
		}
	]
}

function resolveCloudflareDeployRangeScript(): string {
	return `#!/bin/sh
set -eu

zero_sha=0000000000000000000000000000000000000000
head="\${GITHUB_SHA:-$(git rev-parse HEAD)}"
base="\${BEFORE_SHA:-}"
deploy_all=false

if [ -z "$base" ] || [ "$base" = "$zero_sha" ] || ! git cat-file -e "$base^{commit}" 2>/dev/null; then
	base="$head"
	deploy_all=true
fi

{
	echo "base=$base"
	echo "head=$head"
	echo "deploy_all=$deploy_all"
} >> "$GITHUB_OUTPUT"
`
}

function cloudflarePreviewNameScript(): string {
	return `import { createHash } from 'node:crypto'

const MAX_WORKERS_DEV_NAME_LENGTH = 63
const MAX_PREVIEW_ALIAS_LENGTH = 48

export function validateCloudflarePreviewAlias(alias) {
	if (typeof alias !== 'string' || !/^pr-[1-9][0-9]*$/.test(alias)) throw new Error('Preview alias must use the canonical pr-<positive integer> format')
	if (alias.length > MAX_PREVIEW_ALIAS_LENGTH) throw new Error('Preview alias exceeds ' + MAX_PREVIEW_ALIAS_LENGTH + ' characters')
	return alias
}

export function cloudflarePreviewAlias(previewId) {
	const id = String(previewId)
	if (!/^[1-9][0-9]*$/.test(id)) throw new Error('Preview id must be a positive integer')
	return validateCloudflarePreviewAlias('pr-' + id)
}

export function cloudflarePreviewName(productionName, alias) {
	validateCloudflarePreviewAlias(alias)
	const directName = productionName + '-' + alias
	if (directName.length <= MAX_WORKERS_DEV_NAME_LENGTH) return directName

	const digest = createHash('sha256').update(productionName).digest('hex').slice(0, 10)
	const suffix = '-' + digest + '-' + alias
	const prefix = productionName
		.slice(0, MAX_WORKERS_DEV_NAME_LENGTH - suffix.length)
		.replace(/-+$/, '')
	if (!prefix) throw new Error('Could not derive a preview Worker name for ' + productionName)
	return prefix + suffix
}

const [command, value] = process.argv.slice(2)
if (command === '--from-id' && value) console.log(cloudflarePreviewAlias(value))
else if (command === '--validate' && value) console.log(validateCloudflarePreviewAlias(value))
else if (command && value) console.log(cloudflarePreviewName(command, value))
`
}

function verifyCloudflarePreviewIngressScript(): string {
	return `function required(name) {
	const value = process.env[name]?.trim()
	if (!value) throw new Error(name + ' is required')
	return value
}

function domain(name) {
	const value = required(name).toLowerCase().replace(/\\.$/, '')
	if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(value)) throw new Error(name + ' must be a plain DNS hostname without a wildcard')
	return value
}

function requireManagedParent(name, zone) {
	const value = domain(name)
	if (value !== zone && !value.endsWith('.' + zone)) throw new Error(name + ' must belong to CLOUDFLARE_PREVIEW_ZONE_NAME')
	return value
}

async function cloudflare(pathname, token) {
	const response = await fetch('https://api.cloudflare.com/client/v4' + pathname, {
		headers: { Authorization: 'Bearer ' + token }
	})
	const payload = await response.json()
	if (!response.ok || payload.success !== true) throw new Error('Cloudflare preview ingress prerequisite check failed for ' + pathname)
	return payload.result
}

const token = required('CLOUDFLARE_API_TOKEN')
const zoneName = domain('CLOUDFLARE_PREVIEW_ZONE_NAME')
const webDomain = requireManagedParent('CLOUDFLARE_PREVIEW_WEB_DOMAIN', zoneName)
const apiDomain = requireManagedParent('CLOUDFLARE_PREVIEW_API_DOMAIN', zoneName)
if (webDomain === apiDomain) throw new Error('Managed preview web and API domains must be distinct')

const zones = await cloudflare('/zones?name=' + encodeURIComponent(zoneName) + '&status=active', token)
if (!Array.isArray(zones) || zones.length !== 1) throw new Error('CLOUDFLARE_PREVIEW_ZONE_NAME must identify exactly one active Cloudflare zone')
const zoneId = zones[0]?.id
if (typeof zoneId !== 'string' || !zoneId) throw new Error('Cloudflare preview zone has no id')

for (const parent of [webDomain, apiDomain]) {
	const wildcard = '*.' + parent
	const records = await cloudflare(
		'/zones/' + zoneId + '/dns_records?name=' + encodeURIComponent(wildcard),
		token
	)
	if (!Array.isArray(records) || !records.some((record) => record.name === wildcard && record.proxied === true)) throw new Error('Missing proxied shared wildcard DNS record: ' + wildcard)
}

console.log('Managed Cloudflare preview ingress prerequisites verified.')
`
}

function cleanupCloudflarePreviewWorkersScript(): string {
	return `#!/bin/sh
set -eu

alias="\${1:?preview alias is required}"
# Deleting each preview Worker also removes its attached PR-scoped routes.
# Shared wildcard DNS records are prerequisites and are never deleted here.
set --
[ ! -d apps ] || set -- "$@" apps
[ ! -d services ] || set -- "$@" services
if [ "$#" -eq 0 ]; then
	echo "Could not inventory preview Workers: apps and services directories are missing." >&2
	exit 1
fi

configs=$(find "$@" -name wrangler.jsonc -print)
if [ -z "$configs" ]; then
	echo "Could not inventory preview Workers: no Wrangler configurations found." >&2
	exit 1
fi

printf '%s\\n' "$configs" | while read -r config; do
	base_name=$(sed -n 's/.*"name"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p' "$config" | head -n 1)
	if [ -z "$base_name" ]; then
		echo "Could not inventory preview Worker from $config: no top-level name found." >&2
		exit 1
	fi
	worker_name=$(node scripts/cloudflare-preview-name.mjs "$base_name" "$alias")
	deployments=$(npx wrangler@${WRANGLER_VERSION} deployments list --name "$worker_name" --json)
	deployment_count=$(printf '%s' "$deployments" | jq 'length')
	if [ "$deployment_count" -eq 0 ]; then
		echo "Preview Worker $worker_name is missing or already deleted."
		continue
	fi
	echo "Deleting $worker_name"
	npx wrangler@${WRANGLER_VERSION} delete --name "$worker_name" --force
	echo "Deleted $worker_name and its attached preview routes."
done
`
}

function prepareCloudflarePreviewScript(): string {
	return `import { appendFileSync, existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { cloudflarePreviewName } from './cloudflare-preview-name.mjs'

function required(name) {
	const value = process.env[name]
	if (!value) throw new Error(name + ' is required')
	return value
}

function stripJsonc(input) {
	let output = ''
	let inString = false
	let quote = ''
	let escaped = false
	let inLineComment = false
	let inBlockComment = false
	for (let index = 0; index < input.length; index++) {
		const character = input[index]
		const next = input[index + 1]
		if (inLineComment) {
			if (character === '\\n') {
				inLineComment = false
				output += character
			}
			continue
		}
		if (inBlockComment) {
			if (character === '*' && next === '/') {
				inBlockComment = false
				index++
			}
			continue
		}
		if (inString) {
			output += character
			if (escaped) escaped = false
			else if (character === '\\\\') escaped = true
			else if (character === quote) inString = false
			continue
		}
		if (character === '"' || character === "'") {
			inString = true
			quote = character
			output += character
			continue
		}
		if (character === '/' && next === '/') {
			inLineComment = true
			index++
			continue
		}
		if (character === '/' && next === '*') {
			inBlockComment = true
			index++
			continue
		}
		output += character
	}
	return output
}

function findWranglerConfigs(directory) {
	if (!existsSync(directory)) return []
	const found = []
	for (const name of readdirSync(directory)) {
		const candidate = path.join(directory, name)
		if (statSync(candidate).isDirectory()) found.push(...findWranglerConfigs(candidate))
		else if (name === 'wrangler.jsonc') found.push(candidate)
	}
	return found
}

const alias = required('STAGING_ALIAS')
if (!/^[a-z][a-z0-9-]{0,47}$/.test(alias)) throw new Error('STAGING_ALIAS must start with a lowercase letter and contain only lowercase letters, numbers, and dashes')
const hasHonoGateway = existsSync('apps/api/wrangler.jsonc') && existsSync('services')
const hostnamePattern = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/
function domain(name) {
	const value = required(name).trim().toLowerCase().replace(/\\.$/, '')
	if (!hostnamePattern.test(value)) throw new Error(name + ' must be a plain DNS hostname without a wildcard')
	return value
}
const previewZoneName = domain('CLOUDFLARE_PREVIEW_ZONE_NAME')
const previewWebDomain = domain('CLOUDFLARE_PREVIEW_WEB_DOMAIN')
const previewApiDomain = domain('CLOUDFLARE_PREVIEW_API_DOMAIN')
for (const [name, value] of [
	['CLOUDFLARE_PREVIEW_WEB_DOMAIN', previewWebDomain],
	['CLOUDFLARE_PREVIEW_API_DOMAIN', previewApiDomain]
]) if (value !== previewZoneName && !value.endsWith('.' + previewZoneName)) throw new Error(name + ' must belong to CLOUDFLARE_PREVIEW_ZONE_NAME')
if (previewWebDomain === previewApiDomain) throw new Error('Managed preview web and API domains must be distinct')
const localHosts = ['localhost:3000', 'localhost:5173', 'localhost:8786', '127.0.0.1:8786']
const localOrigins = [
	'http://localhost:3000',
	'http://localhost:5173',
	'http://localhost:8786',
	'http://127.0.0.1:8786'
]
const sources = [...findWranglerConfigs('apps'), ...findWranglerConfigs('services')]
	.sort()
	.map((configPath) => {
		const normalizedPath = configPath.split(path.sep).join('/')
		const config = JSON.parse(stripJsonc(readFileSync(configPath, 'utf8')))
		const productionName = config.name
		if (typeof productionName !== 'string' || productionName.length === 0) throw new Error(configPath + ' has no Worker name')
		return { config, configPath, normalizedPath, productionName }
	})
const previewNames = new Map(
	sources.map(({ productionName }) => [productionName, cloudflarePreviewName(productionName, alias)])
)
const gatewayProductionName = sources.find(
	({ normalizedPath }) => normalizedPath === 'apps/api/wrangler.jsonc'
)?.productionName
const webProductionName = sources.find(
	({ normalizedPath }) => normalizedPath === 'apps/web/wrangler.jsonc'
)?.productionName
const marketingProductionName = sources.find(
	({ normalizedPath }) => normalizedPath === 'apps/marketing/wrangler.jsonc'
)?.productionName
const gatewayName = gatewayProductionName ? previewNames.get(gatewayProductionName) : null
const webName = webProductionName ? previewNames.get(webProductionName) : null
const marketingName = marketingProductionName ? previewNames.get(marketingProductionName) : null
if (hasHonoGateway && (!gatewayName || !webName)) throw new Error('Could not derive public preview Worker names')
const apiOrigin = gatewayName ? new URL('https://' + alias + '.' + previewApiDomain) : null
const webOrigin = webName ? new URL('https://' + alias + '.' + previewWebDomain) : null
const marketingOrigin = marketingName
	? new URL('https://' + alias + '-marketing.' + previewWebDomain)
	: null
const inventory = []

for (const { config, configPath, normalizedPath, productionName } of sources) {
	config.name = previewNames.get(productionName)
	delete config.route
	delete config.routes

	const isPrivateService = normalizedPath.startsWith('services/')
	config.workers_dev = false
	config.preview_urls = false
	if (normalizedPath === 'apps/api/wrangler.jsonc' && apiOrigin && webOrigin) {
		config.routes = [
			{ pattern: apiOrigin.host + '/*', zone_name: previewZoneName },
			{ pattern: webOrigin.host + '/api', zone_name: previewZoneName },
			{ pattern: webOrigin.host + '/api/*', zone_name: previewZoneName }
		]
	}
	if (normalizedPath === 'apps/web/wrangler.jsonc' && webOrigin) config.routes = [{ pattern: webOrigin.host + '/*', zone_name: previewZoneName }]
	if (normalizedPath === 'apps/marketing/wrangler.jsonc' && marketingOrigin) config.routes = [{ pattern: marketingOrigin.host + '/*', zone_name: previewZoneName }]
	if (isPrivateService) delete config.routes

	if (process.env.PREVIEW_DB_KIND === 'd1' && Array.isArray(config.d1_databases)) {
		const databaseName = required('STAGING_D1_DATABASE_NAME')
		const databaseId = required('STAGING_D1_DATABASE_ID')
		config.d1_databases = config.d1_databases.map((database) =>
			database.binding === 'DB'
				? { ...database, database_name: databaseName, database_id: databaseId }
				: database
		)
	}

	if (normalizedPath === 'apps/api/wrangler.jsonc' && apiOrigin && webOrigin) {
		config.vars = {
			...(config.vars ?? {}),
			API_PUBLIC_ORIGIN: apiOrigin.origin,
			GATEWAY_PUBLIC_ORIGINS: [webOrigin.origin, apiOrigin.origin, ...localOrigins].join(','),
			API_CORS_ORIGINS: [webOrigin.origin, ...localOrigins].join(',')
		}
	}
	if (normalizedPath === 'services/auth/wrangler.jsonc' && apiOrigin && webOrigin) {
		config.vars = {
			...(config.vars ?? {}),
			BETTER_AUTH_ALLOWED_HOSTS: [webOrigin.host, apiOrigin.host, ...localHosts].join(','),
			AUTH_CORS_ORIGINS: [webOrigin.origin, apiOrigin.origin, ...localOrigins].join(',')
		}
	}
	if (Array.isArray(config.services)) {
		config.services = config.services.map((service) => ({
			...service,
			service:
				previewNames.get(service.service) ?? cloudflarePreviewName(service.service, alias)
		}))
	}

	const outputPath = path.join(path.dirname(configPath), 'wrangler.staging.jsonc')
	writeFileSync(outputPath, JSON.stringify(config, null, 2) + '\\n')
	inventory.push({
		config: normalizedPath,
		name: config.name,
		public: config.workers_dev,
		services: config.services ?? [],
		databases: config.d1_databases ?? []
	})
}

if (inventory.length === 0) throw new Error('No Wrangler configurations found')
if (process.env.GITHUB_OUTPUT && webOrigin) {
	appendFileSync(
		process.env.GITHUB_OUTPUT,
		(apiOrigin ? 'api_worker_name=' + gatewayName + '\\napi_origin=' + apiOrigin.origin + '\\n' : '') +
		'web_worker_name=' + webName + '\\n' +
		'web_origin=' + webOrigin.origin + '\\n' +
		(marketingOrigin
			? 'marketing_worker_name=' + marketingName + '\\nmarketing_origin=' + marketingOrigin.origin + '\\n'
			: '')
	)
}
console.log(JSON.stringify({
	alias,
	apiOrigin: apiOrigin?.origin ?? null,
	webOrigin: webOrigin?.origin ?? null,
	marketingOrigin: marketingOrigin?.origin ?? null,
	workers: inventory
}, null, 2))
`
}

function writeCloudflarePreviewSecretsScript(
	cfg: GvKitConfig,
	db: GvKitConfig['choices']['db']
): string {
	const authSources = previewAuthSecretKeys(cfg).map((key) => [key, key])
	if (db === 'postgres') authSources.push(['DATABASE_URL', 'STAGING_DATABASE_URL'])
	const usersSources = db === 'postgres' ? [['DATABASE_URL', 'STAGING_DATABASE_URL']] : []
	return `import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const outputDirectory = process.argv[2]
if (!outputDirectory) throw new Error('An output directory is required')
mkdirSync(outputDirectory, { recursive: true, mode: 0o700 })
chmodSync(outputDirectory, 0o700)

function writeSecrets(fileName, sources) {
	if (sources.length === 0) return
	const secrets = {}
	for (const [secretName, environmentName] of sources) {
		const value = process.env[environmentName]
		if (!value) throw new Error(environmentName + ' is required')
		secrets[secretName] = value
	}
	const filePath = path.join(outputDirectory, fileName)
	writeFileSync(filePath, JSON.stringify(secrets) + '\\n', { encoding: 'utf8', mode: 0o600 })
	chmodSync(filePath, 0o600)
}

writeSecrets('auth.json', ${JSON.stringify(authSources)})
writeSecrets('users.json', ${JSON.stringify(usersSources)})
`
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
	if (cfg.choices.auth.length > 0 && cfg.choices.backend === 'inside-frontend') keys.push('PUBLIC_AUTH_URL')
	if (cfg.choices.auth.includes('emailOTP')) keys.push('PUBLIC_TURNSTILE_SITE_KEY')
	return keys
}

function workflowVariableRequirements(keys: string[]): string {
	if (keys.length === 0) return ''
	return `# Required GitHub Variables:\n${keys.map((key) => `#   - ${key}`).join('\n')}\n#\n`
}

function workflowVariableEnv(keys: string[]): string {
	if (keys.length === 0) return ''
	return `\n${keys.map((key) => `          ${key}: \${{ vars.${key} }}`).join('\n')}`
}

type CloudflareDeployStage = 'production' | 'staging'

function honoDeploymentSteps({
	cfg,
	stage,
	env,
	phase = 'all',
	marketingEnv = '',
	marketingVariableChecks = ''
}: {
	cfg: GvKitConfig
	stage: CloudflareDeployStage
	env: string
	phase?: 'all' | 'gateway' | 'private' | 'public'
	marketingEnv?: string
	marketingVariableChecks?: string
}): string {
	const project = cfg.choices.name
	const targets = [
		{
			label: 'auth',
			packageName: honoPackageIdentity(project, AUTH_SERVICE),
			phase: 'private',
			secretsFile:
				stage === 'staging' ? '${{ steps.preview_secrets.outputs.auth_file }}' : undefined
		},
		{
			label: 'users',
			packageName: honoPackageIdentity(project, USERS_SERVICE),
			phase: 'private',
			secretsFile:
				stage === 'staging' && cfg.choices.db === 'postgres'
					? '${{ steps.preview_secrets.outputs.users_file }}'
					: undefined
		},
		{ label: 'gateway', packageName: honoPackageIdentity(project, HONO_GATEWAY), phase: 'gateway' },
		...(cfg.choices.marketing === 'astro'
			? [{ label: 'marketing', packageName: `${project}-marketing`, phase: 'public' }]
			: []),
		{ label: 'web', packageName: `${project}-web`, phase: 'public' }
	].filter((target) => phase === 'all' || target.phase === phase)
	return targets
		.map(({ label, packageName, secretsFile }) => {
			const isMarketing = label === 'marketing'
			return `      - name: Deploy ${label} Worker
        run: |
${isMarketing && marketingVariableChecks ? `${marketingVariableChecks}\n` : ''}          if [ "$DEPLOY_ALL" = "true" ]; then
            pnpm turbo run build --filter=${packageName}
            pnpm --filter ${packageName} deploy:${stage}
          else
            pnpm turbo run deploy:${stage} --affected --filter=${packageName}
          fi
        env:
${env}${isMarketing ? marketingEnv : ''}${secretsFile ? `\n          STAGING_SECRETS_FILE: ${secretsFile}` : ''}`
		})
		.join('\n\n')
}

function deployProductionWorkflow(project: string, cfg: GvKitConfig): string {
	const monitoringKeys = marketingMonitoringEnvKeys(cfg)
	const publicKeys = marketingPublicEnvKeys(cfg)
	const nonMonitoringPublicKeys = publicKeys.filter((key) => !monitoringKeys.includes(key))
	const publicOriginRequirements = workflowVariableRequirements(publicKeys)
	const publicOriginEnv = workflowVariableEnv(nonMonitoringPublicKeys)
	const monitoringEnv = workflowVariableEnv(monitoringKeys)
	const publicVariableChecks = nonMonitoringPublicKeys
		.map((key) => `          test -n "$${key}"`)
		.join('\n')
	const monitoringVariableChecks = monitoringKeys
		.map((key) => `          test -n "$${key}"`)
		.join('\n')
	const deployEnv = `          DEPLOY_ALL: \${{ github.event_name == 'workflow_dispatch' || steps.scm.outputs.deploy_all == 'true' }}
          CLOUDFLARE_API_TOKEN: \${{ secrets.CLOUDFLARE_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: \${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
          TURBO_SCM_BASE: \${{ steps.scm.outputs.base }}
          TURBO_SCM_HEAD: \${{ steps.scm.outputs.head }}${publicOriginEnv}`
	const deploymentSteps =
		cfg.choices.backend === 'hono'
			? honoDeploymentSteps({
					cfg,
					stage: 'production',
					env: deployEnv,
					marketingEnv: monitoringEnv,
					marketingVariableChecks: monitoringVariableChecks
				})
			: `      - name: Deploy affected Workers
        run: |
${publicVariableChecks ? `${publicVariableChecks}\n` : ''}          pnpm turbo run deploy:production --affected
        env:
${deployEnv}`
	return `# Deploy ${project} to production on push to main.
#
# Required GitHub Secrets:
#   - CLOUDFLARE_API_TOKEN
#   - CLOUDFLARE_ACCOUNT_ID
#
${publicOriginRequirements}
# Add per-Worker secrets ahead of time via \`wrangler secret put\` — this
# workflow does not push secrets, only code.

name: deploy-production

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
        run: sh scripts/resolve-cloudflare-deploy-range.sh
        env:
          BEFORE_SHA: \${{ github.event.before }}

      - id: db_changes
        name: Check DB migration inputs
        run: |
          if [ "\${{ steps.scm.outputs.deploy_all }}" = "true" ]; then
            echo "should_run=true" >> "$GITHUB_OUTPUT"
          elif git diff --name-only "\${{ steps.scm.outputs.base }}" "\${{ steps.scm.outputs.head }}" | grep -E '^packages/db/(migrations/|src/schema/|drizzle\\.config\\.ts)'; then
            echo "should_run=true" >> "$GITHUB_OUTPUT"
          else
            echo "should_run=false" >> "$GITHUB_OUTPUT"
          fi

      - name: Run production database migrations
        if: steps.db_changes.outputs.should_run == 'true' || github.event_name == 'workflow_dispatch'
        run: pnpm --filter @repo/db db:migrate:production
        env:
          DATABASE_URL: \${{ secrets.DATABASE_URL }}
          CLOUDFLARE_API_TOKEN: \${{ secrets.CLOUDFLARE_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: \${{ secrets.CLOUDFLARE_ACCOUNT_ID }}

      - name: Skip database migrations
        if: steps.db_changes.outputs.should_run != 'true' && github.event_name != 'workflow_dispatch'
        run: echo "No database migration inputs changed."

${
	publicVariableChecks
		? `      - name: Validate public deployment variables
        run: |
${publicVariableChecks}
        env:${publicOriginEnv}

`
		: ''
}${deploymentSteps}
`
}

function previewAuthSecretKeys(cfg: GvKitConfig): string[] {
	const keys = ['BETTER_AUTH_SECRET']
	if (cfg.choices.auth.includes('google')) keys.push('GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET')
	if (cfg.choices.auth.includes('emailOTP')) {
		keys.push('TURNSTILE_SECRET_KEY')
		if (cfg.choices.email === 'resend') keys.push('RESEND_API_KEY', 'FROM_EMAIL')
		if (cfg.choices.email === 'notifuse') keys.push('NOTIFUSE_API_KEY', 'NOTIFUSE_WORKSPACE_ID', 'NOTIFUSE_BASE_URL')
	}
	return keys
}

function previewPrivateSecretsStep(cfg: GvKitConfig, db: GvKitConfig['choices']['db']): string {
	const authSecrets = previewAuthSecretKeys(cfg)
	const env = authSecrets
		.map((key) => `          ${key}: \${{ secrets.${key} }}`)
		.concat(
			db === 'postgres'
				? [`          STAGING_DATABASE_URL: \${{ needs.preview-db.outputs.database_url }}`]
				: []
		)
		.join('\n')
	const usersOutput =
		db === 'postgres'
			? `\n          echo "users_file=$secret_dir/users.json" >> "$GITHUB_OUTPUT"`
			: ''
	return `      - id: preview_secrets
        name: Write private Worker preview secret files
        run: |
          set -euo pipefail
          secret_dir="$RUNNER_TEMP/gv-kit-preview-secrets"
          umask 077
          node scripts/write-cloudflare-preview-secrets.mjs "$secret_dir"
          echo "auth_file=$secret_dir/auth.json" >> "$GITHUB_OUTPUT"${usersOutput}
        env:
${env}`
}

function deployStagingWorkflow({
	project,
	db,
	cfg
}: {
	project: string
	db: GvKitConfig['choices']['db']
	cfg: GvKitConfig
}): string {
	const hasMarketing = cfg.choices.marketing === 'astro'
	const isHono = cfg.choices.backend === 'hono'
	const monitoringKeys = marketingMonitoringEnvKeys(cfg)
	const previewPublicKeys = cfg.choices.auth.includes('emailOTP')
		? ['PUBLIC_TURNSTILE_SITE_KEY']
		: []
	const previewIngressGate = isHono
		? honoPreviewIngressGateJob({ publicKeys: previewPublicKeys })
		: ''
	const basePreviewDbJob = db === 'sqlite' ? d1PreviewDbJob(project) : neonPreviewDbJob(project)
	const previewDbJob = isHono
		? basePreviewDbJob.replace('  preview-db:\n', '  preview-db:\n    needs: preview-ingress\n')
		: basePreviewDbJob
	const stagingConfigStep = writeStagingWranglerConfigStep({ db })
	const requiredVariables = [
		'CLOUDFLARE_PREVIEW_WEB_DOMAIN',
		'CLOUDFLARE_PREVIEW_API_DOMAIN',
		'CLOUDFLARE_PREVIEW_ZONE_NAME',
		...monitoringKeys,
		...previewPublicKeys
	]
	const publicOriginRequirement = workflowVariableRequirements(requiredVariables)
	const authSecretRequirements = isHono
		? previewAuthSecretKeys(cfg)
				.map((key) => `#   - ${key}`)
				.join('\n') + '\n'
		: ''
	const monitoringEnv = workflowVariableEnv(monitoringKeys)
	const previewPublicEnv = workflowVariableEnv(previewPublicKeys)
	const publicOriginEnv = `${
		hasMarketing
			? `
          PUBLIC_MARKETING_URL: \${{ steps.preview_config.outputs.marketing_origin }}
          PUBLIC_APP_URL: \${{ steps.preview_config.outputs.web_origin }}`
			: ''
	}${previewPublicEnv}`
	const deployEnv = `          DEPLOY_ALL: \${{ github.event.action != 'synchronize' }}
          CLOUDFLARE_API_TOKEN: \${{ secrets.CLOUDFLARE_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: \${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
          STAGING_ALIAS: \${{ needs.preview-db.outputs.alias }}
          STAGING_WRANGLER_CONFIG: wrangler.staging.jsonc
          TURBO_SCM_BASE: \${{ github.event.pull_request.base.sha }}
          TURBO_SCM_HEAD: \${{ github.event.pull_request.head.sha }}${publicOriginEnv}`
	const privateDeployments = isHono
		? honoDeploymentSteps({ cfg, stage: 'staging', env: deployEnv, phase: 'private' })
		: ''
	const gatewayDeployment = isHono
		? honoDeploymentSteps({ cfg, stage: 'staging', env: deployEnv, phase: 'gateway' })
		: ''
	const publicDeployments = isHono
		? honoDeploymentSteps({
				cfg,
				stage: 'staging',
				env: deployEnv,
				phase: 'public',
				marketingEnv: monitoringEnv
			})
		: `      - name: Deploy affected Workers (staging)
        run: pnpm turbo run deploy:staging --affected
        env:
${deployEnv}`
	const privateSecretsStep = isHono ? `\n\n${previewPrivateSecretsStep(cfg, db)}` : ''
	const removePrivateSecretsStep = isHono
		? `      - name: Remove private Worker preview secret files
        if: always()
        run: rm -rf "$RUNNER_TEMP/gv-kit-preview-secrets"`
		: ''
	return `# Per-PR staging deploy for ${project}.
# Staging uses PR-scoped preview database resources and temporary Wrangler configs.
# Tear-down lives in cleanup-staging.yml.
#
# Required GitHub Secrets:
#   - CLOUDFLARE_API_TOKEN (including Zone Read and DNS Read for preview ingress validation)
#   - CLOUDFLARE_ACCOUNT_ID
${authSecretRequirements}${db === 'postgres' ? '#   - NEON_API_KEY\n# Required GitHub Variables:\n#   - NEON_PROJECT_ID\n' : ''}${publicOriginRequirement}

name: deploy-staging

on:
  pull_request:
    types: [opened, synchronize, reopened]
    paths-ignore:
      - '**.md'
      - '.github/**'
  workflow_dispatch:

concurrency:
  group: staging-pr-\${{ github.event.pull_request.number || github.run_id }}
  cancel-in-progress: true

jobs:
${previewIngressGate}
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
          ref: \${{ github.event.pull_request.head.sha || github.sha }}
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
        run: ${previewMigrationCommand(db)}
        env:
${previewMigrationEnv(db)}

${privateSecretsStep}

${privateDeployments}

${removePrivateSecretsStep}

${gatewayDeployment}

${publicDeployments}

      - uses: marocchino/sticky-pull-request-comment@v2
        if: github.event_name == 'pull_request'
        with:
          header: staging-deploy
          message: |
            **Staging deployed**

            | Public endpoint | URL |
            |---|---|
            | web | \`\${{ steps.preview_config.outputs.web_origin }}\` |
            | canonical API | \`\${{ steps.preview_config.outputs.api_origin }}\` |

            **Commit**: \`\${{ steps.meta.outputs.short_sha }}\`
            **Updated**: \${{ github.event.pull_request.updated_at }}
`
}

function writeStagingWranglerConfigStep({ db }: { db: GvKitConfig['choices']['db'] }): string {
	const envLines =
		db === 'sqlite'
			? `          PREVIEW_DB_KIND: d1
          STAGING_D1_DATABASE_NAME: \${{ needs.preview-db.outputs.d1_database_name }}
          STAGING_D1_DATABASE_ID: \${{ needs.preview-db.outputs.d1_database_id }}`
			: `          PREVIEW_DB_KIND: neon
          STAGING_DATABASE_URL: \${{ needs.preview-db.outputs.database_url }}`
	return `      - id: preview_config
        name: Write temporary staging Wrangler configs
        run: node scripts/prepare-cloudflare-preview.mjs
        env:
          STAGING_ALIAS: \${{ needs.preview-db.outputs.alias }}
          CLOUDFLARE_PREVIEW_WEB_DOMAIN: \${{ vars.CLOUDFLARE_PREVIEW_WEB_DOMAIN }}
          CLOUDFLARE_PREVIEW_API_DOMAIN: \${{ vars.CLOUDFLARE_PREVIEW_API_DOMAIN }}
          CLOUDFLARE_PREVIEW_ZONE_NAME: \${{ vars.CLOUDFLARE_PREVIEW_ZONE_NAME }}
${envLines}`
}

function previewMigrationCommand(db: GvKitConfig['choices']['db']): string {
	return db === 'sqlite'
		? 'pnpm --filter @repo/db exec wrangler d1 migrations apply "${{ needs.preview-db.outputs.d1_database_name }}" --remote'
		: 'pnpm --filter @repo/db db:migrate:production'
}

function previewMigrationEnv(db: GvKitConfig['choices']['db']): string {
	return db === 'sqlite'
		? `          CLOUDFLARE_API_TOKEN: \${{ secrets.CLOUDFLARE_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: \${{ secrets.CLOUDFLARE_ACCOUNT_ID }}`
		: `          DATABASE_URL: \${{ needs.preview-db.outputs.database_url }}`
}

function honoPreviewIngressGateJob({ publicKeys }: { publicKeys: string[] }): string {
	const publicVariableValidation =
		publicKeys.length === 0
			? ''
			: `      - name: Validate preview public variables
        run: |
${publicKeys.map((key) => `          test -n "$${key}"`).join('\n')}
        env:${workflowVariableEnv(publicKeys)}
`
	return `  preview-ingress:
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@v4
${publicVariableValidation}      - name: Verify managed preview ingress
        run: node scripts/verify-cloudflare-preview-ingress.mjs
        env:
          CLOUDFLARE_API_TOKEN: \${{ secrets.CLOUDFLARE_API_TOKEN }}
          CLOUDFLARE_PREVIEW_WEB_DOMAIN: \${{ vars.CLOUDFLARE_PREVIEW_WEB_DOMAIN }}
          CLOUDFLARE_PREVIEW_API_DOMAIN: \${{ vars.CLOUDFLARE_PREVIEW_API_DOMAIN }}
          CLOUDFLARE_PREVIEW_ZONE_NAME: \${{ vars.CLOUDFLARE_PREVIEW_ZONE_NAME }}
`
}

const PREVIEW_ALIAS_SCRIPT = `alias=$(node scripts/cloudflare-preview-name.mjs --from-id "\${{ github.event.pull_request.number || github.run_id }}")
          echo "alias=$alias" >> "$GITHUB_OUTPUT"
          printf '%s\\n' "gh workflow run cleanup-staging.yml -f alias=$alias" >> "$GITHUB_STEP_SUMMARY"`

function d1PreviewDbJob(project: string): string {
	return `  preview-db:
    runs-on: ubuntu-latest
    outputs:
      alias: \${{ steps.meta.outputs.alias }}
      d1_database_name: \${{ steps.d1.outputs.database_name }}
      d1_database_id: \${{ steps.d1.outputs.database_id }}
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@v4
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
          db_id=$(npx wrangler@${WRANGLER_VERSION} d1 list --json | jq -r --arg name "$db_name" '.[] | select(.name == $name) | (.uuid // .id // "")' | head -n 1)
          if [ -z "$db_id" ]; then
            npx wrangler@${WRANGLER_VERSION} d1 create "$db_name"
            db_id=$(npx wrangler@${WRANGLER_VERSION} d1 list --json | jq -r --arg name "$db_name" '.[] | select(.name == $name) | (.uuid // .id // "")' | head -n 1)
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

function neonPreviewDbJob(project: string): string {
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
      - uses: actions/checkout@v4
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

function cleanupStagingWorkflow(project: string, db: GvKitConfig['choices']['db']): string {
	const previewDbCleanupStep =
		db === 'sqlite' ? d1PreviewDbCleanupStep(project) : neonPreviewDbCleanupStep(project)
	return `# Tear down a PR preview when it closes or a manual preview by canonical alias.
# Cleanup always inventories Workers from the trusted default branch. Source
# branches, production Workers, and shared wildcard DNS records are unchanged.
${db === 'postgres' ? '# Neon preview branch cleanup uses NEON_API_KEY and NEON_PROJECT_ID.\n' : ''}

name: cleanup-staging

on:
  pull_request:
    types: [closed]
  workflow_dispatch:
    inputs:
      alias:
        description: Canonical preview alias reported by deploy-staging (pr-<positive integer>)
        required: true
        type: string

concurrency:
  group: staging-\${{ inputs.alias || format('pr-{0}', github.event.pull_request.number) }}
  cancel-in-progress: true

jobs:
  cleanup:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write
    steps:
      - name: Checkout trusted preview inventory
        uses: actions/checkout@v4
        with:
          fetch-depth: 1
          ref: \${{ github.event.repository.default_branch }}
      - name: Require trusted preview inventory
        run: |
          if [ ! -f scripts/cloudflare-preview-name.mjs ] || [ ! -f scripts/cleanup-cloudflare-preview-workers.sh ]; then
            echo "Trusted default-branch code is incomplete; preview cleanup cannot inventory resources." >&2
            exit 1
          fi
      - uses: actions/setup-node@v4
        with:
          node-version: '24'
      - id: alias
        name: Validate preview alias
        run: |
          alias=$(node scripts/cloudflare-preview-name.mjs --validate "$RAW_PREVIEW_ALIAS")
          echo "alias=$alias" >> "$GITHUB_OUTPUT"
        env:
          RAW_PREVIEW_ALIAS: \${{ inputs.alias || format('pr-{0}', github.event.pull_request.number) }}

      - name: Delete staging Workers
        run: sh scripts/cleanup-cloudflare-preview-workers.sh "\${{ steps.alias.outputs.alias }}"
        env:
          CLOUDFLARE_API_TOKEN: \${{ secrets.CLOUDFLARE_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: \${{ secrets.CLOUDFLARE_ACCOUNT_ID }}

${previewDbCleanupStep}

      - uses: marocchino/sticky-pull-request-comment@v2
        if: github.event_name == 'pull_request'
        with:
          header: staging-deploy
          message: |
            **Staging cleaned up**

            Preview Workers and data resources removed. The source branch was not changed.
`
}

function d1PreviewDbCleanupStep(project: string): string {
	return `      - name: Delete preview D1 database
        run: |
          set -euo pipefail
          db_name="${project}-db-\${{ steps.alias.outputs.alias }}"
          db_id=$(npx wrangler@${WRANGLER_VERSION} d1 list --json | jq -r --arg name "$db_name" '.[] | select(.name == $name) | (.uuid // .id // "")' | head -n 1)
          if [ -z "$db_id" ]; then
            echo "Preview D1 database $db_name is missing or already deleted."
            exit 0
          fi
          npx wrangler@${WRANGLER_VERSION} d1 delete "$db_name" --skip-confirmation
          echo "Deleted preview D1 database $db_name."
        env:
          CLOUDFLARE_API_TOKEN: \${{ secrets.CLOUDFLARE_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: \${{ secrets.CLOUDFLARE_ACCOUNT_ID }}`
}

function neonPreviewDbCleanupStep(project: string): string {
	return `      - name: Delete preview Neon branch
        run: |
          set -euo pipefail
          branch_name="${project}-db-\${{ steps.alias.outputs.alias }}"
          if ! branches_json=$(curl -fsS -H "Authorization: Bearer $NEON_API_KEY" "https://console.neon.tech/api/v2/projects/$NEON_PROJECT_ID/branches"); then
            echo "Could not list Neon branches." >&2
            exit 1
          fi
          branch_id=$(printf '%s' "$branches_json" | jq -r --arg name "$branch_name" '.branches[]? | select(.name == $name) | .id' | head -n 1)
          if [ -z "$branch_id" ]; then
            echo "Preview Neon branch $branch_name is missing or already deleted."
            exit 0
          fi
          curl -fsS -X DELETE -H "Authorization: Bearer $NEON_API_KEY" "https://console.neon.tech/api/v2/projects/$NEON_PROJECT_ID/branches/$branch_id" >/dev/null
          echo "Deleted preview Neon branch $branch_name."
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
	emailProvider: 'resend' | 'notifuse' | null
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
		emailProvider: cfg.choices.email === 'skip' ? null : cfg.choices.email
	}

	return [
		{ path: '.dockerignore', content: dockerignore() },
		{ path: 'Dockerfile', content: dockerfile(opts) },
		{ path: 'docker-compose.yml', content: dockerCompose(opts) },
		...(opts.isHono ? [{ path: 'docker/ingress.conf.template', content: ingressConfig() }] : [])
	]
}

function dockerignore(): string {
	return `*

!apps/
!apps/**
!services/
!services/**
!packages/
!packages/**
!docker/
!docker/**
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

function nodeRuntimeTarget(name: 'auth' | 'gateway' | 'users', port: number): string {
	return `FROM api-runtime AS ${name}-runtime
ENV PORT=${port}
EXPOSE ${port}
`
}

function dockerfile(opts: DockerOpts): string {
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
	const publicBuildKeys = [
		...(opts.hasMarketing
			? [
					'PUBLIC_MARKETING_URL',
					'PUBLIC_APP_URL',
					...(opts.wantsUmami ? ['PUBLIC_UMAMI_HOST', 'PUBLIC_UMAMI_WEBSITE_ID'] : []),
					...(opts.wantsPosthog ? ['PUBLIC_POSTHOG_KEY', 'PUBLIC_POSTHOG_HOST'] : [])
				]
			: []),
		...(opts.wantsEmailOTP ? ['PUBLIC_TURNSTILE_SITE_KEY'] : [])
	]
	const publicBuildArgs = publicBuildKeys.map((key) => `ARG ${key}`).join('\n')
	const publicBuildEnv =
		publicBuildKeys.length > 0
			? `ENV ${publicBuildKeys.map((key) => `${key}=\${${key}}`).join(' \\\n    ')}`
			: ''
	const serviceCopy = opts.isHono ? 'COPY services services\n' : ''
	const workspaceRoots = opts.isHono ? 'apps packages services' : 'apps packages'
	const nodeRuntimeTargets = opts.isHono
		? `${nodeRuntimeTarget('gateway', HONO_GATEWAY.development.port)}\n${nodeRuntimeTarget('auth', AUTH_SERVICE.development.port)}\n${nodeRuntimeTarget('users', USERS_SERVICE.development.port)}`
		: ''

	return `# syntax=docker/dockerfile:1.7
#
# Build any service from the repo root:
#   docker build --target web-runtime --build-arg TURBO_FILTER=<project>-web -t web .
#   docker build --target auth-runtime --build-arg TURBO_FILTER=${honoPackageIdentity('<project>', AUTH_SERVICE)} -t ${AUTH_SERVICE.identity} .
#
# Compose orchestrates these via \`target:\` and \`args:\`.

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

# Copy only package.json files into /pruned/ so the install layer is reused
# whenever source changes but manifests do not.
FROM base AS pruner
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json ./
COPY apps apps
COPY packages packages
${serviceCopy}RUN find ${workspaceRoots} \\( -name 'node_modules' -prune \\) -o \\( -name 'package.json' -print \\) \\
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

FROM builder AS deployer
ARG TURBO_FILTER
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \\
    pnpm --filter="\${TURBO_FILTER}" deploy --legacy --prod --ignore-scripts /prod

FROM node:\${NODE_VERSION}-alpine AS web-runtime
RUN apk add --no-cache tini wget \\
 && addgroup -S app && adduser -S app -G app
ENV NODE_ENV=production \\
    PORT=3000 \\
    HOST=0.0.0.0
WORKDIR /app
COPY --from=deployer --chown=app:app /prod ./
COPY --from=builder --chown=app:app /repo/apps/web/build ./build
USER app
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=3s --start-period=15s --retries=3 \\
    CMD wget --quiet --tries=1 --output-document=/dev/null http://127.0.0.1:3000/healthz || exit 1
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "build/index.js"]

FROM node:\${NODE_VERSION}-alpine AS api-runtime
RUN apk add --no-cache tini wget \\
 && addgroup -S app && adduser -S app -G app
ARG APP_PATH
ENV NODE_ENV=production \\
    HOST=0.0.0.0
WORKDIR /app
COPY --from=deployer --chown=app:app /prod ./
USER app
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \\
    CMD wget --quiet --tries=1 --output-document=/dev/null http://127.0.0.1:$PORT/healthz || exit 1
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/index.js"]

${nodeRuntimeTargets}
# One-shot. Compose runs it with \`condition: service_completed_successfully\`
# so application services wait for migrations before starting.
FROM deps AS migrate-runtime
RUN addgroup -S app && adduser -S app -G app
COPY --from=builder /repo/packages/db ./packages/db
WORKDIR /repo/packages/db
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["sh", "-c", "pnpm exec drizzle-kit migrate && if [ -d /data ]; then chown -R app:app /data; fi"]
${marketingRuntime}
`
}

function dockerCompose(opts: DockerOpts): string {
	const services: string[] = []
	if (opts.isPostgres) services.push(postgresService())
	services.push(migrateService(opts))
	if (opts.isHono) {
		services.push(authService(opts))
		services.push(usersService(opts))
		services.push(gatewayService(opts))
	}
	services.push(webService(opts))
	if (opts.isHono) services.push(ingressService())
	if (opts.hasMarketing) services.push(marketingService(opts))

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
	const env = [`      PORT: "${AUTH_SERVICE.development.port}"`, ...dbEnvLines(opts, '      ')]
	if (opts.hasAuth) {
		env.push('      BETTER_AUTH_SECRET: ${BETTER_AUTH_SECRET:?set BETTER_AUTH_SECRET in .env}')
		env.push(
			'      BETTER_AUTH_ALLOWED_HOSTS: ${BETTER_AUTH_ALLOWED_HOSTS:-localhost:3000,api.localhost:3000,localhost:8786,127.0.0.1:8786}'
		)
		env.push(
			'      AUTH_CORS_ORIGINS: ${AUTH_CORS_ORIGINS:-http://localhost:3000,http://api.localhost:3000}'
		)
	}
	if (opts.wantsGoogle) {
		env.push('      GOOGLE_CLIENT_ID: ${GOOGLE_CLIENT_ID:?set GOOGLE_CLIENT_ID in .env}')
		env.push(
			'      GOOGLE_CLIENT_SECRET: ${GOOGLE_CLIENT_SECRET:?set GOOGLE_CLIENT_SECRET in .env}'
		)
	}
	if (opts.wantsEmailOTP) {
		env.push(
			'      TURNSTILE_SECRET_KEY: ${TURNSTILE_SECRET_KEY:?set TURNSTILE_SECRET_KEY in .env}'
		)
	}
	if (opts.wantsEmailOTP && opts.emailProvider === 'resend') {
		env.push('      RESEND_API_KEY: ${RESEND_API_KEY:-}')
		env.push('      FROM_EMAIL: ${FROM_EMAIL:-}')
	}
	if (opts.wantsEmailOTP && opts.emailProvider === 'notifuse') {
		env.push('      NOTIFUSE_API_KEY: ${NOTIFUSE_API_KEY:?set NOTIFUSE_API_KEY in .env}')
		env.push(
			'      NOTIFUSE_WORKSPACE_ID: ${NOTIFUSE_WORKSPACE_ID:?set NOTIFUSE_WORKSPACE_ID in .env}'
		)
		env.push('      NOTIFUSE_BASE_URL: ${NOTIFUSE_BASE_URL:?set NOTIFUSE_BASE_URL in .env}')
	}

	const lines = [
		`  ${AUTH_SERVICE.transport.docker.serviceName}:`,
		'    build:',
		'      context: .',
		'      target: auth-runtime',
		'      args:',
		`        TURBO_FILTER: "${honoPackageIdentity(opts.project, AUTH_SERVICE)}"`,
		`    image: ${honoServiceName(opts.project, AUTH_SERVICE)}:latest`,
		'    restart: unless-stopped',
		'    environment:',
		...env,
		...volumeMountLines(opts, '    '),
		...dependsOnDbAndMigrate(opts),
		...healthcheckLines(AUTH_SERVICE.development.port)
	]
	return lines.join('\n')
}

function usersService(opts: DockerOpts): string {
	const env = [
		`      PORT: "${USERS_SERVICE.development.port}"`,
		...dbEnvLines(opts, '      '),
		`      ${AUTH_SERVICE.transport.node.targetEnvironmentVariable}: ${dockerServiceOrigin(AUTH_SERVICE)}`
	]

	const lines = [
		`  ${USERS_SERVICE.transport.docker.serviceName}:`,
		'    build:',
		'      context: .',
		'      target: users-runtime',
		'      args:',
		`        TURBO_FILTER: "${honoPackageIdentity(opts.project, USERS_SERVICE)}"`,
		`    image: ${honoServiceName(opts.project, USERS_SERVICE)}:latest`,
		'    restart: unless-stopped',
		'    environment:',
		...env,
		...volumeMountLines(opts, '    '),
		'    depends_on:',
		`      ${AUTH_SERVICE.transport.docker.serviceName}:`,
		'        condition: service_healthy',
		'      migrate:',
		'        condition: service_completed_successfully',
		...healthcheckLines(USERS_SERVICE.development.port)
	]
	return lines.join('\n')
}

function gatewayService(opts: DockerOpts): string {
	return `  ${HONO_GATEWAY.transport.docker.serviceName}:
    build:
      context: .
      target: gateway-runtime
      args:
        TURBO_FILTER: "${honoPackageIdentity(opts.project, HONO_GATEWAY)}"
    image: ${honoServiceName(opts.project, HONO_GATEWAY)}:latest
    restart: unless-stopped
    ports:
      - "${HONO_GATEWAY.development.port}:${HONO_GATEWAY.development.port}"
    environment:
      PORT: "${HONO_GATEWAY.development.port}"
      API_PUBLIC_ORIGIN: \${API_PUBLIC_ORIGIN:-http://api.localhost:3000}
      GATEWAY_PUBLIC_ORIGINS: \${GATEWAY_PUBLIC_ORIGINS:-http://localhost:3000,http://api.localhost:3000,http://localhost:${HONO_GATEWAY.development.port},http://127.0.0.1:${HONO_GATEWAY.development.port}}
      GATEWAY_TRUSTED_INGRESS_SECRET: \${GATEWAY_TRUSTED_INGRESS_SECRET:?set GATEWAY_TRUSTED_INGRESS_SECRET in .env}
      API_CORS_ORIGINS: \${API_CORS_ORIGINS:-http://localhost:3000}
      GATEWAY_UPSTREAM_TIMEOUT_MS: \${GATEWAY_UPSTREAM_TIMEOUT_MS:-10000}
      ${AUTH_SERVICE.transport.node.targetEnvironmentVariable}: ${dockerServiceOrigin(AUTH_SERVICE)}
      ${USERS_SERVICE.transport.node.targetEnvironmentVariable}: ${dockerServiceOrigin(USERS_SERVICE)}
    depends_on:
      ${AUTH_SERVICE.transport.docker.serviceName}:
        condition: service_healthy
      ${USERS_SERVICE.transport.docker.serviceName}:
        condition: service_healthy
${healthcheckLines(HONO_GATEWAY.development.port, '/api/healthz').join('\n')}`
}

function ingressService(): string {
	return `  ingress:
    image: nginxinc/nginx-unprivileged:1.28.0-alpine@sha256:c97ff0bf7cbae369953c6da1232ec14ad9f971d66360c5698db0856a4cd657a0
    restart: unless-stopped
    ports:
      - "3000:8080"
    environment:
      API_HOST: \${API_HOST:-api.localhost}
      PUBLIC_SCHEME: \${PUBLIC_SCHEME:-http}
      GATEWAY_TRUSTED_INGRESS_SECRET: \${GATEWAY_TRUSTED_INGRESS_SECRET:?set GATEWAY_TRUSTED_INGRESS_SECRET in .env}
      NGINX_ENVSUBST_FILTER: "^(API_HOST|PUBLIC_SCHEME|GATEWAY_TRUSTED_INGRESS_SECRET)$"
    volumes:
      - ./docker/ingress.conf.template:/etc/nginx/templates/default.conf.template:ro
    depends_on:
      ${HONO_GATEWAY.transport.docker.serviceName}:
        condition: service_healthy
      web:
        condition: service_healthy
    healthcheck:
      test: ["CMD", "wget", "--quiet", "--spider", "http://127.0.0.1:8080/healthz"]
      interval: 5s
      timeout: 2s
      retries: 5
      start_period: 2s`
}

function ingressConfig(): string {
	return `upstream gateway_upstream {
	server ${HONO_GATEWAY.transport.docker.hostname}:${HONO_GATEWAY.development.port};
}

upstream web_upstream {
	server web:3000;
}

server {
	listen 8080 default_server;
	server_name _;

	location = /api {
		proxy_pass http://gateway_upstream;
		proxy_set_header Host $http_host;
		proxy_set_header X-Forwarded-Host $http_host;
		proxy_set_header X-Forwarded-Proto \${PUBLIC_SCHEME};
		proxy_set_header X-Gateway-Ingress-Secret \${GATEWAY_TRUSTED_INGRESS_SECRET};
		proxy_set_header X-Request-ID $request_id;
	}

	location ^~ /api/ {
		proxy_pass http://gateway_upstream;
		proxy_set_header Host $http_host;
		proxy_set_header X-Forwarded-Host $http_host;
		proxy_set_header X-Forwarded-Proto \${PUBLIC_SCHEME};
		proxy_set_header X-Gateway-Ingress-Secret \${GATEWAY_TRUSTED_INGRESS_SECRET};
		proxy_set_header X-Request-ID $request_id;
	}

	location / {
		proxy_pass http://web_upstream;
		proxy_set_header Host $http_host;
		proxy_set_header X-Forwarded-Host $http_host;
		proxy_set_header X-Forwarded-Proto \${PUBLIC_SCHEME};
		proxy_set_header X-Request-ID $request_id;
	}
}

server {
	listen 8080;
	server_name \${API_HOST};

	location / {
		proxy_pass http://gateway_upstream;
		proxy_set_header Host $http_host;
		proxy_set_header X-Forwarded-Host $http_host;
		proxy_set_header X-Forwarded-Proto \${PUBLIC_SCHEME};
		proxy_set_header X-Gateway-Ingress-Secret \${GATEWAY_TRUSTED_INGRESS_SECRET};
		proxy_set_header X-Request-ID $request_id;
	}
}
`
}

function webService(opts: DockerOpts): string {
	const env: string[] = ['      ORIGIN: ${ORIGIN:-http://localhost:3000}']
	const buildArgs = [`        TURBO_FILTER: "${opts.project}-web"`]
	if (opts.hasMarketing) buildArgs.push('        PUBLIC_APP_URL: ${PUBLIC_APP_URL:-http://localhost:3000}')
	if (opts.wantsEmailOTP) {
		buildArgs.push(
			'        PUBLIC_TURNSTILE_SITE_KEY: ${PUBLIC_TURNSTILE_SITE_KEY:-1x00000000000000000000AA}'
		)
	}

	if (opts.isHono) {
		env.push(
			`      ${HONO_GATEWAY.transport.node.targetEnvironmentVariable}: ${dockerServiceOrigin(HONO_GATEWAY)}`,
			'      GATEWAY_TRUSTED_INGRESS_SECRET: ${GATEWAY_TRUSTED_INGRESS_SECRET:?set GATEWAY_TRUSTED_INGRESS_SECRET in .env}'
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
			`      ${HONO_GATEWAY.transport.docker.serviceName}:`,
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
		...(opts.isHono ? [] : ['    ports:', '      - "3000:3000"']),
		'    environment:',
		...env,
		...volumes,
		...dependsOn,
		...healthcheckLines(3000)
	]
	return lines.join('\n')
}

function marketingService(opts: DockerOpts): string {
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

function healthcheckLines(port: number, path = '/healthz'): string[] {
	return [
		'    healthcheck:',
		`      test: ["CMD", "wget", "--quiet", "--tries=1", "--output-document=/dev/null", "http://127.0.0.1:${port}${path}"]`,
		'      interval: 15s',
		'      timeout: 3s',
		'      retries: 3',
		'      start_period: 10s'
	]
}

function composeVolumes(opts: DockerOpts): string[] {
	return ['volumes:', opts.isPostgres ? '  pgdata:' : '  sqlite_data:']
}
