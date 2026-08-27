import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import {
	assertPermittedWranglerInvocation,
	redactArtifactText,
	unsafeArtifactFindings
} from '../../scripts/gateway-verification-evidence.js'
import {
	buildRunMetadata,
	COVERAGE_RATIONALE,
	GATEWAY_SCAFFOLD_MATRIX,
	uncoveredMaterialInteractions,
	uncoveredMaterialValues
} from '../../scripts/verify-gateway-scaffold-matrix.js'
import { parseJsonc } from '../../src/lib/jsonc.js'
import { buildScaffoldPlan } from '../../src/pipeline/plan.js'
import { GvKitConfig } from '../../src/schema/config.js'

const root = join(import.meta.dir, '..', '..')

describe('gateway generated-workspace verification matrix', () => {
	test('uses stable identifiers and covers every material axis value', () => {
		expect(GATEWAY_SCAFFOLD_MATRIX).toHaveLength(9)
		expect(uncoveredMaterialValues()).toEqual([])
		expect(uncoveredMaterialInteractions()).toEqual([])
		expect(new Set(GATEWAY_SCAFFOLD_MATRIX.map(({ id }) => id)).size).toBe(
			GATEWAY_SCAFFOLD_MATRIX.length
		)
		expect(COVERAGE_RATIONALE.join('\n')).toContain('representative reduction')
		expect(COVERAGE_RATIONALE.join('\n')).toContain('90 supported rows')
	})

	test('fails closed when a required database interaction is removed', () => {
		const withoutCloudflareSqlite = GATEWAY_SCAFFOLD_MATRIX.filter(
			(entry) =>
				!(entry.topology === 'hono' && entry.deploy === 'cf-workers' && entry.db === 'sqlite')
		)
		expect(uncoveredMaterialValues(withoutCloudflareSqlite)).toEqual([])
		expect(uncoveredMaterialInteractions(withoutCloudflareSqlite)).toContain(
			'hono/cf-workers/sqlite/cloudflare-preview'
		)
		expect(
			GATEWAY_SCAFFOLD_MATRIX.filter(
				(entry) => entry.topology === 'hono' && entry.deploy === 'cf-workers'
			).map(({ db }) => db)
		).toEqual(expect.arrayContaining(['postgres', 'sqlite']))
	})

	test('fails closed when the Hono API-client-skip interaction is removed', () => {
		const withoutHonoSkip = GATEWAY_SCAFFOLD_MATRIX.filter(
			(entry) => !(entry.topology === 'hono' && entry.apiClient === 'skip')
		)
		expect(uncoveredMaterialValues(withoutHonoSkip)).toEqual([])
		expect(uncoveredMaterialInteractions(withoutHonoSkip)).toContain('hono/api-client-skip')
	})

	test('Hono API-client-skip keeps OpenAPI and removes client-only output', () => {
		const matrixEntry = GATEWAY_SCAFFOLD_MATRIX.find(
			(entry) => entry.topology === 'hono' && entry.apiClient === 'skip'
		)
		expect(matrixEntry).toBeDefined()
		const raw = parseJsonc(
			readFileSync(join(root, 'fixtures', `${matrixEntry!.fixture}.jsonc`), 'utf8')
		)
		const config = GvKitConfig.parse(raw)
		const plan = buildScaffoldPlan(config)
		const rootPackage = JSON.parse(plan.find(({ path }) => path === 'package.json')!.content) as {
			scripts: Record<string, string>
		}
		const webGuidance = plan.find(({ path }) => path === '.ai/rules/web-svelte.md')!.content
		const generatedText = plan
			.filter(({ path }) => /\.(?:json|md|svelte|ts)$/.test(path))
			.map(({ content }) => content)
			.join('\n')

		expect(config.choices.aiTooling.length).toBeGreaterThan(0)
		expect(config.choices.auth).toEqual([])
		expect(plan.some(({ path }) => path === 'apps/api/openapi.json')).toBe(true)
		expect(plan.some(({ path }) => path.startsWith('packages/openapi-client/'))).toBe(false)
		expect(rootPackage.scripts['openapi:compose']).toBeDefined()
		expect(rootPackage.scripts['openapi:check']).toBeDefined()
		expect(rootPackage.scripts.codegen).toBeUndefined()
		expect(generatedText).not.toMatch(/@repo\/openapi-client|packages\/openapi-client/)
		expect(generatedText).not.toMatch(
			/\$lib\/auth\/client(?:\.ts)?|src\/lib\/auth\/client\.ts|src\/routes\/login\/\+page\.svelte/
		)
		expect(webGuidance).not.toMatch(
			/Better Auth|authClient|AuthContext|setAuthContext|auth-context|auth gating/
		)
	})

	test('covers the highest supported seam for every target', () => {
		expect(new Set(GATEWAY_SCAFFOLD_MATRIX.map(({ highestSeam }) => highestSeam))).toEqual(
			new Set(['cloudflare-preview', 'docker-runtime', 'local-runtime', 'generated-workspace'])
		)
		expect(
			GATEWAY_SCAFFOLD_MATRIX.filter(({ deploy }) => deploy === 'cf-workers').some(
				({ highestSeam }) => highestSeam === 'cloudflare-preview'
			)
		).toBe(true)
		expect(
			GATEWAY_SCAFFOLD_MATRIX.filter(({ deploy }) => deploy === 'docker').some(
				({ highestSeam }) => highestSeam === 'docker-runtime'
			)
		).toBe(true)
		expect(
			GATEWAY_SCAFFOLD_MATRIX.filter(({ deploy }) => deploy === 'skip').some(
				({ highestSeam }) => highestSeam === 'local-runtime'
			)
		).toBe(true)
	})

	test('selected fixtures match their documented configurations', () => {
		for (const entry of GATEWAY_SCAFFOLD_MATRIX) {
			const raw = parseJsonc(
				readFileSync(join(root, 'fixtures', `${entry.fixture}.jsonc`), 'utf8')
			) as { configVersion: 1 | 2 }
			const config = GvKitConfig.parse(raw)
			expect(raw.configVersion, entry.id).toBe(entry.configVersion)
			expect(config.choices.backend, entry.id).toBe(entry.topology)
			expect(config.choices.deploy, entry.id).toBe(entry.deploy)
			expect(config.choices.db, entry.id).toBe(entry.db)
			expect(config.choices.marketing, entry.id).toBe(entry.marketing)
			expect(config.choices.apiClient, entry.id).toBe(entry.apiClient)
			expect(config.choices.auth.length > 0 ? 'auth' : 'no-auth', entry.id).toBe(entry.auth)

			const paths = buildScaffoldPlan(config).map(({ path }) => path)
			expect(paths.includes('apps/api/package.json'), entry.id).toBe(entry.topology === 'hono')
			expect(
				paths.some((path) => path.startsWith('services/')),
				entry.id
			).toBe(entry.topology === 'hono')
		}
	})

	test('Cloudflare execution permits only correctly positioned deploy dry-runs', () => {
		expect(() =>
			assertPermittedWranglerInvocation(['exec', 'wrangler', 'deploy', '--dry-run'])
		).not.toThrow()
		expect(() =>
			assertPermittedWranglerInvocation([
				'exec',
				'wrangler',
				'deploy',
				'--config',
				'wrangler.staging.jsonc',
				'--dry-run'
			])
		).not.toThrow()
		for (const args of [
			['exec', 'wrangler', 'types'],
			['exec', 'wrangler', 'deploy'],
			['exec', 'wrangler', '--dry-run', 'deploy']
		]) expect(() => assertPermittedWranglerInvocation(args)).toThrow()
	})

	test('partial entry reports require reconciliation until the full matrix completes', () => {
		const partial = buildRunMetadata(
			[GATEWAY_SCAFFOLD_MATRIX[0]!],
			[{ id: GATEWAY_SCAFFOLD_MATRIX[0]!.id }]
		)
		expect(partial).toMatchObject({
			scope: 'entry',
			state: 'partial',
			matrixComplete: false,
			reconciliationRequired: true
		})
		const complete = buildRunMetadata(
			GATEWAY_SCAFFOLD_MATRIX,
			GATEWAY_SCAFFOLD_MATRIX.map(({ id }) => ({ id }))
		)
		expect(complete).toMatchObject({
			scope: 'full-matrix',
			state: 'complete',
			matrixComplete: true,
			reconciliationRequired: false
		})
		const duplicate = buildRunMetadata(GATEWAY_SCAFFOLD_MATRIX, [
			...GATEWAY_SCAFFOLD_MATRIX.map(({ id }) => ({ id })),
			{ id: GATEWAY_SCAFFOLD_MATRIX[0]!.id }
		])
		expect(duplicate.matrixComplete).toBe(false)
	})

	test('retained artifact redaction removes machine paths and credential values', () => {
		const unsafe = [
			'/Users/alice/project/file.ts',
			'Authorization: Bearer secret-token-value',
			'DATABASE_URL=postgres://user:password@example.test/db',
			'API_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz'
		].join('\n')
		const redacted = redactArtifactText(unsafe)
		expect(unsafeArtifactFindings(redacted)).toEqual([])
		expect(redacted).toContain('[REDACTED]')
	})

	test('specialized verification preserves generated Cloudflare inputs and fills missing gates', () => {
		const matrix = readFileSync(join(root, 'scripts/verify-gateway-scaffold-matrix.ts'), 'utf8')
		const cloudflare = readFileSync(join(root, 'scripts/verify-gateway-cloudflare.ts'), 'utf8')
		expect(matrix).toContain('normal install, lint, typecheck, test, and build gates')
		expect(matrix).toContain('runStandardCommands({ project, logs, commands })')
		expect(matrix).toContain(
			'if (config.main === undefined && config.assets === undefined) continue'
		)
		expect(cloudflare).toContain('freshWorkspaceInputsUnchanged: true')
		expect(cloudflare).not.toContain('installTypegenVerificationSubstitute')
		expect(cloudflare).not.toContain('Verification-only config-derived bindings')
	})

	test('local auth verification cannot inherit external email credentials', () => {
		const local = readFileSync(join(root, 'scripts/verify-gateway-local.ts'), 'utf8')
		expect(local).toContain("'RESEND_API_KEY'")
		expect(local).toContain("'NOTIFUSE_API_KEY'")
		expect(local).toContain('for (const name of LOCAL_ENVIRONMENT_NAMES) delete environment[name]')
		expect(local).toContain("['cf-workers', 'docker', 'skip']")
		expect(local).toContain("deploy === 'docker' ? 'http://localhost:3000'")
	})
})
