import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import ts from 'typescript'
import { generateDeploy } from '../../src/generators/deploy.js'
import { generateGateway } from '../../src/generators/gateway.js'
import { generateIntegratedDeploy } from '../../src/generators/integrated-deploy.js'
import { generateRoot } from '../../src/generators/root.js'
import { parseJsonc } from '../../src/lib/jsonc.js'
import { GvKitConfig, type Choices } from '../../src/schema/config.js'

const repositoryRoot = join(import.meta.dir, '..', '..')
const fixturesDirectory = join(repositoryRoot, 'fixtures')
const gatewayGeneratorPath = join(repositoryRoot, 'src/generators/gateway.ts')
const integratedDeployGeneratorPath = join(repositoryRoot, 'src/generators/integrated-deploy.ts')
const dockerVerifierPath = join(repositoryRoot, 'scripts/verify-gateway-docker.ts')
const previewWorkflowTestPath = join(repositoryRoot, 'tests/contracts/gateway-preview-workflows.test.ts')
const expectedGatewayRenderers = [
	'renderGatewayPackageJson',
	'renderGatewayTsconfig',
	'renderGatewayAppSource',
	'renderAuthenticatedClientIpSource',
	'renderGatewayEntrySource',
	'renderGatewayWranglerConfig',
	'renderGatewayOpenApiComposerSource',
	'renderGatewayOpenApiMainSource',
	'renderGatewayReadme'
]
const expectedIntegratedDeployRenderers = [
	'renderWorkflowVariableEnvironment',
	'renderProductionDeployWorkflow',
	'renderStagingDeployWorkflow',
	'renderStagingWranglerConfigStep',
	'renderPreviewMigrationCommand',
	'renderPreviewMigrationEnvironment',
	'renderD1PreviewDatabaseJob',
	'renderNeonPreviewDatabaseJob',
	'renderStagingCleanupWorkflow',
	'renderD1PreviewDatabaseCleanupStep',
	'renderNeonPreviewDatabaseCleanupStep',
	'renderDockerignore',
	'renderDockerfile',
	'renderDockerCompose',
	'renderPostgresService',
	'renderMigrateService',
	'renderAuthService',
	'renderUsersService',
	'renderWebService',
	'renderMarketingService'
]

function stringRendererNames(path: string, source: string): string[] {
	const sourceFile = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
	return sourceFile.statements.flatMap((statement) => {
		if (!ts.isFunctionDeclaration(statement) || !statement.name) return []
		if (statement.type?.getText(sourceFile) !== 'string') return []
		return [statement.name.text]
	})
}

function setupNarrationFindings(path: string, source: string): string[] {
	const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, source)
	const findings: string[] = []
	for (let kind = scanner.scan(); kind !== ts.SyntaxKind.EndOfFileToken; kind = scanner.scan()) {
		if (kind !== ts.SyntaxKind.SingleLineCommentTrivia && kind !== ts.SyntaxKind.MultiLineCommentTrivia) continue
		const comment = scanner.getTokenText()
		if (!/\b(?:replace|configure|set[ -]?up)\b/i.test(comment)) continue
		const sourceFile = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true)
		const { line } = sourceFile.getLineAndCharacterOfPosition(scanner.getTokenPos())
		findings.push(`${path}:${line + 1} ${comment.trim()}`)
	}
	return findings
}

function generatedCloudflareGateway() {
	const fixturePath = join(repositoryRoot, 'fixtures/hono-cf-workers-passwordless.jsonc')
	const config = GvKitConfig.parse(parseJsonc(readFileSync(fixturePath, 'utf8')))
	return generateGateway(config)
}

const deploymentChoices: Choices = {
	name: 'demo',
	frontend: 'sveltekit',
	marketing: 'astro',
	backend: 'hono',
	i18n: 'skip',
	monitoring: ['umami', 'posthog'],
	db: 'postgres',
	apiClient: 'hey-api',
	auth: ['emailOTP', 'google'],
	email: 'resend',
	aiTooling: [],
	deploy: 'cf-workers'
}

