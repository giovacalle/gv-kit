import { createHash } from 'node:crypto'
import { posix as path } from 'node:path'
import { describe, expect, test } from 'bun:test'
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

type GeneratedEntry = { path: string; content: string }
type PreviewNames = {
	cloudflarePreviewName(productionName: string, alias: string): string
	cloudflarePreviewAlias(previewId: string): string
	validateCloudflarePreviewAlias(alias: string): string
}

function makeCfg(overrides: Partial<Choices> = {}): GvKitConfig {
	return { configVersion: 2, choices: { ...baseChoices, ...overrides } }
}

function entry(entries: GeneratedEntry[], path: string): string {
	const found = entries.find((candidate) => candidate.path === path)
	if (!found) throw new Error(`Missing generated entry: ${path}`)
	return found.content
}

function replaceRequired({
	source,
	expected,
	replacement
}: {
	source: string
	expected: string
	replacement: string
}): string {
	if (!source.includes(expected)) throw new Error(`Generated source changed at injected seam: ${expected}`)
	return source.replace(expected, replacement)
}

async function previewNames(entries: GeneratedEntry[]): Promise<PreviewNames> {
	let source = entry(entries, 'scripts/cloudflare-preview-name.mjs')
	source = replaceRequired({
		source,
		expected: "import { createHash } from 'node:crypto'",
		replacement: ''
	})
	source = source.replaceAll('export function ', 'function ')
	const load = Object.getPrototypeOf(async function () {}).constructor as new (
		...parameters: string[]
	) => (...arguments_: unknown[]) => Promise<PreviewNames>
	return new load(
		'createHash',
		'process',
		'console',
		`${source}\nreturn { cloudflarePreviewName, cloudflarePreviewAlias, validateCloudflarePreviewAlias }`
	)(createHash, { argv: [] }, { log: () => undefined })
}

function memoryFilesystem(initialEntries: GeneratedEntry[]) {
	const files = new Map(initialEntries.map(({ path, content }) => [path, content]))
	return {
		files,
		adapter: {
			appendFileSync(filePath: string, content: string) {
				files.set(filePath, (files.get(filePath) ?? '') + content)
			},
			existsSync(candidate: string) {
				return files.has(candidate) || [...files.keys()].some((file) => file.startsWith(`${candidate}/`))
			},
			readFileSync(filePath: string) {
				const content = files.get(filePath)
				if (content === undefined) throw new Error(`Missing in-memory file: ${filePath}`)
				return content
			},
			readdirSync(directory: string) {
				return [
					...new Set(
						[...files.keys()]
							.filter((file) => file.startsWith(`${directory}/`))
							.map((file) => file.slice(directory.length + 1).split('/')[0]!)
					)
				]
			},
			statSync(candidate: string) {
				return {
					isDirectory: () =>
						!files.has(candidate) &&
						[...files.keys()].some((file) => file.startsWith(`${candidate}/`))
				}
			},
			writeFileSync(filePath: string, content: string) {
				files.set(filePath, content)
			}
		}
	}
}

async function runPreviewPreparation(
	cfg: GvKitConfig,
	overrideEnv: Record<string, string> = {}
) {
	const entries = runGenerators(cfg)
	const materializedPaths = [
		'apps/api/wrangler.jsonc',
		'apps/web/wrangler.jsonc',
		'services/auth/wrangler.jsonc',
		'services/users/wrangler.jsonc'
	]
	if (entries.some(({ path }) => path === 'apps/marketing/wrangler.jsonc')) {
		materializedPaths.push('apps/marketing/wrangler.jsonc')
	}
	const filesystem = memoryFilesystem(
		materializedPaths.map((path) => ({ path, content: entry(entries, path) }))
	)
	const names = await previewNames(entries)
	let source = entry(entries, 'scripts/prepare-cloudflare-preview.mjs')
	source = replaceRequired({
		source,
		expected:
			"import { appendFileSync, existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'",
		replacement:
			'const { appendFileSync, existsSync, readFileSync, readdirSync, statSync, writeFileSync } = injectedFilesystem'
	})
	source = replaceRequired({
		source,
		expected: "import path from 'node:path'",
		replacement: 'const path = injectedPath'
	})
	source = replaceRequired({
		source,
		expected: "import { cloudflarePreviewName } from './cloudflare-preview-name.mjs'",
		replacement: 'const { cloudflarePreviewName } = injectedPreviewNames'
	})
	const execute = Object.getPrototypeOf(async function () {}).constructor as new (
		...parameters: string[]
	) => (...arguments_: unknown[]) => Promise<void>
	const stdout: string[] = []
	let stderr = ''
	try {
		await new execute(
			'injectedFilesystem',
			'injectedPath',
			'injectedPreviewNames',
			'process',
			'console',
			source
		)(
			filesystem.adapter,
			path,
			names,
			{
				env: {
					GITHUB_OUTPUT: 'github-output.txt',
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
				}
			},
			{ log: (value: string) => stdout.push(value) }
		)
	} catch (error) {
		stderr = error instanceof Error ? error.message : String(error)
	}

	function config(directory: string) {
		return parseJsonc<Record<string, unknown>>(
			filesystem.files.get(`${directory}/wrangler.staging.jsonc`) ?? ''
		)
	}
	return {
		entries,
		exitCode: stderr ? 1 : 0,
		stdout: stdout.join('\n'),
		stderr,
		files: filesystem.files,
		configs: stderr
			? undefined
			: {
					gateway: config('apps/api'),
					web: config('apps/web'),
					auth: config('services/auth'),
					users: config('services/users'),
					marketing: materializedPaths.includes('apps/marketing/wrangler.jsonc')
						? config('apps/marketing')
						: undefined
				},
		githubOutput: filesystem.files.get('github-output.txt')
	}
}

