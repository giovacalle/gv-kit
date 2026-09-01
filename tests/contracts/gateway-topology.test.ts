import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { Hono, type MiddlewareHandler } from 'hono'
import ts from 'typescript'
import { runGenerators } from '../../src/generators/index.js'
import { parseJsonc } from '../../src/lib/jsonc.js'
import { GvKitConfig } from '../../src/schema/config.js'

const fixturesDir = join(import.meta.dir, '..', '..', 'fixtures')
const canonicalHonoQuickstart = `### First run

\`\`\`bash
pnpm install
cp .env.example .env
# Fill the required values in .env.
pnpm local:prepare
pnpm dev
\`\`\`

### Subsequent runs

\`\`\`bash
pnpm dev
\`\`\``

function planFixture(name: string) {
	const raw = parseJsonc(readFileSync(join(fixturesDir, `${name}.jsonc`), 'utf8'))
	return runGenerators(GvKitConfig.parse(raw))
}

const gatewayOwnedSourcePaths = [
	'fixtures/templates/web/overlays/api-client-hey-api/src/routes/users/+page.server.ts',
	'fixtures/templates/web/overlays/inside-frontend-baseline/src/app.d.ts',
	'scripts/gateway-verification-evidence.ts',
	'scripts/verify-gateway-cloudflare.ts',
	'scripts/verify-gateway-docker.ts',
	'scripts/verify-gateway-local.ts',
	'scripts/verify-gateway-preview-security.ts',
	'scripts/verify-gateway-scaffold-matrix.ts',
	'src/generators/api.ts',
	'src/generators/backend.ts',
	'src/generators/cloudflare-worker-types.ts',
	'src/generators/deploy.ts',
	'src/generators/email.ts',
	'src/generators/gateway.ts',
	'src/generators/hono-topology.ts',
	'src/generators/integrated-deploy.ts',
	'src/generators/openapi-contract.ts',
	'src/generators/services/users.ts',
	'src/lib/workers.ts',
	'tests/contracts/gateway-auth.test.ts',
	'tests/contracts/gateway-cloudflare.test.ts',
	'tests/contracts/gateway-docker.test.ts',
	'tests/contracts/gateway-openapi.test.ts',
	'tests/contracts/gateway-preview-workflows.test.ts',
	'tests/contracts/gateway-rollout-compatibility.test.ts',
	'tests/contracts/gateway-scaffold-matrix.test.ts',
	'tests/contracts/gateway-source-standards.test.ts',
	'tests/contracts/gateway-streaming.test.ts',
	'tests/contracts/gateway-topology.test.ts',
	'tests/contracts/users-bindings.test.ts',
	'tests/generators/gateway.test.ts',
	'tests/generators/hono-topology.test.ts'
]

const gatewayEffortSourcePaths = [
	'fixtures/templates/web/base/src/app.d.ts',
	'fixtures/templates/web/base/src/hooks.server.ts',
	'fixtures/templates/web/base/vite.config.ts',
	'fixtures/templates/web/overlays/api-client-hey-api/src/routes/+layout.ts',
	'fixtures/templates/web/overlays/api-client-hey-api/src/routes/users/+page.server.ts',
	'fixtures/templates/web/overlays/auth/src/lib/auth/client.ts',
	'fixtures/templates/web/overlays/auth/src/lib/server/load-session.ts',
	'fixtures/templates/web/overlays/inside-frontend-baseline/src/app.d.ts',
	'scripts/gateway-verification-evidence.ts',
	'scripts/verify-gateway-cloudflare.ts',
	'scripts/verify-gateway-docker.ts',
	'scripts/verify-gateway-local.ts',
	'scripts/verify-gateway-preview-security.ts',
	'scripts/verify-gateway-scaffold-matrix.ts',
	'src/generators/ai-tooling-claude.ts',
	'src/generators/ai-tooling-codex.ts',
	'src/generators/ai-tooling-rules.ts',
	'src/generators/api.ts',
	'src/generators/backend.ts',
	'src/generators/cloudflare-worker-types.ts',
	'src/generators/db.ts',
	'src/generators/deploy.ts',
	'src/generators/email.ts',
	'src/generators/frontend-sveltekit.ts',
	'src/generators/gateway.ts',
	'src/generators/hono-topology.ts',
	'src/generators/i18n.ts',
	'src/generators/integrated-deploy.ts',
	'src/generators/marketing-astro.ts',
	'src/generators/openapi-client.ts',
	'src/generators/openapi-contract.ts',
	'src/generators/root.ts',
	'src/generators/services/auth.ts',
	'src/generators/services/users.ts',
	'src/lib/workers.ts',
	'tests/contracts/astro-scaffold-matrix.test.ts',
	'tests/contracts/auth-bindings.test.ts',
	'tests/contracts/ci-workflow.test.ts',
	'tests/contracts/deploy-compose-yaml.test.ts',
	'tests/contracts/gateway-auth.test.ts',
	'tests/contracts/gateway-cloudflare.test.ts',
	'tests/contracts/gateway-docker.test.ts',
	'tests/contracts/gateway-openapi.test.ts',
	'tests/contracts/gateway-preview-workflows.test.ts',
	'tests/contracts/gateway-rollout-compatibility.test.ts',
	'tests/contracts/gateway-scaffold-matrix.test.ts',
	'tests/contracts/gateway-source-standards.test.ts',
	'tests/contracts/gateway-streaming.test.ts',
	'tests/contracts/gateway-topology.test.ts',
	'tests/contracts/inside-frontend-bindings.test.ts',
	'tests/contracts/topology-routes.test.ts',
	'tests/contracts/users-bindings.test.ts',
	'tests/generators/ai-tooling.test.ts',
	'tests/generators/deploy.test.ts',
	'tests/generators/frontend-sveltekit.test.ts',
	'tests/generators/gateway.test.ts',
	'tests/generators/hono-topology.test.ts',
	'tests/generators/openapi-client.test.ts',
	'tests/generators/root.test.ts',
	'tests/pipeline.test.ts',
	'tests/schema.test.ts'
]