function deploymentCommentRunFindings(path: string, source: string): string[] {
	const findings: string[] = []
	if (/\.[cm]?[jt]sx?$/.test(path)) {
		const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, source)
		for (let kind = scanner.scan(); kind !== ts.SyntaxKind.EndOfFileToken; kind = scanner.scan()) {
			if (kind !== ts.SyntaxKind.MultiLineCommentTrivia || !scanner.getTokenText().includes('\n')) continue
			const line = source.slice(0, scanner.getTokenPos()).split('\n').length
			findings.push(`${path}:${line} multi-line block comment`)
		}
	}
	let previousCommentLine: number | undefined
	let runRecorded = false
	for (const [index, line] of source.split('\n').entries()) {
		const trimmed = line.trimStart()
		const isComment =
			(trimmed.startsWith('#') && !trimmed.startsWith('#!') && !trimmed.startsWith('# syntax=')) ||
			trimmed.startsWith('//')
		if (!isComment) {
			previousCommentLine = undefined
			runRecorded = false
			continue
		}
		if (previousCommentLine === index - 1 && !runRecorded) {
			findings.push(`${path}:${previousCommentLine + 1} consecutive explanatory comments`)
			runRecorded = true
		}
		previousCommentLine = index
	}
	return findings
}

function generatedDeploymentArtifacts() {
	const configs = [
		{
			label: 'gateway-cloudflare',
			generator: generateDeploy,
			choices: deploymentChoices
		},
		{
			label: 'gateway-docker',
			generator: generateDeploy,
			choices: { ...deploymentChoices, deploy: 'docker' as const }
		},
		{
			label: 'integrated-cloudflare',
			generator: generateIntegratedDeploy,
			choices: { ...deploymentChoices, backend: 'inside-frontend' as const, apiClient: 'skip' as const }
		},
		{
			label: 'integrated-docker',
			generator: generateIntegratedDeploy,
			choices: {
				...deploymentChoices,
				backend: 'inside-frontend' as const,
				apiClient: 'skip' as const,
				deploy: 'docker' as const
			}
		}
	]
	return configs.flatMap(({ label, generator, choices }) =>
		generator({ configVersion: 2, choices }).map(({ path, content }) => ({
			path: `${label}:${path}`,
			content
		}))
	)
}

const approvedEnvironmentComments = new Set([
	'# Public build-time origins (complete URLs)',
	'# SQLite (one root-relative database shared by local services)',
	'# Cloudflare Turnstile (auth service only; apps/web holds the public site key)'
])

function environmentCommentFindings(path: string, source: string): string[] {
	return source.split('\n').flatMap((line, index) => {
		const comment = line.trimStart()
		if (!comment.startsWith('#') || approvedEnvironmentComments.has(comment)) return []
		return [`${path}:${index + 1} ${comment}`]
	})
}

function generatedHonoRootEnvironmentExamples() {
	return readdirSync(fixturesDirectory)
		.filter((name) => name.endsWith('.jsonc'))
		.sort()
		.flatMap((fixtureName) => {
			const config = GvKitConfig.parse(
				parseJsonc(readFileSync(join(fixturesDirectory, fixtureName), 'utf8'))
			)
			if (config.choices.backend !== 'hono') return []
			return generateRoot(config)
				.filter(({ path }) => path.startsWith('.env'))
				.map(({ path, content }) => ({ path: `${fixtureName}:${path}`, content }))
		})
}

function helperArgumentFindings(source: string, names: string[]): string[] {
	const sourceFile = ts.createSourceFile('helpers.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
	const found = new Set<string>()
	const findings: string[] = []
	function check(name: string, parameters: ts.NodeArray<ts.ParameterDeclaration>): void {
		if (!names.includes(name)) return
		found.add(name)
		const first = parameters[0]?.name
		const named = parameters.length === 1 && first && ts.isObjectBindingPattern(first)
		const valid = named ? first.elements.length >= 3 : parameters.length <= 2 && parameters.every((parameter) => ts.isIdentifier(parameter.name))
		if (!valid) findings.push(name)
	}
	function visit(node: ts.Node): void {
		if (ts.isFunctionDeclaration(node) && node.name) check(node.name.text, node.parameters)
		if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) check(node.name.text, node.initializer.parameters)
		ts.forEachChild(node, visit)
	}
	visit(sourceFile)
	for (const name of names) if (!found.has(name)) throw new Error(`Missing helper coverage: ${name}`)
	return findings
}

