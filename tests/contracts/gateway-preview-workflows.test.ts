import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { generateDeploy } from '../../src/generators/deploy.js'
import { runGenerators } from '../../src/generators/index.js'
import { parseJsonc } from '../../src/lib/jsonc.js'
import type { Choices, GvKitConfig } from '../../src/schema/config.js'

const baseChoices: Choices = {
	name: 'demo',
	frontend: 'sveltekit',
	marketing: 'inside-web',
	backend: 'hono',
	i18n: 'skip',
	monitoring: [],
	db: 'sqlite',
	apiClient: 'hey-api',
	auth: ['emailOTP'],
	email: 'resend',
	aiTooling: [],
	deploy: 'cf-workers'
}

const temporaryDirectories: string[] = []

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })))
})

function makeCfg(overrides: Partial<Choices> = {}): GvKitConfig {
	return { configVersion: 2, choices: { ...baseChoices, ...overrides } }
}

function entry(entries: { path: string; content: string }[], path: string): string {
	const found = entries.find((candidate) => candidate.path === path)
	if (!found) throw new Error(`Missing generated entry: ${path}`)
	return found.content
}

async function runChecked(command: string[], cwd: string, env: Record<string, string> = {}) {
	const child = Bun.spawn(command, {
		cwd,
		env: { ...Bun.env, ...env },
		stdout: 'pipe',
		stderr: 'pipe'
	})
	const exitCode = await child.exited
	const stdout = await new Response(child.stdout).text()
	const stderr = await new Response(child.stderr).text()
	if (exitCode !== 0) throw new Error(`${command.join(' ')} failed:\n${stderr}`)
	return stdout
}

async function runPreviewPreparation(
	cfg: GvKitConfig,
	overrideEnv: Record<string, string> = {}
) {
	const root = await mkdtemp(join(tmpdir(), 'gv-kit-preview-contract-'))
	temporaryDirectories.push(root)
	const entries = runGenerators(cfg)
	const materializedPaths = [
		'apps/api/wrangler.jsonc',
		'apps/web/wrangler.jsonc',
		'services/auth/wrangler.jsonc',
		'services/users/wrangler.jsonc',
		'scripts/cloudflare-preview-name.mjs',
		'scripts/prepare-cloudflare-preview.mjs'
	]
	if (entries.some(({ path }) => path === 'apps/marketing/wrangler.jsonc')) {
		materializedPaths.push('apps/marketing/wrangler.jsonc')
	}
	for (const path of materializedPaths) {
		const target = join(root, path)
		await mkdir(join(target, '..'), { recursive: true })
		await writeFile(target, entry(entries, path))
	}

	const githubOutput = join(root, 'github-output.txt')
	const process = Bun.spawn(['node', 'scripts/prepare-cloudflare-preview.mjs'], {
		cwd: root,
		env: {
			...Bun.env,
			GITHUB_OUTPUT: githubOutput,
			STAGING_ALIAS: 'pr-123',
			PREVIEW_DB_KIND: cfg.choices.db === 'sqlite' ? 'd1' : 'neon',
			...(cfg.choices.db === 'sqlite'
				? {
						STAGING_D1_DATABASE_NAME: `${cfg.choices.name}-db-pr-123`,
						STAGING_D1_DATABASE_ID: '11111111-1111-4111-8111-111111111111'
					}
				: {
						STAGING_DATABASE_URL:
							'postgres://preview:preview@preview.example.test:5432/preview'
					}),
			CLOUDFLARE_PREVIEW_WEB_DOMAIN: 'app.example.com',
			CLOUDFLARE_PREVIEW_API_DOMAIN: 'api.example.com',
			CLOUDFLARE_PREVIEW_ZONE_NAME: 'example.com',
			...overrideEnv
		},
		stdout: 'pipe',
		stderr: 'pipe'
	})
	const exitCode = await process.exited

	async function config(path: string) {
		return parseJsonc<Record<string, unknown>>(
			await readFile(join(root, path, 'wrangler.staging.jsonc'), 'utf8')
		)
	}
	return {
		root,
		entries,
		exitCode,
		stdout: await new Response(process.stdout).text(),
		stderr: await new Response(process.stderr).text(),
		configs:
			exitCode === 0
				? {
						gateway: await config('apps/api'),
						web: await config('apps/web'),
						auth: await config('services/auth'),
						users: await config('services/users'),
						marketing: materializedPaths.includes('apps/marketing/wrangler.jsonc')
							? await config('apps/marketing')
							: undefined
					}
				: undefined,
		githubOutput:
			exitCode === 0 ? await readFile(githubOutput, 'utf8') : undefined
	}
}

