import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import {
	redactArtifactText,
	unsafeArtifactFindings
} from '../../scripts/gateway-verification-evidence.js'
import {
	extractGeneratedEmailOtp,
	otpSignInFailureDiagnostic
} from '../../scripts/verify-gateway-local.js'
import type { FileEntry } from '../../src/lib/files.js'
import { parseJsonc } from '../../src/lib/jsonc.js'
import { buildScaffoldPlan } from '../../src/pipeline/plan.js'
import { GvKitConfig } from '../../src/schema/config.js'

const PROCESS_ENV_BRIDGE = 'CLOUDFLARE_INCLUDE_PROCESS_ENV'
const cloudflareWorkerPackages = [
	'@hono-cf-workers-passwordless/api-gateway#dev',
	'@hono-cf-workers-passwordless/auth-worker#dev',
	'@hono-cf-workers-passwordless/users-worker#dev'
] as const

function planFixture(name: string): FileEntry[] {
	const fixturePath = join(import.meta.dir, '..', '..', 'fixtures', `${name}.jsonc`)
	const config = GvKitConfig.parse(parseJsonc(readFileSync(fixturePath, 'utf8')))
	return buildScaffoldPlan(config)
}

function entry(entries: FileEntry[], path: string): string {
	const found = entries.find((candidate) => candidate.path === path)
	if (!found) throw new Error(`Missing generated file: ${path}`)
	return found.content
}

describe('local gateway verifier evidence', () => {
	test('uses generated email OTPs transiently without retaining their values', () => {
		const email = 'local-verifier@example.test'
		const output = `auth: [auth] OTP for ${email}: 123456\n`
		expect(extractGeneratedEmailOtp(output, email)).toBe('123456')
		const retained = redactArtifactText(output)
		expect(retained).toBe(`auth: [auth] OTP for ${email}: [REDACTED]\n`)
		expect(unsafeArtifactFindings(retained)).toEqual([])
	})

	test('redacts OTP-bearing post-extraction failure diagnostics', () => {
		const otp = '123456'
		const body = `{"error":"OTP ${otp} rejected","otp":"${otp}"}`
		expect(unsafeArtifactFindings(body)).toContain('OTP field')

		const diagnostic = otpSignInFailureDiagnostic({
			origin: 'http://localhost:3000',
			status: 401,
			body,
			otp
		})
		expect(diagnostic).toBe(
			'OTP sign-in failed for http://localhost:3000: 401 {"error":"OTP [REDACTED] rejected","otp":"[REDACTED]"}'
		)
		expect(diagnostic).not.toContain(otp)
		expect(unsafeArtifactFindings(diagnostic)).toEqual([])
		expect(unsafeArtifactFindings(redactArtifactText(diagnostic))).toEqual([])
	})
})

describe('Cloudflare gateway local environment', () => {
	test('root dev enables Wrangler process environment forwarding for each Worker task', () => {
		const entries = planFixture('hono-cf-workers-passwordless')
		const local = entry(entries, 'scripts/local.mjs')
		const turbo = JSON.parse(entry(entries, 'turbo.json')) as {
			tasks: Record<string, { env?: string[] }>
		}
		const gatewayPackage = JSON.parse(entry(entries, 'apps/api/package.json')) as {
			scripts: Record<string, string>
		}
		const gatewayWrangler = parseJsonc<{ dev: { host: string } }>(
			entry(entries, 'apps/api/wrangler.jsonc')
		)

		expect(local).toContain(
			"if (action === 'dev') process.env.CLOUDFLARE_INCLUDE_PROCESS_ENV = 'true'"
		)
		for (const packageTask of cloudflareWorkerPackages) expect(turbo.tasks[packageTask]?.env, packageTask).toContain(PROCESS_ENV_BRIDGE)
		expect(gatewayPackage.scripts.dev).toContain('wrangler dev --host api.localhost:8786')
		expect(gatewayWrangler.dev.host).toBe('localhost')
		expect(entry(entries, '.env.example')).not.toContain(PROCESS_ENV_BRIDGE)
	})

	test('local forwarding does not create package environment files or alter publishing commands', () => {
		const entries = planFixture('hono-cf-workers-passwordless')
		const packageEnvironment = entries.filter(({ path }) =>
			/^(?:apps|services)\/.+\/(?:\.env|\.dev\.vars)$/.test(path)
		)
		expect(packageEnvironment).toEqual([])

		for (const path of [
			'apps/api/package.json',
			'apps/web/package.json',
			'services/auth/package.json',
			'services/users/package.json'
		]) {
			const pkg = JSON.parse(entry(entries, path)) as { scripts: Record<string, string> }
			expect(pkg.scripts['deploy:production'], path).not.toContain(PROCESS_ENV_BRIDGE)
			expect(pkg.scripts['deploy:staging'], path).not.toContain(PROCESS_ENV_BRIDGE)
		}
	})

	test('non-Cloudflare and non-Hono plans do not enable Wrangler process forwarding', () => {
		for (const fixture of [
			'hono-skip-deploy',
			'hono-docker-full',
			'inside-frontend-typical'
		]) {
			const output = planFixture(fixture)
				.map(({ content }) => content)
				.join('\n')
			expect(output, fixture).not.toContain(PROCESS_ENV_BRIDGE)
		}
	})
})
