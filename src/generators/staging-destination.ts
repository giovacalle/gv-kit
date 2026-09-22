import { parseJsonc } from '../lib/jsonc.js'
import type { GvKitConfig } from '../schema/config.js'
import { generateFrontendSveltekit } from './frontend-sveltekit.js'
import { generateGateway } from './gateway.js'
import { generateMarketingAstro } from './marketing-astro.js'
import { generateAuthService } from './services/auth.js'
import { generateUsersService } from './services/users.js'

export function stagingDestinationScript(cfg: GvKitConfig): string {
	const configurations = Object.fromEntries([
		...generateGateway(cfg),
		...generateAuthService(cfg),
		...generateUsersService(cfg),
		...generateFrontendSveltekit(cfg),
		...generateMarketingAstro(cfg)
	].filter(({ path }) => path.endsWith('/wrangler.jsonc'))
		.map(({ path, content }) => [path.slice(0, -'/wrangler.jsonc'.length), parseJsonc(content)]))
	return `import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual, parseEnv } from 'node:util'
import { cloudflarePreviewName, validateCloudflarePreviewAlias } from './cloudflare-preview-name.mjs'

const configurations = ${JSON.stringify(configurations, null, 2)}
const root = fileURLToPath(new URL('../', import.meta.url))
const directory = path.relative(root, process.cwd()).split(path.sep).join('/')
if (!Object.hasOwn(configurations, directory)) throw new Error('Run staging deployment from its package directory')
if (process.argv.length !== 2) throw new Error('Staging deployment does not accept command-line overrides')
const destinationOverrides = ['WRANGLER_CI_OVERRIDE_NAME', 'CLOUDFLARE_ENV']
for (const key of destinationOverrides) if (Object.hasOwn(process.env, key)) throw new Error('Staging deployment does not accept ' + key)
for (const file of ['.env', '.env.local']) {
	let content
	try { content = readFileSync(file, 'utf8') } catch (error) {
		if (error.code === 'ENOENT') continue
		throw error
	}
	const variables = parseEnv(content)
	for (const key of destinationOverrides) if (Object.hasOwn(variables, key)) throw new Error('Staging deployment does not accept ' + key + ' in ' + file)
}
const alias = validateCloudflarePreviewAlias(process.env.STAGING_ALIAS)
const configPath = process.env.STAGING_WRANGLER_CONFIG
if (!configPath) throw new Error('STAGING_WRANGLER_CONFIG is required; run preview preparation first')
const config = JSON.parse(readFileSync(configPath, 'utf8'))
const expected = structuredClone(configurations[directory])
if (!config || config.name !== cloudflarePreviewName(expected.name, alias)) throw new Error('Staging Worker name does not match this project, package, and alias')

function required(name) {
	const value = process.env[name]
	if (!value) throw new Error(name + ' is required')
	return value
}

function domain(name) {
	const value = required(name).trim().toLowerCase().replace(/\\.$/, '')
	if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(value)) throw new Error(name + ' must be a plain DNS hostname')
	return value
}

const zone = domain('CLOUDFLARE_PREVIEW_ZONE_NAME')
const webDomain = domain('CLOUDFLARE_PREVIEW_WEB_DOMAIN')
const apiDomain = domain('CLOUDFLARE_PREVIEW_API_DOMAIN')
for (const hostname of [webDomain, apiDomain]) if (hostname !== zone && !hostname.endsWith('.' + zone)) throw new Error('Preview domains must belong to the preview zone')
if (webDomain === apiDomain) throw new Error('Preview web and API domains must be distinct')
const webHost = alias + '.' + webDomain
const apiHost = alias + '.' + apiDomain
const webOrigin = 'https://' + webHost
const apiOrigin = 'https://' + apiHost
const localHosts = 'localhost:3000,localhost:5173,api.localhost:8786'
const localOrigins = 'http://localhost:3000,http://localhost:5173,http://api.localhost:8786'
expected.name = cloudflarePreviewName(expected.name, alias)
expected.workers_dev = false
expected.preview_urls = false
delete expected.route
delete expected.routes
if (directory === 'apps/api') {
	expected.routes = [
		{ pattern: apiHost + '/*', zone_name: zone },
		{ pattern: webHost + '/api', zone_name: zone },
		{ pattern: webHost + '/api/*', zone_name: zone }
	]
	expected.vars = {
		...expected.vars,
		API_PUBLIC_ORIGIN: apiOrigin,
		GATEWAY_PUBLIC_ORIGINS: webOrigin + ',' + apiOrigin + ',' + localOrigins,
		API_CORS_ORIGINS: webOrigin + ',' + localOrigins
	}
}
if (directory === 'apps/web') expected.routes = [{ pattern: webHost + '/*', zone_name: zone }]
if (directory === 'apps/marketing') expected.routes = [{ pattern: alias + '-marketing.' + webDomain + '/*', zone_name: zone }]
if (directory === 'services/auth' && expected.vars) {
	expected.vars = {
		...expected.vars,
		BETTER_AUTH_ALLOWED_HOSTS: webHost + ',' + apiHost + ',' + localHosts,
		AUTH_CORS_ORIGINS: webOrigin + ',' + apiOrigin + ',' + localOrigins
	}
}
if (expected.services) expected.services = expected.services.map((binding) => ({ ...binding, service: cloudflarePreviewName(binding.service, alias) }))
if (expected.d1_databases) {
	const repositoryId = required('GITHUB_REPOSITORY_ID')
	if (!/^[1-9][0-9]*$/.test(repositoryId)) throw new Error('GITHUB_REPOSITORY_ID must be a positive integer')
	const databaseName = required('STAGING_D1_DATABASE_NAME')
	const databaseId = required('STAGING_D1_DATABASE_ID')
	if (databaseName !== 'preview-' + repositoryId + '-d1-' + alias) throw new Error('Staging D1 name must belong to the repository and alias')
	if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(databaseId)) throw new Error('Staging D1 ID must be an explicit UUID')
	expected.d1_databases = expected.d1_databases.map((binding) => ({ ...binding, database_name: databaseName, database_id: databaseId }))
}
if (!isDeepStrictEqual(config, expected)) throw new Error('Unsafe staging configuration: use the prepared package configuration with matching preview inputs')
const args = ['deploy', '--config', configPath]
if (expected.secrets?.required.length > 0) {
	const secretsFile = required('STAGING_SECRETS_FILE')
	if (!statSync(secretsFile).isFile()) throw new Error('STAGING_SECRETS_FILE must be a regular file')
	args.push('--secrets-file', secretsFile)
}
const environment = { WRANGLER_SEND_METRICS: 'false', WRANGLER_SEND_ERROR_REPORTS: 'false' }
for (const key of ['PATH', 'HOME', 'USERPROFILE', 'SystemRoot', 'WINDIR', 'TMPDIR', 'TMP', 'TEMP', 'XDG_CONFIG_HOME', 'CI', 'CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_KEY', 'CLOUDFLARE_EMAIL', 'CF_API_TOKEN', 'CF_ACCOUNT_ID', 'CF_API_KEY', 'CF_EMAIL']) if (process.env[key] !== undefined) environment[key] = process.env[key]
const temporary = mkdtempSync(path.join(tmpdir(), 'cloudflare-staging-'))
let result
try {
	const envFile = path.join(temporary, 'empty.env')
	writeFileSync(envFile, '', { mode: 0o600 })
	// An explicit empty file disables Wrangler's automatic system dotenv loading.
	args.push('--env', '', '--env-file', envFile)
	result = spawnSync('wrangler', args, { stdio: 'inherit', env: environment })
	if (result.error) throw result.error
} finally {
	rmSync(temporary, { recursive: true, force: true })
}
process.exit(result.status ?? 1)
`
}
