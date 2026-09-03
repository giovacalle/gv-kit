import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import type { FileEntry } from '../../src/lib/files.js'
import { parseJsonc } from '../../src/lib/jsonc.js'
import { buildScaffoldPlan } from '../../src/pipeline/plan.js'
import { GvKitConfig } from '../../src/schema/config.js'

const fixtureBaselines = {
	'inside-frontend-docker-postgres.jsonc':
		'8bb69fcce70daa68d3e91238dff217905cae0a783141b8c48e34017d9396e627',
	'inside-frontend-docker-sqlite.jsonc':
		'a95da4e5e771c4369db5c5209c8283a774cf5b367afaed3b0b8a6e34a2318495'
} as const

function loadPlan(fixtureName: string): FileEntry[] {
	const fixturePath = join(import.meta.dir, '..', '..', 'fixtures', fixtureName)
	const config = GvKitConfig.parse(parseJsonc(readFileSync(fixturePath, 'utf8')))
	return buildScaffoldPlan(config)
}

function contentFrom(entries: FileEntry[], path: string): string {
	const entry = entries.find((candidate) => candidate.path === path)
	if (!entry) throw new Error(`Integrated Docker output requires ${path}`)
	return entry.content
}

function packageNamesFrom(entries: FileEntry[]): Set<string> {
	return new Set(
		entries
			.filter(({ path }) => path.endsWith('package.json'))
			.map(({ content }) => (JSON.parse(content) as { name: string }).name)
	)
}

function documentedBuildCommands(readme: string): string[] {
	return [...readme.matchAll(/^docker build .+$/gm)].map((match) => match[0])
}

function buildArgument(command: string, name: string): string | undefined {
	return command.match(new RegExp(`--build-arg ${name}=("[^"]+"|\\S+)`))?.[1]?.replaceAll('"', '')
}

function targetFrom(command: string): string | undefined {
	return command.match(/--target (\S+)/)?.[1]
}

function outputHashWithoutDockerComments(entries: FileEntry[]): string {
	const normalized = entries
		.map((entry) =>
			entry.path === 'Dockerfile'
				? {
						...entry,
						content: entry.content
							.split('\n')
							.filter((line) => !line.startsWith('#'))
							.join('\n')
					}
				: entry
		)
		.sort((left, right) => left.path.localeCompare(right.path))

	return new Bun.CryptoHasher('sha256').update(JSON.stringify(normalized)).digest('hex')
}

describe('non-Hono integrated Docker output', () => {
	for (const [fixtureName, baselineHash] of Object.entries(fixtureBaselines)) {
		test(`${fixtureName} documents only generated targets, paths, and packages`, () => {
			const entries = loadPlan(fixtureName)
			const dockerfile = contentFrom(entries, 'Dockerfile')
			const readme = contentFrom(entries, 'README.md')
			const paths = new Set(entries.map(({ path }) => path))
			const packageNames = packageNamesFrom(entries)
			const commands = documentedBuildCommands(readme)

			expect(commands).toHaveLength(2)
			expect(dockerfile).not.toContain('apps/api/auth')
			expect(dockerfile).not.toContain('auth-worker')

			for (const command of commands) {
				const target = targetFrom(command)
				const workspacePackage = buildArgument(command, 'TURBO_FILTER')
				const appPath = buildArgument(command, 'APP_PATH')

				expect(target, command).toBeDefined()
				expect(dockerfile, command).toContain(` AS ${target}`)
				expect(workspacePackage, command).toBeDefined()
				expect(packageNames, command).toContain(workspacePackage!)
				if (appPath) expect(paths, command).toContain(`${appPath}/package.json`)
			}
		})

		test(`${fixtureName} matches the accepted non-Hono baseline`, () => {
			expect(outputHashWithoutDockerComments(loadPlan(fixtureName))).toBe(baselineHash)
		})
	}
})
