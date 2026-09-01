import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import ts from 'typescript'
import { generateGateway } from '../../src/generators/gateway.js'
import { parseJsonc } from '../../src/lib/jsonc.js'
import { GvKitConfig } from '../../src/schema/config.js'

const repositoryRoot = join(import.meta.dir, '..', '..')
const gatewayGeneratorPath = join(repositoryRoot, 'src/generators/gateway.ts')
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

function stringRendererNames(source: string): string[] {
	const sourceFile = ts.createSourceFile(
		gatewayGeneratorPath,
		source,
		ts.ScriptTarget.Latest,
		true,
		ts.ScriptKind.TS
	)
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
		if (
			kind !== ts.SyntaxKind.SingleLineCommentTrivia &&
			kind !== ts.SyntaxKind.MultiLineCommentTrivia
		) continue
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
			if (
				ts.isCallExpression(node) &&
				ts.isPropertyAccessExpression(node.expression) &&
				node.expression.expression.getText(sourceFile) === 'Bun' &&
				node.expression.name.text === 'spawn'
			) {
				subprocessCommands.push(node.arguments[0]?.getText(sourceFile) ?? '')
			}
			ts.forEachChild(node, visit)
		}
		visit(sourceFile)
		expect(subprocessCommands).toEqual(["['sh', '-n']"])
	})

	test('gateway string renderers use outcome-oriented render names', () => {
		const source = readFileSync(gatewayGeneratorPath, 'utf8')
		expect(stringRendererNames(source)).toEqual(expectedGatewayRenderers)
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
})
