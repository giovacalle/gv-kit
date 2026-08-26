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

async function materializePreviewConfigs(cfg: GvKitConfig) {
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
			CLOUDFLARE_WORKERS_SUBDOMAIN: 'example'
		},
		stdout: 'pipe',
		stderr: 'pipe'
	})
	const exitCode = await process.exited
	const stderr = await new Response(process.stderr).text()
	expect(exitCode, stderr).toBe(0)

	async function config(path: string) {
		return parseJsonc<Record<string, unknown>>(
			await readFile(join(root, path, 'wrangler.staging.jsonc'), 'utf8')
		)
	}
	return {
		root,
		gateway: await config('apps/api'),
		web: await config('apps/web'),
		auth: await config('services/auth'),
		users: await config('services/users'),
		marketing: materializedPaths.includes('apps/marketing/wrangler.jsonc')
			? await config('apps/marketing')
			: undefined,
		githubOutput: await readFile(githubOutput, 'utf8')
	}
}

describe('Cloudflare gateway preview contracts', () => {
	test('one stable alias rewrites every Worker, service binding, origin, and D1 binding', async () => {
		const configs = await materializePreviewConfigs(makeCfg())
		expect(configs.gateway.name).toBe('demo-api-pr-123')
		expect(configs.web.name).toBe('demo-web-pr-123')
		expect(configs.auth.name).toBe('demo-auth-pr-123')
		expect(configs.users.name).toBe('demo-users-pr-123')

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
		expect(configs.gateway.vars).toEqual({
			API_PUBLIC_ORIGIN: 'https://demo-api-pr-123.example.workers.dev'
		})

		for (const config of [configs.auth, configs.users]) {
			expect(config.workers_dev).toBe(false)
			expect(config.preview_urls).toBe(false)
			expect(config.routes).toBeUndefined()
			expect(config.d1_databases).toEqual([
				{
					binding: 'DB',
					database_name: 'demo-db-pr-123',
					database_id: '11111111-1111-4111-8111-111111111111'
				}
			])
		}
		for (const config of [configs.gateway, configs.web]) {
			expect(config.workers_dev).toBe(true)
			expect(config.preview_urls).toBe(false)
			expect(config.routes).toBeUndefined()
		}
	})

	test('long valid project names keep collision-resistant preview Workers within DNS limits', async () => {
		const project = 'a'.repeat(55)
		const cfg = makeCfg({ name: project })
		const configs = await materializePreviewConfigs(cfg)
		const previewConfigs = [configs.gateway, configs.web, configs.auth, configs.users]
		const previewNames = previewConfigs.map((config) => config.name as string)

		for (const name of previewNames) {
			expect(name.length).toBeLessThanOrEqual(63)
			expect(name).toMatch(/-[0-9a-f]{10}-pr-123$/)
		}
		expect(new Set(previewNames).size).toBe(previewNames.length)
		expect(configs.gateway.services).toEqual([
			{ binding: 'AUTH', service: configs.auth.name },
			{ binding: 'USERS', service: configs.users.name }
		])
		expect(configs.web.services).toEqual([
			{ binding: 'GATEWAY', service: configs.gateway.name }
		])
		expect(configs.users.services).toEqual([
			{ binding: 'AUTH', service: configs.auth.name }
		])
		expect(configs.gateway.vars).toEqual({
			API_PUBLIC_ORIGIN: `https://${String(configs.gateway.name)}.example.workers.dev`
		})

		const generated = runGenerators(cfg)
		for (const packagePath of [
			'apps/api/package.json',
			'apps/web/package.json',
			'services/auth/package.json',
			'services/users/package.json'
		]) {
			const packageJson = JSON.parse(entry(generated, packagePath)) as {
				scripts: Record<string, string>
			}
			const deployCommand = packageJson.scripts['deploy:staging']
			expect(deployCommand).toContain(
				'wrangler deploy --config "${STAGING_WRANGLER_CONFIG:-wrangler.jsonc}"'
			)
			expect(deployCommand).not.toContain('--name')
		}
		for (const [path, previewName] of [
			['apps/api/wrangler.jsonc', configs.gateway.name],
			['apps/web/wrangler.jsonc', configs.web.name],
			['services/auth/wrangler.jsonc', configs.auth.name],
			['services/users/wrangler.jsonc', configs.users.name]
		] as const) {
			const production = parseJsonc<{ name: string }>(entry(generated, path))
			const cleanupName = (
				await runChecked(
					['node', 'scripts/cloudflare-preview-name.mjs', production.name, 'pr-123'],
					configs.root
				)
			).trim()
			expect(cleanupName).toBe(String(previewName))
		}
		const cleanup = entry(generated, 'scripts/cleanup-cloudflare-preview-workers.sh')
		expect(cleanup).toContain('node scripts/cloudflare-preview-name.mjs')
	})

	test('Astro preview uses its prepared bounded Worker name and origin', async () => {
		const project = 'a'.repeat(52)
		const cfg = makeCfg({ name: project, marketing: 'astro' })
		const configs = await materializePreviewConfigs(cfg)
		const marketingName = String(configs.marketing?.name)

		expect(marketingName).toHaveLength(63)
		expect(marketingName).toMatch(/-[0-9a-f]{10}-pr-123$/)
		const generated = runGenerators(cfg)
		const marketingPackage = JSON.parse(entry(generated, 'apps/marketing/package.json')) as {
			scripts: Record<string, string>
		}
		expect(marketingPackage.scripts['deploy:staging']).toBe(
			'test -n "$STAGING_ALIAS" && wrangler deploy --config "${STAGING_WRANGLER_CONFIG:-wrangler.jsonc}"'
		)
		const staging = entry(generated, '.github/workflows/deploy-staging.yml')
		expect(staging).toContain(
			'PUBLIC_MARKETING_URL: ${{ steps.preview_config.outputs.marketing_origin }}'
		)
		expect(configs.githubOutput).toContain(`marketing_worker_name=${marketingName}\n`)
		expect(configs.githubOutput).toContain(
			`marketing_origin=https://${marketingName}.example.workers.dev\n`
		)
		expect(staging).not.toContain(`${project}-marketing-\${{ needs.preview-db.outputs.alias }}`)

		const production = parseJsonc<{ name: string }>(
			entry(generated, 'apps/marketing/wrangler.jsonc')
		)
		const cleanupName = (
			await runChecked(
				['node', 'scripts/cloudflare-preview-name.mjs', production.name, 'pr-123'],
				configs.root
			)
		).trim()
		expect(cleanupName).toBe(marketingName)
	})

	test('preview auth hosts and CORS contain only preview and local origins', async () => {
		const { auth } = await materializePreviewConfigs(makeCfg())
		expect(auth.vars).toEqual({
			BETTER_AUTH_ALLOWED_HOSTS:
				'demo-web-pr-123.example.workers.dev,demo-api-pr-123.example.workers.dev,localhost:3000,localhost:5173,localhost:8786,127.0.0.1:8786',
			AUTH_CORS_ORIGINS:
				'https://demo-web-pr-123.example.workers.dev,https://demo-api-pr-123.example.workers.dev,http://localhost:3000,http://localhost:5173,http://localhost:8786,http://127.0.0.1:8786'
		})
		expect(JSON.stringify(auth.vars)).not.toContain('<domain>')
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

	test('web Worker forwards its preview API path through the preview GATEWAY binding', () => {
		const entries = runGenerators(makeCfg())
		const hooks = entry(entries, 'apps/web/src/hooks.server.ts')
		expect(hooks).toContain('const forwardApiAlias: Handle')
		expect(hooks).toContain("event.url.pathname.startsWith('/api/')")
		expect(hooks).toContain('gateway.fetch(event.request)')
		expect(hooks.indexOf('forwardApiAlias')).toBeLessThan(hooks.indexOf('attachUser'))
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
