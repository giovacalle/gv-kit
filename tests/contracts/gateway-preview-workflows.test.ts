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
	cloudflarePreviewProject: string
	cloudflarePreviewName(productionName: string, alias: string): string
	cloudflarePreviewAlias(previewId: string): string
	validateCloudflarePreviewAlias(alias: string): string
	validateCloudflarePreviewName(previewName: string, alias: string): string
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

async function previewNames({ entries }: { entries: GeneratedEntry[] }): Promise<PreviewNames> {
	let source = entry(entries, 'scripts/cloudflare-preview-name.mjs')
	source = replaceRequired({
		source,
		expected: "import { createHash } from 'node:crypto'",
		replacement: ''
	})
	source = source.replaceAll('export function ', 'function ')
	source = source.replace('export const cloudflarePreviewProject', 'const cloudflarePreviewProject')
	const load = Object.getPrototypeOf(async function () {}).constructor as new (
		dependenciesParameter: 'dependencies',
		source: string
	) => (dependencies: {
		createHash: typeof createHash
		process: { argv: string[] }
		console: { log(value: string): void }
	}) => Promise<PreviewNames>
	return new load(
		'dependencies',
		`const { createHash, process, console } = dependencies\n${source}\nreturn { cloudflarePreviewProject, cloudflarePreviewName, cloudflarePreviewAlias, validateCloudflarePreviewAlias, validateCloudflarePreviewName }`
	)({ createHash, process: { argv: [] }, console: { log: () => undefined } })
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
				return (
					files.has(candidate) || [...files.keys()].some((file) => file.startsWith(`${candidate}/`))
				)
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

async function runPreviewPreparation({
	cfg,
	overrideEnv = {}
}: {
	cfg: GvKitConfig
	overrideEnv?: Record<string, string>
}) {
	const entries = runGenerators(cfg)
	const materializedPaths = [
		'apps/api/wrangler.jsonc',
		'apps/web/wrangler.jsonc',
		'services/auth/wrangler.jsonc',
		'services/users/wrangler.jsonc'
	]
	if (entries.some(({ path }) => path === 'apps/marketing/wrangler.jsonc')) materializedPaths.push('apps/marketing/wrangler.jsonc')
	const filesystem = memoryFilesystem([
		...materializedPaths.map((path) => ({ path, content: entry(entries, path) })),
		{
			path: 'services/auth/node_modules/dependency/wrangler.jsonc',
			content: JSON.stringify({ name: `${cfg.choices.name}-dependency-worker` })
		}
	])
	const names = await previewNames({ entries })
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
		expected: `import {
	cloudflarePreviewName,
	cloudflarePreviewProject,
	validateCloudflarePreviewAlias
} from './cloudflare-preview-name.mjs'`,
		replacement:
			'const { cloudflarePreviewName, cloudflarePreviewProject, validateCloudflarePreviewAlias } = injectedPreviewNames'
	})
	const execute = Object.getPrototypeOf(async function () {}).constructor as new (
		dependenciesParameter: 'dependencies',
		source: string
	) => (dependencies: {
		filesystem: typeof filesystem.adapter
		path: typeof path
		previewNames: PreviewNames
		process: { env: Record<string, string | undefined> }
		console: { log(value: string): void }
	}) => Promise<void>
	const stdout: string[] = []
	let stderr = ''
	try {
		await new execute(
			'dependencies',
			`const { filesystem: injectedFilesystem, path: injectedPath, previewNames: injectedPreviewNames, process, console } = dependencies\n${source}`
		)({
			filesystem: filesystem.adapter,
			path,
			previewNames: names,
			process: {
				env: {
					GITHUB_OUTPUT: 'github-output.txt',
					STAGING_ALIAS: 'pr-123',
					PREVIEW_DB_KIND: cfg.choices.db === 'sqlite' ? 'd1' : 'neon',
					...(cfg.choices.db === 'sqlite'
						? {
								STAGING_D1_DATABASE_NAME: 'preview-123456-d1-pr-123',
								STAGING_D1_DATABASE_ID: '11111111-1111-4111-8111-111111111111'
							}
						: {
								STAGING_DATABASE_URL:
									'postgres://preview:preview@preview.example.test:5432/preview',
								STAGING_NEON_BRANCH_NAME: 'preview-123456-neon-pr-123',
								STAGING_NEON_BRANCH_ID: 'br-preview-123'
							}),
					CLOUDFLARE_PREVIEW_WEB_DOMAIN: 'app.example.com',
					CLOUDFLARE_PREVIEW_API_DOMAIN: 'api.example.com',
					CLOUDFLARE_PREVIEW_ZONE_NAME: 'example.com',
					...overrideEnv
				}
			},
			console: { log: (value: string) => stdout.push(value) }
		})
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
		githubOutput: filesystem.files.get('github-output.txt'),
		manifest: filesystem.files.get('cloudflare-preview-manifest.json')
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

type DatabaseProvider = 'd1' | 'neon'
function databaseCleanupSource(provider: DatabaseProvider, project = 'demo'): string {
	const workflow = Bun.YAML.parse(
		entry(
			generateDeploy(makeCfg({ name: project, db: provider === 'd1' ? 'sqlite' : 'postgres' })),
			'.github/workflows/cleanup-staging.yml'
		)
	) as { jobs: { cleanup: { steps: Array<{ id?: string; run?: string }> } } }
	const source = workflow.jobs.cleanup.steps.find(({ id }) => id === 'database_cleanup')?.run
	if (!source) throw new Error(`Missing ${provider} cleanup source`)
	return source
		.replaceAll('${{ github.repository_id }}', '123456')
		.replaceAll('${{ steps.alias.outputs.alias }}', 'pr-123')
}

describe('Cloudflare gateway preview contracts', () => {
	test('the managed-domain gate runs before preview database provisioning', () => {
		const workflow = Bun.YAML.parse(
			entry(generateDeploy(makeCfg()), '.github/workflows/deploy-staging.yml')
		) as {
			jobs: Record<
				string,
				{
					needs?: string
					steps?: Array<{ name?: string; run?: string; env?: Record<string, string> }>
				}
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
			dependenciesParameter: 'dependencies',
			source: string
		) => (dependencies: {
			fetch(input: string, init?: RequestInit): Promise<Response>
			process: { env: typeof env }
			console: { log(value: string): void }
		}) => Promise<void>
		const env = {
			CLOUDFLARE_API_TOKEN: 'verification-token',
			CLOUDFLARE_PREVIEW_WEB_DOMAIN: 'app.example.com',
			CLOUDFLARE_PREVIEW_API_DOMAIN: 'api.example.com',
			CLOUDFLARE_PREVIEW_ZONE_NAME: 'example.com'
		}
		const verify = async ({ missingWildcard }: { missingWildcard?: string } = {}) => {
			const output: string[] = []
			const requests: string[] = []
			await new execute(
				'dependencies',
				`const { fetch, process, console } = dependencies\n${source}`
			)({
				fetch: async (input: string, init?: RequestInit) => {
					const url = new URL(input)
					if (url.origin !== 'https://api.cloudflare.com') throw new Error(`Unexpected origin: ${url.origin}`)
					if (init?.method && init.method !== 'GET') throw new Error(`Unexpected method: ${init.method}`)
					expect(init?.headers).toEqual({ Authorization: 'Bearer verification-token' })
					requests.push(`${url.pathname}${url.search}`)
					if (url.pathname === '/client/v4/zones') {
						expect([...url.searchParams]).toEqual([
							['name', 'example.com'],
							['status', 'active']
						])
						return Response.json({ success: true, result: [{ id: 'zone-id' }] })
					}
					if (url.pathname !== '/client/v4/zones/zone-id/dns_records') throw new Error(`Unexpected Cloudflare API path: ${url.pathname}`)
					const name = url.searchParams.get('name')
					if (!['*.app.example.com', '*.api.example.com'].includes(name ?? '')) throw new Error(`Unexpected DNS inventory name: ${name}`)
					const result = missingWildcard === name ? [] : [{ name, proxied: true }]
					return Response.json({ success: true, result })
				},
				process: { env },
				console: { log: (value: string) => output.push(value) }
			})
			expect(requests).toEqual([
				'/client/v4/zones?name=example.com&status=active',
				'/client/v4/zones/zone-id/dns_records?name=*.app.example.com',
				'/client/v4/zones/zone-id/dns_records?name=*.api.example.com'
			])
			return output.join('\n')
		}

		expect(await verify()).toContain('Managed Cloudflare preview ingress prerequisites verified.')
		expect(verify({ missingWildcard: '*.api.example.com' })).rejects.toThrow(
			'Missing proxied shared wildcard DNS record: *.api.example.com'
		)
	})

	test('one alias gives the gateway direct managed-domain routes and keeps private boundaries', async () => {
		const result = await runPreviewPreparation({ cfg: makeCfg() })
		expect(result.exitCode, result.stderr).toBe(0)
		const configs = result.configs!
		const names = await previewNames({ entries: result.entries })
		expect(configs.gateway.name).toBe(names.cloudflarePreviewName('demo-api', 'pr-123'))
		expect(configs.web.name).toBe(names.cloudflarePreviewName('demo-web', 'pr-123'))
		expect(configs.auth.name).toBe(names.cloudflarePreviewName('demo-auth', 'pr-123'))
		expect(configs.users.name).toBe(names.cloudflarePreviewName('demo-users', 'pr-123'))
		expect(configs.gateway.routes).toEqual([
			{ pattern: 'pr-123.api.example.com/*', zone_name: 'example.com' },
			{ pattern: 'pr-123.app.example.com/api', zone_name: 'example.com' },
			{ pattern: 'pr-123.app.example.com/api/*', zone_name: 'example.com' }
		])
		expect(configs.web.routes).toEqual([
			{ pattern: 'pr-123.app.example.com/*', zone_name: 'example.com' }
		])
		expect(configs.gateway.services).toEqual([
			{ binding: 'AUTH', service: configs.auth.name },
			{ binding: 'USERS', service: configs.users.name }
		])
		expect(configs.web.services).toEqual([{ binding: 'GATEWAY', service: configs.gateway.name }])
		expect(configs.users.services).toEqual([{ binding: 'AUTH', service: configs.auth.name }])
		for (const config of Object.values(configs)) {
			if (!config) continue
			expect(config.workers_dev).toBe(false)
			expect(config.preview_urls).toBe(false)
		}
		for (const config of [configs.auth, configs.users]) expect(config.routes).toBeUndefined()
		expect(configs.gateway.vars).toEqual({
			API_PUBLIC_ORIGIN: 'https://pr-123.api.example.com',
			GATEWAY_PUBLIC_ORIGINS:
				'https://pr-123.app.example.com,https://pr-123.api.example.com,http://localhost:3000,http://localhost:5173,http://api.localhost:8786',
			API_CORS_ORIGINS:
				'https://pr-123.app.example.com,http://localhost:3000,http://localhost:5173,http://api.localhost:8786',
			GATEWAY_UPSTREAM_TIMEOUT_MS: '10000'
		})
		expect(configs.auth.vars).toEqual({
			BETTER_AUTH_ALLOWED_HOSTS:
				'pr-123.app.example.com,pr-123.api.example.com,localhost:3000,localhost:5173,api.localhost:8786',
			AUTH_CORS_ORIGINS:
				'https://pr-123.app.example.com,https://pr-123.api.example.com,http://localhost:3000,http://localhost:5173,http://api.localhost:8786'
		})
		expect(result.githubOutput).toContain('api_origin=https://pr-123.api.example.com\n')
		expect(result.githubOutput).toContain('web_origin=https://pr-123.app.example.com\n')
		expect(JSON.parse(result.manifest ?? '')).toEqual({
			schemaVersion: 1,
			project: 'demo',
			alias: 'pr-123',
			workers: [
				{
					config: 'apps/api/wrangler.jsonc',
					productionName: 'demo-api',
					name: configs.gateway.name
				},
				{ config: 'apps/web/wrangler.jsonc', productionName: 'demo-web', name: configs.web.name },
				{
					config: 'services/auth/wrangler.jsonc',
					productionName: 'demo-auth',
					name: configs.auth.name
				},
				{
					config: 'services/users/wrangler.jsonc',
					productionName: 'demo-users',
					name: configs.users.name
				}
			],
			database: {
				kind: 'd1',
				name: 'preview-123456-d1-pr-123',
				id: '11111111-1111-4111-8111-111111111111'
			}
		})
	})

	test('preview preparation fails closed before writing configs when managed domains are absent', async () => {
		const result = await runPreviewPreparation({
			cfg: makeCfg(),
			overrideEnv: { CLOUDFLARE_PREVIEW_WEB_DOMAIN: '' }
		})
		expect(result.exitCode).not.toBe(0)
		expect(result.stderr).toContain('CLOUDFLARE_PREVIEW_WEB_DOMAIN is required')
		expect(result.stdout).toBe('')
		for (const directory of ['apps/api', 'apps/web', 'services/auth', 'services/users']) expect(result.files.has(`${directory}/wrangler.staging.jsonc`)).toBe(false)
	})

	test('preview Worker names remain bounded for cleanup', async () => {
		const project = 'a'.repeat(55)
		const result = await runPreviewPreparation({ cfg: makeCfg({ name: project }) })
		expect(result.exitCode, result.stderr).toBe(0)
		const previewNames = Object.values(result.configs!).flatMap((config) =>
			config && typeof config.name === 'string' ? [config.name] : []
		)
		for (const name of previewNames) {
			expect(name.length).toBeLessThanOrEqual(63)
			expect(name).toMatch(/^pv-[0-9a-f]{16}-[0-9a-f]{10}-pr-123$/)
		}
		expect(new Set(previewNames).size).toBe(previewNames.length)
	})

	test('Astro preview uses a managed hostname covered by the shared web wildcard', async () => {
		const result = await runPreviewPreparation({ cfg: makeCfg({ marketing: 'astro' }) })
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
		const production = entry(entries, '.github/workflows/deploy-production.yml')
		const productionWorkflow = Bun.YAML.parse(production) as {
			jobs: { deploy: { steps: Array<{ name?: string }> } }
		}
		const productionNames = productionWorkflow.jobs.deploy.steps.flatMap(({ name }) =>
			name ? [name] : []
		)
		let previous = -1
		for (const name of [
			'Run production database migrations',
			'Deploy auth Worker',
			'Deploy users Worker',
			'Deploy gateway Worker',
			'Deploy web Worker'
		]) {
			const current = productionNames.indexOf(name)
			expect(current, name).toBeGreaterThan(previous)
			previous = current
		}

		const staging = entry(entries, '.github/workflows/deploy-staging.yml')
		expect(staging.indexOf('Apply preview D1 migrations')).toBeLessThan(
			staging.indexOf('Publish prebuilt preview Workers from trusted code')
		)
		const publisher = entry(entries, 'scripts/publish-cloudflare-preview.sh')
		previous = -1
		for (const directory of ['services/auth', 'services/users', 'apps/api', 'apps/web']) {
			const current = publisher.indexOf(`publish "${directory}"`)
			expect(current, directory).toBeGreaterThan(previous)
			previous = current
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
		expect(production).toContain("steps.scm.outputs.deploy_all == 'true'")
		expect(production).toContain('if [ "${{ steps.scm.outputs.deploy_all }}" = "true" ]; then')
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
		expect(staging).toContain('| web | `${{ needs.build-preview.outputs.web_origin }}`')
		expect(staging).toContain('| canonical API | `${{ needs.build-preview.outputs.api_origin }}`')
		expect(staging).not.toMatch(/\| (?:auth|users) \|/)

		const cleanup = entry(entries, '.github/workflows/cleanup-staging.yml')
		const cleanupScript = entry(entries, 'scripts/cleanup-cloudflare-preview-workers.sh')
		const guidance = entry(runGenerators(makeCfg()), 'README.md')
		expect(cleanup).toContain(
			'sh scripts/cleanup-cloudflare-preview-workers.sh "${{ steps.alias.outputs.alias }}"'
		)
		expect(cleanupScript).toContain('/accounts/$CLOUDFLARE_ACCOUNT_ID/workers/scripts')
		expect(cleanupScript).toContain(
			'node scripts/cloudflare-preview-name.mjs --validate-name "$worker_name" "$alias"'
		)
		expect(cleanupScript).toContain('Deleted $worker_name and its attached preview routes.')
		expect(cleanupScript).toContain('shared wildcard DNS remains')
		expect(cleanupScript).not.toMatch(/dns_records|wrangler[^\n]*dns/i)
		expect(guidance).toContain('inventories account Workers')
		expect(guidance).toContain('validates each name against the project namespace')
		expect(guidance).toContain('and preview alias before deletion')
		expect(guidance).toContain('Deleting a preview Worker also removes its PR-scoped routes')
		expect(guidance).toContain('wildcard DNS records are')
		expect(guidance).toContain('prerequisites and remain in place')
		expect(cleanup).not.toContain('deleteRef')
		expect(cleanup).not.toContain('contents: write')
		expect(cleanup).not.toContain('git push')
		expect(cleanup).toContain('.name == "deploy-staging"')
		expect(cleanup).toContain('.conclusion == "success"')
		expect(cleanup).toContain('Preview inventory artifact count exceeds the cleanup bound.')
		expect(cleanup).toContain('[ "$artifact_name" != "$expected_artifact_name" ]')
	})

	test('cleanup inventories topology drift, rejects unsafe names, and reports partial failures', async () => {
		const generated = generateDeploy(makeCfg())
		const cleanup = entry(generated, 'scripts/cleanup-cloudflare-preview-workers.sh')
		const names = await previewNames({ entries: generated })
		const driftedWorkers = ['demo-billing', 'demo-members', 'demo-users'].map((productionName) =>
			names.cloudflarePreviewName(productionName, 'pr-123')
		)
		await shellSyntax(cleanup)
		expect(cleanup).toContain('set -eu')
		expect(cleanup).toContain('Could not inventory preview Workers from Cloudflare.')
		expect(cleanup).toContain('Cloudflare returned a malformed preview Worker inventory.')
		expect(cleanup).not.toContain('result_info')
		expect(cleanup).not.toContain('data-urlencode')
		expect(cleanup).toContain('npx wrangler@4.125.0 delete --name "$worker_name" --force')
		expect(cleanup).not.toContain('find "$@" -name wrangler.jsonc')
		expect(cleanup).not.toContain('|| true')

		expect(names.validateCloudflarePreviewAlias('pr-123')).toBe('pr-123')
		expect(() => names.validateCloudflarePreviewAlias('demo-web')).toThrow()
		expect(() => names.validateCloudflarePreviewAlias('pr-0')).toThrow()
		expect(() => names.validateCloudflarePreviewAlias(`pr-${'1'.repeat(30)}`)).toThrow()
		const firstDriftedWorker = driftedWorkers[0]!
		expect(names.validateCloudflarePreviewName(firstDriftedWorker, 'pr-123')).toBe(
			firstDriftedWorker
		)
		expect(() => names.validateCloudflarePreviewName('demo-web', 'pr-123')).toThrow()
		expect(() => names.validateCloudflarePreviewName(firstDriftedWorker, 'pr-124')).toThrow()
		expect(() => names.cloudflarePreviewName('unrelated-web', 'pr-123')).toThrow()

		const workflow = entry(generated, '.github/workflows/cleanup-staging.yml')
		expect(workflow).toContain('preview cleanup cannot inventory resources')
		expect(workflow).not.toContain('|| true')
		expect(workflow).toContain("if: always() && steps.alias.outcome == 'success'")
		expect(workflow).toContain('Preview cleanup completed with $failures failed resource group(s).')
	})

	test('database cleanup keeps durable bounded provider contracts', () => {
		for (const provider of ['d1', 'neon'] as const) {
			const cleanup = databaseCleanupSource(provider)
			expect(databaseCleanupSource(provider, 'renamed-project')).toBe(cleanup)
			expect(cleanup).toContain(
				provider === 'd1'
					? 'Cloudflare returned duplicate preview D1 identities.'
					: 'Neon returned duplicate preview branch identities.'
			)
			expect(cleanup).toContain(
				provider === 'd1'
					? 'Cloudflare returned an unsafe preview D1 identity.'
					: 'Neon returned an unsafe preview branch identity.'
			)
			if (provider === 'neon') {
				expect(cleanup).toContain(
					'Neon refused cleanup of a default or protected preview branch.'
				)
			}

			const staging = entry(
				generateDeploy(makeCfg({ db: provider === 'd1' ? 'sqlite' : 'postgres' })),
				'.github/workflows/deploy-staging.yml'
			)
			expect(staging).toContain(
				provider === 'd1'
					? 'preview-${{ github.repository_id }}-d1-${{ steps.meta.outputs.alias }}'
					: 'preview-${{ github.repository_id }}-neon-$alias'
			)
		}
	})

	test('inventory authentication and incomplete cleanup remain fail-closed', () => {
		const workflow = entry(generateDeploy(makeCfg()), '.github/workflows/cleanup-staging.yml')
		expect(workflow).toContain(
			'("pr-" + (.pull_requests[0].number | tostring)) == $preview_alias'
		)
		expect(workflow).toContain('expected_artifact_name="$prefix-$run_id"')
		expect(workflow).toContain('[ "$artifact_name" != "$expected_artifact_name" ]')
		expect(workflow).toContain('authenticated_count=$artifact_count')
		expect(workflow).toContain(
			'No authenticated preview deployment inventory exists for $PREVIEW_ALIAS; cleanup is incomplete.'
		)
	})

	test('provider credentials never reach PR-controlled processes', async () => {
		for (const db of ['sqlite', 'postgres'] as const) {
			const entries = generateDeploy(makeCfg({ db }))
			const source = entry(entries, '.github/workflows/deploy-staging.yml')
			const workflow = Bun.YAML.parse(source) as {
				jobs: Record<
					string,
					{
						steps: Array<{
							uses?: string
							run?: string
							with?: Record<string, string>
							env?: Record<string, string>
						}>
					}
				>
			}
			expect(source).toContain('pull_request_target:')
			expect(source).toContain(
				"if: github.event_name != 'workflow_dispatch' || github.ref == format('refs/heads/{0}', github.event.repository.default_branch)"
			)
			expect(source).toContain('trusted-source/packages/db/')
			expect(source).not.toContain('preview-artifact/packages/db/')
			if (db === 'postgres') expect(source).toContain('trusted-source/packages/db/migrations')
			const build = workflow.jobs['build-preview']!
			expect(JSON.stringify(build)).not.toMatch(/secrets\.(?:CLOUDFLARE|NEON)/)
			expect(JSON.stringify(build)).not.toContain('database_url')

			for (const [jobName, job] of Object.entries(workflow.jobs)) {
				const serialized = JSON.stringify(job)
				if (!/secrets\.(?:CLOUDFLARE|NEON)|needs\.preview-db\.outputs\.database_url/.test(serialized)) continue
				for (const step of job.steps) {
					if (step.uses === 'actions/checkout@v4') {
						expect(step.with?.ref, jobName).toBe(
							'${{ github.event.pull_request.base.sha || github.event.repository.default_branch }}'
						)
					}
					expect(step.run ?? '', jobName).not.toMatch(
						/pnpm (?:install|turbo|--filter)|scripts\/prepare-cloudflare-preview|db:migrate:production/
					)
					expect(step.run ?? '', jobName).not.toContain('github.event.pull_request.head.sha')
				}
			}

			const publisher = entry(entries, 'scripts/publish-cloudflare-preview.sh')
			await shellSyntax(publisher)
			expect(publisher).toContain('--no-bundle')
			expect(publisher).not.toMatch(/pnpm|turbo|node_modules/)

		}
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
			staging.indexOf('Publish prebuilt preview Workers from trusted code')
		)
		const publisher = entry(deployEntries, 'scripts/publish-cloudflare-preview.sh')
		expect(publisher).toContain('--secrets-file "$PREVIEW_SECRETS_DIR/auth.json"')
		expect(publisher).toContain('--secrets-file "$PREVIEW_SECRETS_DIR/users.json"')
		expect(staging).not.toContain('wrangler secret put')
		expect(staging).toContain('secret_dir="$RUNNER_TEMP/gateway-preview-secrets"')
		expect(staging).toContain('run: rm -rf "$RUNNER_TEMP/gateway-preview-secrets"')
		expect(staging.match(/\$RUNNER_TEMP\/gateway-preview-secrets/g)).toHaveLength(2)
		for (const generated of deployEntries) {
			expect(generated.content, generated.path).not.toMatch(
				/\bgv-kit\b|\bthe scaffolder\b|\bthe generator\b|\bthis CLI\b/i
			)
		}
		expect(staging.indexOf('Remove private Worker preview secret files')).toBeGreaterThan(
			staging.indexOf('Publish prebuilt preview Workers from trusted code')
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
		const usersPackage = JSON.parse(entry(runGenerators(cfg), 'services/users/package.json')) as {
			scripts: Record<string, string>
		}

		const publisher = entry(deployEntries, 'scripts/publish-cloudflare-preview.sh')
		expect(publisher).toContain('--secrets-file "$PREVIEW_SECRETS_DIR/auth.json"')
		expect(publisher).not.toContain('users.json')
		expect(usersPackage.scripts['deploy:staging']).not.toContain('--secrets-file')
		expect(staging).not.toContain('wrangler secret put')
	})
})