function inlineControlBodyFindings(path: string, source: string): string[] {
	const sourceFile = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true)
	const findings: string[] = []

	function recordBody({
		body,
		control,
		headerEnd
	}: {
		body: ts.Statement
		control: string
		headerEnd: number
	}) {
		if (ts.isBlock(body)) {
			if (body.statements.length !== 1) return
			const statement = body.statements[0]!
			const start = sourceFile.getLineAndCharacterOfPosition(statement.getStart(sourceFile))
			const end = sourceFile.getLineAndCharacterOfPosition(statement.getEnd())
			if (start.line !== end.line) return
			const { line } = sourceFile.getLineAndCharacterOfPosition(body.getStart(sourceFile))
			findings.push(`${path}:${line + 1} (${control}, braced)`)
			return
		}

		const header = sourceFile.getLineAndCharacterOfPosition(headerEnd)
		const start = sourceFile.getLineAndCharacterOfPosition(body.getStart(sourceFile))
		const end = sourceFile.getLineAndCharacterOfPosition(body.getEnd())
		if (header.line !== start.line) findings.push(`${path}:${start.line + 1} (${control}, split)`)
		if (start.line !== end.line && !(control === 'else' && ts.isIfStatement(body))) findings.push(`${path}:${start.line + 1} (${control}, unbraced multi-line)`)
	}

	function visit(node: ts.Node) {
		if (ts.isIfStatement(node)) {
			recordBody({ body: node.thenStatement, control: 'if', headerEnd: node.expression.getEnd() })
			if (node.elseStatement) {
				const elseKeyword = node
					.getChildren(sourceFile)
					.find((child) => child.kind === ts.SyntaxKind.ElseKeyword)
				recordBody({
					body: node.elseStatement,
					control: 'else',
					headerEnd: elseKeyword?.getEnd() ?? node.thenStatement.getEnd()
				})
			}
		} else if (
			ts.isForStatement(node) ||
			ts.isForInStatement(node) ||
			ts.isForOfStatement(node) ||
			ts.isWhileStatement(node)
		) {
			const control = ts.isForStatement(node)
				? 'for'
				: ts.isForInStatement(node)
					? 'for-in'
					: ts.isForOfStatement(node)
						? 'for-of'
						: 'while'
			const closeParen = node
				.getChildren(sourceFile)
				.find((child) => child.kind === ts.SyntaxKind.CloseParenToken)
			recordBody({
				body: node.statement,
				control,
				headerEnd: closeParen?.getEnd() ?? node.statement.getStart(sourceFile)
			})
		} else if (ts.isDoStatement(node)) {
			const doKeyword = node
				.getChildren(sourceFile)
				.find((child) => child.kind === ts.SyntaxKind.DoKeyword)
			recordBody({
				body: node.statement,
				control: 'do',
				headerEnd: doKeyword?.getEnd() ?? node.getStart(sourceFile)
			})
		}
		ts.forEachChild(node, visit)
	}

	visit(sourceFile)
	return findings
}

function positionalParameterFindings(path: string, source: string): string[] {
	const sourceFile = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true)
	const findings: string[] = []

	function hasHelperBinding(node: ts.FunctionLikeDeclaration): boolean {
		if (
			ts.isFunctionDeclaration(node) ||
			ts.isMethodDeclaration(node) ||
			ts.isConstructorDeclaration(node) ||
			ts.isGetAccessorDeclaration(node) ||
			ts.isSetAccessorDeclaration(node)) return true
		if (!ts.isArrowFunction(node) && !ts.isFunctionExpression(node)) return false

		let binding: ts.Node = node
		let parent = binding.parent
		while (
			ts.isParenthesizedExpression(parent) ||
			ts.isAsExpression(parent) ||
			ts.isTypeAssertionExpression(parent) ||
			ts.isSatisfiesExpression(parent) ||
			ts.isNonNullExpression(parent)
		) {
			binding = parent
			parent = binding.parent
		}

		if (
			ts.isVariableDeclaration(parent) ||
			ts.isPropertyAssignment(parent) ||
			ts.isPropertyDeclaration(parent) ||
			ts.isExportAssignment(parent)) return true

		return (
			ts.isBinaryExpression(parent) &&
			parent.right === binding &&
			parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
			parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment
		)
	}

	function visit(node: ts.Node) {
		if (
			ts.isFunctionDeclaration(node) ||
			ts.isMethodDeclaration(node) ||
			ts.isArrowFunction(node) ||
			ts.isFunctionExpression(node) ||
			ts.isConstructorDeclaration(node) ||
			ts.isGetAccessorDeclaration(node) ||
			ts.isSetAccessorDeclaration(node)
		) {
			const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
			const restParameter = node.parameters.find((parameter) => parameter.dotDotDotToken)
			if (hasHelperBinding(node) && restParameter) findings.push(`${path}:${line + 1} rest parameter`)
			else if (node.parameters.length >= 3) findings.push(`${path}:${line + 1} ${node.parameters.length} positional parameters`)
		}
		ts.forEachChild(node, visit)
	}

	visit(sourceFile)
	return findings
}

function genericVerifierHelperNameFindings(path: string, source: string): string[] {
	if (!/^scripts\/verify-.*\.ts$/.test(path)) return []

	const sourceFile = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true)
	const findings: string[] = []

	function visit(node: ts.Node) {
		const isGenericFunctionDeclaration =
			ts.isFunctionDeclaration(node) && node.name?.text === 'run'
		const isGenericMethod = ts.isMethodDeclaration(node) && node.name.getText(sourceFile) === 'run'
		const isGenericVariable =
			ts.isVariableDeclaration(node) &&
			ts.isIdentifier(node.name) &&
			node.name.text === 'run' &&
			(node.initializer === undefined ||
				ts.isArrowFunction(node.initializer) ||
				ts.isFunctionExpression(node.initializer))
		if (isGenericFunctionDeclaration || isGenericMethod || isGenericVariable) {
			const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
			findings.push(`${path}:${line + 1} generic verifier helper name run`)
		}
		ts.forEachChild(node, visit)
	}

	visit(sourceFile)
	return findings
}

function dynamicSourceParameterFindings(path: string, source: string): string[] {
	const sourceFile = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true)
	const findings: string[] = []

	function visit(node: ts.Node) {
		if (ts.isNewExpression(node) && node.arguments) {
			const declaredParameters = node.arguments.slice(0, -1)
			if (
				declaredParameters.length >= 3 &&
				declaredParameters.every((argument) => ts.isStringLiteralLike(argument))
			) {
				const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
				findings.push(
					`${path}:${line + 1} ${declaredParameters.length} dynamic positional parameters`
				)
			}
		}
		ts.forEachChild(node, visit)
	}

	visit(sourceFile)
	return findings
}

function generatedGatewaySources({
	includeSharedBackendAndCloudflareTypes = false,
	includeAuthSchemaAndCleanup = false
}: {
	includeSharedBackendAndCloudflareTypes?: boolean
	includeAuthSchemaAndCleanup?: boolean
} = {}): Array<{
	path: string
	content: string
}> {
	const sources = new Map<string, { path: string; content: string }>()
	for (const name of readdirSync(fixturesDir).filter((candidate) => candidate.endsWith('.jsonc'))) {
		const fixture = name.slice(0, -'.jsonc'.length)
		const raw = parseJsonc(readFileSync(join(fixturesDir, name), 'utf8'))
		const config = GvKitConfig.parse(raw)
		if (config.choices.backend !== 'hono') continue

		for (const generated of runGenerators(config)) {
			const isTypeScriptOrJavaScript = /\.[cm]?[jt]sx?$/.test(generated.path)
			const isGatewayOrService =
				generated.path.startsWith('apps/api/') || generated.path.startsWith('services/')
			const isPreviewTool =
				generated.path.startsWith('scripts/') && generated.path.includes('cloudflare-preview')
			const isSharedBackend = generated.path.startsWith('packages/backend/')
			const isCloudflareType = generated.path.endsWith('worker-configuration.bootstrap.d.ts')
			const isAuthSchema = generated.path === 'packages/db/src/schema/auth.ts'
			const isCleanupScript =
				generated.path === 'scripts/cleanup-cloudflare-preview-workers.sh'
			const isSupportedSource =
				isTypeScriptOrJavaScript || (includeAuthSchemaAndCleanup && isCleanupScript)
			const isIncluded =
				isGatewayOrService ||
				isPreviewTool ||
				(includeSharedBackendAndCloudflareTypes && (isSharedBackend || isCloudflareType)) ||
				(includeAuthSchemaAndCleanup && (isAuthSchema || isCleanupScript))
			if (!isSupportedSource || !isIncluded) continue

			const key = `${generated.path}\0${generated.content}`
			if (!sources.has(key)) {
				sources.set(key, {
					path: `${fixture}:${generated.path}`,
					content: generated.content
				})
			}
		}
	}
	return [...sources.values()]
}