function nonJsoncWranglerConfigNames(source: string): string[] {
	return source.match(/\bwrangler(?:\.[a-z-]+)*\.json\b/g) ?? []
}

describe('gateway source standards', () => {
	test('temporary Wrangler config filenames retain the JSONC convention at every boundary', () => {
		for (const fixture of readdirSync(fixturesDirectory).filter((name) => name.endsWith('.jsonc'))) {
			const cfg = GvKitConfig.parse(parseJsonc(readFileSync(join(fixturesDirectory, fixture), 'utf8')))
			for (const file of generateDeploy(cfg)) expect(nonJsoncWranglerConfigNames(file.content), `${fixture}:${file.path}`).toEqual([])
		}
		const verifier = readFileSync(join(repositoryRoot, 'scripts/verify-gateway-preview-security.ts'), 'utf8')
		expect(nonJsoncWranglerConfigNames(verifier)).toEqual([])
	})

	test('temporary config filename coverage rejects either original JSON name', () => {
		for (const name of ['wrangler.publish.json', 'wrangler.preview-migrations.json']) expect(nonJsoncWranglerConfigNames(`--config ${name}`)).toEqual([name])
		expect(nonJsoncWranglerConfigNames('wrangler.jsonc wrangler.publish.jsonc wrangler.preview-migrations.jsonc manifest.json')).toEqual([])
	})

	test('publisher and preview test helpers follow the positional-input boundary', () => {
		const sources = [
			{ path: 'src/generators/deploy.ts', names: ['writeStagingWranglerConfigStep', 'honoPreviewIngressGateJob', 'deployStagingWorkflow'] },
			{ path: 'tests/contracts/gateway-preview-workflows.test.ts', names: ['previewNames', 'runPreviewPreparation', 'verify', 'replaceRequired'] },
			{ path: 'tests/contracts/gateway-rollout-compatibility.test.ts', names: ['requestFromFixture'] }
		]
		for (const { path, names } of sources) expect(helperArgumentFindings(readFileSync(join(repositoryRoot, path), 'utf8'), names), path).toEqual([])
	})

	test('helper argument coverage rejects original small bags without banning domain values', () => {
		const originals = [
			'function writeStagingWranglerConfigStep({ db }: { db: string }) {}',
			'function honoPreviewIngressGateJob({ publicKeys }: { publicKeys: string[] }) {}',
			'async function previewNames({ entries }: { entries: Entry[] }) {}',
			'async function runPreviewPreparation({ cfg, overrideEnv = {} }: { cfg: Config; overrideEnv?: object }) {}',
			'const verify = async ({ missingWildcard }: { missingWildcard?: string } = {}) => {}',
			'function requestFromFixture({ fixture, origin }: { fixture: Fixture; origin?: string }) {}'
		]
		const names = ['writeStagingWranglerConfigStep', 'honoPreviewIngressGateJob', 'previewNames', 'runPreviewPreparation', 'verify', 'requestFromFixture']
		for (const [index, source] of originals.entries()) expect(helperArgumentFindings(source, [names[index]!])).toEqual([names[index]!])
		expect(helperArgumentFindings('function domain(config: Config) {}\nfunction named({ a, b, c }: Inputs) {}\nconst optional = (value?: string) => {}', ['domain', 'named', 'optional'])).toEqual([])
		expect(helperArgumentFindings('function positional(a: string, b: string, c: string) {}', ['positional'])).toEqual(['positional'])
		expect(() => helperArgumentFindings('', ['missing'])).toThrow('Missing helper coverage: missing')
	})

	test('Docker verifier cleans up before propagating verification failures', () => {
		const source = readFileSync(dockerVerifierPath, 'utf8')
		const capturedFailure = source.indexOf('verificationError = error')
		const cleanup = source.indexOf('cleanup = await performCleanup()')
		const propagatedFailure = source.indexOf('if (verificationFailed) throw verificationError')

		expect(source).not.toMatch(/finally\s*\{[\s\S]*?throw/u)
		expect(source).toContain("composeCommand: 'down'")
		expect(source).toContain('return assertCleanup(generated.project, env)')
		expect(capturedFailure).toBeGreaterThan(-1)
		expect(cleanup).toBeGreaterThan(capturedFailure)
		expect(propagatedFailure).toBeGreaterThan(cleanup)
	})

	test('preview workflow tests do not import filesystem mutation APIs', () => {
		const source = readFileSync(previewWorkflowTestPath, 'utf8')
		const sourceFile = ts.createSourceFile(
			previewWorkflowTestPath,
			source,
			ts.ScriptTarget.Latest,
			true,
			ts.ScriptKind.TS
		)
		const filesystemImports = sourceFile.statements.flatMap((statement) => {
			if (!ts.isImportDeclaration(statement)) return []
			if (!ts.isStringLiteral(statement.moduleSpecifier)) return []
			return /^node:fs(?:\/promises)?$/.test(statement.moduleSpecifier.text)
				? [statement.moduleSpecifier.text]
				: []
		})
		expect(filesystemImports).toEqual([])
		expect(source).not.toMatch(/\bBun\.(?:write|file\([^)]*\)\.writer)\b/)
		const subprocessCommands: string[] = []
		function visit(node: ts.Node): void {
			if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.expression.getText(sourceFile) === 'Bun' && node.expression.name.text === 'spawn') subprocessCommands.push(node.arguments[0]?.getText(sourceFile) ?? '')
			ts.forEachChild(node, visit)
		}
		visit(sourceFile)
		expect(subprocessCommands).toEqual(["['sh', '-n']"])
	})

	test('gateway string renderers use outcome-oriented render names', () => {
		const source = readFileSync(gatewayGeneratorPath, 'utf8')
		expect(stringRendererNames(gatewayGeneratorPath, source)).toEqual(expectedGatewayRenderers)
	})

	test('integrated deployment string renderers use outcome-oriented render names', () => {
		const source = readFileSync(integratedDeployGeneratorPath, 'utf8')
		expect(stringRendererNames(integratedDeployGeneratorPath, source)).toEqual(
			expectedIntegratedDeployRenderers
		)
	})

	test('setup narration detector finds instructions only in comments', () => {
		const source = [
			'// Replace <domain> before deployment.',
			'const message = "Replace <domain> before deployment."',
			'/* Configure the production domain. */'
		].join('\n')
		expect(setupNarrationFindings('sample.ts', source)).toEqual([
			'sample.ts:1 // Replace <domain> before deployment.',
			'sample.ts:3 /* Configure the production domain. */'
		])
	})

	test('generated gateway source and config comments contain no setup narration', () => {
		const findings = generatedCloudflareGateway()
			.filter(({ path }) => /\.(?:[cm]?[jt]sx?|jsonc)$/.test(path))
			.flatMap(({ path, content }) => setupNarrationFindings(path, content))
		expect(findings).toEqual([])
	})

	test('deployment comment detector rejects consecutive explanations', () => {
		expect(
			deploymentCommentRunFindings(
				'sample.ts',
				[
					'# one concise constraint',
					'name: sample',
					'# first explanation',
					'# second explanation',
					'/* first block line',
					' * second block line */'
				].join('\n')
			)
		).toEqual([
			'sample.ts:5 multi-line block comment',
			'sample.ts:3 consecutive explanatory comments'
		])
		expect(
			deploymentCommentRunFindings(
				'.env.example',
				['# first environment explanation', '# second environment explanation', 'VALUE=1'].join(
					'\n'
				)
			)
		).toEqual(['.env.example:1 consecutive explanatory comments'])
	})

	test('Hono root environment examples reject label-only comments', () => {
		expect(
			environmentCommentFindings(
				'.env.example',
				['# Production gateway', 'API_PUBLIC_ORIGIN=https://api.example.com'].join('\n')
			)
		).toEqual(['.env.example:1 # Production gateway'])
		expect(
			environmentCommentFindings(
				'.env.example',
				[
					'# SQLite (one root-relative database shared by local services)',
					'SQLITE_PATH=file:./.data/local.db'
				].join('\n')
			)
		).toEqual([])
		const findings = generatedHonoRootEnvironmentExamples().flatMap(({ path, content }) => [
			...deploymentCommentRunFindings(path, content),
			...environmentCommentFindings(path, content)
		])
		expect(findings).toEqual([])
	})

	test('gateway and integrated deployment artifacts keep comments concise', () => {
		const findings = generatedDeploymentArtifacts().flatMap(({ path, content }) =>
			deploymentCommentRunFindings(path, content)
		)
		expect(findings).toEqual([])
	})
})
