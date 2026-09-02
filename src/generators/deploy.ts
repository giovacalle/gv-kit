import { cloudflareProductionWorkerName } from '../lib/cloudflare-worker-name.js'
import type { FileEntry } from '../lib/files.js'
import type { GvKitConfig } from '../schema/config.js'
import {
	AUTH_SERVICE,
	dockerServiceOrigin,
	HONO_GATEWAY,
	HONO_SERVICES,
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
		{ path: '.github/workflows/cleanup-staging.yml', content: cleanupStagingWorkflow(db) },
		{
			path: 'scripts/cloudflare-preview-name.mjs',
			content: cloudflarePreviewNameScript(cfg)
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
		{
			path: 'scripts/publish-cloudflare-preview.sh',
			content: publishCloudflarePreviewScript(cfg)
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

function cloudflarePreviewNameScript(cfg: GvKitConfig): string {
	const project = cfg.choices.name
	const productionNameAliases = [
		HONO_GATEWAY.transport.cfWorkers.serviceNameSuffix,
		...HONO_SERVICES.map((service) => service.transport.cfWorkers.serviceNameSuffix),
		'web',
		...(cfg.choices.marketing === 'astro' ? ['marketing'] : [])
	]
		.map((service) => {
			const legacyName = `${project}-${service}`
			const boundedName = cloudflareProductionWorkerName({ project, service })
			return [boundedName, legacyName] as const
		})
		.filter(([boundedName, legacyName]) => boundedName !== legacyName)
	const aliasesDeclaration =
		productionNameAliases.length === 0
			? ''
			: `const productionNameAliases = new Map(${JSON.stringify(productionNameAliases)})\n`
	const validateProductionNameBody =
		productionNameAliases.length === 0
			? `\tif (typeof productionName !== 'string' || (productionName !== cloudflarePreviewProject && !productionName.startsWith(cloudflarePreviewProject + '-'))) throw new Error('Worker name is outside the preview project namespace')
\tif (/-pr-[1-9][0-9]*$/.test(productionName)) throw new Error('Production Worker name must not contain a preview alias')
\treturn productionName`
			: `\tconst legacyName = productionNameAliases.get(productionName) ?? productionName
\tif (typeof legacyName !== 'string' || (legacyName !== cloudflarePreviewProject && !legacyName.startsWith(cloudflarePreviewProject + '-'))) throw new Error('Worker name is outside the preview project namespace')
\tif (/-pr-[1-9][0-9]*$/.test(legacyName)) throw new Error('Production Worker name must not contain a preview alias')
\treturn legacyName`
	const cloudflarePreviewNameBody =
		productionNameAliases.length === 0
			? `\tvalidateProductionName(productionName)
\tvalidateCloudflarePreviewAlias(alias)
\tconst resourceDigest = createHash('sha256')
\t\t.update(productionName)`
			: `\tconst legacyName = validateProductionName(productionName)
\tvalidateCloudflarePreviewAlias(alias)
\tconst resourceDigest = createHash('sha256')
\t\t.update(legacyName)`

	return `import { createHash } from 'node:crypto'

const MAX_PREVIEW_ALIAS_LENGTH = 32
const PROJECT_NAMESPACE_DIGEST_LENGTH = 16
const RESOURCE_DIGEST_LENGTH = 10

export const cloudflarePreviewProject = ${JSON.stringify(project)}
const projectNamespace = 'pv-' + createHash('sha256')
	.update(cloudflarePreviewProject)
	.digest('hex')
	.slice(0, PROJECT_NAMESPACE_DIGEST_LENGTH)
${aliasesDeclaration}
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

function validateProductionName(productionName) {
${validateProductionNameBody}
}

export function cloudflarePreviewName(productionName, alias) {
${cloudflarePreviewNameBody}
		.digest('hex')
		.slice(0, RESOURCE_DIGEST_LENGTH)
	return projectNamespace + '-' + resourceDigest + '-' + alias
}

export function validateCloudflarePreviewName(previewName, alias) {
	validateCloudflarePreviewAlias(alias)
	const pattern = new RegExp('^' + projectNamespace + '-[0-9a-f]{' + RESOURCE_DIGEST_LENGTH + '}-' + alias + '$')
	if (typeof previewName !== 'string' || !pattern.test(previewName)) throw new Error('Worker name is outside the validated project and preview alias namespace')
	return previewName
}

const [command, value, alias] = process.argv.slice(2)
if (command === '--from-id' && value) console.log(cloudflarePreviewAlias(value))
else if (command === '--validate' && value) console.log(validateCloudflarePreviewAlias(value))
else if (command === '--validate-name' && value && alias) console.log(validateCloudflarePreviewName(value, alias))
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

alias=$(node scripts/cloudflare-preview-name.mjs --validate "\${1:?preview alias is required}")
# Only validated alias-scoped Workers are deleted; their routes are removed while shared wildcard DNS remains.
inventory_file=$(mktemp)
trap 'rm -f "$inventory_file"' EXIT HUP INT TERM
if ! response=$(curl -fsS "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/workers/scripts" \\
	-H "Authorization: Bearer $CLOUDFLARE_API_TOKEN"); then
	echo "Could not inventory preview Workers from Cloudflare." >&2
	exit 1
fi
if ! printf '%s' "$response" | jq -e '.success == true and (.errors | type == "array") and (.messages | type == "array") and (.result | type == "array") and all(.result[]; (.id | type) == "string")' >/dev/null; then
	echo "Cloudflare returned a malformed preview Worker inventory." >&2
	exit 1
fi
printf '%s' "$response" | jq -r '.result[].id' > "$inventory_file"
sort -u "$inventory_file" -o "$inventory_file"
failures=0
while IFS= read -r worker_name; do
	if ! node scripts/cloudflare-preview-name.mjs --validate-name "$worker_name" "$alias" >/dev/null 2>&1; then continue; fi
	echo "Deleting $worker_name"
	if npx wrangler@${WRANGLER_VERSION} delete --name "$worker_name" --force; then
		echo "Deleted $worker_name and its attached preview routes."
	else
		echo "Failed to delete preview Worker $worker_name." >&2
		failures=$((failures + 1))
	fi
done < "$inventory_file"

if [ "$failures" -ne 0 ]; then
	echo "$failures preview Worker deletion(s) failed." >&2
	exit 1
fi
`
}

function publishCloudflarePreviewScript(cfg: GvKitConfig): string {
	const targets = [
		{
			directory: AUTH_SERVICE.workspacePath,
			productionName: cloudflareProductionWorkerName({
				project: cfg.choices.name,
				service: AUTH_SERVICE.transport.cfWorkers.serviceNameSuffix
			}),
			bundle: 'index.js',
			secrets: cfg.choices.auth.length > 0 ? 'auth.json' : undefined,
			databasePolicy:
				cfg.choices.db === 'sqlite' && cfg.choices.auth.length > 0 ? 'exact-d1' : 'none',
			routePolicy: 'none',
			servicePolicy: 'none',
			assetsPolicy: 'none'
		},
		{
			directory: USERS_SERVICE.workspacePath,
			productionName: cloudflareProductionWorkerName({
				project: cfg.choices.name,
				service: USERS_SERVICE.transport.cfWorkers.serviceNameSuffix
			}),
			bundle: 'index.js',
			secrets: cfg.choices.db === 'postgres' ? 'users.json' : undefined,
			databasePolicy: cfg.choices.db === 'sqlite' ? 'exact-d1' : 'none',
			routePolicy: 'none',
			servicePolicy: 'auth',
			assetsPolicy: 'none'
		},
		{
			directory: HONO_GATEWAY.workspacePath,
			productionName: cloudflareProductionWorkerName({
				project: cfg.choices.name,
				service: HONO_GATEWAY.transport.cfWorkers.serviceNameSuffix
			}),
			bundle: 'index.js',
			secrets: undefined,
			databasePolicy: 'none',
			routePolicy: 'api',
			servicePolicy: 'gateway',
			assetsPolicy: 'none'
		},
		...(cfg.choices.marketing === 'astro'
			? [
					{
						directory: 'apps/marketing',
						productionName: cloudflareProductionWorkerName({
							project: cfg.choices.name,
							service: 'marketing'
						}),
						bundle: 'no-op-worker.js',
						secrets: undefined,
						databasePolicy: 'none',
						routePolicy: 'marketing',
						servicePolicy: 'none',
						assetsPolicy: 'marketing'
					}
				]
			: []),
		{
			directory: 'apps/web',
			productionName: cloudflareProductionWorkerName({
				project: cfg.choices.name,
				service: 'web'
			}),
			bundle: '_worker.js',
			secrets: undefined,
			databasePolicy: 'none',
			routePolicy: 'web',
			servicePolicy: 'gateway-binding',
			assetsPolicy: 'web'
		}
	]
	const preparations = targets
		.map(
			({ directory, bundle, databasePolicy, routePolicy, servicePolicy, assetsPolicy }) =>
				`prepare ${JSON.stringify(directory)} ${JSON.stringify(bundle)} ${databasePolicy} ${routePolicy} ${servicePolicy} ${assetsPolicy}`
		)
		.join('\n')
	const deployments = targets
		.map(({ directory, bundle, secrets }) => {
			const secretArgument = secrets ? ` --secrets-file "$PREVIEW_SECRETS_DIR/${secrets}"` : ''
			return `publish ${JSON.stringify(directory)} ${JSON.stringify(bundle)}${secretArgument}`
		})
		.join('\n')
	const d1Requirements =
		cfg.choices.db === 'sqlite'
			? `: "\${STAGING_D1_DATABASE_NAME:?preview D1 database name is required}"
: "\${STAGING_D1_DATABASE_ID:?preview D1 database id is required}"
`
			: ''
	const authRuntimeVariablePolicy =
		cfg.choices.auth.length > 0
			? `${AUTH_SERVICE.workspacePath})
			jq -cn \\
				--arg allowed_hosts "$preview_web_host,$preview_api_host,$local_hosts" \\
				--arg cors_origins "$preview_web_origin,$preview_api_origin,$local_origins" \\
				'{BETTER_AUTH_ALLOWED_HOSTS: $allowed_hosts, AUTH_CORS_ORIGINS: $cors_origins}'
			;;
		`
			: ''
	const targetsWithoutRuntimeVariables = [
		...(cfg.choices.auth.length === 0 ? [AUTH_SERVICE.workspacePath] : []),
		USERS_SERVICE.workspacePath,
		'apps/web',
		...(cfg.choices.marketing === 'astro' ? ['apps/marketing'] : [])
	].join('|')
	return `#!/bin/sh
set -eu

: "\${PREVIEW_ARTIFACT:?preview artifact directory is required}"
: "\${PREVIEW_SECRETS_DIR:?preview secrets directory is required}"
: "\${TRUSTED_SOURCE:?trusted source directory is required}"
: "\${STAGING_ALIAS:?preview alias is required}"
${d1Requirements}
: "\${CLOUDFLARE_PREVIEW_ZONE_NAME:?preview zone name is required}"
: "\${CLOUDFLARE_PREVIEW_WEB_DOMAIN:?preview web domain is required}"
: "\${CLOUDFLARE_PREVIEW_API_DOMAIN:?preview API domain is required}"

preview_api_host="$STAGING_ALIAS.$CLOUDFLARE_PREVIEW_API_DOMAIN"
preview_web_host="$STAGING_ALIAS.$CLOUDFLARE_PREVIEW_WEB_DOMAIN"
preview_api_origin="https://$preview_api_host"
preview_web_origin="https://$preview_web_host"
local_hosts='localhost:3000,localhost:5173,api.localhost:8786'
local_origins='http://localhost:3000,http://localhost:5173,http://api.localhost:8786'

expected_preview_runtime_variables() {
	directory=$1
	case "$directory" in
		${HONO_GATEWAY.workspacePath})
			jq -cn \\
				--arg api_origin "$preview_api_origin" \\
				--arg public_origins "$preview_web_origin,$preview_api_origin,$local_origins" \\
				--arg cors_origins "$preview_web_origin,$local_origins" \\
				'{API_PUBLIC_ORIGIN: $api_origin, GATEWAY_PUBLIC_ORIGINS: $public_origins, API_CORS_ORIGINS: $cors_origins, GATEWAY_UPSTREAM_TIMEOUT_MS: "10000"}'
			;;
		${authRuntimeVariablePolicy}${targetsWithoutRuntimeVariables}) printf '%s' '{}' ;;
		*) echo "Trusted preview runtime variable policy is invalid for $directory." >&2; exit 1 ;;
	esac
}

trusted_worker_name() {
	directory=$1
	production_name=$2
	config="$PREVIEW_ARTIFACT/$directory/wrangler.staging.jsonc"
	if [ ! -f "$config" ]; then
		echo "Preview Worker config is missing for $directory." >&2
		exit 1
	fi
	name=$(jq -er '.name | select(type == "string")' "$config")
	expected_name=$(node "$TRUSTED_SOURCE/scripts/cloudflare-preview-name.mjs" "$production_name" "$STAGING_ALIAS")
	if [ "$name" != "$expected_name" ]; then
		echo "Preview Worker name is unsafe for $directory." >&2
		exit 1
	fi
	node "$TRUSTED_SOURCE/scripts/cloudflare-preview-name.mjs" --validate-name "$name" "$STAGING_ALIAS" >/dev/null
	printf '%s' "$name"
}

auth_worker_name=$(trusted_worker_name ${JSON.stringify(AUTH_SERVICE.workspacePath)} ${JSON.stringify(cloudflareProductionWorkerName({ project: cfg.choices.name, service: AUTH_SERVICE.transport.cfWorkers.serviceNameSuffix }))})
users_worker_name=$(trusted_worker_name ${JSON.stringify(USERS_SERVICE.workspacePath)} ${JSON.stringify(cloudflareProductionWorkerName({ project: cfg.choices.name, service: USERS_SERVICE.transport.cfWorkers.serviceNameSuffix }))})
gateway_worker_name=$(trusted_worker_name ${JSON.stringify(HONO_GATEWAY.workspacePath)} ${JSON.stringify(cloudflareProductionWorkerName({ project: cfg.choices.name, service: HONO_GATEWAY.transport.cfWorkers.serviceNameSuffix }))})
web_worker_name=$(trusted_worker_name "apps/web" ${JSON.stringify(cloudflareProductionWorkerName({ project: cfg.choices.name, service: 'web' }))})
${cfg.choices.marketing === 'astro' ? `marketing_worker_name=$(trusted_worker_name "apps/marketing" ${JSON.stringify(cloudflareProductionWorkerName({ project: cfg.choices.name, service: 'marketing' }))})\n` : ''}worker_name_count=$(printf '%s\n' "$auth_worker_name" "$users_worker_name" "$gateway_worker_name" "$web_worker_name"${cfg.choices.marketing === 'astro' ? ' "$marketing_worker_name"' : ''} | sort -u | wc -l | tr -d ' ')
if [ "$worker_name_count" -ne ${cfg.choices.marketing === 'astro' ? '5' : '4'} ]; then
	echo "Preview Worker names must be distinct." >&2
	exit 1
fi

prepare() {
	directory=$1
	bundle=$2
	database_policy=$3
	route_policy=$4
	service_policy=$5
	assets_policy=$6
	target_dir="$PREVIEW_ARTIFACT/$directory"
	source_config="$target_dir/wrangler.staging.jsonc"
	bundle_path=".preview-bundle/$bundle"
	publish_config="$target_dir/wrangler.publish.json"
	if [ ! -f "$source_config" ] || [ ! -f "$target_dir/$bundle_path" ]; then
		echo "Preview artifact is incomplete for $directory." >&2
		exit 1
	fi
	worker_name=$(jq -er '.name | select(type == "string")' "$source_config")
	node "$TRUSTED_SOURCE/scripts/cloudflare-preview-name.mjs" --validate-name "$worker_name" "$STAGING_ALIAS" >/dev/null
	if ! jq -e '.workers_dev == false and .preview_urls == false' "$source_config" >/dev/null; then
		echo "Preview public development URLs are unsafe for $directory." >&2
		exit 1
	fi
	expected_vars=$(expected_preview_runtime_variables "$directory")
	if ! jq -e --argjson expected "$expected_vars" '
		((has("vars") | not) and $expected == {}) or
		((.vars | type) == "object" and .vars == $expected)
	' "$source_config" >/dev/null; then
		echo "Preview runtime variables are unsafe for $directory." >&2
		exit 1
	fi
	case "$route_policy" in
		none) expected_routes='[]' ;;
		api) expected_routes=$(jq -cn --arg alias "$STAGING_ALIAS" --arg api "$CLOUDFLARE_PREVIEW_API_DOMAIN" --arg web "$CLOUDFLARE_PREVIEW_WEB_DOMAIN" --arg zone "$CLOUDFLARE_PREVIEW_ZONE_NAME" '[{pattern: ($alias + "." + $api + "/*"), zone_name: $zone}, {pattern: ($alias + "." + $web + "/api"), zone_name: $zone}, {pattern: ($alias + "." + $web + "/api/*"), zone_name: $zone}]') ;;
		web) expected_routes=$(jq -cn --arg alias "$STAGING_ALIAS" --arg web "$CLOUDFLARE_PREVIEW_WEB_DOMAIN" --arg zone "$CLOUDFLARE_PREVIEW_ZONE_NAME" '[{pattern: ($alias + "." + $web + "/*"), zone_name: $zone}]') ;;
		marketing) expected_routes=$(jq -cn --arg alias "$STAGING_ALIAS" --arg web "$CLOUDFLARE_PREVIEW_WEB_DOMAIN" --arg zone "$CLOUDFLARE_PREVIEW_ZONE_NAME" '[{pattern: ($alias + "-marketing." + $web + "/*"), zone_name: $zone}]') ;;
		*) echo "Trusted preview route policy is invalid for $directory." >&2; exit 1 ;;
	esac
	if ! jq -e --argjson expected "$expected_routes" '(.routes // []) == $expected and (has("route") | not)' "$source_config" >/dev/null; then
		echo "Preview routes are unsafe for $directory." >&2
		exit 1
	fi
	case "$service_policy" in
		none) expected_services='[]' ;;
		auth) expected_services=$(jq -cn --arg auth "$auth_worker_name" '[{binding: "AUTH", service: $auth}]') ;;
		gateway) expected_services=$(jq -cn --arg auth "$auth_worker_name" --arg users "$users_worker_name" '[{binding: "AUTH", service: $auth}, {binding: "USERS", service: $users}]') ;;
		gateway-binding) expected_services=$(jq -cn --arg gateway "$gateway_worker_name" '[{binding: "GATEWAY", service: $gateway}]') ;;
		*) echo "Trusted preview service policy is invalid for $directory." >&2; exit 1 ;;
	esac
	if ! jq -e --argjson expected "$expected_services" '(.services // []) == $expected' "$source_config" >/dev/null; then
		echo "Preview Service Bindings are unsafe for $directory." >&2
		exit 1
	fi
	case "$assets_policy" in
		none) expected_assets='null' ;;
		web) expected_assets='{"binding":"ASSETS","directory":".svelte-kit/cloudflare"}' ;;
		marketing) expected_assets='{"directory":"./dist/","not_found_handling":"404-page","html_handling":"auto-trailing-slash"}' ;;
		*) echo "Trusted preview assets policy is invalid for $directory." >&2; exit 1 ;;
	esac
	if ! jq -e --argjson expected "$expected_assets" '(.assets // null) == $expected' "$source_config" >/dev/null; then
		echo "Preview asset bindings are unsafe for $directory." >&2
		exit 1
	fi
	case "$database_policy" in
		exact-d1)
			if ! jq -e --arg name "$STAGING_D1_DATABASE_NAME" --arg id "$STAGING_D1_DATABASE_ID" '
				.d1_databases == [{ binding: "DB", database_name: $name, database_id: $id }]
			' "$source_config" >/dev/null; then
				echo "Preview D1 bindings are unsafe for $directory." >&2
				exit 1
			fi
			;;
		none)
			if ! jq -e '((has("d1_databases") | not) or .d1_databases == [])' "$source_config" >/dev/null; then
				echo "Preview D1 bindings are forbidden for $directory." >&2
				exit 1
			fi
			;;
		*)
			echo "Trusted preview database policy is invalid for $directory." >&2
			exit 1
			;;
	esac
	jq --arg main "$bundle_path" '
		{
			name,
			main: $main,
			compatibility_date,
			compatibility_flags,
			workers_dev,
			preview_urls,
			vars,
			services,
			d1_databases,
			routes,
			assets,
			observability
		}
		| with_entries(select(.value != null))
	' "$source_config" > "$publish_config"
}

publish() {
	directory=$1
	bundle=$2
	shift 2
	target_dir="$PREVIEW_ARTIFACT/$directory"
	bundle_path=".preview-bundle/$bundle"
	if [ ! -f "$target_dir/wrangler.publish.json" ]; then
		echo "Trusted preview publish config is missing for $directory." >&2
		exit 1
	fi
	(
		cd "$target_dir"
		npx wrangler@${WRANGLER_VERSION} deploy "$bundle_path" --no-bundle --config wrangler.publish.json "$@"
	)
}

${preparations}

${deployments}
`
}

function prepareCloudflarePreviewScript(): string {
	return `import { appendFileSync, existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import {
	cloudflarePreviewName,
	cloudflarePreviewProject,
	validateCloudflarePreviewAlias
} from './cloudflare-preview-name.mjs'

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
		if (name === 'node_modules' || name === '.wrangler') continue
		const candidate = path.join(directory, name)
		if (statSync(candidate).isDirectory()) found.push(...findWranglerConfigs(candidate))
		else if (name === 'wrangler.jsonc') found.push(candidate)
	}
	return found
}

function previewDatabaseResource() {
	if (process.env.PREVIEW_DB_KIND === 'd1') {
		return {
			kind: 'd1',
			name: required('STAGING_D1_DATABASE_NAME'),
			id: required('STAGING_D1_DATABASE_ID')
		}
	}
	if (process.env.PREVIEW_DB_KIND === 'neon') {
		return {
			kind: 'neon',
			name: required('STAGING_NEON_BRANCH_NAME'),
			id: required('STAGING_NEON_BRANCH_ID')
		}
	}
	throw new Error('PREVIEW_DB_KIND must be d1 or neon')
}

const alias = validateCloudflarePreviewAlias(required('STAGING_ALIAS'))
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
const localHosts = ['localhost:3000', 'localhost:5173', 'api.localhost:8786']
const localOrigins = [
	'http://localhost:3000',
	'http://localhost:5173',
	'http://api.localhost:8786'
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
	if (normalizedPath === 'services/auth/wrangler.jsonc' && apiOrigin && webOrigin && config.vars) {
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
		productionName,
		name: config.name,
		public: config.workers_dev,
		services: config.services ?? [],
		databases: config.d1_databases ?? []
	})
}

if (inventory.length === 0) throw new Error('No Wrangler configurations found')
const database = previewDatabaseResource()
const deploymentManifest = {
	schemaVersion: 1,
	project: cloudflarePreviewProject,
	alias,
	workers: inventory.map(({ config, productionName, name }) => ({ config, productionName, name })),
	database
}
writeFileSync('cloudflare-preview-manifest.json', JSON.stringify(deploymentManifest, null, 2) + '\\n')
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
	if (cfg.choices.auth.length > 0 && db === 'postgres') authSources.push(['DATABASE_URL', 'STAGING_DATABASE_URL'])
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
				stage === 'staging' && cfg.choices.auth.length > 0
					? '${{ steps.preview_secrets.outputs.auth_file }}'
					: undefined
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
	if (cfg.choices.auth.length === 0) return []
	const keys = ['BETTER_AUTH_SECRET']
	if (cfg.choices.auth.includes('google')) keys.push('GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET')
	if (cfg.choices.auth.includes('emailOTP')) {
		keys.push('TURNSTILE_SECRET_KEY')
		if (cfg.choices.email === 'resend') keys.push('RESEND_API_KEY', 'FROM_EMAIL')
		if (cfg.choices.email === 'notifuse') keys.push('NOTIFUSE_API_KEY', 'NOTIFUSE_WORKSPACE_ID', 'NOTIFUSE_BASE_URL')
	}
	return keys
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
	const monitoringKeys = marketingMonitoringEnvKeys(cfg)
	const previewPublicKeys = cfg.choices.auth.includes('emailOTP')
		? ['PUBLIC_TURNSTILE_SITE_KEY']
		: []
	const previewIngressGate = honoPreviewIngressGateJob({ publicKeys: previewPublicKeys })
	const previewDbJob = (db === 'sqlite' ? d1PreviewDbJob() : neonPreviewDbJob()).replace(
		'  preview-db:\n',
		'  preview-db:\n    needs: preview-ingress\n'
	)
	const stagingConfigStep = writeStagingWranglerConfigStep({ db })
	const requiredVariables = [
		'CLOUDFLARE_PREVIEW_WEB_DOMAIN',
		'CLOUDFLARE_PREVIEW_API_DOMAIN',
		'CLOUDFLARE_PREVIEW_ZONE_NAME',
		...monitoringKeys,
		...previewPublicKeys
	]
	const publicOriginRequirement = workflowVariableRequirements(requiredVariables)
	const authSecretRequirements =
		previewAuthSecretKeys(cfg)
			.map((key) => `#   - ${key}`)
			.join('\n') + '\n'
	const buildTargets = [
		{
			packageName: honoPackageIdentity(project, AUTH_SERVICE),
			directory: AUTH_SERVICE.workspacePath
		},
		{
			packageName: honoPackageIdentity(project, USERS_SERVICE),
			directory: USERS_SERVICE.workspacePath
		},
		{
			packageName: honoPackageIdentity(project, HONO_GATEWAY),
			directory: HONO_GATEWAY.workspacePath
		},
		...(hasMarketing ? [{ packageName: `${project}-marketing`, directory: 'apps/marketing' }] : []),
		{ packageName: `${project}-web`, directory: 'apps/web' }
	]
	const buildFilters = buildTargets.map(({ packageName }) => ` --filter=${packageName}`).join('')
	const bundleCommands = buildTargets
		.map(
			({ packageName, directory }) =>
				`          pnpm --filter ${packageName} exec wrangler deploy --config wrangler.staging.jsonc --dry-run --outdir=.preview-bundle\n          test -d ${directory}/.preview-bundle`
		)
		.join('\n')
	const artifactPaths = [
		'cloudflare-preview-manifest.json',
		...buildTargets.flatMap(({ directory }) => [
			`${directory}/wrangler.staging.jsonc`,
			`${directory}/.preview-bundle`
		]),
		'apps/web/.svelte-kit/cloudflare',
		...(hasMarketing ? ['apps/marketing/dist'] : [])
	]
		.map((path) => `            ${path}`)
		.join('\n')
	const buildPublicEnv = `${
		hasMarketing
			? `
          PUBLIC_MARKETING_URL: \${{ steps.preview_config.outputs.marketing_origin }}
          PUBLIC_APP_URL: \${{ steps.preview_config.outputs.web_origin }}`
			: ''
	}${workflowVariableEnv([...monitoringKeys, ...previewPublicKeys])}`
	const privateSecretEnv = previewAuthSecretKeys(cfg)
		.map((key) => `          ${key}: \${{ secrets.${key} }}`)
		.concat(
			db === 'postgres'
				? [`          STAGING_DATABASE_URL: \${{ needs.preview-db.outputs.database_url }}`]
				: []
		)
		.join('\n')
	const hasPrivateSecrets = cfg.choices.auth.length > 0 || db === 'postgres'
	const privateSecretsStep = hasPrivateSecrets
		? `      - id: preview_secrets
        name: Write private Worker preview secret files from trusted code
        run: |
          set -euo pipefail
          secret_dir="$RUNNER_TEMP/gateway-preview-secrets"
          umask 077
          node trusted-source/scripts/write-cloudflare-preview-secrets.mjs "$secret_dir"
          echo "directory=$secret_dir" >> "$GITHUB_OUTPUT"
        env:
${privateSecretEnv}
`
		: `      - id: preview_secrets
        run: echo "directory=$RUNNER_TEMP/gateway-preview-secrets" >> "$GITHUB_OUTPUT"
`
	const migrationStep = trustedPreviewMigrationStep(db)
	const publishDatabaseEnv =
		db === 'sqlite'
			? `
          STAGING_D1_DATABASE_NAME: \${{ needs.preview-db.outputs.d1_database_name }}
          STAGING_D1_DATABASE_ID: \${{ needs.preview-db.outputs.d1_database_id }}`
			: ''
	return `# Per-PR staging deploy for ${project}.
# The pull_request_target workflow definition is trusted. PR code is built without provider
# credentials, then a separate job uploads only prebuilt bundles with pinned provider tools.
# Tear-down lives in cleanup-staging.yml.
#
# Required GitHub Secrets:
#   - CLOUDFLARE_API_TOKEN (including Zone Read and DNS Read for preview ingress validation)
#   - CLOUDFLARE_ACCOUNT_ID
${authSecretRequirements}${db === 'postgres' ? '#   - NEON_API_KEY\n# Required GitHub Variables:\n#   - NEON_PROJECT_ID\n' : ''}${publicOriginRequirement}

name: deploy-staging

on:
  pull_request_target:
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

  build-preview:
    needs: preview-db
    runs-on: ubuntu-latest
    permissions:
      contents: read
    outputs:
      api_origin: \${{ steps.preview_config.outputs.api_origin }}
      web_origin: \${{ steps.preview_config.outputs.web_origin }}
      marketing_origin: \${{ steps.preview_config.outputs.marketing_origin }}
      short_sha: \${{ steps.meta.outputs.short_sha }}
    steps:
      - name: Checkout untrusted preview source without provider credentials
        uses: actions/checkout@v4
        with:
          fetch-depth: 0
          filter: blob:none
          ref: \${{ github.event.pull_request.head.sha || github.sha }}
      - id: meta
        run: echo "short_sha=$(printf '%s' "$PREVIEW_SHA" | cut -c1-7)" >> "$GITHUB_OUTPUT"
        env:
          PREVIEW_SHA: \${{ github.event.pull_request.head.sha || github.sha }}
      - uses: pnpm/action-setup@v4
        with:
          version: 11.1.1
      - uses: actions/setup-node@v4
        with:
          node-version: '24'
          cache: 'pnpm'
      - run: pnpm install --frozen-lockfile

${stagingConfigStep}

      - name: Build untrusted preview source and package passive Worker bundles
        run: |
          pnpm turbo run build${buildFilters}
${bundleCommands}
        env:
          STAGING_ALIAS: \${{ needs.preview-db.outputs.alias }}${buildPublicEnv}

      - name: Upload passive preview bundle
        uses: actions/upload-artifact@v4
        with:
          name: cloudflare-preview-build-\${{ needs.preview-db.outputs.alias }}-\${{ github.run_id }}
          path: |
${artifactPaths}
          include-hidden-files: true
          if-no-files-found: error
          retention-days: 1

  deploy:
    needs: [preview-db, build-preview]
    runs-on: ubuntu-latest
    permissions:
      actions: read
      contents: read
      pull-requests: write
    steps:
      - name: Checkout trusted deployment code
        uses: actions/checkout@v4
        with:
          path: trusted-source
          ref: \${{ github.event.pull_request.base.sha || github.event.repository.default_branch }}
      - uses: actions/setup-node@v4
        with:
          node-version: '24'
      - name: Download passive preview bundle
        uses: actions/download-artifact@v4
        with:
          name: cloudflare-preview-build-\${{ needs.preview-db.outputs.alias }}-\${{ github.run_id }}
          path: preview-artifact

${migrationStep}

${privateSecretsStep}
      - name: Publish prebuilt preview Workers from trusted code
        run: sh trusted-source/scripts/publish-cloudflare-preview.sh
        env:
          PREVIEW_ARTIFACT: \${{ github.workspace }}/preview-artifact
          PREVIEW_SECRETS_DIR: \${{ steps.preview_secrets.outputs.directory }}
          TRUSTED_SOURCE: \${{ github.workspace }}/trusted-source
          STAGING_ALIAS: \${{ needs.preview-db.outputs.alias }}
          CLOUDFLARE_PREVIEW_ZONE_NAME: \${{ vars.CLOUDFLARE_PREVIEW_ZONE_NAME }}
          CLOUDFLARE_PREVIEW_WEB_DOMAIN: \${{ vars.CLOUDFLARE_PREVIEW_WEB_DOMAIN }}
          CLOUDFLARE_PREVIEW_API_DOMAIN: \${{ vars.CLOUDFLARE_PREVIEW_API_DOMAIN }}${publishDatabaseEnv}
          CLOUDFLARE_API_TOKEN: \${{ secrets.CLOUDFLARE_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: \${{ secrets.CLOUDFLARE_ACCOUNT_ID }}

      - name: Validate and seal exact preview deployment inventory
        run: |
          set -euo pipefail
          manifest=preview-artifact/cloudflare-preview-manifest.json
          alias=\${{ needs.preview-db.outputs.alias }}
          repository_id=\${{ github.repository_id }}
          database_kind=${db === 'sqlite' ? 'd1' : 'neon'}
          database_name=\${{ needs.preview-db.outputs.${db === 'sqlite' ? 'd1_database_name' : 'neon_branch_name'} }}
          database_id=\${{ needs.preview-db.outputs.${db === 'sqlite' ? 'd1_database_id' : 'neon_branch_id'} }}
          jq -e --arg alias "$alias" --arg kind "$database_kind" --arg name "$database_name" --arg id "$database_id" '
            .schemaVersion == 1 and .alias == $alias and
            (.workers | type == "array") and
            .database == { kind: $kind, name: $name, id: $id }
          ' "$manifest" >/dev/null
          jq -r '.workers[].name' "$manifest" | while IFS= read -r worker_name; do
            node trusted-source/scripts/cloudflare-preview-name.mjs --validate-name "$worker_name" "$alias" >/dev/null
          done
          mkdir -p "$RUNNER_TEMP/trusted-preview-inventory"
          jq --arg repository_id "$repository_id" '
            .schemaVersion = 2 | .repositoryId = $repository_id
          ' "$manifest" > "$RUNNER_TEMP/trusted-preview-inventory/cloudflare-preview-manifest.json"
      - name: Record exact preview deployment inventory
        uses: actions/upload-artifact@v4
        with:
          name: cloudflare-preview-inventory-\${{ needs.preview-db.outputs.alias }}
          path: \${{ runner.temp }}/trusted-preview-inventory/cloudflare-preview-manifest.json
          if-no-files-found: error
          retention-days: 90

      - name: Remove private Worker preview secret files
        if: always()
        run: rm -rf "$RUNNER_TEMP/gateway-preview-secrets"

      - uses: marocchino/sticky-pull-request-comment@v2
        if: github.event_name == 'pull_request_target'
        with:
          header: staging-deploy
          message: |
            **Staging deployed**

            | Public endpoint | URL |
            |---|---|
            | web | \`\${{ needs.build-preview.outputs.web_origin }}\` |
            | canonical API | \`\${{ needs.build-preview.outputs.api_origin }}\` |

            **Commit**: \`\${{ needs.build-preview.outputs.short_sha }}\`
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
          STAGING_NEON_BRANCH_NAME: \${{ needs.preview-db.outputs.neon_branch_name }}
          STAGING_NEON_BRANCH_ID: \${{ needs.preview-db.outputs.neon_branch_id }}`
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

function trustedPreviewMigrationStep(db: GvKitConfig['choices']['db']): string {
	if (db === 'sqlite') {
		return `      - name: Apply preview D1 migrations with a trusted pinned tool
        run: |
          set -euo pipefail
          cat > trusted-source/packages/db/wrangler.preview-migrations.json <<'JSON'
          {
            "name": "preview-migrations",
            "compatibility_date": "2026-08-24",
            "d1_databases": [{
              "binding": "DB",
              "database_name": "\${{ needs.preview-db.outputs.d1_database_name }}",
              "database_id": "\${{ needs.preview-db.outputs.d1_database_id }}",
              "migrations_dir": "migrations"
            }]
          }
          JSON
          npx wrangler@${WRANGLER_VERSION} d1 migrations apply "\${{ needs.preview-db.outputs.d1_database_name }}" --remote --config trusted-source/packages/db/wrangler.preview-migrations.json
        env:
          CLOUDFLARE_API_TOKEN: \${{ secrets.CLOUDFLARE_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: \${{ secrets.CLOUDFLARE_ACCOUNT_ID }}`
	}
	return `      - name: Apply preview Neon migrations with a trusted pinned tool
        run: |
          set -euo pipefail
          cat > "$RUNNER_TEMP/drizzle.preview.config.mjs" <<'JS'
          export default {
            out: process.env.PREVIEW_MIGRATIONS,
            dialect: 'postgresql',
            dbCredentials: { url: process.env.DATABASE_URL },
            strict: true,
            verbose: true
          }
          JS
          npx drizzle-kit@0.31.8 migrate --config "$RUNNER_TEMP/drizzle.preview.config.mjs"
        env:
          DATABASE_URL: \${{ needs.preview-db.outputs.database_url }}
          PREVIEW_MIGRATIONS: \${{ github.workspace }}/trusted-source/packages/db/migrations`
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
    if: github.event_name != 'workflow_dispatch' || github.ref == format('refs/heads/{0}', github.event.repository.default_branch)
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
      - name: Checkout trusted ingress verification
        uses: actions/checkout@v4
        with:
          ref: \${{ github.event.pull_request.base.sha || github.event.repository.default_branch }}
${publicVariableValidation}      - name: Verify managed preview ingress
        run: node scripts/verify-cloudflare-preview-ingress.mjs
        env:
          CLOUDFLARE_API_TOKEN: \${{ secrets.CLOUDFLARE_API_TOKEN }}
          CLOUDFLARE_PREVIEW_WEB_DOMAIN: \${{ vars.CLOUDFLARE_PREVIEW_WEB_DOMAIN }}
          CLOUDFLARE_PREVIEW_API_DOMAIN: \${{ vars.CLOUDFLARE_PREVIEW_API_DOMAIN }}
          CLOUDFLARE_PREVIEW_ZONE_NAME: \${{ vars.CLOUDFLARE_PREVIEW_ZONE_NAME }}
`
}

const PREVIEW_ALIAS_SCRIPT = `preview_id="\${{ github.event.pull_request.number || github.run_id }}"
          if ! printf '%s' "$preview_id" | grep -Eq '^[1-9][0-9]*$' || [ "\${#preview_id}" -gt 29 ]; then
            echo "Preview id must be a bounded positive integer." >&2
            exit 1
          fi
          alias="pr-$preview_id"
          echo "alias=$alias" >> "$GITHUB_OUTPUT"
          printf '%s\\n' "gh workflow run cleanup-staging.yml -f alias=$alias" >> "$GITHUB_STEP_SUMMARY"`

function d1PreviewDbJob(): string {
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
          db_name="preview-\${{ github.repository_id }}-d1-\${{ steps.meta.outputs.alias }}"
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

function neonPreviewDbJob(): string {
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
          echo "neon_branch_name=preview-\${{ github.repository_id }}-neon-$alias" >> "$GITHUB_OUTPUT"
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

function cleanupStagingWorkflow(db: GvKitConfig['choices']['db']): string {
	const previewDbCleanupStep =
		db === 'sqlite' ? d1PreviewDbCleanupStep() : neonPreviewDbCleanupStep()
	return `# Tear down a PR preview when it closes or a manual preview by canonical alias.
# Cleanup always inventories preview resources from the trusted default branch. Source
# branches, production resources, and shared wildcard DNS records are unchanged.
${db === 'postgres' ? '# Neon preview branch cleanup uses NEON_API_KEY and NEON_PROJECT_ID.\n' : ''}

name: cleanup-staging

on:
  pull_request_target:
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
    if: github.event_name != 'workflow_dispatch' || github.ref == format('refs/heads/{0}', github.event.repository.default_branch)
    runs-on: ubuntu-latest
    permissions:
      actions: read
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

      - id: preview_inventories
        name: Download durable preview inventories
        run: |
          set -euo pipefail
          inventory_dir="$RUNNER_TEMP/cloudflare-preview-inventories"
          mkdir -p "$inventory_dir"
          pages=$(mktemp)
          trap 'rm -f "$pages" "$RUNNER_TEMP"/cloudflare-preview-inventory-*.zip' EXIT HUP INT TERM
          gh api --paginate --slurp "/repos/$GITHUB_REPOSITORY/actions/artifacts?per_page=100" > "$pages"
          if ! jq -e 'type == "array" and length <= 100 and all(.[]; (.artifacts | type) == "array")' "$pages" >/dev/null; then
            echo "GitHub returned a malformed preview inventory artifact listing." >&2
            exit 1
          fi
          artifact_records=$(jq -r --arg prefix "cloudflare-preview-inventory-\${{ steps.alias.outputs.alias }}" '
            [.[].artifacts[]
              | select(
                  .expired == false and (.workflow_run.id | type) == "number" and
                  (.name == $prefix or (.name | startswith($prefix + "-")))
                )]
            | sort_by(.created_at) | reverse
            | .[] | [.id, .workflow_run.id, .name] | @tsv
          ' "$pages")
          artifact_count=$(printf '%s\\n' "$artifact_records" | awk 'NF { count++ } END { print count + 0 }')
          if [ "$artifact_count" -gt 100 ]; then
            echo "Preview inventory artifact count exceeds the cleanup bound." >&2
            exit 1
          fi
          printf '%s\\n' "$artifact_records" | while IFS="$(printf '\\t')" read -r artifact_id run_id artifact_name; do
            [ -n "$artifact_id" ] || continue
            run=$(gh api "/repos/$GITHUB_REPOSITORY/actions/runs/$run_id")
            if ! printf '%s' "$run" | jq -e --arg repository_id "$EXPECTED_REPOSITORY_ID" --arg default_branch "$EXPECTED_DEFAULT_BRANCH" --arg preview_alias "\${{ steps.alias.outputs.alias }}" '
              .name == "deploy-staging" and .path == ".github/workflows/deploy-staging.yml" and
              .status == "completed" and .conclusion == "success" and
              (.repository.id | tostring) == $repository_id and
              (
                .event == "pull_request_target" or
                (.event == "workflow_dispatch" and .head_branch == $default_branch) or
                (
                  .event == "pull_request" and (.pull_requests | length) == 1 and
                  ("pr-" + (.pull_requests[0].number | tostring)) == $preview_alias and
                  (.pull_requests[0].base.repo.id | tostring) == $repository_id and
                  .pull_requests[0].base.ref == $default_branch
                )
              )
            ' >/dev/null; then
              echo "Preview inventory artifact $artifact_id has no trusted successful deployment run." >&2
              exit 1
            fi
            event=$(printf '%s' "$run" | jq -r '.event')
            prefix="cloudflare-preview-inventory-\${{ steps.alias.outputs.alias }}"
            if [ "$event" = "pull_request" ]; then
              expected_artifact_name="$prefix-$run_id"
            else
              expected_artifact_name="$prefix"
            fi
            if [ "$artifact_name" != "$expected_artifact_name" ]; then
              echo "Preview inventory artifact $artifact_id does not match its trusted deployment generation." >&2
              exit 1
            fi
            zip="$RUNNER_TEMP/cloudflare-preview-inventory-$artifact_id.zip"
            manifest="$inventory_dir/$artifact_id.$event.json"
            gh api "/repos/$GITHUB_REPOSITORY/actions/artifacts/$artifact_id/zip" > "$zip"
            if ! unzip -p "$zip" cloudflare-preview-manifest.json > "$manifest"; then
              echo "Preview inventory artifact $artifact_id is malformed." >&2
              exit 1
            fi
            if [ "$event" = "pull_request" ]; then
              base_sha=$(printf '%s' "$run" | jq -er '.pull_requests[0].base.sha | select(test("^[0-9a-f]{40}$"))')
              encoded_workflow=$(gh api "/repos/$GITHUB_REPOSITORY/contents/.github/workflows/deploy-staging.yml?ref=$base_sha" --jq .content)
              trusted_project=$(printf '%s' "$encoded_workflow" | tr -d '\\n' | base64 --decode | sed -n 's/^# Per-PR staging deploy for \\([a-z0-9][a-z0-9-]*\\)\\.$/\\1/p' | head -n 1)
              if [ -z "$trusted_project" ] || ! jq -e --arg alias "\${{ steps.alias.outputs.alias }}" --arg project "$trusted_project" '
                .schemaVersion == 1 and .project == $project and .alias == $alias and
                .database.name == ($project + "-db-" + $alias)
              ' "$manifest" >/dev/null; then
                echo "Legacy preview inventory artifact $artifact_id does not match its immutable trusted base." >&2
                exit 1
              fi
            fi
          done
          echo "authenticated_count=$artifact_count" >> "$GITHUB_OUTPUT"
        env:
          EXPECTED_DEFAULT_BRANCH: \${{ github.event.repository.default_branch }}
          EXPECTED_REPOSITORY_ID: \${{ github.repository_id }}
          GH_TOKEN: \${{ github.token }}

      - id: worker_cleanup
        name: Delete staging Workers
        run: sh scripts/cleanup-cloudflare-preview-workers.sh "\${{ steps.alias.outputs.alias }}"
        env:
          CLOUDFLARE_API_TOKEN: \${{ secrets.CLOUDFLARE_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: \${{ secrets.CLOUDFLARE_ACCOUNT_ID }}

${previewDbCleanupStep}

      - id: cleanup_result
        name: Report preview cleanup result
        if: always()
        run: |
          failures=0
          if [ "$WORKER_CLEANUP_OUTCOME" != "success" ]; then
            echo "Worker cleanup outcome: $WORKER_CLEANUP_OUTCOME" >&2
            failures=$((failures + 1))
          fi
          if [ "$DATABASE_CLEANUP_OUTCOME" != "success" ]; then
            echo "Database cleanup outcome: $DATABASE_CLEANUP_OUTCOME" >&2
            failures=$((failures + 1))
          fi
          if ! printf '%s' "$AUTHENTICATED_INVENTORY_COUNT" | grep -Eq '^[1-9][0-9]*$'; then
            echo "No authenticated preview deployment inventory exists for $PREVIEW_ALIAS; cleanup is incomplete." >&2
            failures=$((failures + 1))
          fi
          if [ "$failures" -ne 0 ]; then
            echo "Preview cleanup completed with $failures failed resource group(s)." >&2
            exit 1
          fi
          echo "Preview cleanup removed every discovered resource."
        env:
          WORKER_CLEANUP_OUTCOME: \${{ steps.worker_cleanup.outcome }}
          DATABASE_CLEANUP_OUTCOME: \${{ steps.database_cleanup.outcome }}
          AUTHENTICATED_INVENTORY_COUNT: \${{ steps.preview_inventories.outputs.authenticated_count }}
          PREVIEW_ALIAS: \${{ steps.alias.outputs.alias }}

      - uses: marocchino/sticky-pull-request-comment@v2
        if: github.event_name == 'pull_request_target' && steps.cleanup_result.outcome == 'success'
        with:
          header: staging-deploy
          message: |
            **Staging cleaned up**

            Preview Workers and data resources removed. The source branch was not changed.
`
}

function d1PreviewDbCleanupStep(): string {
	return `      - id: database_cleanup
        name: Delete preview D1 databases
        if: always() && steps.alias.outcome == 'success'
        run: |
          set -euo pipefail
          repository_id="\${{ github.repository_id }}"
          alias="\${{ steps.alias.outputs.alias }}"
          if ! printf '%s' "$repository_id" | grep -Eq '^[1-9][0-9]*$'; then
            echo "GitHub supplied an invalid repository id." >&2
            exit 1
          fi
          prefix="preview-$repository_id-"
          suffix="-$alias"
          candidates=$(mktemp)
          trap 'rm -f "$candidates"' EXIT HUP INT TERM
          databases_json=$(npx wrangler@${WRANGLER_VERSION} d1 list --json)
          if ! printf '%s' "$databases_json" | jq -e 'type == "array" and length <= 10000 and all(.[]; (.name | type) == "string" and (((.uuid // .id) // "") | type) == "string")' >/dev/null; then
            echo "Cloudflare returned a malformed preview D1 inventory." >&2
            exit 1
          fi
          if ! printf '%s' "$databases_json" | jq -e 'group_by(.uuid // .id // "") | all(.[]; length == 1)' >/dev/null; then
            echo "Cloudflare returned duplicate preview D1 identities." >&2
            exit 1
          fi
          printf '%s' "$databases_json" | jq -r --arg prefix "$prefix" --arg suffix "$suffix" '.[] | select(.name | startswith($prefix) and endswith($suffix)) | [.name, (.uuid // .id // "")] | @tsv' > "$candidates"
          if [ -d "\${PREVIEW_MANIFEST_DIR:-}" ]; then
            for manifest in "$PREVIEW_MANIFEST_DIR"/*.json; do
              [ -e "$manifest" ] || continue
              case "$manifest" in
                *.pull_request.json) manifest_generation=pull_request ;;
                *.pull_request_target.json) manifest_generation=pull_request_target ;;
                *.workflow_dispatch.json) manifest_generation=workflow_dispatch ;;
                *) echo "Recorded preview D1 identity has no trusted deployment generation." >&2; exit 1 ;;
              esac
              if ! identity=$(jq -er --arg alias "$alias" --arg repository_id "$repository_id" --arg generation "$manifest_generation" '
                if .schemaVersion == 1 then
                  select($generation == "pull_request") | select(
                    .alias == $alias and .project != null and
                    (.project | type == "string" and test("^[a-z0-9]+(-[a-z0-9]+)*$") and length <= 255) and
                    .database.kind == "d1" and
                    .database.name == (.project + "-db-" + $alias)
                  )
                elif .schemaVersion == 2 then
                  select($generation == "pull_request_target" or $generation == "workflow_dispatch") | select(
                    .repositoryId == $repository_id and .alias == $alias and
                    .database.kind == "d1" and
                    (.database.name | test("^preview-" + $repository_id + "-[a-z0-9]+(-[a-z0-9]+)*-" + $alias + "$"))
                  )
                else error("unsupported manifest schema") end
                | select(.database.id | type == "string")
                | [.database.name, .database.id] | @tsv
              ' "$manifest"); then
                echo "Recorded preview D1 identity is malformed or outside this repository preview." >&2
                exit 1
              fi
              db_name=$(printf '%s' "$identity" | cut -f1)
              db_id=$(printf '%s' "$identity" | cut -f2)
              if printf '%s' "$databases_json" | jq -e --arg name "$db_name" --arg id "$db_id" 'any(.[]; .name == $name and (.uuid // .id // "") == $id)' >/dev/null; then
                printf '%s\\t%s\\n' "$db_name" "$db_id" >> "$candidates"
              fi
            done
          fi
          sort -u "$candidates" -o "$candidates"
          candidate_count=$(awk 'END { print NR + 0 }' "$candidates")
          if [ "$candidate_count" -gt 100 ]; then
            echo "Cloudflare preview D1 inventory exceeds the cleanup bound." >&2
            exit 1
          fi
          if [ "$candidate_count" -eq 0 ]; then
            echo "Preview D1 databases for $alias are missing or already deleted."
            exit 0
          fi
          while IFS="$(printf '\\t')" read -r db_name db_id; do
            if { ! printf '%s' "$db_name" | grep -Eq "^preview-$repository_id-[a-z0-9]+(-[a-z0-9]+)*-$alias$" && ! printf '%s' "$db_name" | grep -Eq "^[a-z0-9]+(-[a-z0-9]+)*-db-$alias$"; } || ! printf '%s' "$db_id" | grep -Eq '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'; then
              echo "Cloudflare returned an unsafe preview D1 identity." >&2
              exit 1
            fi
          done < "$candidates"
          failures=0
          while IFS="$(printf '\\t')" read -r db_name db_id; do
            if npx wrangler@${WRANGLER_VERSION} d1 delete "$db_id" --skip-confirmation; then
              echo "Deleted preview D1 database $db_name ($db_id)."
            else
              echo "Failed to delete preview D1 database $db_name ($db_id)." >&2
              failures=$((failures + 1))
            fi
          done < "$candidates"
          if [ "$failures" -ne 0 ]; then
            echo "$failures preview D1 database deletion(s) failed." >&2
            exit 1
          fi
        env:
          CLOUDFLARE_API_TOKEN: \${{ secrets.CLOUDFLARE_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: \${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
          PREVIEW_MANIFEST_DIR: \${{ runner.temp }}/cloudflare-preview-inventories`
}

function neonPreviewDbCleanupStep(): string {
	return `      - id: database_cleanup
        name: Delete preview Neon branches
        if: always() && steps.alias.outcome == 'success'
        run: |
          set -euo pipefail
          repository_id="\${{ github.repository_id }}"
          alias="\${{ steps.alias.outputs.alias }}"
          if ! printf '%s' "$repository_id" | grep -Eq '^[1-9][0-9]*$'; then
            echo "GitHub supplied an invalid repository id." >&2
            exit 1
          fi
          prefix="preview-$repository_id-"
          suffix="-$alias"
          branch_inventory=$(mktemp)
          candidates=$(mktemp)
          trap 'rm -f "$branch_inventory" "$candidates"' EXIT HUP INT TERM
          cursor=''
          page=1
          while :; do
            if [ -n "$cursor" ]; then
              if ! branches_json=$(curl -fsS -G -H "Authorization: Bearer $NEON_API_KEY" --data-urlencode "limit=1000" --data-urlencode "cursor=$cursor" "https://console.neon.tech/api/v2/projects/$NEON_PROJECT_ID/branches"); then
                echo "Could not list Neon branches." >&2
                exit 1
              fi
            elif ! branches_json=$(curl -fsS -G -H "Authorization: Bearer $NEON_API_KEY" --data-urlencode "limit=1000" "https://console.neon.tech/api/v2/projects/$NEON_PROJECT_ID/branches"); then
              echo "Could not list Neon branches." >&2
              exit 1
            fi
            if ! printf '%s' "$branches_json" | jq -e '(.branches | type == "array") and (.branches | length) <= 1000 and all(.branches[]; (.name | type) == "string" and (.id | type) == "string" and (.default | type) == "boolean" and (.protected | type) == "boolean") and (.pagination | type == "object") and ((.pagination.next == null) or ((.pagination.next | type) == "string" and (.pagination.next | length) > 0 and (.pagination.next | length) <= 2048))' >/dev/null; then
              echo "Neon returned a malformed preview branch inventory." >&2
              exit 1
            fi
            printf '%s' "$branches_json" | jq -c '.branches[]' >> "$branch_inventory"
            next_cursor=$(printf '%s' "$branches_json" | jq -r '.pagination.next // empty')
            if [ -z "$next_cursor" ]; then break; fi
            if [ "$page" -ge 100 ]; then
              echo "Neon preview branch inventory exceeds the cleanup bound." >&2
              exit 1
            fi
            cursor="$next_cursor"
            page=$((page + 1))
          done
          if ! jq -s -e 'group_by(.id) | all(.[]; length == 1)' "$branch_inventory" >/dev/null; then
            echo "Neon returned duplicate preview branch identities." >&2
            exit 1
          fi
          jq -r --arg prefix "$prefix" --arg suffix "$suffix" 'select(.name | startswith($prefix) and endswith($suffix)) | [.name, .id] | @tsv' "$branch_inventory" > "$candidates"
          if [ -d "\${PREVIEW_MANIFEST_DIR:-}" ]; then
            for manifest in "$PREVIEW_MANIFEST_DIR"/*.json; do
              [ -e "$manifest" ] || continue
              case "$manifest" in
                *.pull_request.json) manifest_generation=pull_request ;;
                *.pull_request_target.json) manifest_generation=pull_request_target ;;
                *.workflow_dispatch.json) manifest_generation=workflow_dispatch ;;
                *) echo "Recorded preview Neon identity has no trusted deployment generation." >&2; exit 1 ;;
              esac
              if ! identity=$(jq -er --arg alias "$alias" --arg repository_id "$repository_id" --arg generation "$manifest_generation" '
                if .schemaVersion == 1 then
                  select($generation == "pull_request") | select(
                    .alias == $alias and .project != null and
                    (.project | type == "string" and test("^[a-z0-9]+(-[a-z0-9]+)*$") and length <= 255) and
                    .database.kind == "neon" and
                    .database.name == (.project + "-db-" + $alias)
                  )
                elif .schemaVersion == 2 then
                  select($generation == "pull_request_target" or $generation == "workflow_dispatch") | select(
                    .repositoryId == $repository_id and .alias == $alias and
                    .database.kind == "neon" and
                    (.database.name | test("^preview-" + $repository_id + "-[a-z0-9]+(-[a-z0-9]+)*-" + $alias + "$"))
                  )
                else error("unsupported manifest schema") end
                | select(.database.id | type == "string")
                | [.database.name, .database.id] | @tsv
              ' "$manifest"); then
                echo "Recorded preview Neon identity is malformed or outside this repository preview." >&2
                exit 1
              fi
              branch_name=$(printf '%s' "$identity" | cut -f1)
              branch_id=$(printf '%s' "$identity" | cut -f2)
              if jq -e --arg name "$branch_name" --arg id "$branch_id" 'select(.name == $name and .id == $id)' "$branch_inventory" >/dev/null; then
                printf '%s\\t%s\\n' "$branch_name" "$branch_id" >> "$candidates"
              fi
            done
          fi
          sort -u "$candidates" -o "$candidates"
          candidate_count=$(awk 'END { print NR + 0 }' "$candidates")
          if [ "$candidate_count" -gt 100 ]; then
            echo "Neon preview branch inventory exceeds the cleanup candidate bound." >&2
            exit 1
          fi
          if [ "$candidate_count" -eq 0 ]; then
            echo "Preview Neon branches for $alias are missing or already deleted."
            exit 0
          fi
          while IFS="$(printf '\\t')" read -r branch_name branch_id; do
            if { ! printf '%s' "$branch_name" | grep -Eq "^preview-$repository_id-[a-z0-9]+(-[a-z0-9]+)*-$alias$" && ! printf '%s' "$branch_name" | grep -Eq "^[a-z0-9]+(-[a-z0-9]+)*-db-$alias$"; } || ! printf '%s' "$branch_id" | grep -Eq '^br-[A-Za-z0-9_-]+$'; then
              echo "Neon returned an unsafe preview branch identity." >&2
              exit 1
            fi
            if ! jq -e --arg name "$branch_name" --arg id "$branch_id" 'select(.name == $name and .id == $id and .default == false and .protected == false)' "$branch_inventory" >/dev/null; then
              echo "Neon refused cleanup of a default or protected preview branch." >&2
              exit 1
            fi
          done < "$candidates"
          failures=0
          while IFS="$(printf '\\t')" read -r branch_name branch_id; do
            if curl -fsS -X DELETE -H "Authorization: Bearer $NEON_API_KEY" "https://console.neon.tech/api/v2/projects/$NEON_PROJECT_ID/branches/$branch_id" >/dev/null; then
              echo "Deleted preview Neon branch $branch_name ($branch_id)."
            else
              echo "Failed to delete preview Neon branch $branch_name ($branch_id)." >&2
              failures=$((failures + 1))
            fi
          done < "$candidates"
          if [ "$failures" -ne 0 ]; then
            echo "$failures preview Neon branch deletion(s) failed." >&2
            exit 1
          fi
        env:
          NEON_PROJECT_ID: \${{ vars.NEON_PROJECT_ID }}
          NEON_API_KEY: \${{ secrets.NEON_API_KEY }}
          PREVIEW_MANIFEST_DIR: \${{ runner.temp }}/cloudflare-preview-inventories`
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
	const env = [`      PORT: "${AUTH_SERVICE.development.port}"`]
	if (opts.hasAuth) {
		env.push(...dbEnvLines(opts, '      '))
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
		...(opts.hasAuth ? volumeMountLines(opts, '    ') : []),
		...(opts.hasAuth ? dependsOnDbAndMigrate(opts) : []),
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
		proxy_http_version 1.1;
		proxy_request_buffering off;
		proxy_buffering off;
		proxy_set_header Host $http_host;
		proxy_set_header X-Forwarded-Host $http_host;
		proxy_set_header X-Forwarded-Proto \${PUBLIC_SCHEME};
		proxy_set_header X-Gateway-Ingress-Secret \${GATEWAY_TRUSTED_INGRESS_SECRET};
		proxy_set_header X-Request-ID $request_id;
	}

	location ^~ /api/ {
		proxy_pass http://gateway_upstream;
		proxy_http_version 1.1;
		proxy_request_buffering off;
		proxy_buffering off;
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
		proxy_http_version 1.1;
		proxy_request_buffering off;
		proxy_buffering off;
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
