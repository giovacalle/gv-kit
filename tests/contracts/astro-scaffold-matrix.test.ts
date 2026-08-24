import { describe, expect, test } from 'bun:test'
import {
	ASTRO_SCAFFOLD_MATRIX,
	ASTRO_SUPPORTED_CARTESIAN_ROWS,
	matrixGateNames,
	uncoveredSupportedPairs,
	UNSUPPORTED_ASTRO_CASES
} from '../../scripts/verify-astro-scaffold-matrix.js'
import { buildScaffoldPlan } from '../../src/pipeline/plan.js'
import { GvKitConfig } from '../../src/schema/config.js'

describe('Astro generated-project verification matrix', () => {
	test('pairwise covers every supported prompt-reachable option interaction', () => {
		expect(ASTRO_SUPPORTED_CARTESIAN_ROWS).toBe(8_832)
		expect(uncoveredSupportedPairs()).toEqual([])
		expect(new Set(ASTRO_SCAFFOLD_MATRIX.map((entry) => entry.choices.topology))).toEqual(
			new Set(['hono', 'inside-frontend'])
		)
		expect(new Set(ASTRO_SCAFFOLD_MATRIX.map((entry) => entry.choices.deploy))).toEqual(
			new Set(['cf-workers', 'docker', 'skip'])
		)
		expect(new Set(ASTRO_SCAFFOLD_MATRIX.map((entry) => entry.choices.auth))).toEqual(
			new Set(['none', 'google', 'emailOTP', 'emailOTP+google'])
		)
		expect(new Set(ASTRO_SCAFFOLD_MATRIX.map((entry) => entry.choices.db))).toEqual(
			new Set(['sqlite', 'postgres'])
		)
		expect(new Set(ASTRO_SCAFFOLD_MATRIX.map((entry) => entry.choices.apiClient))).toEqual(
			new Set(['hey-api', 'skip'])
		)
		expect(new Set(ASTRO_SCAFFOLD_MATRIX.map((entry) => entry.choices.i18n))).toEqual(
			new Set(['paraglide', 'skip'])
		)
		expect(new Set(ASTRO_SCAFFOLD_MATRIX.map((entry) => entry.choices.email))).toEqual(
			new Set(['resend', 'notifuse', 'skip'])
		)
		expect(new Set(ASTRO_SCAFFOLD_MATRIX.map((entry) => entry.choices.monitoring))).toEqual(
			new Set(['none', 'umami', 'posthog', 'both'])
		)
		expect(new Set(ASTRO_SCAFFOLD_MATRIX.map((entry) => entry.choices.aiTooling))).toEqual(
			new Set([
				'none',
				'claude',
				'codex',
				'opencode',
				'claude+codex',
				'claude+opencode',
				'codex+opencode',
				'claude+codex+opencode'
			])
		)
	})

	test('documents every unsupported Astro combination as a schema rejection', () => {
		expect(UNSUPPORTED_ASTRO_CASES.map((entry) => entry.id)).toEqual([
			'inside-frontend-hey-api',
			'inside-frontend-auth',
			'email-otp-without-mailer'
		])
		for (const unsupported of UNSUPPORTED_ASTRO_CASES) {
			const parsed = GvKitConfig.safeParse(unsupported.config)
			expect(parsed.success).toBe(false)
			if (!parsed.success) {
				expect(parsed.error.issues.map((issue) => issue.message)).toContain(unsupported.expected)
			}
		}
	})

	test('every entry validates to the requested Astro application topology', () => {
		for (const entry of ASTRO_SCAFFOLD_MATRIX) {
			const { choices } = entry.config
			expect(choices.marketing).toBe('astro')
			expect(choices.backend).toBe(
				entry.choices.topology === 'inside-frontend' ? 'inside-frontend' : 'hono'
			)
			expect(choices.apiClient).toBe(entry.choices.apiClient)

			const paths = new Set(buildScaffoldPlan(entry.config).map((file) => file.path))
			expect(paths.has('apps/marketing/package.json')).toBe(true)
			expect(paths.has('apps/web/package.json')).toBe(true)
			expect(paths.has('apps/api/auth/package.json')).toBe(
				entry.choices.topology !== 'inside-frontend'
			)
		}
	})

	test('generated-project gates extend the common checks by deployment target', () => {
		const common = ['install', 'test', 'typecheck', 'lint', 'build', 'deploy-artifacts']
		expect(matrixGateNames('skip')).toEqual(common)
		expect(matrixGateNames('docker')).toEqual([...common, 'docker-compose-config'])
		expect(matrixGateNames('cf-workers')).toEqual([
			...common,
			'marketing-wrangler-dry-run',
			'web-wrangler-dry-run'
		])
	})

	test('every matrix plan reflects its deploy and optional-feature selections', () => {
		for (const entry of ASTRO_SCAFFOLD_MATRIX) {
			const plan = buildScaffoldPlan(entry.config)
			const paths = new Set(plan.map((file) => file.path))
			const marketingPackage = JSON.parse(
				plan.find((file) => file.path === 'apps/marketing/package.json')!.content
			) as { dependencies?: Record<string, string> }
			const hasAuth = entry.choices.auth !== 'none'

			expect(paths.has('apps/marketing/wrangler.jsonc')).toBe(entry.choices.deploy === 'cf-workers')
			expect(paths.has('apps/web/wrangler.jsonc')).toBe(entry.choices.deploy === 'cf-workers')
			expect(paths.has('Dockerfile')).toBe(entry.choices.deploy === 'docker')
			expect(paths.has('docker-compose.yml')).toBe(entry.choices.deploy === 'docker')
			expect(paths.has('apps/marketing/src/pages/[locale]/index.astro')).toBe(
				entry.choices.i18n === 'paraglide'
			)
			expect(paths.has('packages/openapi-client/openapi-ts.config.ts')).toBe(
				entry.choices.apiClient === 'hey-api'
			)
			expect(paths.has('apps/web/src/routes/login/+page.svelte')).toBe(hasAuth)
			expect(paths.has('apps/web/src/routes/me/+page.svelte')).toBe(hasAuth)
			expect(Boolean(marketingPackage.dependencies?.['posthog-js'])).toBe(
				entry.config.choices.monitoring.includes('posthog')
			)
			expect(paths.has('AGENTS.md')).toBe(entry.config.choices.aiTooling.includes('codex'))
			expect(paths.has('CLAUDE.md')).toBe(entry.config.choices.aiTooling.includes('claude'))
			expect(paths.has('opencode.json')).toBe(entry.config.choices.aiTooling.includes('opencode'))
		}
	})
})