describe('Cloudflare gateway preview contracts', () => {
	test('the managed-domain gate runs before preview database provisioning', () => {
		const workflow = Bun.YAML.parse(
			entry(generateDeploy(makeCfg()), '.github/workflows/deploy-staging.yml')
		) as {
			jobs: Record<
				string,
				{ needs?: string; steps?: Array<{ name?: string; run?: string; env?: Record<string, string> }> }
			>
		}
		expect(workflow.jobs['preview-db']?.needs).toBe('preview-ingress')
		const gate = workflow.jobs['preview-ingress']?.steps?.find(
			(step) => step.name === 'Verify managed preview ingress'
		)
		expect(gate?.run).toContain('verify-cloudflare-preview-ingress.mjs')
		expect(gate?.env).toEqual({
			CLOUDFLARE_API_TOKEN: '${{ secrets.CLOUDFLARE_API_TOKEN }}',
			CLOUDFLARE_PREVIEW_WEB_DOMAIN: '${{ vars.CLOUDFLARE_PREVIEW_WEB_DOMAIN }}',
			CLOUDFLARE_PREVIEW_API_DOMAIN: '${{ vars.CLOUDFLARE_PREVIEW_API_DOMAIN }}',
			CLOUDFLARE_PREVIEW_ZONE_NAME: '${{ vars.CLOUDFLARE_PREVIEW_ZONE_NAME }}'
		})
	})

	test('the ingress gate verifies both shared proxied wildcard DNS records', async () => {
		const root = await mkdtemp(join(tmpdir(), 'gv-kit-preview-ingress-gate-'))
		temporaryDirectories.push(root)
		const generated = generateDeploy(makeCfg())
		await mkdir(join(root, 'scripts'), { recursive: true })
		await writeFile(
			join(root, 'scripts/verify-cloudflare-preview-ingress.mjs'),
			entry(generated, 'scripts/verify-cloudflare-preview-ingress.mjs')
		)
		await writeFile(
			join(root, 'mock-fetch.mjs'),
			`globalThis.fetch = async (input) => {
	const url = new URL(String(input))
	let result
	if (url.pathname === '/client/v4/zones') result = [{ id: 'zone-id' }]
	else {
		const name = url.searchParams.get('name')
		result = process.env.MISSING_WILDCARD === name ? [] : [{ name, proxied: true }]
	}
	return new Response(JSON.stringify({ success: true, result }), {
		status: 200,
		headers: { 'content-type': 'application/json' }
	})
}
`
		)
		const env = {
			CLOUDFLARE_API_TOKEN: 'verification-token',
			CLOUDFLARE_PREVIEW_WEB_DOMAIN: 'app.example.com',
			CLOUDFLARE_PREVIEW_API_DOMAIN: 'api.example.com',
			CLOUDFLARE_PREVIEW_ZONE_NAME: 'example.com'
		}
		const output = await runChecked(
			['node', '--import', './mock-fetch.mjs', 'scripts/verify-cloudflare-preview-ingress.mjs'],
			root,
			env
		)
		expect(output).toContain('Managed Cloudflare preview ingress prerequisites verified.')

		const missing = Bun.spawn(
			['node', '--import', './mock-fetch.mjs', 'scripts/verify-cloudflare-preview-ingress.mjs'],
			{
				cwd: root,
				env: { ...Bun.env, ...env, MISSING_WILDCARD: '*.api.example.com' },
				stdout: 'pipe',
				stderr: 'pipe'
			}
		)
		expect(await missing.exited).not.toBe(0)
		expect(await new Response(missing.stderr).text()).toContain(
			'Missing proxied shared wildcard DNS record: *.api.example.com'
		)
	})

	test('one alias gives the gateway direct managed-domain routes and keeps private boundaries', async () => {
		const result = await runPreviewPreparation(makeCfg())
		expect(result.exitCode, result.stderr).toBe(0)
		const configs = result.configs!
		expect(configs.gateway.name).toBe('demo-api-pr-123')
		expect(configs.web.name).toBe('demo-web-pr-123')
		expect(configs.auth.name).toBe('demo-auth-pr-123')
		expect(configs.users.name).toBe('demo-users-pr-123')
		expect(configs.gateway.routes).toEqual([
			{ pattern: 'pr-123.api.example.com/*', zone_name: 'example.com' },
			{ pattern: 'pr-123.app.example.com/api', zone_name: 'example.com' },
			{ pattern: 'pr-123.app.example.com/api/*', zone_name: 'example.com' }
		])
		expect(configs.web.routes).toEqual([
			{ pattern: 'pr-123.app.example.com/*', zone_name: 'example.com' }
		])
		expect(configs.gateway.services).toEqual([
			{ binding: 'AUTH', service: 'demo-auth-pr-123' },
			{ binding: 'USERS', service: 'demo-users-pr-123' }
		])
		expect(configs.web.services).toEqual([
			{ binding: 'GATEWAY', service: 'demo-api-pr-123' }
		])
		expect(configs.users.services).toEqual([
			{ binding: 'AUTH', service: 'demo-auth-pr-123' }
		])
		for (const config of Object.values(configs)) {
			if (!config) continue
			expect(config.workers_dev).toBe(false)
			expect(config.preview_urls).toBe(false)
		}
		for (const config of [configs.auth, configs.users]) expect(config.routes).toBeUndefined()
		expect(configs.gateway.vars).toEqual({
			API_PUBLIC_ORIGIN: 'https://pr-123.api.example.com',
			API_CORS_ORIGINS:
				'https://pr-123.app.example.com,http://localhost:3000,http://localhost:5173,http://localhost:8786,http://127.0.0.1:8786',
			GATEWAY_UPSTREAM_TIMEOUT_MS: '10000'
		})
		expect(configs.auth.vars).toEqual({
			BETTER_AUTH_ALLOWED_HOSTS:
				'pr-123.app.example.com,pr-123.api.example.com,localhost:3000,localhost:5173,localhost:8786,127.0.0.1:8786',
			AUTH_CORS_ORIGINS:
				'https://pr-123.app.example.com,https://pr-123.api.example.com,http://localhost:3000,http://localhost:5173,http://localhost:8786,http://127.0.0.1:8786'
		})
		expect(result.githubOutput).toContain('api_origin=https://pr-123.api.example.com\n')
		expect(result.githubOutput).toContain('web_origin=https://pr-123.app.example.com\n')
	})

	test('preview preparation fails closed before writing configs when managed domains are absent', async () => {
		const result = await runPreviewPreparation(makeCfg(), {
			CLOUDFLARE_PREVIEW_WEB_DOMAIN: ''
		})
		expect(result.exitCode).not.toBe(0)
		expect(result.stderr).toContain('CLOUDFLARE_PREVIEW_WEB_DOMAIN is required')
		expect(result.stdout).toBe('')
		for (const directory of ['apps/api', 'apps/web', 'services/auth', 'services/users']) {
			expect(await Bun.file(join(result.root, directory, 'wrangler.staging.jsonc')).exists()).toBe(
				false
			)
		}
	})

	test('preview Worker names remain bounded for cleanup', async () => {
		const project = 'a'.repeat(55)
		const result = await runPreviewPreparation(makeCfg({ name: project }))
		expect(result.exitCode, result.stderr).toBe(0)
		const previewNames = Object.values(result.configs!).flatMap((config) =>
			config && typeof config.name === 'string' ? [config.name] : []
		)
		for (const name of previewNames) {
			expect(name.length).toBeLessThanOrEqual(63)
			expect(name).toMatch(/-[0-9a-f]{10}-pr-123$/)
		}
		expect(new Set(previewNames).size).toBe(previewNames.length)
	})

	test('Astro preview uses a managed hostname covered by the shared web wildcard', async () => {
		const result = await runPreviewPreparation(makeCfg({ marketing: 'astro' }))
		expect(result.exitCode, result.stderr).toBe(0)
		expect(result.configs?.marketing?.routes).toEqual([
			{ pattern: 'pr-123-marketing.app.example.com/*', zone_name: 'example.com' }
		])
		expect(result.githubOutput).toContain(
			'marketing_origin=https://pr-123-marketing.app.example.com\n'
		)
	})

	test('database, private services, gateway, and web deploy in order for production and previews', () => {
		const entries = generateDeploy(makeCfg())
		for (const workflowPath of [
			'.github/workflows/deploy-production.yml',
			'.github/workflows/deploy-staging.yml'
		]) {
			const source = entry(entries, workflowPath)
			const workflow = Bun.YAML.parse(source) as {
				jobs: { deploy: { needs?: string; steps: Array<{ name?: string }> } }
			}
			const orderedNames = [
				workflowPath.includes('staging')
					? 'Run preview database migrations'
					: 'Run production database migrations',
				'Deploy auth Worker',
				'Deploy users Worker',
				'Deploy gateway Worker',
				'Deploy web Worker'
			]
			const stepNames = workflow.jobs.deploy.steps.flatMap(({ name }) => (name ? [name] : []))
			let previous = -1
			for (const name of orderedNames) {
				const current = stepNames.indexOf(name)
				expect(current, `${workflowPath}: ${name}`).toBeGreaterThan(previous)
				previous = current
			}
			if (workflowPath.includes('staging')) expect(workflow.jobs.deploy.needs).toBe('preview-db')
			expect(source).toContain('pnpm turbo run deploy:')
			expect(source).toContain('--affected --filter=')
		}
		const staging = entry(entries, '.github/workflows/deploy-staging.yml')
		expect(staging).toContain("DEPLOY_ALL: ${{ github.event.action != 'synchronize' }}")
		for (const target of ['@demo/auth-worker', '@demo/users-worker', '@demo/api-gateway', 'demo-web']) {
			expect(staging).toContain(
				`pnpm turbo run build --filter=${target}\n            pnpm --filter ${target} deploy:staging`
			)
		}
	})

	test('a root production push forces migrations and an ordered full deployment', async () => {
		const entries = generateDeploy(makeCfg())
		const root = await mkdtemp(join(tmpdir(), 'gv-kit-production-range-contract-'))
		temporaryDirectories.push(root)
		await mkdir(join(root, 'scripts'), { recursive: true })
		await writeFile(
			join(root, 'scripts/resolve-cloudflare-deploy-range.sh'),
			entry(entries, 'scripts/resolve-cloudflare-deploy-range.sh')
		)
		await runChecked(['git', 'init', '--quiet'], root)
		await runChecked(['git', 'config', 'user.email', 'contract@example.com'], root)
		await runChecked(['git', 'config', 'user.name', 'Contract Test'], root)
		await writeFile(join(root, 'root.txt'), 'root commit\n')
		await runChecked(['git', 'add', 'root.txt'], root)
		await runChecked(['git', 'commit', '--quiet', '-m', 'root'], root)
		const head = (await runChecked(['git', 'rev-parse', 'HEAD'], root)).trim()
		const githubOutput = join(root, 'github-output.txt')
		await runChecked(['sh', 'scripts/resolve-cloudflare-deploy-range.sh'], root, {
			BEFORE_SHA: '0000000000000000000000000000000000000000',
			GITHUB_OUTPUT: githubOutput,
			GITHUB_SHA: head
		})

		const outputs = await readFile(githubOutput, 'utf8')
		expect(outputs).toContain(`base=${head}`)
		expect(outputs).toContain(`head=${head}`)
		expect(outputs).toContain('deploy_all=true')

		const production = entry(entries, '.github/workflows/deploy-production.yml')
		expect(production).toContain('steps.scm.outputs.deploy_all == \'true\'')
		expect(production).toContain(
			'if [ "${{ steps.scm.outputs.deploy_all }}" = "true" ]; then'
		)
		expect(production).not.toContain('HEAD^1')
	})

	test('staging deploy and cleanup share PR concurrency and cancel in-flight work', () => {
		const entries = generateDeploy(makeCfg())
		const staging = entry(entries, '.github/workflows/deploy-staging.yml')
		const cleanup = entry(entries, '.github/workflows/cleanup-staging.yml')
		const concurrency = `concurrency:
  group: staging-\${{ github.event.pull_request.number || github.ref }}
  cancel-in-progress: true`

		expect(staging).toContain(concurrency)
		expect(cleanup).toContain(concurrency)
		expect(staging).toContain('workflow_dispatch:')
	})

	test('sticky reporting is public-only and cleanup cannot delete source branches or production Workers', () => {
		const entries = generateDeploy(makeCfg())
		const staging = entry(entries, '.github/workflows/deploy-staging.yml')
		expect(staging).toContain('| web | `${{ steps.preview_config.outputs.web_origin }}`')
		expect(staging).toContain(
			'| canonical API | `${{ steps.preview_config.outputs.api_origin }}`'
		)
		expect(staging).not.toMatch(/\| (?:auth|users) \|/)

		const cleanup = entry(entries, '.github/workflows/cleanup-staging.yml')
		const cleanupScript = entry(entries, 'scripts/cleanup-cloudflare-preview-workers.sh')
		expect(cleanup).toContain(
			'sh scripts/cleanup-cloudflare-preview-workers.sh "${{ steps.branch.outputs.alias }}"'
		)
		expect(cleanupScript).toContain('find "$@" -name wrangler.jsonc')
		expect(cleanupScript).toContain(
			'worker_name=$(node scripts/cloudflare-preview-name.mjs "$base_name" "$alias")'
		)
		expect(cleanupScript).toContain('Deleted $worker_name and its attached preview routes.')
		expect(cleanupScript).toContain('Shared wildcard DNS records')
		expect(cleanupScript).not.toMatch(/dns_records|api\.cloudflare\.com|wrangler[^\n]*dns/i)
		expect(cleanup).not.toContain('deleteRef')
		expect(cleanup).not.toContain('contents: write')
		expect(cleanup).not.toContain('git push')
	})

	test('cleanup exits nonzero when Worker inventory or deletion fails', async () => {
		const generated = generateDeploy(makeCfg())
		const root = await mkdtemp(join(tmpdir(), 'gv-kit-cleanup-contract-'))
		temporaryDirectories.push(root)
		for (const [path, content] of [
			['apps/web/wrangler.jsonc', '{"name":"demo-web"}\n'],
			[
				'scripts/cloudflare-preview-name.mjs',
				entry(generated, 'scripts/cloudflare-preview-name.mjs')
			],
			[
				'scripts/cleanup-cloudflare-preview-workers.sh',
				entry(generated, 'scripts/cleanup-cloudflare-preview-workers.sh')
			]
		] as const) {
			const target = join(root, path)
			await mkdir(join(target, '..'), { recursive: true })
			await writeFile(target, content)
		}
		const bin = join(root, 'bin')
		await mkdir(bin)
		await writeFile(
			join(bin, 'npx'),
			`#!/bin/sh
if [ "$MOCK_CLEANUP" = "inventory-failure" ]; then exit 17; fi
if [ "$2" = "deployments" ]; then
	if [ "$MOCK_CLEANUP" = "missing" ]; then echo '[]'; else echo '[{"id":"deployment"}]'; fi
	exit 0
fi
if [ "$MOCK_CLEANUP" = "delete-failure" ]; then exit 23; fi
exit 0
`,
			{ mode: 0o755 }
		)

		async function cleanupExitCode(mode: string) {
			const child = Bun.spawn(
				['sh', 'scripts/cleanup-cloudflare-preview-workers.sh', 'pr-123'],
				{
					cwd: root,
					env: { ...Bun.env, PATH: `${bin}:${Bun.env.PATH}`, MOCK_CLEANUP: mode },
					stdout: 'pipe',
					stderr: 'pipe'
				}
			)
			return child.exited
		}

		expect(await cleanupExitCode('inventory-failure')).not.toBe(0)
		expect(await cleanupExitCode('delete-failure')).not.toBe(0)
		expect(await cleanupExitCode('missing')).toBe(0)
		expect(await cleanupExitCode('success')).toBe(0)

		const workflow = entry(generated, '.github/workflows/cleanup-staging.yml')
		expect(workflow).toContain('preview cleanup cannot inventory resources')
		expect(workflow).not.toContain('|| true')
		expect(workflow).not.toContain('if: always()')
	})

	test('web Worker never handles inbound browser API aliases', () => {
		const entries = runGenerators(makeCfg())
		const hooks = entry(entries, 'apps/web/src/hooks.server.ts')
		expect(hooks).toContain('export const handleFetch')
		expect(hooks).not.toContain('forwardApiAlias')
		expect(hooks).not.toContain('gateway.fetch(event.request)')
	})

	test('required preview secrets are supplied with each private Worker initial deployment', () => {
		const cfg = makeCfg({ db: 'postgres' })
		const deployEntries = generateDeploy(cfg)
		const staging = entry(deployEntries, '.github/workflows/deploy-staging.yml')
		const secretFiles = entry(deployEntries, 'scripts/write-cloudflare-preview-secrets.mjs')
		const previewConfig = entry(deployEntries, 'scripts/prepare-cloudflare-preview.mjs')
		const generatedEntries = runGenerators(cfg)
		const authPackage = JSON.parse(entry(generatedEntries, 'services/auth/package.json')) as {
			scripts: Record<string, string>
		}
		const usersPackage = JSON.parse(entry(generatedEntries, 'services/users/package.json')) as {
			scripts: Record<string, string>
		}

		expect(staging.indexOf('Write private Worker preview secret files')).toBeLessThan(
			staging.indexOf('Deploy auth Worker')
		)
		expect(staging).toContain(
			'STAGING_SECRETS_FILE: ${{ steps.preview_secrets.outputs.auth_file }}'
		)
		expect(staging).toContain(
			'STAGING_SECRETS_FILE: ${{ steps.preview_secrets.outputs.users_file }}'
		)
		expect(staging).not.toContain('wrangler secret put')
		expect(staging.indexOf('Remove private Worker preview secret files')).toBeGreaterThan(
			staging.indexOf('Deploy users Worker')
		)
		expect(staging.indexOf('Remove private Worker preview secret files')).toBeLessThan(
			staging.indexOf('Deploy gateway Worker')
		)
		for (const deployScript of [
			authPackage.scripts['deploy:staging'],
			usersPackage.scripts['deploy:staging']
		]) {
			expect(deployScript).toContain('test -n "$STAGING_SECRETS_FILE"')
			expect(deployScript).toContain('--secrets-file "$STAGING_SECRETS_FILE"')
		}
		expect(secretFiles).toContain('["DATABASE_URL","STAGING_DATABASE_URL"]')
		expect(secretFiles).toContain("writeSecrets('auth.json'")
		expect(secretFiles).toContain("writeSecrets('users.json'")
		expect(staging).toContain('STAGING_DATABASE_URL: ${{ needs.preview-db.outputs.database_url }}')
		expect(previewConfig).not.toContain('DATABASE_URL:')
	})

	test('D1 previews bootstrap auth secrets without inventing users secrets', () => {
		const cfg = makeCfg({ db: 'sqlite' })
		const deployEntries = generateDeploy(cfg)
		const staging = entry(deployEntries, '.github/workflows/deploy-staging.yml')
		const usersPackage = JSON.parse(
			entry(runGenerators(cfg), 'services/users/package.json')
		) as { scripts: Record<string, string> }

		expect(staging).toContain(
			'STAGING_SECRETS_FILE: ${{ steps.preview_secrets.outputs.auth_file }}'
		)
		expect(staging).not.toContain('steps.preview_secrets.outputs.users_file')
		expect(usersPackage.scripts['deploy:staging']).not.toContain('--secrets-file')
		expect(staging).not.toContain('wrangler secret put')
	})
})
