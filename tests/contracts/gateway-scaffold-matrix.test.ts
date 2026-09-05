import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import {
	assertPermittedWranglerInvocation,
	redactArtifactText,
	unsafeArtifactFindings
} from '../../scripts/gateway-verification-evidence.js'
import { createDockerRuntimeEnvironment } from '../../scripts/verify-gateway-docker.js'
import {
	buildRunMetadata,
	COVERAGE_RATIONALE,
	createVerificationCommandEnvironment,
	DOCKER_RUNTIME_OWNED_ENVIRONMENT_KEYS,
	GATEWAY_SCAFFOLD_MATRIX,
	uncoveredMaterialInteractions,
	uncoveredMaterialValues,
	unresolvedGeneratorMarkers,
	validateCloudflareWorkflowStructure
} from '../../scripts/verify-gateway-scaffold-matrix.js'
import type {
	CloudflareWorkflowSources,
	GatewayMatrixEntry
} from '../../scripts/verify-gateway-scaffold-matrix.js'
import { parseJsonc } from '../../src/lib/jsonc.js'
import { buildScaffoldPlan } from '../../src/pipeline/plan.js'
import { GvKitConfig } from '../../src/schema/config.js'

const root = join(import.meta.dir, '..', '..')

function cloudflareMatrixEntry(db?: 'postgres' | 'sqlite'): GatewayMatrixEntry {
	const entry = GATEWAY_SCAFFOLD_MATRIX.find(
		(candidate) =>
			candidate.topology === 'hono' &&
			candidate.deploy === 'cf-workers' &&
			(db === undefined || candidate.db === db)
	)
	if (!entry) throw new Error(`Cloudflare matrix entry is missing${db ? ` for ${db}` : ''}`)
	return entry
}

function generatedCloudflareWorkflows(entry: GatewayMatrixEntry): CloudflareWorkflowSources {
	const raw = parseJsonc(readFileSync(join(root, 'fixtures', `${entry.fixture}.jsonc`), 'utf8'))
	const plan = buildScaffoldPlan(GvKitConfig.parse(raw))
	const workflow = (path: string) =>
		plan.find((candidate) => candidate.path === `.github/workflows/${path}`)?.content ?? ''
	return {
		production: workflow('deploy-production.yml'),
		staging: workflow('deploy-staging.yml')
	}
}

