import { describe, expect, test } from 'bun:test'

import {
	EFFECT_SCAFFOLD_MATRIX,
	EFFECT_SUPPORTED_CARTESIAN_ROWS,
	UNSUPPORTED_EFFECT_CASES,
	uncoveredSupportedPairs
} from '../../scripts/verify-effect-scaffold-matrix.js'
import { buildScaffoldPlan } from '../../src/pipeline/plan.js'
import { GvKitConfig } from '../../src/schema/config.js'

describe('Effect generated-project verification matrix', () => {
	test('pairwise covers every supported independent option interaction', () => {
		expect(EFFECT_SUPPORTED_CARTESIAN_ROWS).toBe(7_680)
		expect(uncoveredSupportedPairs()).toEqual([])
		expect(new Set(EFFECT_SCAFFOLD_MATRIX.map((entry) => entry.choices.deploy))).toEqual(
			new Set(['cf-workers', 'docker', 'skip'])
		)
		expect(new Set(EFFECT_SCAFFOLD_MATRIX.map((entry) => entry.choices.db))).toEqual(
			new Set(['sqlite', 'postgres'])
		)
		expect(new Set(EFFECT_SCAFFOLD_MATRIX.map((entry) => entry.choices.auth))).toEqual(
			new Set(['none', 'google', 'emailOTP', 'emailOTP+google'])
		)
		expect(new Set(EFFECT_SCAFFOLD_MATRIX.map((entry) => entry.choices.email))).toEqual(
			new Set(['skip', 'resend', 'notifuse'])
		)
		expect(new Set(EFFECT_SCAFFOLD_MATRIX.map((entry) => entry.choices.monitoring))).toEqual(
			new Set(['none', 'umami', 'posthog', 'both'])
		)
		expect(new Set(EFFECT_SCAFFOLD_MATRIX.map((entry) => entry.choices.aiTooling))).toEqual(
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

	test('canonical monitoring and AI subsets map to independent schema choices', () => {
		const expectedMonitoring = new Map<string, Array<'umami' | 'posthog'>>([
			['none', []],
			['umami', ['umami']],
			['posthog', ['posthog']],
			['both', ['umami', 'posthog']]
		])
		const expectedAiTooling = new Map<string, Array<'claude' | 'codex' | 'opencode'>>([
			['none', []],
			['claude', ['claude']],
			['codex', ['codex']],
			['opencode', ['opencode']],
			['claude+codex', ['claude', 'codex']],
			['claude+opencode', ['claude', 'opencode']],
			['codex+opencode', ['codex', 'opencode']],
			['claude+codex+opencode', ['claude', 'codex', 'opencode']]
		])
		for (const entry of EFFECT_SCAFFOLD_MATRIX) {
			expect(entry.config.choices.monitoring).toEqual(
				expectedMonitoring.get(entry.choices.monitoring)!
			)
			expect(entry.config.choices.aiTooling).toEqual(
				expectedAiTooling.get(entry.choices.aiTooling)!
			)
		}
	})

	test('every entry validates as an Effect Hono scaffold and gates Hey API entries', () => {
		for (const entry of EFFECT_SCAFFOLD_MATRIX) {
			expect(entry.config.choices.backendRuntime).toBe('effect')
			expect(entry.config.choices.backend).toBe('hono')
			const rootPackage = buildScaffoldPlan(entry.config).find((file) => file.path === 'package.json')
			expect(rootPackage).toBeDefined()
			const scripts = JSON.parse(rootPackage!.content).scripts as Record<string, string>
			expect(scripts.test).toBeDefined()
			expect(scripts.typecheck).toBeDefined()
			expect(scripts.lint).toBeDefined()
			expect(scripts.build).toBeDefined()
			expect(Boolean(scripts['client:generate'])).toBe(entry.choices.apiClient === 'hey-api')
			expect(scripts['contract:verify']).toBeUndefined()
		}
	})

	test('no-auth Effect entries do not require the auth database schema', () => {
		for (const entry of EFFECT_SCAFFOLD_MATRIX.filter((entry) => entry.choices.auth === 'none')) {
			const plan = buildScaffoldPlan(entry.config)
			expect(
				plan.some((file) => file.path === 'apps/api/users/src/infrastructure/database.ts')
			).toBe(false)
			const handler = plan.find(
				(file) => file.path === 'apps/api/users/src/features/me/handler.ts'
			)
			expect(handler?.content).not.toContain('makeDatabaseLayer')
			expect(handler?.content).toContain('Effect.provide(authLayer)')
		}
	})

	test('Effect auth-session service imports Context for every generated runtime', () => {
		for (const deploy of ['cf-workers', 'docker', 'skip'] as const) {
			const source = buildScaffoldPlan({
				...EFFECT_SCAFFOLD_MATRIX[0]!.config,
				choices: { ...EFFECT_SCAFFOLD_MATRIX[0]!.config.choices, deploy }
			}).find((file) => file.path === 'apps/api/auth/src/effect/auth-session.ts')?.content
			expect(source).toContain("import { Context, Effect } from 'effect'")
			expect(source).toContain(
				deploy === 'cf-workers' ? "import { getAuth } from '../auth.js'" : "import { auth } from '../auth.js'"
			)
		}
	})

	test('Effect Node services use the supported tsup flag while Promise keeps historical bytes', () => {
		const base = EFFECT_SCAFFOLD_MATRIX.find((entry) => entry.choices.deploy === 'docker')!.config
		const effectPlan = buildScaffoldPlan(base)
		const promisePlan = buildScaffoldPlan({
			...base,
			choices: { ...base.choices, backendRuntime: 'promise' }
		})
		for (const path of ['apps/api/auth/package.json', 'apps/api/users/package.json']) {
			const effectPackage = JSON.parse(effectPlan.find((file) => file.path === path)!.content) as {
				scripts: Record<string, string>
			}
			const promisePackage = JSON.parse(promisePlan.find((file) => file.path === path)!.content) as {
				scripts: Record<string, string>
			}
			expect(effectPackage.scripts.build).toBe(
				'tsup src/index.ts --format esm --target=node20 --out-dir dist'
			)
			expect(promisePackage.scripts.build).toBe(
				'tsup src/index.ts --format esm --target=node20 --outdir dist'
			)
		}
	})

	test('Effect database layers consume Env only on Cloudflare', () => {
		for (const deploy of ['docker', 'skip'] as const) for (const db of ['sqlite', 'postgres'] as const) {
				const base = EFFECT_SCAFFOLD_MATRIX.find((entry) => entry.choices.auth !== 'none')!.config
				const database = buildScaffoldPlan({
					...base,
					choices: { ...base.choices, deploy, db }
				}).find((file) => file.path === 'apps/api/users/src/infrastructure/database.ts')
					?.content
				expect(database).toContain('makeDatabaseLayer(_env: Env)')
				expect(database).toContain('process.env.')
		}
		const cloudflareBase = EFFECT_SCAFFOLD_MATRIX.find(
			(entry) => entry.choices.deploy === 'cf-workers' && entry.choices.auth !== 'none'
		)!.config
		const cloudflareDatabase = buildScaffoldPlan(cloudflareBase).find(
			(file) => file.path === 'apps/api/users/src/infrastructure/database.ts'
		)?.content
		expect(cloudflareDatabase).toContain('makeDatabaseLayer(env: Env)')
		expect(cloudflareDatabase).toContain('createDb({')
		expect(cloudflareDatabase).toContain('env.')
	})

	test('documents every unsupported Effect combination as a schema rejection', () => {
		expect(UNSUPPORTED_EFFECT_CASES.map((entry) => entry.id)).toEqual([
			'inside-frontend-effect',
			'inside-frontend-hey-api-effect',
			'email-otp-without-mailer'
		])
	})

	test('omitted and explicit Promise configurations generate identically', () => {
		const effect = EFFECT_SCAFFOLD_MATRIX[0]!.config
		const choices = { ...effect.choices, name: 'promise-parity' }
		delete (choices as { backendRuntime?: string }).backendRuntime
		const omitted = GvKitConfig.parse({ configVersion: 1, choices })
		const explicit = GvKitConfig.parse({
			configVersion: 1,
			choices: { ...choices, backendRuntime: 'promise' }
		})
		expect(buildScaffoldPlan(omitted)).toEqual(buildScaffoldPlan(explicit))
	})
})