function isProtectedComment(comment: string): boolean {
	return (
		/^\/\*\s*@gvkit:/.test(comment) ||
		/^\/\/\/\s*<reference\b/.test(comment) ||
		/\b(?:eslint|prettier|svelte|@ts-|c8|istanbul)[- :]/i.test(comment) ||
		/\b(?:SPDX-License-Identifier|Copyright|@license)\b/i.test(comment) ||
		/\b(?:auto-?generated|generated file|generated by|do not edit)\b/i.test(comment)
	)
}

function sourceStandardFindings(path: string, source: string): string[] {
	const sourceFile = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true)
	const findings = [
		...positionalParameterFindings(path, source),
		...genericVerifierHelperNameFindings(path, source)
	]
	const literalRanges: Array<{ start: number; end: number }> = []

	function visit(node: ts.Node) {
		const isLiteral =
			ts.isStringLiteralLike(node) ||
			ts.isRegularExpressionLiteral(node) ||
			node.kind === ts.SyntaxKind.TemplateHead ||
			node.kind === ts.SyntaxKind.TemplateMiddle ||
			node.kind === ts.SyntaxKind.TemplateTail ||
			node.kind === ts.SyntaxKind.JsxText
		if (isLiteral) literalRanges.push({ start: node.getStart(sourceFile), end: node.getEnd() })
		ts.forEachChild(node, visit)
	}

	visit(sourceFile)
	literalRanges.sort((left, right) => left.start - right.start)

	const commentRanges: Array<{
		kind: ts.SyntaxKind.SingleLineCommentTrivia | ts.SyntaxKind.MultiLineCommentTrivia
		pos: number
		end: number
	}> = []
	let literalIndex = 0
	for (let position = 0; position < source.length; ) {
		let literal = literalRanges[literalIndex]
		while (literal && literal.end <= position) {
			literalIndex += 1
			literal = literalRanges[literalIndex]
		}
		if (literal && position >= literal.start && position < literal.end) {
			position = literal.end
			continue
		}

		if (source.startsWith('//', position)) {
			const lineEnd = source.indexOf('\n', position + 2)
			const end = lineEnd === -1 ? source.length : lineEnd
			commentRanges.push({ kind: ts.SyntaxKind.SingleLineCommentTrivia, pos: position, end })
			position = end
			continue
		}
		if (source.startsWith('/*', position)) {
			const closingDelimiter = source.indexOf('*/', position + 2)
			const end = closingDelimiter === -1 ? source.length : closingDelimiter + 2
			commentRanges.push({ kind: ts.SyntaxKind.MultiLineCommentTrivia, pos: position, end })
			position = end
			continue
		}
		position += 1
	}

	let previousExplanatoryLine: { line: number; end: number } | undefined
	let lineCommentGroupStart: number | undefined
	for (const range of commentRanges) {
		const comment = source.slice(range.pos, range.end)
		const { line } = sourceFile.getLineAndCharacterOfPosition(range.pos)
		if (range.kind === ts.SyntaxKind.MultiLineCommentTrivia) {
			if (!isProtectedComment(comment)) findings.push(`${path}:${line + 1} block comment`)
			previousExplanatoryLine = undefined
			lineCommentGroupStart = undefined
			continue
		}

		const lineStart = sourceFile.getPositionOfLineAndCharacter(line, 0)
		const isExplanatory =
			source.slice(lineStart, range.pos).trim() === '' && !isProtectedComment(comment)
		const followsPrevious =
			previousExplanatoryLine?.line === line - 1 &&
			/^\s*$/.test(source.slice(previousExplanatoryLine.end, range.pos))
		if (isExplanatory && followsPrevious && previousExplanatoryLine) {
			if (lineCommentGroupStart === undefined) {
				lineCommentGroupStart = previousExplanatoryLine.line
				findings.push(`${path}:${lineCommentGroupStart + 1} consecutive line comments`)
			}
		} else lineCommentGroupStart = undefined
		previousExplanatoryLine = isExplanatory ? { line, end: range.end } : undefined
	}

	return findings
}

function generatedShellCommentFindings(path: string, source: string): string[] {
	const explanatoryLines = source
		.split('\n')
		.map((line, index) => ({ line: index, text: line.trimStart() }))
		.filter(({ text }) => text.startsWith('#') && !text.startsWith('#!'))
	if (explanatoryLines.length <= 1) return []
	return [`${path}:${explanatoryLines[0]!.line + 1} multiple explanatory line comments`]
}

function generatedCommentFindings(path: string, source: string): string[] {
	if (path.endsWith('.sh')) return generatedShellCommentFindings(path, source)

	const sourceFile = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true)
	const literalRanges: Array<{ start: number; end: number }> = []
	const findings: string[] = []

	function visit(node: ts.Node) {
		if (
			ts.isStringLiteralLike(node) ||
			ts.isRegularExpressionLiteral(node) ||
			node.kind === ts.SyntaxKind.TemplateHead ||
			node.kind === ts.SyntaxKind.TemplateMiddle ||
			node.kind === ts.SyntaxKind.TemplateTail ||
			node.kind === ts.SyntaxKind.JsxText
		) {
			literalRanges.push({
				start: node.getStart(sourceFile),
				end: node.getEnd()
			})
		}
		ts.forEachChild(node, visit)
	}

	visit(sourceFile)

	const scanner = ts.createScanner(
		ts.ScriptTarget.Latest,
		false,
		ts.LanguageVariant.Standard,
		source
	)
	let previousExplanatoryLine: number | undefined
	let lineCommentGroupStart: number | undefined
	for (let kind = scanner.scan(); kind !== ts.SyntaxKind.EndOfFileToken; kind = scanner.scan()) {
		const start = scanner.getTokenPos()
		if (literalRanges.some((range) => start >= range.start && start < range.end)) continue
		if (kind === ts.SyntaxKind.MultiLineCommentTrivia) {
			if (!isProtectedComment(scanner.getTokenText())) {
				const { line } = sourceFile.getLineAndCharacterOfPosition(start)
				findings.push(`${path}:${line + 1} block comment`)
			}
			previousExplanatoryLine = undefined
			lineCommentGroupStart = undefined
			continue
		}
		if (kind === ts.SyntaxKind.SingleLineCommentTrivia) {
			const { line } = sourceFile.getLineAndCharacterOfPosition(start)
			const lineStart = sourceFile.getPositionOfLineAndCharacter(line, 0)
			const isLineLeading = source.slice(lineStart, start).trim() === ''
			const isExplanatory = isLineLeading && !isProtectedComment(scanner.getTokenText())
			if (isExplanatory && previousExplanatoryLine === line - 1) {
				if (lineCommentGroupStart === undefined) {
					lineCommentGroupStart = line - 1
					findings.push(`${path}:${lineCommentGroupStart + 1} consecutive line comments`)
				}
			} else lineCommentGroupStart = undefined
			previousExplanatoryLine = isExplanatory ? line : undefined
			continue
		}
		if (kind === ts.SyntaxKind.WhitespaceTrivia || kind === ts.SyntaxKind.NewLineTrivia) continue
		previousExplanatoryLine = undefined
		lineCommentGroupStart = undefined
	}

	return findings
}