describe('gateway generated-workspace verification matrix', () => {
	test('isolates Docker runtime origins from conflicting matrix settings at every ingress port', () => {
		const conflictingParent = {
			PATH: '/usr/bin',
			DOCKER_CONFIG: '/tmp/docker-config',
			ORIGIN: 'https://parent-web.example.test',
			BETTER_AUTH_ALLOWED_HOSTS: 'parent-web.example.test,parent-api.example.test',
			AUTH_CORS_ORIGINS: 'https://parent-web.example.test',
			API_CORS_ORIGINS: 'https://parent-web.example.test',
			API_PUBLIC_ORIGIN: 'https://parent-api.example.test',
			GATEWAY_PUBLIC_ORIGINS:
				'https://parent-web.example.test,https://parent-api.example.test'
		}
		const specializedParent = createVerificationCommandEnvironment({
			inheritedEnvironment: conflictingParent,
			cwd: root,
			omittedEnvironment: DOCKER_RUNTIME_OWNED_ENVIRONMENT_KEYS
		})

		for (const key of DOCKER_RUNTIME_OWNED_ENVIRONMENT_KEYS) expect(specializedParent[key], key).toBeUndefined()
		expect(specializedParent.DOCKER_CONFIG).toBe('/tmp/docker-config')

		for (const webPort of [3000, 13_000]) {
			const webOrigin = `http://localhost:${webPort}`
			const apiOrigin = `http://api.localhost:${webPort}`
			const runtimeEnvironment = createDockerRuntimeEnvironment({
				inheritedEnvironment: conflictingParent,
				binPath: '/verify-bin',
				projectName: 'gvkit-runtime-test',
				webOrigin,
				apiOrigin
			})

			expect(runtimeEnvironment.ORIGIN, String(webPort)).toBe(webOrigin)
			expect(runtimeEnvironment.BETTER_AUTH_ALLOWED_HOSTS, String(webPort)).toBe(
				`localhost:${webPort},api.localhost:${webPort},localhost:8786,127.0.0.1:8786`
			)
			expect(runtimeEnvironment.AUTH_CORS_ORIGINS, String(webPort)).toBe(
				`${webOrigin},${apiOrigin}`
			)
			expect(runtimeEnvironment.API_CORS_ORIGINS, String(webPort)).toBe(webOrigin)
			expect(runtimeEnvironment.API_PUBLIC_ORIGIN, String(webPort)).toBe(apiOrigin)
			expect(runtimeEnvironment.GATEWAY_PUBLIC_ORIGINS, String(webPort)).toBe(
				`${webOrigin},${apiOrigin},http://localhost:8786,http://127.0.0.1:8786`
			)
			expect(runtimeEnvironment.DOCKER_CONFIG, String(webPort)).toBe('/tmp/docker-config')
		}
	})

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
			GATEWAY_SCAFFOLD_MATRIX.find(
				({ id }) => id === 'gdk02-no-auth-sqlite-astro-no-client-v2'
			)?.highestSeam
		).toBe('docker-runtime')
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

	test('validates current generated Cloudflare workflows through the matrix contract', async () => {
		const cloudflareEntries = GATEWAY_SCAFFOLD_MATRIX.filter(
			(entry) => entry.topology === 'hono' && entry.deploy === 'cf-workers'
		)
		for (const matrixEntry of cloudflareEntries) {
			const result = await validateCloudflareWorkflowStructure(
				generatedCloudflareWorkflows(matrixEntry),
				matrixEntry
			)

			expect(result.stagingNeeds, matrixEntry.id).toEqual(['preview-db', 'build-preview'])
			expect(result.stagingSteps, matrixEntry.id).toContain(
				'Publish prebuilt preview Workers from trusted code'
			)
		}
	})

	test('workflow validation rejects credentials and active deploys in the untrusted build', async () => {
		const matrixEntry = cloudflareMatrixEntry()
		const { production, staging } = generatedCloudflareWorkflows(matrixEntry)
		const credentialedBuild = staging.replace(
			'          STAGING_ALIAS: ${{ needs.preview-db.outputs.alias }}',
			'          STAGING_ALIAS: ${{ needs.preview-db.outputs.alias }}\n          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}'
		)
		const bracketCredentialedBuild = staging.replace(
			'          STAGING_ALIAS: ${{ needs.preview-db.outputs.alias }}',
			"          STAGING_ALIAS: ${{ needs.preview-db.outputs.alias }}\n          CLOUDFLARE_API_TOKEN: ${{ secrets['CLOUDFLARE_API_TOKEN'] }}"
		)
		const spacedBracketCredentialedBuild = staging.replace(
			'          STAGING_ALIAS: ${{ needs.preview-db.outputs.alias }}',
			"          STAGING_ALIAS: ${{ needs.preview-db.outputs.alias }}\n          CLOUDFLARE_API_TOKEN: ${{ secrets ['CLOUDFLARE_API_TOKEN'] }}"
		)
		const formattedCredentialedBuild = staging.replace(
			'          STAGING_ALIAS: ${{ needs.preview-db.outputs.alias }}',
			"          STAGING_ALIAS: ${{ needs.preview-db.outputs.alias }}\n          CLOUDFLARE_API_TOKEN: ${{ format('{0}', secrets.CLOUDFLARE_API_TOKEN) }}"
		)
		const aliasedDatabaseCredential = staging
			.replace(
				'      database_url: ${{ steps.create_neon_branch.outputs.db_url_pooled }}',
				'      database_url: ${{ steps.create_neon_branch.outputs.db_url_pooled }}\n      leaked_connection: ${{ steps.create_neon_branch.outputs.db_url_pooled }}'
			)
			.replace(
				'          STAGING_ALIAS: ${{ needs.preview-db.outputs.alias }}',
				'          STAGING_ALIAS: ${{ needs.preview-db.outputs.alias }}\n          LEAKED_DATABASE_URL: ${{ needs.preview-db.outputs.leaked_connection }}'
			)
		const activeBuild = staging.replace(' --dry-run --outdir=.preview-bundle', '')
		const chainedActiveBuild = staging.replace(
			' --dry-run --outdir=.preview-bundle\n',
			' --dry-run --outdir=.preview-bundle; pnpm --filter attacker exec wrangler deploy --config wrangler.staging.jsonc\n'
		)

		await expect(
			validateCloudflareWorkflowStructure(
				{ production, staging: credentialedBuild },
				matrixEntry
			)
		).rejects.toThrow('PR-controlled preview build receives provider credentials')
		for (const secretExpression of [
			bracketCredentialedBuild,
			spacedBracketCredentialedBuild,
			formattedCredentialedBuild
		]) {
			await expect(
				validateCloudflareWorkflowStructure(
					{ production, staging: secretExpression },
					matrixEntry
				)
			).rejects.toThrow('PR-controlled preview build receives provider credentials')
		}
		await expect(
			validateCloudflareWorkflowStructure(
				{ production, staging: aliasedDatabaseCredential },
				matrixEntry
			)
		).rejects.toThrow('preview build job does not match trusted passive structure')
		await expect(
			validateCloudflareWorkflowStructure({ production, staging: activeBuild }, matrixEntry)
		).rejects.toThrow('untrusted preview build does not produce only passive Worker bundles')
		await expect(
			validateCloudflareWorkflowStructure({ production, staging: chainedActiveBuild }, matrixEntry)
		).rejects.toThrow('untrusted preview build does not produce only passive Worker bundles')
	})

	test('workflow validation rejects credentials outside trusted steps', async () => {
		const matrixEntry = cloudflareMatrixEntry()
		const { production, staging } = generatedCloudflareWorkflows(matrixEntry)
		const workflowScopedSecretContext = staging.replace(
			'\njobs:\n',
			'\nenv:\n  EXPOSED_SECRETS: ${{ toJSON(secrets) }}\n\njobs:\n'
		)
		const jobScopedCredential = staging.replace(
			'  deploy:\n    needs: [preview-db, build-preview]\n    runs-on: ubuntu-latest',
			'  deploy:\n    needs: [preview-db, build-preview]\n    runs-on: ubuntu-latest\n    env:\n      CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}'
		)
		const jobScopedSecretContext = staging.replace(
			'  deploy:\n    needs: [preview-db, build-preview]\n    runs-on: ubuntu-latest',
			'  deploy:\n    needs: [preview-db, build-preview]\n    runs-on: ubuntu-latest\n    env:\n      EXPOSED_SECRETS: ${{ toJSON(secrets) }}'
		)
		const unrelatedActionCredential = staging.replace(
			'      - uses: marocchino/sticky-pull-request-comment@v2\n',
			'      - uses: marocchino/sticky-pull-request-comment@v2\n        env:\n          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}\n'
		)
		const stepScopedSecretContext = staging.replace(
			'      - uses: marocchino/sticky-pull-request-comment@v2\n',
			'      - uses: marocchino/sticky-pull-request-comment@v2\n        env:\n          EXPOSED_SECRETS: ${{ toJSON(secrets) }}\n'
		)
		const alteredSecretWriter = staging.replace(
			'          node trusted-source/scripts/write-cloudflare-preview-secrets.mjs "$secret_dir"',
			'          node trusted-source/scripts/write-cloudflare-preview-secrets.mjs "$secret_dir"\n          node preview-artifact/exfiltrate.mjs'
		)
		const alteredMigration = staging.replace(
			'          npx drizzle-kit@0.31.8 migrate --config "$RUNNER_TEMP/drizzle.preview.config.mjs"',
			'          npx drizzle-kit@0.31.8 migrate --config "$RUNNER_TEMP/drizzle.preview.config.mjs"\n          node preview-artifact/exfiltrate.mjs'
		)
		const maliciousStepShell = staging.replace(
			'        run: sh trusted-source/scripts/publish-cloudflare-preview.sh',
			'        run: sh trusted-source/scripts/publish-cloudflare-preview.sh\n        shell: node preview-artifact/exfiltrate.mjs {0}'
		)
		const jobRunDefaults = staging.replace(
			'  deploy:\n    needs: [preview-db, build-preview]',
			'  deploy:\n    defaults:\n      run:\n        shell: node preview-artifact/exfiltrate.mjs {0}\n    needs: [preview-db, build-preview]'
		)
		const workflowRunDefaults = staging.replace(
			'\njobs:\n',
			'\ndefaults:\n  run:\n    shell: node preview-artifact/exfiltrate.mjs {0}\n\njobs:\n'
		)

		await expect(
			validateCloudflareWorkflowStructure(
				{ production, staging: workflowScopedSecretContext },
				matrixEntry
			)
		).rejects.toThrow('preview workflow exposes provider credentials at workflow scope')
		for (const jobCredential of [jobScopedCredential, jobScopedSecretContext]) {
			await expect(
				validateCloudflareWorkflowStructure(
					{ production, staging: jobCredential },
					matrixEntry
				)
			).rejects.toThrow('deploy exposes provider credentials at job scope')
		}
		await expect(
			validateCloudflareWorkflowStructure({ production, staging: jobRunDefaults }, matrixEntry)
		).rejects.toThrow('deploy overrides execution for credentialed steps')
		await expect(
			validateCloudflareWorkflowStructure(
				{ production, staging: workflowRunDefaults },
				matrixEntry
			)
		).rejects.toThrow('preview workflow overrides execution for credentialed steps')
		for (const untrustedStep of [
			unrelatedActionCredential,
			stepScopedSecretContext,
			alteredSecretWriter,
			alteredMigration,
			maliciousStepShell
		]) {
			await expect(
				validateCloudflareWorkflowStructure(
					{ production, staging: untrustedStep },
					matrixEntry
				)
			).rejects.toThrow('deploy exposes provider credentials to an untrusted step')
		}
	})

	test('workflow validation requires a trusted trigger and one publisher after migrations', async () => {
		const matrixEntry = cloudflareMatrixEntry('postgres')
		const { production, staging } = generatedCloudflareWorkflows(matrixEntry)
		const untrustedTrigger = staging.replace(
			'  pull_request_target:',
			'  pull_request:\n    # pull_request_target:'
		)
		const duplicatePublisher = staging.replace(
			'      - name: Validate and seal exact preview deployment inventory',
			'      - name: Publish a second preview copy\n        run: sh trusted-source/scripts/publish-cloudflare-preview.sh\n\n      - name: Validate and seal exact preview deployment inventory'
		)
		const parsed = Bun.YAML.parse(staging) as {
			jobs: { deploy: { steps: Array<{ name?: string }> } }
		}
		const deploySteps = parsed.jobs.deploy.steps
		const migrationIndex = deploySteps.findIndex((step) =>
			step.name?.startsWith('Apply preview Neon migrations')
		)
		const publisherIndex = deploySteps.findIndex(
			(step) => step.name === 'Publish prebuilt preview Workers from trusted code'
		)
		if (migrationIndex < 0 || publisherIndex < 0) throw new Error('Expected deployment steps are missing')
		const migrationStep = deploySteps[migrationIndex]!
		deploySteps[migrationIndex] = deploySteps[publisherIndex]!
		deploySteps[publisherIndex] = migrationStep
		const publishBeforeMigration = Bun.YAML.stringify(parsed)

		await expect(
			validateCloudflareWorkflowStructure({ production, staging: untrustedTrigger }, matrixEntry)
		).rejects.toThrow('preview deployment does not use a trusted workflow definition')
		await expect(
			validateCloudflareWorkflowStructure({ production, staging: duplicatePublisher }, matrixEntry)
		).rejects.toThrow('staging workflow must have one trusted publisher')
		await expect(
			validateCloudflareWorkflowStructure(
				{ production, staging: publishBeforeMigration },
				matrixEntry
			)
		).rejects.toThrow('workflow step order is invalid')
	})

	test('workflow validation rejects obsolete individual preview deployment steps', async () => {
		const matrixEntry = cloudflareMatrixEntry()
		const { production, staging: generatedStaging } = generatedCloudflareWorkflows(matrixEntry)
		const staging = generatedStaging.replace(
			'Publish prebuilt preview Workers from trusted code',
			'Deploy auth Worker'
		)
		const obsoletePackageDeploy = generatedStaging.replace(
			'run: sh trusted-source/scripts/publish-cloudflare-preview.sh',
			'run: pnpm --filter @repo/auth-worker deploy:staging'
		)

		await expect(
			validateCloudflareWorkflowStructure({ production, staging }, matrixEntry)
		).rejects.toThrow('obsolete individual preview Worker deployment step')
		await expect(
			validateCloudflareWorkflowStructure(
				{ production, staging: obsoletePackageDeploy },
				matrixEntry
			)
		).rejects.toThrow('obsolete individual preview package deployment command')
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

	test('unresolved-marker scanning permits only selected Umami output', () => {
		const internalMarkers = [
			'__PROJECT__',
			'__COMPAT_DATE__',
			'__GATEWAY_TARGET__',
			'__GATEWAY_SERVICE__',
			'__GATEWAY_URL__',
			'__AUTH_URL__'
		]
		internalMarkers.forEach((marker) => {
			expect(
				unresolvedGeneratorMarkers({
					path: 'apps/web/src/app.html',
					content: marker,
					umamiSelected: true
				})
			).toEqual([marker])
		})
		expect(
			unresolvedGeneratorMarkers({
				path: 'apps/web/src/app.html',
				content: '__UMAMI_WEBSITE_ID__',
				umamiSelected: true
			})
		).toEqual([])
		expect(
			unresolvedGeneratorMarkers({
				path: 'apps/web/src/app.html',
				content: '__UMAMI_WEBSITE_ID__',
				umamiSelected: false
			})
		).toEqual(['__UMAMI_WEBSITE_ID__'])
		expect(
			unresolvedGeneratorMarkers({
				path: 'apps/web/src/routes/+page.svelte',
				content: '__UMAMI_WEBSITE_ID__',
				umamiSelected: true
			})
		).toEqual(['__UMAMI_WEBSITE_ID__'])
	})

	test('retained artifact redaction removes machine paths and credential values', () => {
		const unsafe = [
			'/Users/alice/project/file.ts',
			'Authorization: Bearer secret-token-value',
			'DATABASE_URL=postgres://user:password@example.test/db',
			'API_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz',
			'auth: [auth] OTP for person+local@example.test: 123456'
		].join('\n')
		expect(unsafeArtifactFindings(unsafe)).toContain('generated email OTP')
		const redacted = redactArtifactText(unsafe)
		expect(unsafeArtifactFindings(redacted)).toEqual([])
		expect(redacted).toContain('[auth] OTP for person+local@example.test: [REDACTED]')
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