async function shellSyntax(source: string): Promise<void> {
	const child = Bun.spawn(['sh', '-n'], {
		stdin: new Blob([source]),
		stdout: 'pipe',
		stderr: 'pipe'
	})
	const exitCode = await child.exited
	const stderr = await new Response(child.stderr).text()
	if (exitCode !== 0) throw new Error(`Generated shell syntax failed:\n${stderr}`)
}

type CleanupMode =
	| 'directories-missing'
	| 'inventory-failure'
	| 'delete-failure'
	| 'missing'
	| 'success'

async function runCleanupScript(source: string, mode: CleanupMode) {
	let executableSource = source
	let injectedCommands = ''
	if (mode !== 'directories-missing') {
		executableSource = replaceRequired({
			source,
			expected: `set --
[ ! -d apps ] || set -- "$@" apps
[ ! -d services ] || set -- "$@" services`,
			replacement: 'set -- apps services'
		})
		injectedCommands = `find() {
	printf '%s\\n' 'apps/web/wrangler.jsonc'
}
sed() {
	printf '%s\\n' 'demo-web'
}
head() {
	command head "$@"
}
node() {
	if [ "$1" != 'scripts/cloudflare-preview-name.mjs' ] || [ "$2" != 'demo-web' ] || [ "$3" != 'pr-123' ]; then
		return 91
	fi
	printf '%s\\n' 'demo-web-pr-123'
}
npx() {
	if [ "$2" = 'deployments' ]; then
		if [ "$MOCK_CLEANUP" = 'inventory-failure' ]; then
			echo 'mock deployment inventory failure' >&2
			return 17
		fi
		if [ "$MOCK_CLEANUP" = 'missing' ]; then
			printf '%s\\n' '[]'
		else
			printf '%s\\n' '[{"id":"deployment"}]'
		fi
		return 0
	fi
	if [ "$2" = 'delete' ]; then
		if [ "$MOCK_CLEANUP" = 'delete-failure' ]; then
			echo 'mock Worker deletion failure' >&2
			return 23
		fi
		return 0
	fi
	return 92
}
jq() {
	input=$(cat)
	if [ "$input" = '[]' ]; then printf '0\\n'; else printf '1\\n'; fi
}`
	}
	const child = Bun.spawn(['sh', '-s', '--', 'pr-123'], {
		cwd: import.meta.dir,
		env: { ...Bun.env, MOCK_CLEANUP: mode },
		stdin: new Blob([`${injectedCommands}\n${executableSource}`]),
		stdout: 'pipe',
		stderr: 'pipe'
	})
	const [exitCode, stdout, stderr] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text()
	])
	return { exitCode, stdout, stderr }
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
		const generated = generateDeploy(makeCfg())
		const source = entry(generated, 'scripts/verify-cloudflare-preview-ingress.mjs')
		const execute = Object.getPrototypeOf(async function () {}).constructor as new (
			...parameters: string[]
		) => (...arguments_: unknown[]) => Promise<void>
		const env = {
			CLOUDFLARE_API_TOKEN: 'verification-token',
			CLOUDFLARE_PREVIEW_WEB_DOMAIN: 'app.example.com',
			CLOUDFLARE_PREVIEW_API_DOMAIN: 'api.example.com',
			CLOUDFLARE_PREVIEW_ZONE_NAME: 'example.com'
		}
		const verify = async (missingWildcard?: string) => {
			const output: string[] = []
			await new execute('fetch', 'process', 'console', source)(
				async (input: string) => {
					const url = new URL(input)
					const name = url.searchParams.get('name')
					const result =
						url.pathname === '/client/v4/zones'
							? [{ id: 'zone-id' }]
							: missingWildcard === name
								? []
								: [{ name, proxied: true }]
					return Response.json({ success: true, result })
				},
				{ env },
				{ log: (value: string) => output.push(value) }
			)
			return output.join('\n')
		}

		expect(await verify()).toContain(
			'Managed Cloudflare preview ingress prerequisites verified.'
		)
		expect(verify('*.api.example.com')).rejects.toThrow(
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
			GATEWAY_PUBLIC_ORIGINS:
				'https://pr-123.app.example.com,https://pr-123.api.example.com,http://localhost:3000,http://localhost:5173,http://localhost:8786,http://127.0.0.1:8786',
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
			expect(result.files.has(`${directory}/wrangler.staging.jsonc`)).toBe(false)
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
		const range = entry(entries, 'scripts/resolve-cloudflare-deploy-range.sh')
		await shellSyntax(range)
		expect(range).toContain('zero_sha=0000000000000000000000000000000000000000')
		expect(range).toContain('! git cat-file -e "$base^{commit}"')
		expect(range).toContain('base="$head"\n\tdeploy_all=true')
		expect(range).toContain('echo "deploy_all=$deploy_all"')

		const production = entry(entries, '.github/workflows/deploy-production.yml')
		expect(production).toContain('steps.scm.outputs.deploy_all == \'true\'')
		expect(production).toContain(
			'if [ "${{ steps.scm.outputs.deploy_all }}" = "true" ]; then'
		)
		expect(production).not.toContain('HEAD^1')
	})

	test('staging deploy and cleanup share canonical PR and manual concurrency', () => {
		const entries = generateDeploy(makeCfg())
		const staging = entry(entries, '.github/workflows/deploy-staging.yml')
		const cleanup = entry(entries, '.github/workflows/cleanup-staging.yml')

		expect(staging).toContain(
			'group: staging-pr-${{ github.event.pull_request.number || github.run_id }}'
		)
		expect(cleanup).toContain(
			"group: staging-${{ inputs.alias || format('pr-{0}', github.event.pull_request.number) }}"
		)
		expect(staging).toContain('workflow_dispatch:')
		expect(cleanup).toContain('workflow_dispatch:')
		expect(cleanup).toContain('ref: ${{ github.event.repository.default_branch }}')
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
			'sh scripts/cleanup-cloudflare-preview-workers.sh "${{ steps.alias.outputs.alias }}"'
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

	test('cleanup fails closed on inventory and deletion errors', async () => {
		const generated = generateDeploy(makeCfg())
		const cleanup = entry(generated, 'scripts/cleanup-cloudflare-preview-workers.sh')
		await shellSyntax(cleanup)
		expect(cleanup).toContain('set -eu')
		expect(cleanup).toContain('Could not inventory preview Workers: apps and services directories are missing.')
		expect(cleanup).toContain('Could not inventory preview Workers: no Wrangler configurations found.')
		expect(cleanup).toContain('npx wrangler@4.125.0 deployments list --name "$worker_name" --json')
		expect(cleanup).toContain('npx wrangler@4.125.0 delete --name "$worker_name" --force')
		expect(cleanup).not.toContain('|| true')

		const directoriesMissing = await runCleanupScript(cleanup, 'directories-missing')
		expect(directoriesMissing.exitCode).toBe(1)
		expect(directoriesMissing.stderr).toContain(
			'Could not inventory preview Workers: apps and services directories are missing.'
		)

		const inventoryFailure = await runCleanupScript(cleanup, 'inventory-failure')
		expect(inventoryFailure.exitCode).toBe(17)
		expect(inventoryFailure.stderr).toContain('mock deployment inventory failure')

		const deletionFailure = await runCleanupScript(cleanup, 'delete-failure')
		expect(deletionFailure.exitCode).toBe(23)
		expect(deletionFailure.stderr).toContain('mock Worker deletion failure')

		const missingWorker = await runCleanupScript(cleanup, 'missing')
		expect(missingWorker.exitCode).toBe(0)
		expect(missingWorker.stdout).toContain(
			'Preview Worker demo-web-pr-123 is missing or already deleted.'
		)
		expect(missingWorker.stdout).not.toContain('Deleting demo-web-pr-123')

		const success = await runCleanupScript(cleanup, 'success')
		expect(success.exitCode).toBe(0)
		expect(success.stdout).toContain('Deleting demo-web-pr-123')
		expect(success.stdout).toContain(
			'Deleted demo-web-pr-123 and its attached preview routes.'
		)

		const names = await previewNames(generated)
		expect(names.validateCloudflarePreviewAlias('pr-123')).toBe('pr-123')
		expect(() => names.validateCloudflarePreviewAlias('demo-web')).toThrow()
		expect(() => names.validateCloudflarePreviewAlias('pr-0')).toThrow()
		expect(() => names.validateCloudflarePreviewAlias(`pr-${'1'.repeat(46)}`)).toThrow()

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
