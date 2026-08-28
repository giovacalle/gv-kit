import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import type { FileEntry } from '../../src/lib/files.js'
import { parseJsonc } from '../../src/lib/jsonc.js'
import { buildScaffoldPlan } from '../../src/pipeline/plan.js'
import { GvKitConfig } from '../../src/schema/config.js'

const fixtureBaselines = {
	'inside-frontend-docker-postgres.jsonc':
		'af2b5ebf5bd2f8cc97db0ae49e0c7e650a40a6cee1a35accb7eede2b88925dd0',
	'inside-frontend-docker-sqlite.jsonc':
		'3c5935043649f1a23761bee5f327fa9da67f2bc16845e6ad0c329a897b81987f'
} as const

function loadPlan(fixtureName: string): FileEntry[] {
	const fixturePath = join(import.meta.dir, '..', '..', 'fixtures', fixtureName)
	const config = GvKitConfig.parse(parseJsonc(readFileSync(fixturePath, 'utf8')))
	return buildScaffoldPlan(config)
}

function dockerfileFrom(entries: FileEntry[]): string {
	const dockerfile = entries.find(({ path }) => path === 'Dockerfile')
	if (!dockerfile) throw new Error('Integrated Docker output requires a Dockerfile')
	return dockerfile.content
}

function packageNamesFrom(entries: FileEntry[]): Set<string> {
	return new Set(
		entries
			.filter(({ path }) => path.endsWith('package.json'))
			.map(({ content }) => (JSON.parse(content) as { name: string }).name)
	)
}

function documentedBuildCommands(dockerfile: string): string[] {
	return [...dockerfile.matchAll(/^# {3}(docker build .+)$/gm)].map((match) => match[1]!)
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
			const dockerfile = dockerfileFrom(entries)
			const paths = new Set(entries.map(({ path }) => path))
			const packageNames = packageNamesFrom(entries)
			const commands = documentedBuildCommands(dockerfile)

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

		test(`${fixtureName} changes Docker comments only`, () => {
			expect(outputHashWithoutDockerComments(loadPlan(fixtureName))).toBe(baselineHash)
		})
	}
})
