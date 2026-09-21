import { spawnSync } from 'node:child_process'
import { chmod, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { runGenerators } from '../src/generators/index.js'
import { parseJsonc } from '../src/lib/jsonc.js'
import { GvKitConfig } from '../src/schema/config.js'

type Scenario = {
	name: string
	valid?: boolean
	production?: boolean
	deploymentExit?: number
	arguments?: string
	env?: Record<string, string>
	content?: string
	dotenv?: { file: string; content: string }
	change?: (config: Record<string, unknown>) => void
}

const args = process.argv.slice(2)
if ((args.length !== 2 && args.length !== 4) || args[0] !== '--output' || (args.length === 4 && args[2] !== '--scenario')) throw new Error('Usage: bun scripts/verify-package-staging.ts --output <new-owned-directory> [--scenario <name>]')
const selectedScenario = args[3]
const output = resolve(args[1]!)
await mkdir(dirname(output), { recursive: true })
await mkdir(output)
const bin = join(output, 'bin')
await mkdir(bin)
const node = Bun.which('node')
if (!node) throw new Error('Node is required')
await symlink(node, join(bin, 'node'))
await writeFile(join(bin, 'pnpm'), '#!/bin/sh\n[ "$#" -eq 1 ] && [ "$1" = cf-typegen ] || exit 91\nprintf "typegen\\n" >> "$TYPEGEN_RECEIPT"\n')
await writeFile(join(bin, 'wrangler'), `#!/usr/bin/env node
import { appendFileSync, readFileSync } from 'node:fs'
const args = process.argv.slice(2)
if (args[0] !== 'deploy') process.exit(92)
const index = args.indexOf('--config')
const configPath = index === -1 ? 'wrangler.jsonc' : args[index + 1]
const { receipt, deploymentExit } = JSON.parse(readFileSync('.staging-verifier.json', 'utf8'))
const envFile = args[args.indexOf('--env-file') + 1]
appendFileSync(receipt, JSON.stringify({ args, configPath, config: readFileSync(configPath, 'utf8'), environment: process.env, envFileContent: args.includes('--env-file') ? readFileSync(envFile, 'utf8') : null }) + '\\n')
process.exit(deploymentExit)
`)
for (const executable of ['pnpm', 'wrangler']) await chmod(join(bin, executable), 0o755)
const matrix: Array<Record<string, unknown>> = []
let failures = 0
for (const db of ['sqlite', 'postgres'] as const) {
	for (const hasAuth of [false, true]) {
		const variant = `${db}-${hasAuth ? 'auth' : 'no-auth'}`
		const cfg = GvKitConfig.parse({ configVersion: 2, choices: {
			name: 'staging-verification', frontend: 'sveltekit', marketing: 'astro', backend: 'hono',
			i18n: 'skip', monitoring: [], db, apiClient: 'skip', auth: hasAuth ? ['emailOTP', 'google'] : [],
			email: hasAuth ? 'resend' : 'skip', aiTooling: [], deploy: 'cf-workers'
		} })
		const project = join(output, variant)
		for (const entry of runGenerators(cfg)) {
			await mkdir(dirname(join(project, entry.path)), { recursive: true })
			await writeFile(join(project, entry.path), entry.content)
		}
		const secrets = join(project, 'synthetic-secrets.json')
		await writeFile(secrets, '{}\n', { mode: 0o600 })
		await mkdir(join(project, 'tmp'))
		const environment = {
			TMPDIR: join(project, 'tmp'), PATH: bin + ':/usr/bin:/bin', HOME: project, STAGING_ALIAS: 'pr-123', STAGING_SECRETS_FILE: secrets,
			PREVIEW_DB_KIND: db === 'sqlite' ? 'd1' : 'neon', GITHUB_REPOSITORY_ID: '123456',
			STAGING_D1_DATABASE_NAME: 'preview-123456-d1-pr-123', STAGING_D1_DATABASE_ID: '11111111-1111-4111-8111-111111111111',
			STAGING_NEON_BRANCH_NAME: 'preview-123456-neon-pr-123', STAGING_NEON_BRANCH_ID: 'br-synthetic',
			CLOUDFLARE_PREVIEW_ZONE_NAME: 'example.test', CLOUDFLARE_PREVIEW_WEB_DOMAIN: 'app.example.test', CLOUDFLARE_PREVIEW_API_DOMAIN: 'api.example.test'
		}
		const preparation = spawnSync(node, ['scripts/prepare-cloudflare-preview.mjs'], { cwd: project, env: environment, encoding: 'utf8', timeout: 10_000 })
		await writeFile(join(project, 'preparation.json'), JSON.stringify({ exitCode: preparation.status, stdout: preparation.stdout, stderr: preparation.stderr }, null, 2))
		if (preparation.status !== 0) throw new Error('Preview preparation failed: ' + preparation.stderr)
		for (const directory of ['apps/api', 'apps/web', 'services/auth', 'services/users', 'apps/marketing']) {
			const pkg = JSON.parse(await readFile(join(project, directory, 'package.json'), 'utf8'))
			const command = pkg.scripts['deploy:staging']
			if (typeof command !== 'string') throw new Error('Missing staging command for ' + directory)
			const original = parseJsonc<Record<string, unknown>>(await readFile(join(project, directory, 'wrangler.staging.jsonc'), 'utf8'))
			const other = parseJsonc<Record<string, unknown>>(await readFile(join(project, directory === 'apps/api' ? 'apps/web' : 'apps/api', 'wrangler.staging.jsonc'), 'utf8'))
			const production = await readFile(join(project, directory, 'wrangler.jsonc'), 'utf8')
			const needsSecrets = directory === 'services/auth' ? hasAuth : directory === 'services/users' && db === 'postgres'
			const scenarios: Scenario[] = [
				{ name: 'constrained-child-environment', valid: true, env: { NODE_OPTIONS: '--trace-warnings', UNRELATED_SECRET: 'synthetic-not-for-wrangler', CLOUDFLARE_API_BASE_URL: 'https://untrusted.example.test', CLOUDFLARE_API_TOKEN: 'synthetic-provider-token', CLOUDFLARE_ACCOUNT_ID: '00000000000000000000000000000000' } },
				{ name: 'inherited-production-name', env: { WRANGLER_CI_OVERRIDE_NAME: String(parseJsonc<Record<string, unknown>>(production).name) } },
				{ name: 'inherited-cross-preview-name', env: { WRANGLER_CI_OVERRIDE_NAME: String(original.name).replace('pr-123', 'pr-124') } },
				{ name: 'inherited-environment', env: { CLOUDFLARE_ENV: 'production' } },
				{ name: 'dotenv-production-name', dotenv: { file: '.env.local', content: 'WRANGLER_CI_OVERRIDE_NAME=production-worker\n' } },
				{ name: 'dotenv-base-production-name', dotenv: { file: '.env', content: 'export WRANGLER_CI_OVERRIDE_NAME="production-worker"\n' } },
				{ name: 'dotenv-cross-preview-name', dotenv: { file: '.env', content: 'WRANGLER_CI_OVERRIDE_NAME=' + String(original.name).replace('pr-123', 'pr-124') + '\n' } },
				{ name: 'dotenv-environment', dotenv: { file: '.env.local', content: 'CLOUDFLARE_ENV=production\n' } },
				{ name: 'dotenv-expanded-name', dotenv: { file: '.env.local', content: 'DESTINATION=production-worker\nWRANGLER_CI_OVERRIDE_NAME=${DESTINATION}\n' } },
				{ name: 'dotenv-empty-name', dotenv: { file: '.env', content: 'WRANGLER_CI_OVERRIDE_NAME=\n' } },
				{ name: 'inherited-empty-name', env: { WRANGLER_CI_OVERRIDE_NAME: '' } },
				{ name: 'inherited-empty-environment', env: { CLOUDFLARE_ENV: '' } },
				{ name: 'dotenv-not-loaded', valid: true, dotenv: { file: '.env.local', content: 'UNRELATED_SECRET=synthetic-not-for-wrangler\nCLOUDFLARE_API_TOKEN=synthetic-dotenv-token\nNODE_OPTIONS=--trace-warnings\n' } },
				{ name: 'wrangler-failure', valid: true, deploymentExit: 73 },
				{ name: 'cli-destination-override', arguments: '--name production-worker' },
				{ name: 'alias-control-character', env: { STAGING_ALIAS: 'pr-123\n' }, content: JSON.stringify(original).replaceAll('pr-123', 'pr-123\\n') },
				{ name: 'missing-config', env: { STAGING_WRANGLER_CONFIG: '' } },
				{ name: 'malformed-config', content: '{"name":' },
				{ name: 'null-config', content: 'null' },
				{ name: 'production-config', content: production },
				{ name: 'wrong-project', change: (config) => { config.name = 'pv-0000000000000000-0000000000-pr-123' } },
				{ name: 'wrong-package', change: (config) => { config.name = other.name } },
				{ name: 'wrong-alias', env: { STAGING_ALIAS: 'pr-124' } },
				{ name: 'missing-alias', env: { STAGING_ALIAS: '' } },
				{ name: 'noncanonical-alias', env: { STAGING_ALIAS: 'pr-0123' } },
				{ name: 'production-route', change: (config) => { config.routes = [{ pattern: 'production.example.test/*', zone_name: 'example.test' }] } },
				{ name: 'cross-preview-route', change: (config) => { config.routes = [{ pattern: 'pr-124.app.example.test/*', zone_name: 'example.test' }] } },
				{ name: 'singular-route', change: (config) => { config.route = 'production.example.test/*' } },
				{ name: 'production-binding', change: (config) => { config.services = [{ binding: 'AUTH', service: 'staging-verification-auth' }] } },
				{ name: 'cross-preview-binding', change: (config) => { config.services = [{ binding: 'AUTH', service: String(other.name).replace('pr-123', 'pr-124') }] } },
				{ name: 'workers-dev-enabled', change: (config) => { config.workers_dev = true } },
				{ name: 'workers-dev-omitted', change: (config) => { delete config.workers_dev } },
				{ name: 'preview-urls-enabled', change: (config) => { config.preview_urls = true } },
				{ name: 'production-database', change: (config) => { config.d1_databases = [{ binding: 'DB', database_name: 'staging-verification-db', database_id: '22222222-2222-4222-8222-222222222222' }] } },
				{ name: 'cross-preview-database', change: (config) => { config.d1_databases = [{ binding: 'DB', database_name: 'preview-123456-d1-pr-124', database_id: environment.STAGING_D1_DATABASE_ID }] } },
				{ name: 'wrong-database-id', change: (config) => { config.d1_databases = [{ binding: 'DB', database_name: environment.STAGING_D1_DATABASE_NAME, database_id: '22222222-2222-4222-8222-222222222222' }] } },
				{ name: 'production-runtime-origin', change: (config) => { config.vars = { ...Object(config.vars), API_PUBLIC_ORIGIN: 'https://production.example.test' } } },
				{ name: 'extra-resource-binding', change: (config) => { config.kv_namespaces = [{ binding: 'PRODUCTION', id: 'production-id' }] } },
				{ name: 'environment-override', change: (config) => { config.env = { production: { name: 'staging-verification-api' } } } },
				{ name: 'build-hook', change: (config) => { config.build = { command: 'echo unexpected' } } },
				{ name: 'valid-prepared', valid: true },
				{ name: 'valid-reordered', valid: true, content: JSON.stringify(Object.fromEntries(Object.entries(original).reverse())) },
				{ name: 'missing-secret-file', valid: !needsSecrets, env: { STAGING_SECRETS_FILE: '' } },
				{ name: 'nonexistent-secret-file', valid: !needsSecrets, env: { STAGING_SECRETS_FILE: join(project, 'does-not-exist.json') } },
				{ name: 'production-unchanged', valid: true, production: true, env: { STAGING_ALIAS: '', STAGING_WRANGLER_CONFIG: '', STAGING_SECRETS_FILE: '' } }
			]
			for (const scenario of scenarios.filter(({ name }) => !selectedScenario || name === selectedScenario)) {
				const name = directory.replace('/', '-') + '-' + scenario.name
				const receipt = join(project, name + '-deploy.jsonl')
				const typegenReceipt = join(project, name + '-typegen.log')
				await writeFile(receipt, '')
				await writeFile(join(project, directory, '.staging-verifier.json'), JSON.stringify({ receipt, deploymentExit: scenario.deploymentExit ?? 0 }))
				const config = structuredClone(original)
				scenario.change?.(config)
				const configPath = join(project, directory, 'probe staging.jsonc')
				await writeFile(configPath, scenario.content ?? JSON.stringify(config))
				const env: Record<string, string> = { ...environment, STAGING_WRANGLER_CONFIG: configPath, TYPEGEN_RECEIPT: typegenReceipt, ...scenario.env }
				const executedCommand = (scenario.production ? pkg.scripts['deploy:production'] : command) + (scenario.arguments ? ' ' + scenario.arguments : '')
				if (scenario.dotenv) await writeFile(join(project, directory, scenario.dotenv.file), scenario.dotenv.content)
				const result = spawnSync('/bin/sh', ['-c', executedCommand], { cwd: join(project, directory), env, encoding: 'utf8', timeout: 10_000 })
				if (scenario.dotenv) await rm(join(project, directory, scenario.dotenv.file))
				const calls = (await readFile(receipt, 'utf8')).trim().split('\n').filter(Boolean)
				let passed = !result.error && (scenario.valid ? result.status === (scenario.deploymentExit ?? 0) && calls.length === 1 : result.status !== 0 && calls.length === 0)
				if (scenario.valid && calls.length === 1) {
					const call = JSON.parse(calls[0]!)
					const deployed = parseJsonc<Record<string, unknown>>(call.config)
					const expectedName = scenario.production ? parseJsonc<Record<string, unknown>>(production).name : original.name
					passed &&= deployed.name === expectedName
					passed &&= call.args.includes('--secrets-file') === (!scenario.production && needsSecrets)
					if (!scenario.production) {
						passed &&= call.configPath === configPath
						passed &&= call.args.includes('--env') && call.args[call.args.indexOf('--env') + 1] === '' && call.envFileContent === ''
						passed &&= !['NODE_OPTIONS', 'UNRELATED_SECRET', 'CLOUDFLARE_API_BASE_URL', 'STAGING_ALIAS', 'WRANGLER_CI_OVERRIDE_NAME', 'CLOUDFLARE_ENV'].some((key) => key in call.environment)
						if (scenario.name === 'dotenv-not-loaded') passed &&= !('CLOUDFLARE_API_TOKEN' in call.environment)
					}
					if (scenario.name === 'constrained-child-environment') passed &&= call.environment.CLOUDFLARE_API_TOKEN === env.CLOUDFLARE_API_TOKEN && call.environment.CLOUDFLARE_ACCOUNT_ID === env.CLOUDFLARE_ACCOUNT_ID
				}
				const temporaryFiles = await readdir(join(project, 'tmp'))
				passed &&= temporaryFiles.length === 0
				const record = { variant, directory, scenario: scenario.name, temporaryFiles, command: executedCommand, exitCode: result.status, calls: calls.length, passed, inputConfig: scenario.content ?? config, inputEnvironment: scenario.env ?? {}, dotenv: scenario.dotenv, stdout: result.stdout, stderr: result.stderr, error: result.error?.message }
				await writeFile(join(project, name + '-result.json'), JSON.stringify(record, null, 2))
				matrix.push(record)
				if (!passed) failures++
				console.log(`${passed ? 'PASS' : 'FAIL'} ${variant} ${directory} ${scenario.name}: exit=${result.status} deployments=${calls.length}`)
			}
		}
	}
}
await writeFile(join(output, 'summary.json'), JSON.stringify({ matrix, failures, node: spawnSync(node, ['--version'], { encoding: 'utf8' }).stdout.trim(), bun: Bun.version, network: 'No provider CLI or credentials. Receipt-only stubs.', cleanup: 'All synchronous child commands awaited. Output retained for inspection.' }, null, 2))
if (matrix.length === 0) throw new Error('No matching scenarios')
if (failures) process.exitCode = 1