type GatewayTarget = { fetch(request: Request): Promise<Response> }
type GatewayOptions = {
	openApiDocument: {
		openapi: string
		info: Record<string, unknown>
		paths: Record<string, unknown>
	}
	canonicalApiOrigin: string
	publicOrigins?: string
	corsOrigins?: string
	logger?: (line: string) => void
	upstreamTimeoutMs?: number
}

type GatewayModule = {
	createGateway(
		targets: { AUTH?: GatewayTarget; USERS?: GatewayTarget },
		options?: GatewayOptions
	): {
		fetch(request: Request): Promise<Response>
	}
}

type HandleFetchModule = {
	handleFetch(input: {
		event: { url: URL; platform?: { env: { GATEWAY?: GatewayTarget } } }
		request: Request
		fetch(request: Request): Promise<Response>
	}): Promise<Response>
}

async function loadGeneratedGateway(): Promise<GatewayModule> {
	const app = planFixture('hono-skip-deploy').find((entry) => entry.path === 'apps/api/src/app.ts')
	if (!app) throw new Error('generated gateway app is missing')

	const honoUrl = import.meta.resolve('hono')
	const source = app.content.replace("from 'hono'", `from '${honoUrl}'`)
	const transpiler = new Bun.Transpiler({ loader: 'ts', target: 'bun' })
	const javascript = transpiler.transformSync(source)
	const moduleUrl = URL.createObjectURL(new Blob([javascript], { type: 'text/javascript' }))
	const module = (await import(moduleUrl)) as GatewayModule
	URL.revokeObjectURL(moduleUrl)
	return module
}

async function loadGeneratedServiceLogger(): Promise<{
	logger(service: string, writeLog?: (line: string) => void): MiddlewareHandler
}> {
	const entry = planFixture('hono-skip-deploy').find(
		(candidate) => candidate.path === 'packages/backend/src/middleware/logger.ts'
	)
	if (!entry) throw new Error('generated service logger is missing')

	const transpiler = new Bun.Transpiler({ loader: 'ts', target: 'bun' })
	const javascript = transpiler.transformSync(entry.content)
	const moduleUrl = URL.createObjectURL(new Blob([javascript], { type: 'text/javascript' }))
	const module = (await import(moduleUrl)) as {
		logger(service: string, writeLog?: (line: string) => void): MiddlewareHandler
	}
	URL.revokeObjectURL(moduleUrl)
	return module
}

async function loadGeneratedHandleFetch(): Promise<HandleFetchModule> {
	const hooks = planFixture('hono-skip-deploy').find(
		(entry) => entry.path === 'apps/web/src/hooks.server.ts'
	)
	if (!hooks) throw new Error('generated web server hooks are missing')

	const source = hooks.content
		.replace(
			"import { env } from '$env/dynamic/private'",
			"const env = { GATEWAY_URL: 'http://gateway.test' }"
		)
		.replace(
			"import { sequence } from '@sveltejs/kit/hooks'",
			'const sequence = (...handlers: unknown[]) => handlers'
		)
	const transpiler = new Bun.Transpiler({ loader: 'ts', target: 'bun' })
	const javascript = transpiler.transformSync(source)
	const moduleUrl = URL.createObjectURL(new Blob([javascript], { type: 'text/javascript' }))
	const module = (await import(moduleUrl)) as HandleFetchModule
	URL.revokeObjectURL(moduleUrl)
	return module
}

