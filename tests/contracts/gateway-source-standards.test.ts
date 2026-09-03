import { readFileSync } from 'node:fs'
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
const gatewayGeneratorPath = join(repositoryRoot, 'src/generators/gateway.ts')
const integratedDeployGeneratorPath = join(repositoryRoot, 'src/generators/integrated-deploy.ts')
const previewWorkflowTestPath = join(repositoryRoot, 'tests/contracts/gateway-preview-workflows.test.ts')
const expectedGatewayRenderers = [
	'renderGatewayPackageJson',
	'renderGatewayTsconfig',
	'renderGatewayAppSource',
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

function environmentSetupNarrationFindings(path: string, source: string): string[] {
	return source.split('\n').flatMap((line, index) => {
		const comment = line.trimStart()
		if (!comment.startsWith('#') || !/\b(?:copy|fill|replace|configure|set[ -]?up)\b/i.test(comment)) return []
		return [`${path}:${index + 1} ${comment}`]
	})
}

function generatedRootEnvironmentExamples() {
	const configs = [
		{ label: 'gateway-cloudflare', choices: deploymentChoices },
		{
			label: 'gateway-docker',
			choices: { ...deploymentChoices, deploy: 'docker' as const }
		}
	]
	return configs.flatMap(({ label, choices }) =>
		generateRoot({ configVersion: 2, choices })
			.filter(({ path }) => path.startsWith('.env'))
			.map(({ path, content }) => ({ path: `${label}:${path}`, content }))
	)
}

describe('gateway source standards', () => {
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

	test('deployment-related root environment examples keep comments concise', () => {
		expect(
			environmentSetupNarrationFindings('.env.example', '# Copy to .env and fill required values.')
		).toEqual(['.env.example:1 # Copy to .env and fill required values.'])
		const findings = generatedRootEnvironmentExamples().flatMap(({ path, content }) => [
			...deploymentCommentRunFindings(path, content),
			...environmentSetupNarrationFindings(path, content)
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