describe('local private-service gateway topology', () => {
	test('source standards detect comments inside comment-only blocks', () => {
		const source = [
			'function positional(first: string, second: string, third: string) {}',
			'function variadic(...values: string[]) {}',
			`const literals = ['// text', '/* text */', /\\/\\//]`,
			'const template = `// text ${input} /* text */`',
			'try {',
			'} catch {',
			'\t// first line',
			'\t// second line',
			'\t/* block */',
			'}',
			'/* eslint-disable -- required tool control */',
			'/// <reference types="required-tool" />'
		].join('\n')
		expect(sourceStandardFindings('sample.ts', source)).toEqual([
			'sample.ts:1 3 positional parameters',
			'sample.ts:2 rest parameter',
			'sample.ts:7 consecutive line comments',
			'sample.ts:9 block comment'
		])
		expect(
			dynamicSourceParameterFindings(
				'sample.ts',
				"new AsyncFunction('filesystem', 'path', 'process', source)"
			)
		).toEqual(['sample.ts:1 3 dynamic positional parameters'])
		expect(
			genericVerifierHelperNameFindings(
				'scripts/verify-sample.ts',
				'async function run() {}'
			)
		).toEqual(['scripts/verify-sample.ts:1 generic verifier helper name run'])
	})

	test('source standards reject bound rest helpers without rejecting API callbacks', () => {
		const source = [
			'function declared(...values: string[]) {}',
			'const variable = (...values: string[]) => values',
			'const helpers = {',
			'\tcomposeArgs: (...values: string[]) => values,',
			'\tpnpmArgs: function (...values: string[]) { return values },',
			'\tcommand(...values: string[]) { return values }',
			'}',
			'let assigned',
			'assigned = (...values: string[]) => values',
			'assigned ??= function (...values: string[]) { return values }',
			'class Registry {',
			'\tconstructor(...values: string[]) {}',
			'\tcomposeArgs = (...values: string[]) => values',
			'}',
			'export default (...values: string[]) => values',
			'consume(((...values: string[]) => values))',
			'consume((function (...values: string[]) { return values }))'
		].join('\n')

		expect(positionalParameterFindings('sample.ts', source)).toEqual([
			'sample.ts:1 rest parameter',
			'sample.ts:2 rest parameter',
			'sample.ts:4 rest parameter',
			'sample.ts:5 rest parameter',
			'sample.ts:6 rest parameter',
			'sample.ts:9 rest parameter',
			'sample.ts:10 rest parameter',
			'sample.ts:12 rest parameter',
			'sample.ts:13 rest parameter',
			'sample.ts:15 rest parameter'
		])
	})

	test('control-body standard detects invalid single-statement layout without parsing text', () => {
		const source = [
			"const template = `<!--@gvkit:if auth-->if (directive) { return 'template' }<!--@gvkit:endif-->`",
			"const object = { if: 'property', body: { return: 'value' } }",
			'if (ready) {',
			'\treturn object',
			'} else {',
			'\tconsume(object)',
			'}',
			'for (let index = 0; index < 1; index++) {',
			'\tconsume(index)',
			'}',
			'for (const key in object) {',
			'\tconsume(key)',
			'}',
			'for (const value of values) {',
			'\tconsume(value)',
			'}',
			'while (ready) {',
			'\tready = false',
			'}',
			'do {',
			'\tready = false',
			'} while (ready)',
			'if (ready) {',
			'\treturn consume(',
			'\t\tobject',
			'\t)',
			'}',
			'if (split)',
			'\treturn object',
			'if (multiline) return consume(',
			'\tobject',
			')',
			'if (first) return first',
			'else if (second) return second'
		].join('\n')

		expect(inlineControlBodyFindings('sample.ts', source)).toEqual([
			'sample.ts:3 (if, braced)',
			'sample.ts:5 (else, braced)',
			'sample.ts:8 (for, braced)',
			'sample.ts:11 (for-in, braced)',
			'sample.ts:14 (for-of, braced)',
			'sample.ts:17 (while, braced)',
			'sample.ts:20 (do, braced)',
			'sample.ts:29 (if, split)',
			'sample.ts:30 (if, unbraced multi-line)'
		])
	})

	test('gateway-owned source uses named options and no multi-line comments', () => {
		const findings = gatewayOwnedSourcePaths.flatMap((path) =>
			sourceStandardFindings(path, readFileSync(join(fixturesDir, '..', path), 'utf8'))
		)
		expect(findings).toEqual([])
	})

	test('gateway effort source uses named options and outcome-oriented verifier names', () => {
		const findings = gatewayEffortSourcePaths.flatMap((path) => {
			const source = readFileSync(join(fixturesDir, '..', path), 'utf8')
			return [
				...positionalParameterFindings(path, source),
				...genericVerifierHelperNameFindings(path, source)
			]
		})
		expect(findings).toEqual([])
	})

	test('generated gateway, preview, service, and dynamic source use named options', () => {
		const emittedFindings = generatedGatewaySources().flatMap(({ path, content }) =>
			positionalParameterFindings(path, content)
		)
		const previewTestPath = 'tests/contracts/gateway-preview-workflows.test.ts'
		const dynamicFindings = dynamicSourceParameterFindings(
			previewTestPath,
			readFileSync(join(fixturesDir, '..', previewTestPath), 'utf8')
		)
		expect([...emittedFindings, ...dynamicFindings]).toEqual([])
	})

	test('generated comment standard rejects explanatory blocks and consecutive lines', () => {
		const source = [
			"const literal = `// first\\n// second`",
			'/* explanatory block */',
			'// first explanation',
			'// second explanation',
			'/* eslint-disable -- generated declarations need broad ambient types */',
			'/// <reference types="@cloudflare/workers-types" />',
			'/*@gvkit:if feature*/',
			'/*! Copyright Example. SPDX-License-Identifier: MIT */',
			'// Generated by a required tool. Do not edit.',
			'// This one-line comment records a non-obvious constraint.'
		].join('\n')

		expect(generatedCommentFindings('sample.ts', source)).toEqual([
			'sample.ts:2 block comment',
			'sample.ts:3 consecutive line comments'
		])
		expect(
			generatedCommentFindings(
				'sample.sh',
				['#!/bin/sh', '# first explanation', '', '# second explanation', 'echo done'].join('\n')
			)
		).toEqual(['sample.sh:2 multiple explanatory line comments'])
	})

	test('generated gateway, service, schema, preview, cleanup, and Cloudflare type comments stay concise', () => {
		const findings = generatedGatewaySources({
			includeSharedBackendAndCloudflareTypes: true,
			includeAuthSchemaAndCleanup: true
		}).flatMap(({ path, content }) => generatedCommentFindings(path, content))
		expect(findings).toEqual([])
	})

	test('gateway-owned source and emitted code use inline single-statement control bodies', () => {
		const sourceFindings = gatewayEffortSourcePaths.flatMap((path) =>
			inlineControlBodyFindings(
				path,
				readFileSync(join(fixturesDir, '..', path), 'utf8')
			)
		)
		const emittedFindings = readdirSync(fixturesDir)
			.filter((name) => name.endsWith('.jsonc'))
			.flatMap((name) => {
				const fixture = name.slice(0, -'.jsonc'.length)
				const raw = parseJsonc(readFileSync(join(fixturesDir, name), 'utf8'))
				const config = GvKitConfig.parse(raw)
				if (config.choices.backend !== 'hono') return []

				return runGenerators(config)
					.filter(
						({ path }) =>
							(path.startsWith('apps/api/') ||
								path.startsWith('services/') ||
								path.startsWith('packages/backend/') ||
								path === 'apps/web/src/hooks.server.ts' ||
								path === 'apps/web/vite.config.ts' ||
								(path.startsWith('scripts/') && path.includes('cloudflare-preview'))) &&
							/\.[cm]?[jt]sx?$/.test(path)
					)
					.flatMap(({ path, content }) =>
						inlineControlBodyFindings(`${fixture}:${path}`, content)
					)
			})

		expect([...sourceFindings, ...emittedFindings]).toEqual([])
	})

	test('every Hono plan emits a gateway and private service packages', () => {
		for (const fixture of ['hono-skip-deploy', 'hono-docker-full', 'hono-cf-workers-full']) {
			const entries = planFixture(fixture)
			const paths = entries.map((entry) => entry.path)

			expect(paths).toContain('apps/api/package.json')
			expect(paths).toContain('apps/api/src/app.ts')
			expect(paths).toContain('services/auth/package.json')
			expect(paths).toContain('services/users/package.json')
			expect(paths.some((path) => path.startsWith('apps/api/auth/'))).toBe(false)
			expect(paths.some((path) => path.startsWith('apps/api/users/'))).toBe(false)
		}
	})

	test('the gateway forwards the original request and returns the upstream response', async () => {
		const { createGateway } = await loadGeneratedGateway()
		let forwarded: Request | undefined
		let releaseSecondChunk: () => void = () => undefined
		const secondChunk = new Promise<void>((resolve) => (releaseSecondChunk = resolve))
		const streamedBody = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new TextEncoder().encode('streamed '))
				void secondChunk.then(() => {
					controller.enqueue(new TextEncoder().encode('response'))
					controller.close()
				})
			}
		})
		const upstream = new Response(streamedBody, {
			status: 207,
			headers: [
				['content-type', 'text/plain'],
				['set-cookie', 'first=1; Path=/'],
				['set-cookie', 'second=2; Path=/'],
				['x-request-id', 'request-123']
			]
		})
		const gateway = createGateway(
			{
				USERS: {
					async fetch(request) {
						forwarded = request
						return upstream
					}
				}
			},
			{
				openApiDocument: { openapi: '3.0.0', info: {}, paths: {} },
				canonicalApiOrigin: 'http://web.test',
				publicOrigins: 'http://web.test'
			}
		)
		const request = new Request('http://web.test/api/v1/users/me?expanded=true', {
			method: 'POST',
			headers: { cookie: 'session=abc', 'x-request-id': 'request-123', 'x-trace': 'one' },
			body: 'request body'
		})

		const response = await gateway.fetch(request)

		expect(forwarded).not.toBe(request)
		expect(forwarded?.method).toBe('POST')
		expect(forwarded?.url).toBe('http://web.test/api/v1/users/me?expanded=true')
		expect(forwarded?.headers.get('cookie')).toBe('session=abc')
		expect(forwarded?.headers.get('x-request-id')).toBe('request-123')
		expect(forwarded?.headers.get('x-trace')).toBe('one')
		expect(await forwarded?.text()).toBe('request body')
		expect(response.status).toBe(207)
		expect(response.headers.get('x-request-id')).toBe('request-123')
		expect(response.headers.getSetCookie()).toEqual(['first=1; Path=/', 'second=2; Path=/'])
		const reader = response.body!.getReader()
		const first = await reader.read()
		expect(new TextDecoder().decode(first.value)).toBe('streamed ')
		releaseSecondChunk()
		const second = await reader.read()
		expect(new TextDecoder().decode(second.value)).toBe('response')
		expect((await reader.read()).done).toBe(true)
	})

	test('the gateway forwards caller cancellation without reporting a timeout', async () => {
		const { createGateway } = await loadGeneratedGateway()
		const caller = new AbortController()
		const lines: string[] = []
		let forwardedSignal: AbortSignal | undefined
		let markTargetStarted: () => void = () => undefined
		const targetStarted = new Promise<void>((resolve) => (markTargetStarted = resolve))
		const gateway = createGateway(
			{
				USERS: {
					async fetch(request) {
						forwardedSignal = request.signal
						markTargetStarted()
						return new Promise<Response>(() => undefined)
					}
				}
			},
			{
				openApiDocument: { openapi: '3.0.0', info: {}, paths: {} },
				canonicalApiOrigin: 'http://localhost:8786',
				publicOrigins: 'http://web.test',
				logger: (line) => lines.push(line),
				upstreamTimeoutMs: 1_000
			}
		)
		const responsePromise = gateway.fetch(
			new Request('http://web.test/api/v1/users/me', { signal: caller.signal })
		)

		await targetStarted
		caller.abort()
		const response = await responsePromise

		expect(forwardedSignal?.aborted).toBe(true)
		expect(response.status).toBe(502)
		const events = lines.map((line) => (JSON.parse(line) as { event: string }).event)
		expect(events).toContain('transport_failure')
		expect(events).not.toContain('upstream_timeout')
	})

	test('the gateway generates one request ID and emits a credential-safe routing log', async () => {
		const { createGateway } = await loadGeneratedGateway()
		const lines: string[] = []
		let serviceRequestId: string | null = null
		const gateway = createGateway(
			{
				USERS: {
					async fetch(request) {
						serviceRequestId = request.headers.get('x-request-id')
						return new Response('ok', { headers: { 'x-request-id': serviceRequestId ?? '' } })
					}
				}
			},
			{
				openApiDocument: { openapi: '3.0.0', info: {}, paths: {} },
				canonicalApiOrigin: 'http://localhost:8786',
				publicOrigins: 'http://web.test',
				logger: (line) => lines.push(line)
			}
		)
		const response = await gateway.fetch(
			new Request('http://web.test/api/v1/users/me?token=not-logged', {
				headers: { cookie: 'secret-cookie' }
			})
		)

		expect(serviceRequestId).toMatch(/^[0-9a-f-]{36}$/)
		expect(response.headers.get('x-request-id')).toBe(serviceRequestId)
		const logs = lines.map((line) => JSON.parse(line) as Record<string, unknown>)
		expect(logs).toContainEqual(
			expect.objectContaining({
				event: 'route_selected',
				requestId: serviceRequestId,
				target: 'USERS',
				path: '/api/v1/users/me'
			})
		)
		expect(lines.join('\n')).not.toContain('secret-cookie')
		expect(lines.join('\n')).not.toContain('not-logged')
	})

	test('private services echo the gateway request ID in structured logs and responses', async () => {
		const entries = planFixture('hono-skip-auth-emailotp')
		const authApp = entries.find((entry) => entry.path === 'services/auth/src/app.ts')!.content
		const usersApp = entries.find((entry) => entry.path === 'services/users/src/app.ts')!.content
		const { logger } = await loadGeneratedServiceLogger()
		const lines: string[] = []
		const service = new Hono()
		service.use(
			'*',
			logger('users', (line) => lines.push(line))
		)
		service.get('/api/v1/users/me', (c) => c.text('ok'))

		const response = await service.fetch(
			new Request('http://users.test/api/v1/users/me?private=not-logged', {
				headers: { cookie: 'secret-cookie', 'x-request-id': 'request-123' }
			})
		)

		expect(response.headers.get('x-request-id')).toBe('request-123')
		expect(lines.map((line) => JSON.parse(line))).toContainEqual({
			event: 'service_request_completed',
			requestId: 'request-123',
			service: 'users',
			method: 'GET',
			path: '/api/v1/users/me',
			status: 200,
			durationMs: expect.any(Number)
		})
		expect(lines.join('\n')).not.toContain('secret-cookie')
		expect(lines.join('\n')).not.toContain('not-logged')
		expect(authApp).toContain("logger('auth')")
		expect(usersApp).toContain("logger('users')")
	})

	test('the gateway applies explicit routing and failure semantics without retrying', async () => {
		const { createGateway } = await loadGeneratedGateway()
		let authCalls = 0
		let usersCalls = 0
		const lines: string[] = []
		const options: GatewayOptions = {
			openApiDocument: { openapi: '3.0.0', info: {}, paths: {} },
			canonicalApiOrigin: 'http://localhost:8786',
			publicOrigins: 'http://web.test',
			logger: (line) => lines.push(line),
			upstreamTimeoutMs: 10
		}
		const gateway = createGateway(
			{
				AUTH: {
					async fetch() {
						authCalls += 1
						return new Response('auth')
					}
				},
				USERS: {
					async fetch(request) {
						usersCalls += 1
						if (new URL(request.url).pathname.endsWith('/slow')) return new Promise<Response>(() => undefined)
						throw new Error('transport failed')
					}
				}
			},
			options
		)

		expect(await (await gateway.fetch(new Request('http://web.test/api/healthz'))).text()).toBe(
			'ok'
		)
		expect((await gateway.fetch(new Request('http://web.test/api/unknown'))).status).toBe(404)
		expect(
			(await createGateway({}, options).fetch(new Request('http://web.test/api/auth/session')))
				.status
		).toBe(503)
		expect((await gateway.fetch(new Request('http://web.test/api/auth/session'))).status).toBe(200)
		expect((await gateway.fetch(new Request('http://web.test/api/v1/users/me'))).status).toBe(502)
		expect((await gateway.fetch(new Request('http://web.test/api/v1/users/slow'))).status).toBe(504)
		expect(authCalls).toBe(1)
		expect(usersCalls).toBe(2)

		const events = lines.map((line) => JSON.parse(line) as { event: string })
		expect(events.map(({ event }) => event)).toEqual(
			expect.arrayContaining([
				'route_selected',
				'target_missing',
				'transport_failure',
				'upstream_timeout',
				'request_completed'
			])
		)
		expect(lines.join('\n')).not.toContain('transport failed')
	})

	test('one root command starts the gateway and loopback-only services', () => {
		const entries = planFixture('hono-skip-deploy')
		const rootPackage = entries.find((entry) => entry.path === 'package.json')
		const localScript = entries.find((entry) => entry.path === 'scripts/local.mjs')
		const turbo = entries.find((entry) => entry.path === 'turbo.json')
		const gatewayIndex = entries.find((entry) => entry.path === 'apps/api/src/index.ts')
		const authIndex = entries.find((entry) => entry.path === 'services/auth/src/index.ts')
		const usersIndex = entries.find((entry) => entry.path === 'services/users/src/index.ts')
		const usersPackage = entries.find((entry) => entry.path === 'services/users/package.json')

		expect(JSON.parse(rootPackage!.content).scripts.dev).toBe('node scripts/local.mjs dev')
		expect(localScript?.content).toContain("dev: ['exec', 'turbo', 'run', 'dev'")
		expect(localScript?.content).toContain("'--filter=./apps/*', '--filter=./services/*'")
		expect(localScript?.content).not.toContain('--env-mode=loose')
		const tasks = JSON.parse(turbo!.content).tasks as Record<string, { env?: string[] }>
		expect(tasks['@hono-skip-deploy/api-gateway#dev']?.env).toContain('API_PUBLIC_ORIGIN')
		expect(tasks['@hono-skip-deploy/auth-worker#dev']?.env).toEqual(['SQLITE_PATH'])
		expect(tasks['@hono-skip-deploy/users-worker#dev']?.env).toEqual(['SQLITE_PATH', 'AUTH_URL'])
		expect(tasks['hono-skip-deploy-web#dev']?.env).toContain('GATEWAY_URL')
		expect(gatewayIndex?.content).toContain("process.env.HOST ?? '127.0.0.1'")
		expect(gatewayIndex?.content).toContain('process.env.PORT ?? 8786')
		expect(gatewayIndex?.content).toContain("redirect: 'manual'")
		expect(gatewayIndex?.content).toContain('corsOrigins: process.env.API_CORS_ORIGINS')
		expect(gatewayIndex?.content).toContain(
			'upstreamTimeoutMs: Number(process.env.GATEWAY_UPSTREAM_TIMEOUT_MS ?? 10000)'
		)
		expect(authIndex?.content).toContain("process.env.HOST ?? '127.0.0.1'")
		expect(usersIndex?.content).toContain("process.env.HOST ?? '127.0.0.1'")
		expect(usersIndex?.content).toContain(
			"const authUrl = process.env.AUTH_URL ?? 'http://127.0.0.1:8787'"
		)
		expect(usersIndex?.content).toContain('return app.fetch(request, { AUTH_URL: authUrl })')
		expect(usersPackage?.content).toContain('@hono/node-server')
	})

	test('browser examples use the same-origin alias and SSR uses a private gateway transport', () => {
		const entries = planFixture('hono-skip-deploy')
		const vite = entries.find((entry) => entry.path === 'apps/web/vite.config.ts')
		const layout = entries.find((entry) => entry.path === 'apps/web/src/routes/+layout.ts')
		const hooks = entries.find((entry) => entry.path === 'apps/web/src/hooks.server.ts')

		expect(vite?.content).toContain("'^/api(?:[/?]|$)': { target: 'http://127.0.0.1:8786' }")
		expect(vite?.content).not.toContain("'/api': { target:")
		expect(vite?.content).not.toContain('port: 3000')
		const dockerVite = planFixture('hono-docker-sqlite-auth').find(
			(entry) => entry.path === 'apps/web/vite.config.ts'
		)
		expect(dockerVite?.content).toContain("host: '127.0.0.1'")
		expect(dockerVite?.content).toContain('port: 3000')
		expect(layout?.content).toContain("baseUrl: ''")
		expect(layout?.content).not.toContain('PUBLIC_USERS_URL')
		expect(hooks?.content).toContain('export const handleFetch')
		expect(hooks?.content).toContain('env.GATEWAY_URL')
		expect(hooks?.content).toContain('new Request(upstream, request)')
		expect(hooks?.content).toContain("headers.set('x-gateway-ingress-secret'")
		expect(hooks?.content).not.toContain('forwardApiAlias')
		expect(hooks?.content).not.toContain('gateway.fetch(event.request)')
	})

	test('SSR sends only same-origin API requests through the private gateway', async () => {
		const { handleFetch } = await loadGeneratedHandleFetch()
		const gatewayRequests: Request[] = []
		const passthroughRequests: Request[] = []
		const event = {
			url: new URL('https://app.example/account'),
			platform: {
				env: {
					GATEWAY: {
						async fetch(request: Request) {
							gatewayRequests.push(request)
							return new Response('gateway')
						}
					}
				}
			}
		}
		const passthrough = async (request: Request) => {
			passthroughRequests.push(request)
			return new Response('passthrough')
		}
		const exactApiRequest = new Request('https://app.example/api')
		const sameOriginApiRequest = new Request('https://app.example/api/v1/users/me')
		const externalApiRequest = new Request('https://third-party.example/api/data')
		const outsideApiRequest = new Request('https://app.example/apiary')

		expect(
			await (await handleFetch({ event, request: exactApiRequest, fetch: passthrough })).text()
		).toBe('gateway')
		expect(
			await (await handleFetch({ event, request: sameOriginApiRequest, fetch: passthrough })).text()
		).toBe('gateway')
		expect(
			await (await handleFetch({ event, request: externalApiRequest, fetch: passthrough })).text()
		).toBe('passthrough')
		expect(
			await (await handleFetch({ event, request: outsideApiRequest, fetch: passthrough })).text()
		).toBe('passthrough')
		expect(gatewayRequests).toEqual([exactApiRequest, sameOriginApiRequest])
		expect(passthroughRequests).toEqual([externalApiRequest, outsideApiRequest])
	})

	test('the workspace and root tooling discover the gateway and private services', () => {
		const entries = planFixture('hono-skip-deploy')
		const workspace = entries.find((entry) => entry.path === 'pnpm-workspace.yaml')
		const tsconfig = entries.find((entry) => entry.path === 'tsconfig.json')

		expect(workspace?.content).toContain("- 'apps/*'")
		expect(workspace?.content).toContain("- 'services/*'")
		expect(workspace?.content).not.toContain("- 'apps/api/*'")
		expect(tsconfig?.content).toContain('"services/**/*"')
	})

	test('public and generated Hono quickstarts use the same local setup sequence', () => {
		const publicReadme = readFileSync(join(fixturesDir, '..', 'README.md'), 'utf8')
		expect(publicReadme).toContain('For the default Hono scaffold')
		expect(publicReadme).toContain(canonicalHonoQuickstart)
		expect(publicReadme).toContain('## Reproduce a generated project')
		expect(publicReadme).toContain('project.config.jsonc')
		expect(publicReadme).toContain(
			'npx gv-kit new another-project --config path/to/project.config.jsonc'
		)

		for (const fixture of ['hono-skip-deploy', 'hono-docker-full', 'hono-cf-workers-full']) {
			const rootReadme = planFixture(fixture).find((entry) => entry.path === 'README.md')?.content ?? ''
			expect(rootReadme).toContain(canonicalHonoQuickstart)
		}
	})

	test('generated Hono documentation contracts one public gateway topology', () => {
		for (const fixture of ['hono-skip-deploy', 'hono-docker-full', 'hono-cf-workers-full']) {
			const entries = planFixture(fixture)
			const rootReadme = entries.find((entry) => entry.path === 'README.md')?.content ?? ''
			const gatewayReadme =
				entries.find((entry) => entry.path === 'apps/api/README.md')?.content ?? ''
			const authReadme =
				entries.find((entry) => entry.path === 'services/auth/README.md')?.content ?? ''
			const usersReadme =
				entries.find((entry) => entry.path === 'services/users/README.md')?.content ?? ''

			expect(rootReadme).toContain('## API topology')
			expect(rootReadme).toContain("web origin's `/api/*` alias")
			expect(rootReadme).toContain('canonical API origin')
			expect(rootReadme).toContain('`/api/auth/*`')
			expect(rootReadme).toContain('`/api/v1/*`')
			expect(rootReadme).toContain('`/api/openapi.json`')
			expect(rootReadme).toContain('request-scoped SSR transport')
			expect(gatewayReadme).toContain('must not import or mount service applications')
			expect(authReadme).toContain('private service')
			expect(authReadme).toContain('reachable externally only through the gateway')
			expect(usersReadme).toContain('private service')
			expect(usersReadme).toContain('composition input owned by this service')
			expect(usersReadme).not.toContain('| `GET /openapi.json` | public |')
		}
	})

	test('generated Hono plans contain no direct-service compatibility output', () => {
		for (const fixture of ['hono-skip-deploy', 'hono-docker-full', 'hono-cf-workers-full']) {
			const entries = planFixture(fixture)
			const paths = entries.map((entry) => entry.path)
			const output = entries.map((entry) => entry.content).join('\n')

			expect(paths.some((path) => /^apps\/api\/(?:auth|users)(?:\/|$)/.test(path))).toBe(false)
			expect(paths.some((path) => path.includes('/routes/api/auth/'))).toBe(false)
			expect(output).not.toMatch(/^PUBLIC_(?:API|AUTH|USERS)_URL=/m)
			expect(output).not.toContain('@repo/openapi-client/users')
			expect(output).not.toContain('apps/api/auth')
			expect(output).not.toContain('apps/api/users')
		}
	})

	test('environment examples separate ingress, private transports, and allowlists', () => {
		const entries = planFixture('hono-docker-full')
		const env = entries.find((entry) => entry.path === '.env.example')?.content ?? ''

		expect(env).toContain('# Canonical API origin advertised by the gateway OpenAPI endpoint')
		expect(env).toContain('# Browser API alias: http://localhost:3000/api/*')
		expect(env).toContain('# Private gateway and service targets')
		expect(env).toContain('GATEWAY_URL=http://127.0.0.1:8786')
		expect(env).toContain('AUTH_URL=http://127.0.0.1:8787')
		expect(env).toContain('USERS_URL=http://127.0.0.1:8788')
		expect(env).toContain(
			'BETTER_AUTH_ALLOWED_HOSTS=localhost:3000,api.localhost:3000,localhost:8786,127.0.0.1:8786'
		)
		expect(env).toContain('AUTH_CORS_ORIGINS=http://localhost:3000,http://api.localhost:3000')
		expect(env).toContain('GATEWAY_PUBLIC_ORIGINS=')
		expect(env).toContain('API_CORS_ORIGINS=')
		expect(env).toContain('GATEWAY_UPSTREAM_TIMEOUT_MS=10000')
	})

	test('release artifacts document the breaking generated-output migration', () => {
		const migration = readFileSync(
			join(fixturesDir, '..', 'docs/migrations/hono-api-gateway.md'),
			'utf8'
		)
		const changeset = readFileSync(
			join(fixturesDir, '..', '.changeset/contract-hono-gateway.md'),
			'utf8'
		)
		const generatedTopology = [
			'hono-skip-deploy',
			'hono-docker-full',
			'hono-cf-workers-full'
		]
			.flatMap((fixture) => planFixture(fixture))
			.map((entry) => entry.content)
			.join('\n')
		const requiredGatewayVariables = [
			'API_PUBLIC_ORIGIN',
			'GATEWAY_PUBLIC_ORIGINS',
			'API_CORS_ORIGINS',
			'GATEWAY_UPSTREAM_TIMEOUT_MS',
			'GATEWAY_TRUSTED_INGRESS_SECRET'
		]
		const expectedTopologyVariables = [
			...requiredGatewayVariables,
			'GATEWAY_URL',
			'AUTH_URL',
			'USERS_URL',
			'BETTER_AUTH_ALLOWED_HOSTS',
			'AUTH_CORS_ORIGINS'
		]
		const documentedTopologyVariables = Array.from(
			migration.matchAll(/^\| `([A-Z][A-Z0-9_]*)` \|/gm),
			(match) => match[1]!
		)

		for (const section of [
			'## Layout',
			'## Routes',
			'## Environment',
			'## Client imports',
			'## Deployment',
			'## Cookies and CORS',
			'## OpenAPI'
		]) expect(migration).toContain(section)
		expect(documentedTopologyVariables).toEqual(expectedTopologyVariables)
		for (const variable of requiredGatewayVariables) expect(migration).toContain(variable)
		for (const variable of documentedTopologyVariables) expect(generatedTopology).toContain(variable)
		expect(migration).toContain('| `API_CORS_ORIGINS` | Gateway (`apps/api`) |')
		expect(migration).toContain('| `AUTH_CORS_ORIGINS` | Auth service (`services/auth`) |')
		expect(migration).toContain('Cloudflare Service Bindings do not use this secret')
		expect(migration).toContain('Node gateway startup fails if either is absent')
		expect(migration).toContain('Docker Compose requires the same secret')
		expect(migration).toContain('Preview values must name only that preview')
		expect(migration).toContain('No automatic migration is provided')
		expect(changeset).toContain('"gv-kit": major')
		expect(changeset).toContain('Hono gateway')
	})
})
