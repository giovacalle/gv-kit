import { spawn } from 'node:child_process'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { runGenerators } from '../src/generators/index.js'
import { GvKitConfig } from '../src/schema/config.js'
import { parseJsonc } from '../src/lib/jsonc.js'
import { verifyPreviewMigrations } from './verify-preview-migrations.js'
import { verifyPreviewCleanup } from './verify-preview-cleanup.js'

type WorkerTarget = { name: string; directory: string }
type DatabaseProvider = 'd1' | 'neon'
type ProbeResult = { exitCode: number; stdout: string; stderr: string }
type WranglerConfig = {
	name: string
	routes?: Array<Record<string, unknown>>
	services?: Array<{ binding: string; service: string }>
	d1_databases?: Array<Record<string, string>>
	vars?: Record<string, string>
}

type PublisherProbeMode =
	| 'valid'
	| 'hostile-auth'
	| 'reordered-vars'
	| 'd1-binding'
	| 'route'
	| 'collision'
	| 'gateway-api-origin'
	| 'gateway-public-origins'
	| 'gateway-cors-origins'
	| 'auth-hosts'
	| 'auth-cors-origins'
	| 'extra-vars'
	| 'missing-var'

type PreviewSecurityOptions = {
	project: string
	cleanupWorkflow: string
	workers: WorkerTarget[]
	alias: string
	repositoryId: string
	database: {
		provider: DatabaseProvider
		name: string
		id: string
	}
	previewSecretDirectory: string
	previewZoneName: string
	previewWebDomain: string
	previewApiDomain: string
}

async function runProbe({
	executable,
	args,
	cwd,
	env = {},
	input,
	inheritEnvironment = true
}: {
	executable: string
	args: string[]
	cwd: string
	env?: Record<string, string>
	input?: string
	inheritEnvironment?: boolean
}): Promise<ProbeResult> {
	const child = spawn(executable, args, {
		cwd,
		env: { ...(inheritEnvironment ? process.env : {}), ...env },
		timeout: 120_000,
		stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe']
	})
	if (input !== undefined) child.stdin!.end(input)
	let stdout = ''
	let stderr = ''
	child.stdout!.on('data', (chunk) => (stdout += chunk.toString()))
	child.stderr!.on('data', (chunk) => (stderr += chunk.toString()))
	const exitCode = await new Promise<number>((done, reject) => {
		child.on('error', reject)
		child.on('close', (status) => done(status ?? 1))
	})
	return { exitCode, stdout, stderr }
}

function requirePassed(result: ProbeResult, name: string): void {
	if (result.exitCode !== 0) throw new Error(`${name} failed:\n${result.stderr || result.stdout}`)
}

function requireRejected({
	result,
	name,
	message
}: {
	result: ProbeResult
	name: string
	message: string
}): void {
	if (result.exitCode === 0) throw new Error(`${name} unexpectedly passed`)
	if (!result.stderr.includes(message)) throw new Error(`${name} did not fail with ${JSON.stringify(message)}:\n${result.stderr}`)
}

async function readOptional(path: string): Promise<string> {
	return readFile(path, 'utf8').catch(() => '')
}

async function resetDirectory(path: string): Promise<void> {
	await rm(path, { recursive: true, force: true })
	await mkdir(path, { recursive: true })
}

async function verifyLegacyInventoryAuthentication({
	project,
	source,
	alias,
	provider,
	repositoryId
}: {
	project: string
	source: string
	alias: string
	provider: DatabaseProvider
	repositoryId: string
}): Promise<string[]> {
	const root = join(project, '.wrangler/verify-preview-inventory-authentication')
	const workflowContent = Buffer.from('# Per-PR staging deploy for verification.\n').toString(
		'base64'
	)
	const manifest = JSON.stringify({
		schemaVersion: 1,
		project: 'verification',
		alias,
		workers: [],
		database: {
			kind: provider,
			name: `verification-db-${alias}`,
			id: provider === 'd1' ? '55555555-5555-4555-8555-555555555555' : 'br-legacy'
		}
	})

	async function probeLegacyInventoryAuthentication({
		name,
		prNumber = Number(alias.slice(3)),
		artifactRunSuffix = 777,
		empty = false
	}: {
		name: string
		prNumber?: number
		artifactRunSuffix?: number
		empty?: boolean
	}): Promise<ProbeResult & { output: string; requests: string }> {
		const directory = join(root, name)
		await resetDirectory(directory)
		const githubOutput = join(directory, 'github-output.txt')
		const requestLog = join(directory, 'requests.log')
		await writeFile(requestLog, '')
		const artifactPages = JSON.stringify([
			{
				artifacts: empty
					? []
					: [
							{
								id: 888,
								name: `cloudflare-preview-inventory-${alias}-${artifactRunSuffix}`,
								expired: false,
								created_at: '2026-01-01T00:00:00Z',
								workflow_run: { id: 777 }
							}
						]
			}
		])
		const runRecord = JSON.stringify({
			name: 'deploy-staging',
			path: '.github/workflows/deploy-staging.yml',
			status: 'completed',
			conclusion: 'success',
			repository: { id: Number(repositoryId) },
			event: 'pull_request',
			pull_requests: [
				{
					number: prNumber,
					base: {
						repo: { id: Number(repositoryId) },
						ref: 'main',
						sha: 'a'.repeat(40)
					}
				}
			]
		})
		const commands = `gh() {
	printf '%s\\n' "$*" >> "$MOCK_REQUEST_LOG"
	if [ "$#" -eq 4 ] && [ "$1" = 'api' ] && [ "$2" = '--paginate' ] && [ "$3" = '--slurp' ] && [ "$4" = "/repos/$GITHUB_REPOSITORY/actions/artifacts?per_page=100" ]; then
		printf '%s\\n' "$MOCK_ARTIFACT_PAGES"
		return 0
	fi
	if [ "$#" -eq 2 ] && [ "$1" = 'api' ] && [ "$2" = "/repos/$GITHUB_REPOSITORY/actions/runs/777" ]; then
		printf '%s\\n' "$MOCK_RUN"
		return 0
	fi
	if [ "$#" -eq 4 ] && [ "$1" = 'api' ] && [ "$2" = "/repos/$GITHUB_REPOSITORY/contents/.github/workflows/deploy-staging.yml?ref=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" ] && [ "$3" = '--jq' ] && [ "$4" = '.content' ]; then
		printf '%s\\n' "$MOCK_WORKFLOW_CONTENT"
		return 0
	fi
	if [ "$#" -eq 2 ] && [ "$1" = 'api' ] && [ "$2" = "/repos/$GITHUB_REPOSITORY/actions/artifacts/888/zip" ]; then
		printf '%s\\n' 'mock zip'
		return 0
	fi
	echo "Unexpected mocked GitHub API request: $*" >&2
	return 91
}
unzip() {
	[ "$#" -eq 3 ] && [ "$1" = '-p' ] && [ "$3" = 'cloudflare-preview-manifest.json' ]
	printf '%s\\n' "$MOCK_MANIFEST"
}
`
		const result = await runProbe({
			executable: 'bash',
			args: ['-s'],
			cwd: directory,
			input: `${commands}\n${source}`,
			env: {
				EXPECTED_DEFAULT_BRANCH: 'main',
				EXPECTED_REPOSITORY_ID: repositoryId,
				GH_TOKEN: 'verification-token',
				GITHUB_OUTPUT: githubOutput,
				GITHUB_REPOSITORY: 'owner/repository',
				RUNNER_TEMP: directory,
				MOCK_ARTIFACT_PAGES: artifactPages,
				MOCK_MANIFEST: manifest,
				MOCK_REQUEST_LOG: requestLog,
				MOCK_RUN: runRecord,
				MOCK_WORKFLOW_CONTENT: workflowContent
			}
		})
		return {
			...result,
			output: await readOptional(githubOutput),
			requests: await readOptional(requestLog)
		}
	}

	const valid = await probeLegacyInventoryAuthentication({ name: 'valid' })
	requirePassed(valid, 'legacy preview inventory authentication')
	if (valid.output !== 'authenticated_count=1\n') throw new Error('legacy preview inventory did not record one authenticated artifact')
	if (!valid.requests.includes('/actions/artifacts/888/zip')) throw new Error('legacy preview inventory did not download the authenticated artifact')

	const crossPr = await probeLegacyInventoryAuthentication({
		name: 'cross-pr',
		prNumber: Number(alias.slice(3)) + 1
	})
	requireRejected({
		result: crossPr,
		name: 'cross-PR preview inventory',
		message: 'has no trusted completed deployment run.'
	})
	if (crossPr.requests.includes('/actions/artifacts/888/zip')) throw new Error('cross-PR preview inventory reached artifact download')

	const forged = await probeLegacyInventoryAuthentication({
		name: 'forged-artifact',
		artifactRunSuffix: 999
	})
	requireRejected({
		result: forged,
		name: 'forged preview inventory artifact',
		message: 'does not match its trusted deployment generation.'
	})
	if (forged.requests.includes('/actions/artifacts/888/zip')) throw new Error('forged preview inventory reached artifact download')

	const empty = await probeLegacyInventoryAuthentication({ name: 'empty', empty: true })
	requirePassed(empty, 'empty preview inventory download')
	if (empty.output !== 'authenticated_count=0\n') throw new Error('empty preview inventory did not record zero authenticated artifacts')

	return ['legacy-artifact-valid', 'legacy-artifact-cross-pr', 'legacy-artifact-forged', 'empty-artifact-inventory']
}

async function verifyCleanupResult({
	project,
	source,
	alias
}: {
	project: string
	source: string
	alias: string
}): Promise<string> {
	const result = await runProbe({
		executable: 'bash',
		args: ['-s'],
		cwd: project,
		input: source,
		env: {
			INVENTORY_OUTCOME: 'success',
			WORKER_CLEANUP_OUTCOME: 'success',
			DATABASE_CLEANUP_OUTCOME: 'success',
			AUTHENTICATED_INVENTORY_COUNT: '0',
			PREVIEW_ALIAS: alias
		}
	})
	requireRejected({
		result,
		name: 'empty authenticated preview inventory result',
		message: `No authenticated preview deployment inventory exists for ${alias}; cleanup is incomplete.`
	})
	return 'empty-artifact-result-fail-closed'
}

async function verifyWorkerCleanup({
	project,
	workers,
	alias
}: {
	project: string
	workers: WorkerTarget[]
	alias: string
}): Promise<string[]> {
	const script = await readFile(
		join(project, 'scripts/cleanup-cloudflare-preview-workers.sh'),
		'utf8'
	)
	const root = join(project, '.wrangler/verify-worker-cleanup-security')
	const deletionLog = join(root, 'deletions.log')
	await resetDirectory(root)
	const validWorkers = (
		await Promise.all(
			workers.map(async ({ directory }) =>
				parseJsonc<WranglerConfig>(
					await readFile(join(project, directory, 'wrangler.staging.jsonc'), 'utf8')
				)
			)
		)
	).map(({ name }) => name)
	await writeFile(
		join(project, '.verify-bin/curl'),
		`#!/bin/sh
set -eu
if [ "$#" -ne 4 ] || [ "$1" != '-fsS' ] || [ "$2" != "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/workers/scripts" ] || [ "$3" != '-H' ] || [ "$4" != "Authorization: Bearer $CLOUDFLARE_API_TOKEN" ]; then
	echo "Unexpected Worker inventory command: $*" >&2
	exit 92
fi
if [ "$WORKER_CLEANUP_MODE" = 'inventory-failure' ]; then
	echo 'mock Worker inventory failure' >&2
	exit 17
fi
printf '%s\\n' "$WORKER_CLEANUP_INVENTORY"
`,
		{ mode: 0o755 }
	)
	await writeFile(
		join(project, '.verify-bin/npx'),
		`#!/bin/sh
set -eu
test "$1" = 'wrangler@4.125.0'
test "$2" = 'delete'
test "$3" = '--name'
test "$5" = '--force'
test "$#" -eq 5
printf '%s\\n' "$4" >> "$WORKER_CLEANUP_DELETION_LOG"
[ "$4" != "$WORKER_CLEANUP_FAILURE_NAME" ]
`,
		{ mode: 0o755 }
	)

	async function probeWorkerCleanup({
		mode,
		inventory,
		failureName = ''
	}: {
		mode: string
		inventory: unknown
		failureName?: string
	}): Promise<ProbeResult & { deletions: string[] }> {
		await writeFile(deletionLog, '')
		const result = await runProbe({
			executable: 'sh',
			args: ['-s', '--', alias],
			cwd: project,
			input: script,
			env: {
				PATH: `${join(project, '.verify-bin')}:${process.env.PATH ?? ''}`,
				CLOUDFLARE_ACCOUNT_ID: 'verification-account',
				CLOUDFLARE_API_TOKEN: 'verification-token',
				WORKER_CLEANUP_MODE: mode,
				WORKER_CLEANUP_INVENTORY: JSON.stringify(inventory),
				WORKER_CLEANUP_DELETION_LOG: deletionLog,
				WORKER_CLEANUP_FAILURE_NAME: failureName
			}
		})
		return {
			...result,
			deletions: (await readOptional(deletionLog)).trim().split('\n').filter(Boolean)
		}
	}

	const safeInventory = {
		success: true,
		errors: [],
		messages: [],
		result: [
			...validWorkers.map((id) => ({ id })),
			{ id: 'production-worker' },
			{ id: 'pv-unrelated-project-worker-pr-123' }
		]
	}
	const inventoryFailure = await probeWorkerCleanup({
		mode: 'inventory-failure',
		inventory: safeInventory
	})
	requireRejected({
		result: inventoryFailure,
		name: 'Worker inventory failure',
		message: 'Could not inventory preview Workers from Cloudflare.'
	})

	const malformed = await probeWorkerCleanup({
		mode: 'malformed',
		inventory: { success: true, errors: [], messages: [], result: [{ id: 42 }] }
	})
	requireRejected({
		result: malformed,
		name: 'malformed Worker inventory',
		message: 'Cloudflare returned a malformed preview Worker inventory.'
	})
	if (malformed.deletions.length !== 0) throw new Error('malformed Worker inventory reached deletion')

	const deletionFailure = await probeWorkerCleanup({
		mode: 'delete-failure',
		inventory: safeInventory,
		failureName: validWorkers[0]!
	})
	requireRejected({
		result: deletionFailure,
		name: 'Worker deletion failure',
		message: '1 preview Worker deletion(s) failed.'
	})
	if (JSON.stringify(deletionFailure.deletions.sort()) !== JSON.stringify([...validWorkers].sort())) throw new Error('Worker cleanup did not attempt every bounded candidate after one failure')

	const missing = await probeWorkerCleanup({
		mode: 'missing',
		inventory: { success: true, errors: [], messages: [], result: [] }
	})
	requirePassed(missing, 'missing Worker cleanup inventory')
	if (missing.deletions.length !== 0) throw new Error('missing Worker inventory reached deletion')

	const success = await probeWorkerCleanup({ mode: 'success', inventory: safeInventory })
	requirePassed(success, 'bounded Worker cleanup inventory')
	if (JSON.stringify(success.deletions.sort()) !== JSON.stringify([...validWorkers].sort())) throw new Error('Worker cleanup crossed its validated preview namespace')

	return [
		'worker-inventory-failure',
		'worker-inventory-malformed',
		'worker-delete-partial-failure',
		'worker-missing-resource',
		'worker-exact-cleanup'
	]
}

function databaseInventory({
	provider,
	records,
	next = null
}: {
	provider: DatabaseProvider
	records: Array<Record<string, unknown>>
	next?: string | null
}): string {
	return provider === 'd1'
		? JSON.stringify(records)
		: JSON.stringify({ branches: records, pagination: { next } })
}

async function verifyDatabaseCleanup({
	project,
	source,
	provider,
	alias,
	repositoryId,
	previewName,
	previewId
}: {
	project: string
	source: string
	provider: DatabaseProvider
	alias: string
	repositoryId: string
	previewName: string
	previewId: string
}): Promise<string[]> {
	const root = join(project, '.wrangler/verify-database-security')
	const manifestDirectory = join(root, 'inventories')
	const deletionLog = join(root, 'deletions.log')
	const script = join(root, 'cleanup.sh')
	await resetDirectory(root)
	await writeFile(script, source, { mode: 0o755 })
	const driftedName = `preview-${repositoryId}-${provider === 'd1' ? 'database-v2' : 'branch-v2'}-${alias}`
	const driftedId = provider === 'd1' ? '22222222-2222-4222-8222-222222222222' : 'br-preview-v2'
	const legacyName = `verification-db-${alias}`
	const legacyId = provider === 'd1' ? '55555555-5555-4555-8555-555555555555' : 'br-preview-legacy'
	const stableRecords =
		provider === 'd1'
			? [
					{ name: previewName, uuid: previewId },
					{ name: driftedName, uuid: driftedId }
				]
			: [
					{ name: previewName, id: previewId, default: false, protected: false },
					{ name: driftedName, id: driftedId, default: false, protected: false }
				]
	const legacyRecord =
		provider === 'd1'
			? { name: legacyName, uuid: legacyId }
			: { name: legacyName, id: legacyId, default: false, protected: false }
	const unrelatedRecord =
		provider === 'd1'
			? { name: 'verification-db', uuid: '33333333-3333-4333-8333-333333333333' }
			: { name: 'verification-db', id: 'br-production', default: true, protected: true }

	if (provider === 'd1') {
		await writeFile(
			join(project, '.verify-bin/npx'),
			`#!/bin/sh
set -eu
if [ "$1" = 'wrangler@4.125.0' ] && [ "$2" = 'd1' ] && [ "$3" = 'list' ] && [ "$4" = '--json' ] && [ "$#" -eq 4 ]; then
	printf '%s\\n' "$DATABASE_CLEANUP_INVENTORY"
	exit 0
fi
if [ "$1" = 'wrangler@4.125.0' ] && [ "$2" = 'd1' ] && [ "$3" = 'delete' ] && [ "$5" = '--skip-confirmation' ] && [ "$#" -eq 5 ]; then
	printf '%s\\n' "$4" >> "$DATABASE_CLEANUP_DELETION_LOG"
	[ "$4" != "$DATABASE_CLEANUP_FAILURE_ID" ]
	exit
fi
echo "Unexpected D1 cleanup command: $*" >&2
exit 92
`,
			{ mode: 0o755 }
		)
	} else {
		await writeFile(
			join(project, '.verify-bin/curl'),
			`#!/bin/sh
set -eu
if [ "$#" -eq 6 ] && [ "$1" = '-fsS' ] && [ "$2" = '-X' ] && [ "$3" = 'DELETE' ] && [ "$4" = '-H' ] && [ "$5" = "Authorization: Bearer $NEON_API_KEY" ]; then
	url=$6
	case "$url" in "https://console.neon.tech/api/v2/projects/$NEON_PROJECT_ID/branches/"*) ;; *) echo "Unexpected Neon deletion URL: $url" >&2; exit 92 ;; esac
	id="\${url##*/}"
	printf '%s\\n' "$id" >> "$DATABASE_CLEANUP_DELETION_LOG"
	[ "$id" != "$DATABASE_CLEANUP_FAILURE_ID" ]
	exit
fi
if [ "$#" -eq 7 ] && [ "$1" = '-fsS' ] && [ "$2" = '-G' ] && [ "$3" = '-H' ] && [ "$4" = "Authorization: Bearer $NEON_API_KEY" ] && [ "$5" = '--data-urlencode' ] && [ "$6" = 'limit=1000' ] && [ "$7" = "https://console.neon.tech/api/v2/projects/$NEON_PROJECT_ID/branches" ]; then
	printf '%s\\n' "$DATABASE_CLEANUP_INVENTORY"
	exit 0
fi
if [ "$#" -eq 9 ] && [ "$1" = '-fsS' ] && [ "$2" = '-G' ] && [ "$3" = '-H' ] && [ "$4" = "Authorization: Bearer $NEON_API_KEY" ] && [ "$5" = '--data-urlencode' ] && [ "$6" = 'limit=1000' ] && [ "$7" = '--data-urlencode' ] && [ "$8" = 'cursor=cursor-2' ] && [ "$9" = "https://console.neon.tech/api/v2/projects/$NEON_PROJECT_ID/branches" ]; then
	printf '%s\\n' "$DATABASE_CLEANUP_PAGE_TWO"
	exit 0
fi
echo "Unexpected Neon cleanup command: $*" >&2
exit 92
`,
			{ mode: 0o755 }
		)
	}

	async function probeDatabaseCleanup({
		records,
		manifestGeneration = 'pull_request',
		failureId = '',
		pageTwoRecords = []
	}: {
		records: Array<Record<string, unknown>>
		manifestGeneration?: 'pull_request' | 'pull_request_target' | 'none'
		failureId?: string
		pageTwoRecords?: Array<Record<string, unknown>>
	}): Promise<ProbeResult & { deletions: string[] }> {
		await resetDirectory(manifestDirectory)
		await writeFile(deletionLog, '')
		if (manifestGeneration !== 'none') {
			await writeFile(
				join(manifestDirectory, `legacy.${manifestGeneration}.json`),
				JSON.stringify({
					schemaVersion: 1,
					project: 'verification',
					alias,
					workers: [],
					database: { kind: provider, name: legacyName, id: legacyId }
				})
			)
		}
		const result = await runProbe({
			executable: 'bash',
			args: [script],
			cwd: project,
			env: {
				PATH: `${join(project, '.verify-bin')}:${process.env.PATH ?? ''}`,
				CLOUDFLARE_ACCOUNT_ID: 'verification-account',
				CLOUDFLARE_API_TOKEN: 'verification-token',
				NEON_API_KEY: 'verification-token',
				NEON_PROJECT_ID: 'verification-project',
				PREVIEW_MANIFEST_DIR: manifestDirectory,
				DATABASE_CLEANUP_INVENTORY: databaseInventory({
					provider,
					records,
					next: pageTwoRecords.length > 0 ? 'cursor-2' : null
				}),
				DATABASE_CLEANUP_PAGE_TWO: databaseInventory({
					provider,
					records: pageTwoRecords
				}),
				DATABASE_CLEANUP_DELETION_LOG: deletionLog,
				DATABASE_CLEANUP_FAILURE_ID: failureId
			}
		})
		return {
			...result,
			deletions: (await readOptional(deletionLog)).trim().split('\n').filter(Boolean)
		}
	}

	const successRecords = [...stableRecords, legacyRecord, unrelatedRecord]
	const success = await probeDatabaseCleanup({ records: successRecords })
	requirePassed(success, `${provider} preview database cleanup`)
	const expectedSuccess = [previewId, driftedId, legacyId].sort()
	if (JSON.stringify(success.deletions.sort()) !== JSON.stringify(expectedSuccess)) throw new Error(`${provider} cleanup did not delete the exact bounded inventory`)

	const sharedId = previewId
	const duplicateRecords =
		provider === 'd1'
			? [
					{ name: previewName, uuid: sharedId },
					{ name: 'verification-db', id: sharedId }
				]
			: [{ name: previewName, id: sharedId, default: false, protected: false }]
	const duplicate = await probeDatabaseCleanup({
		records: duplicateRecords,
		pageTwoRecords:
			provider === 'neon'
				? [{ name: 'verification-db', id: sharedId, default: true, protected: true }]
				: []
	})
	requireRejected({
		result: duplicate,
		name: `${provider} duplicate provider identity`,
		message:
			provider === 'd1'
				? 'Cloudflare returned duplicate preview D1 identities.'
				: 'Neon returned duplicate preview branch identities.'
	})
	if (duplicate.deletions.length !== 0) throw new Error(`${provider} duplicate identity reached deletion`)

	const malformedRecords =
		provider === 'd1'
			? [{ name: `preview-${repositoryId}-malformed-${alias}`, uuid: 'production-database' }]
			: [
					{
						name: `preview-${repositoryId}-malformed-${alias}`,
						id: 'production-branch',
						default: false,
						protected: false
					}
				]
	const malformed = await probeDatabaseCleanup({ records: malformedRecords })
	requireRejected({
		result: malformed,
		name: `${provider} malformed provider identity`,
		message:
			provider === 'd1'
				? 'Cloudflare returned an unsafe preview D1 identity.'
				: 'Neon returned an unsafe preview branch identity.'
	})
	if (malformed.deletions.length !== 0) throw new Error(`${provider} malformed identity reached deletion`)

	if (provider === 'neon') {
		for (const ownership of ['default', 'protected'] as const) {
			const unsafe = await probeDatabaseCleanup({
				records: [
					{
						name: previewName,
						id: previewId,
						default: ownership === 'default',
						protected: ownership === 'protected'
					}
				]
			})
			requireRejected({
				result: unsafe,
				name: `Neon ${ownership} preview branch`,
				message: 'Neon refused cleanup of a default or protected preview branch.'
			})
			if (unsafe.deletions.length !== 0) throw new Error(`Neon ${ownership} branch reached deletion`)
		}
	}

	const wrongGeneration = await probeDatabaseCleanup({
		records: successRecords,
		manifestGeneration: 'pull_request_target'
	})
	requireRejected({
		result: wrongGeneration,
		name: `${provider} wrong manifest generation`,
		message: `Recorded preview ${provider === 'd1' ? 'D1' : 'Neon'} identity is malformed`
	})
	if (wrongGeneration.deletions.length !== 0) throw new Error(`${provider} wrong manifest generation reached deletion`)

	const missing = await probeDatabaseCleanup({ records: [] })
	requirePassed(missing, `${provider} missing preview database cleanup`)
	if (missing.deletions.length !== 0) throw new Error(`${provider} missing inventory reached deletion`)

	const partial = await probeDatabaseCleanup({
		records: successRecords,
		failureId: previewId
	})
	requireRejected({
		result: partial,
		name: `${provider} partial cleanup failure`,
		message: `1 preview ${provider === 'd1' ? 'D1 database' : 'Neon branch'} deletion(s) failed.`
	})
	if (JSON.stringify(partial.deletions.sort()) !== JSON.stringify(expectedSuccess)) throw new Error(`${provider} partial cleanup did not attempt every bounded candidate`)

	const noManifest = await probeDatabaseCleanup({
		records: successRecords,
		manifestGeneration: 'none'
	})
	requirePassed(noManifest, `${provider} cleanup without an authenticated inventory`)
	if (JSON.stringify(noManifest.deletions.sort()) !== JSON.stringify([previewId, driftedId].sort())) throw new Error(`${provider} cleanup without a manifest crossed the stable namespace`)

	return [
		`${provider}-exact-cleanup`,
		`${provider}-duplicate-identity`,
		`${provider}-malformed-identity`,
		...(provider === 'neon' ? ['neon-default-branch', 'neon-protected-branch'] : []),
		`${provider}-wrong-manifest-generation`,
		`${provider}-missing-resource`,
		`${provider}-partial-failure`,
		`${provider}-stable-cleanup-without-manifest`
	]
}

async function verifyTrustedPublisher({
	project,
	workers,
	provider,
	alias,
	previewSecretDirectory,
	previewZoneName,
	previewWebDomain,
	previewApiDomain,
	previewDatabaseName,
	previewDatabaseId
}: {
	project: string
	workers: WorkerTarget[]
	provider: DatabaseProvider
	alias: string
	previewSecretDirectory: string
	previewZoneName: string
	previewWebDomain: string
	previewApiDomain: string
	previewDatabaseName: string
	previewDatabaseId: string
}): Promise<string[]> {
	const root = join(project, '.wrangler/verify-preview-publisher')
	const artifact = join(root, 'artifact')
	const publishLog = join(root, 'publish.log')
	const configs = Object.fromEntries(
		await Promise.all(
			workers.map(async (worker) => [
				worker.directory,
				parseJsonc<WranglerConfig>(
					await readFile(join(project, worker.directory, 'wrangler.staging.jsonc'), 'utf8')
				)
			])
		)
	) as Record<string, WranglerConfig>
	const publishAuthSecret = (await readOptional(join(previewSecretDirectory, 'auth.json')))
		? 'auth.json'
		: ''
	const publishUsersSecret = (await readOptional(join(previewSecretDirectory, 'users.json')))
		? 'users.json'
		: ''
	const bundles: Record<string, string> = {
		'services/auth': 'index.js',
		'services/users': 'index.js',
		'apps/api': 'index.js',
		'apps/web': '_worker.js',
		'apps/marketing': 'no-op-worker.js'
	}
	await resetDirectory(root)
	await writeFile(
		join(project, '.verify-bin/npx'),
		`#!/bin/sh
set -eu
case "$PWD" in
	"$PREVIEW_ARTIFACT/services/auth") bundle=index.js; secret="$PUBLISH_AUTH_SECRET"; assets=none ;;
	"$PREVIEW_ARTIFACT/services/users") bundle=index.js; secret="$PUBLISH_USERS_SECRET"; assets=none ;;
	"$PREVIEW_ARTIFACT/apps/api") bundle=index.js; secret=; assets=none ;;
	"$PREVIEW_ARTIFACT/apps/web") bundle=_worker.js; secret=; assets=web ;;
	"$PREVIEW_ARTIFACT/apps/marketing") bundle=no-op-worker.js; secret=; assets=marketing ;;
	*) echo "Unexpected publisher working directory: $PWD" >&2; exit 92 ;;
esac
test "$1" = 'wrangler@4.125.0'
test "$2" = 'deploy'
test "$3" = ".preview-bundle/$bundle"
test "$4" = '--no-bundle'
test "$5" = '--config'
test "$6" = 'wrangler.publish.jsonc'
if [ -n "$secret" ]; then
	test "$#" -eq 8
	test "$7" = '--secrets-file'
	test "$8" = "$PREVIEW_SECRETS_DIR/$secret"
else
	test "$#" -eq 6
fi
jq -e --arg main ".preview-bundle/$bundle" '.main == $main and .workers_dev == false and .preview_urls == false' wrangler.publish.jsonc >/dev/null
case "$assets" in
	none) jq -e 'has("assets") | not' wrangler.publish.jsonc >/dev/null ;;
	web) jq -e '.assets == {binding: "ASSETS", directory: ".svelte-kit/cloudflare"}' wrangler.publish.jsonc >/dev/null ;;
	marketing) jq -e '.assets == {directory: "./dist/", not_found_handling: "404-page", html_handling: "auto-trailing-slash"}' wrangler.publish.jsonc >/dev/null ;;
esac
printf '%s\\n' "$PWD: $*" >> "$PUBLISH_LOG"
`,
		{ mode: 0o755 }
	)

	async function probeTrustedPublisher(
		mode: PublisherProbeMode
	): Promise<ProbeResult & { invocations: string[] }> {
		await resetDirectory(artifact)
		await writeFile(publishLog, '')
		const authName = configs['services/auth']?.name
		if (!authName) throw new Error('Preview auth Worker config is missing')
		for (const worker of workers) {
			const bundle = bundles[worker.directory]
			if (!bundle) throw new Error(`No preview bundle contract exists for ${worker.directory}`)
			const target = join(artifact, worker.directory)
			await mkdir(join(target, '.preview-bundle'), { recursive: true })
			const config = structuredClone(configs[worker.directory]!)
			if (mode === 'collision' && worker.directory === 'apps/api') config.name = authName
			if (mode === 'collision' && worker.directory === 'apps/web' && config.services) {
				config.services = config.services.map((service) =>
					service.binding === 'GATEWAY' ? { ...service, service: authName } : service
				)
			}
			if (mode === 'route' && worker.directory === 'apps/web') config.routes = [{ pattern: 'production.example.com/*', zone_name: 'example.com' }]
			if (worker.directory === 'apps/api') {
				if (mode === 'gateway-api-origin') {
					config.vars = {
						...(config.vars ?? {}),
						API_PUBLIC_ORIGIN: 'https://api.example.com'
					}
				}
				if (mode === 'gateway-public-origins') {
					config.vars = {
						...(config.vars ?? {}),
						GATEWAY_PUBLIC_ORIGINS: `${config.vars?.GATEWAY_PUBLIC_ORIGINS ?? ''},https://app.example.com`
					}
				}
				if (mode === 'gateway-cors-origins') {
					config.vars = {
						...(config.vars ?? {}),
						API_CORS_ORIGINS: `${config.vars?.API_CORS_ORIGINS ?? ''},https://unrelated.example.net`
					}
				}
				if (mode === 'missing-var') delete config.vars?.API_PUBLIC_ORIGIN
				if (mode === 'reordered-vars') {
					config.vars = Object.fromEntries(
						Object.entries(config.vars ?? {}).reverse()
					)
				}
			}
			if (worker.directory === 'services/auth') {
				if (mode === 'auth-hosts') {
					config.vars = {
						...(config.vars ?? {}),
						BETTER_AUTH_ALLOWED_HOSTS: `${config.vars?.BETTER_AUTH_ALLOWED_HOSTS ?? ''},app.example.com`
					}
				}
				if (mode === 'auth-cors-origins') {
					config.vars = {
						...(config.vars ?? {}),
						AUTH_CORS_ORIGINS: `${config.vars?.AUTH_CORS_ORIGINS ?? ''},https://unrelated.example.net`
					}
				}
				if (mode === 'reordered-vars') {
					config.vars = Object.fromEntries(
						Object.entries(config.vars ?? {}).reverse()
					)
				}
			}
			if (mode === 'extra-vars' && worker.directory === 'services/users') config.vars = { INJECTED_VARIABLE: 'production-value' }
			if (mode === 'd1-binding' && worker.directory === 'services/users') {
				config.d1_databases = [
					...(config.d1_databases ?? []),
					{
						binding: 'PRODUCTION',
						database_name: 'production-db',
						database_id: '99999999-9999-4999-8999-999999999999'
					}
				]
			}
			await writeFile(join(target, 'wrangler.staging.jsonc'), JSON.stringify(config))
			await writeFile(join(target, '.preview-bundle', bundle), mode === 'hostile-auth' && worker.directory === 'services/auth'
				? 'export default { fetch(request, env) { return new Response(env.BETTER_AUTH_SECRET) } }\n'
				: 'export default {}\n')
		}
		const result = await runProbe({
			executable: 'sh',
			args: ['scripts/publish-cloudflare-preview.sh'],
			cwd: project,
			env: {
				PATH: `${join(project, '.verify-bin')}:${process.env.PATH ?? ''}`,
				PREVIEW_ARTIFACT: artifact,
				PREVIEW_SECRETS_DIR: previewSecretDirectory,
				TRUSTED_SOURCE: project,
				STAGING_ALIAS: alias,
				CLOUDFLARE_PREVIEW_ZONE_NAME: previewZoneName,
				CLOUDFLARE_PREVIEW_WEB_DOMAIN: previewWebDomain,
				CLOUDFLARE_PREVIEW_API_DOMAIN: previewApiDomain,
				PUBLISH_LOG: publishLog,
				PUBLISH_AUTH_SECRET: publishAuthSecret,
				PUBLISH_USERS_SECRET: publishUsersSecret,
				...(provider === 'd1'
					? {
							STAGING_D1_DATABASE_NAME: previewDatabaseName,
							STAGING_D1_DATABASE_ID: previewDatabaseId
						}
					: {})
			}
		})
		return {
			...result,
			invocations: (await readOptional(publishLog)).trim().split('\n').filter(Boolean)
		}
	}

	const valid = await probeTrustedPublisher('valid')
	requirePassed(valid, 'trusted preview publisher')
	if (valid.invocations.length !== workers.length) throw new Error('trusted preview publisher did not invoke Wrangler once per Worker')

	const hostile = await probeTrustedPublisher('hostile-auth')
	requirePassed(hostile, 'authorized hostile auth bundle with safe configuration')
	if (hostile.invocations.length !== workers.length) throw new Error('hostile auth bundle did not reach passive publication')
	if (publishAuthSecret) {
		const secrets = JSON.parse(await readFile(join(previewSecretDirectory, 'auth.json'), 'utf8'))
		const bundle = await import(join(artifact, 'services/auth/.preview-bundle/index.js'))
		const response = await bundle.default.fetch(new Request('https://preview.example.test/api/auth/leak'), secrets)
		if (await response.text() !== secrets.BETTER_AUTH_SECRET) throw new Error('authorized application binding access was not demonstrated')
		if (!hostile.invocations.some((line) => line.includes('services/auth') && line.includes('--secrets-file'))) throw new Error('auth publication omitted preview bindings')
	}
	await writeFile(join(root, 'hostile-auth-evidence.json'), JSON.stringify({ safeConfiguration: true, passivePublishCount: hostile.invocations.length, permittedBindingReadable: Boolean(publishAuthSecret) }, null, 2))

	const reorderedVariables = await probeTrustedPublisher('reordered-vars')
	requirePassed(reorderedVariables, 'reordered preview runtime variables')
	if (reorderedVariables.invocations.length !== workers.length) throw new Error('semantically equivalent reordered runtime variables did not reach every Wrangler invocation')

	const variableAttacks: Array<{
		mode: PublisherProbeMode
		name: string
		target: string
		result: string
	}> = [
		{
			mode: 'gateway-api-origin',
			name: 'production preview API origin',
			target: 'apps/api',
			result: 'publisher-unsafe-api-origin'
		},
		{
			mode: 'gateway-public-origins',
			name: 'production gateway public origin',
			target: 'apps/api',
			result: 'publisher-unsafe-gateway-public-origins'
		},
		{
			mode: 'gateway-cors-origins',
			name: 'unrelated gateway CORS origin',
			target: 'apps/api',
			result: 'publisher-unsafe-gateway-cors-origins'
		},
		{
			mode: 'auth-hosts',
			name: 'production auth host',
			target: 'services/auth',
			result: 'publisher-unsafe-auth-hosts'
		},
		{
			mode: 'auth-cors-origins',
			name: 'unrelated auth CORS origin',
			target: 'services/auth',
			result: 'publisher-unsafe-auth-cors-origins'
		},
		{
			mode: 'extra-vars',
			name: 'extra users runtime variable',
			target: 'services/users',
			result: 'publisher-extra-runtime-variable'
		},
		{
			mode: 'missing-var',
			name: 'missing gateway runtime variable',
			target: 'apps/api',
			result: 'publisher-missing-runtime-variable'
		}
	]
	for (const attack of variableAttacks) {
		const rejected = await probeTrustedPublisher(attack.mode)
		requireRejected({
			result: rejected,
			name: attack.name,
			message: `Preview runtime variables are unsafe for ${attack.target}.`
		})
		if (rejected.invocations.length !== 0) throw new Error(`${attack.name} reached Wrangler`)
	}

	const binding = await probeTrustedPublisher('d1-binding')
	requireRejected({
		result: binding,
		name: 'unsafe preview D1 binding',
		message:
			provider === 'd1'
				? 'Preview D1 bindings are unsafe for services/users.'
				: 'Preview D1 bindings are forbidden for services/users.'
	})
	if (binding.invocations.length !== 0) throw new Error('unsafe D1 binding reached Wrangler')

	const route = await probeTrustedPublisher('route')
	requireRejected({
		result: route,
		name: 'unsafe preview route',
		message: 'Preview routes are unsafe for apps/web.'
	})
	if (route.invocations.length !== 0) throw new Error('unsafe preview route reached Wrangler')

	const collision = await probeTrustedPublisher('collision')
	requireRejected({
		result: collision,
		name: 'preview Worker identity collision',
		message: 'Preview Worker name is unsafe for apps/api.'
	})
	if (collision.invocations.length !== 0) throw new Error('Worker identity collision reached Wrangler')

	return [
		'publisher-valid',
		'publisher-authorized-hostile-auth-safe-configuration',
		'publisher-reordered-runtime-variables',
		...variableAttacks.map(({ result }) => result),
		'publisher-unsafe-d1-binding',
		'publisher-unsafe-route',
		'publisher-worker-collision'
	]
}

type AuthorizationWorkflow = {
	on: Record<string, unknown>
	jobs: Record<string, {
		needs?: string | string[]
		if?: string
		env?: Record<string, string>
		environment?: string
		steps: Array<{ id?: string; name?: string; run?: string; uses?: string; with?: Record<string, unknown>; env?: Record<string, string> }>
	}>
}

export async function verifyAutomaticPullRequestChecks(project: string): Promise<string[]> {
	const root = join(project, '.wrangler/verify-automatic-pr-checks')
	await resetDirectory(root)
	const workflow = Bun.YAML.parse(await readFile(join(project, '.github/workflows/check-pr.yml'), 'utf8')) as AuthorizationWorkflow & { env?: Record<string, string> }
	const job = workflow.jobs.check
	if (!job || job.environment || /secrets\./.test(JSON.stringify(workflow))) throw new Error('Automatic PR checks must remain credential-free')
	const variables: Record<string, string> = {
		PUBLIC_TURNSTILE_SITE_KEY: '1x00000000000000000000AA',
		PUBLIC_MARKETING_URL: 'https://marketing.preview-verification.example',
		PUBLIC_APP_URL: 'https://app.preview-verification.example',
		PUBLIC_UMAMI_HOST: 'https://analytics.preview-verification.example',
		PUBLIC_UMAMI_WEBSITE_ID: 'synthetic-website-id',
		PUBLIC_POSTHOG_KEY: 'synthetic-public-key',
		PUBLIC_POSTHOG_HOST: 'https://analytics.preview-verification.example'
	}
	const results: string[] = []
	for (const task of ['typecheck', 'lint', 'build']) {
		const step = job.steps.find((candidate) => candidate.run === 'pnpm ' + task)
		if (!step?.run) throw new Error('Missing automatic PR ' + task + ' step')
		const env: Record<string, string> = { PATH: join(project, '.verify-bin') + ':' + process.env.PATH, CI: 'true', WRANGLER_SEND_METRICS: 'false' }
		for (const key of ['HOME', 'TMPDIR', 'XDG_CONFIG_HOME']) if (process.env[key]) env[key] = process.env[key]!
		for (const [key, value] of Object.entries({ ...workflow.env, ...job.env, ...step.env })) {
			const variable = /^\$\{\{ vars\.([A-Z_]+) \}\}$/.exec(value)
			if (variable) {
				if (!(variable[1]! in variables)) throw new Error('Unstubbed public CI variable: ' + variable[1])
				env[key] = variables[variable[1]!]!
			} else {
				if (value.includes('${{')) throw new Error('Unsupported automatic CI expression: ' + value)
				env[key] = value
			}
		}
		const result = await runProbe({ executable: 'bash', args: ['-e', '-c', step.run], cwd: project, env, inheritEnvironment: false })
		await writeFile(join(root, task + '.json'), JSON.stringify({ command: step.run, workflowEnvironment: { ...workflow.env, ...job.env, ...step.env }, resolvedPublicEnvironment: Object.fromEntries(Object.entries(env).filter(([key]) => key.startsWith('PUBLIC_'))), inheritedCredentials: false, ...result }, null, 2))
		requirePassed(result, 'automatic PR ' + task)
		results.push('automatic-pr-' + task)
	}
	await writeFile(join(root, 'summary.json'), JSON.stringify({ results, dependencySetup: 'Dependencies installed separately by the workspace verifier; actual emitted typecheck, lint and build steps executed with only their declared public inputs.' }, null, 2))
	return results
}

async function verifyPreviewCredentialBoundary(project: string, api: Record<string, unknown>): Promise<string[]> {
	const root = join(project, '.wrangler/verify-preview-credential-boundary')
	await resetDirectory(root)
	const staging = Bun.YAML.parse(await readFile(join(project, '.github/workflows/deploy-staging.yml'), 'utf8')) as AuthorizationWorkflow
	const ci = Bun.YAML.parse(await readFile(join(project, '.github/workflows/check-pr.yml'), 'utf8')) as AuthorizationWorkflow
	const cleanup = Bun.YAML.parse(await readFile(join(project, '.github/workflows/cleanup-staging.yml'), 'utf8')) as AuthorizationWorkflow
	for (const name of ['preview-ingress', 'preview-db', 'deploy']) if (staging.jobs[name]?.environment !== 'cloudflare-preview') throw new Error(`${name} lacks the external preview credential boundary`)
	if (cleanup.jobs.cleanup?.environment !== 'cloudflare-preview') throw new Error('Cleanup cannot access protected preview credentials')
	if (staging.jobs.authorize?.environment || staging.jobs['build-preview']?.environment || ci.jobs.check?.environment) throw new Error('Authorization or untrusted checks can request preview credentials')
	if (!cleanup.jobs.cleanup.steps.some((step) => step.id === 'credential_policy' && step.run === 'node scripts/verify-cloudflare-preview-policy.mjs --verify')) throw new Error('Cleanup does not verify credential protection')
	const reference = staging.jobs['preview-ingress']!.steps.find((step) => step.env?.CLOUDFLARE_API_TOKEN)?.env?.CLOUDFLARE_API_TOKEN
	if (reference !== '${{ secrets.PREVIEW_CLOUDFLARE_API_TOKEN }}') throw new Error('Preview credential reference has an unsafe legacy fallback')
	const environmentPolicy = api['/repos/owner/repository/environments/cloudflare-preview/deployment-branch-policies'] as { branch_policies: Array<{ name: string; type: string }> }
	const policies = environmentPolicy.branch_policies
	const receipts: Array<{ name: string; credentials: number; receipts: number; exitCode: number }> = []
	for (const scenario of [
		{ name: 'writer-branch-dispatch', ref: 'refs/heads/feature', environment: 'cloudflare-preview', workflow: staging, allowed: false },
		{ name: 'writer-same-repository-pr', ref: 'refs/pull/181/merge', environment: 'cloudflare-preview', workflow: ci, allowed: false },
		{ name: 'writer-removes-environment', ref: 'refs/heads/feature', environment: '', workflow: staging, allowed: false },
		{ name: 'writer-selects-unconfigured-environment', ref: 'refs/heads/feature', environment: 'writer-preview', workflow: staging, allowed: false },
		{ name: 'writer-tag-named-main', ref: 'refs/tags/main', environment: 'cloudflare-preview', workflow: staging, allowed: false },
		{ name: 'trusted-default-branch-credential-access', ref: 'refs/heads/main', environment: 'cloudflare-preview', workflow: staging, allowed: true }
	]) {
		const directory = join(root, scenario.name)
		await mkdir(directory)
		const receipt = join(directory, 'privileged-receipts.log')
		await writeFile(receipt, '')
		const modified = structuredClone(scenario.workflow)
		modified.jobs['independent-writer-job'] = {
			environment: scenario.environment,
			steps: [{ run: 'test -n "$CLOUDFLARE_API_TOKEN"\nprintf "privileged\\n" >> "$RECEIPT"', env: { CLOUDFLARE_API_TOKEN: reference } }]
		}
		await writeFile(join(directory, 'modified-workflow.json'), JSON.stringify(modified, null, 2))
		const injected = modified.jobs['independent-writer-job']!
		// Model only GitHub's documented environment/ref secret release, never the application gate.
		const released = injected.environment === 'cloudflare-preview' && policies.some((policy) => policy.type === 'branch' && scenario.ref === 'refs/heads/' + policy.name)
		const result = await runProbe({ executable: 'bash', args: ['-e', '-c', injected.steps[0]!.run!], cwd: directory, env: { CLOUDFLARE_API_TOKEN: released ? 'synthetic-provider-token' : '', RECEIPT: receipt } })
		const reached = Boolean(await readOptional(receipt))
		await writeFile(join(directory, 'result.json'), JSON.stringify({ ...result, released, reached }, null, 2))
		if (released !== scenario.allowed || reached !== scenario.allowed) throw new Error(`${scenario.name} violated the external credential boundary`)
		receipts.push({ name: scenario.name, credentials: Number(released), receipts: Number(reached), exitCode: result.exitCode })
	}
	await writeFile(join(root, 'summary.json'), JSON.stringify({ receipts, limitation: 'Synthetic GitHub environment/ref release model with actual emitted credential references and modified workflows. Not live GitHub scheduling. Trusted default-branch source integrity is checked separately by the emitted policy script; writer branch modifications never become trusted default source.' }, null, 2))
	return receipts.map(({ name }) => 'credential-boundary-' + name)
}

export async function verifyPreviewAuthorization(project: string): Promise<string[]> {
	const workflow = Bun.YAML.parse(await readFile(join(project, '.github/workflows/deploy-staging.yml'), 'utf8')) as AuthorizationWorkflow
	const root = join(project, '.wrangler/verify-preview-authorization')
	await resetDirectory(root)
	const preload = join(root, 'github-fixture.mjs')
	await writeFile(preload, `import { readFileSync } from 'node:fs'
globalThis.fetch = async (url, options) => {
 if (!String(url).startsWith('https://api.github.com/') || options.headers.Authorization !== 'Bearer synthetic-github-token') throw new Error('Unexpected API request')
 const fixtures = JSON.parse(readFileSync(process.env.API_FIXTURE, 'utf8'))
 const path = new URL(url).pathname
 if (!(path in fixtures)) throw new Error('Unstubbed GitHub request: ' + path)
 const payload = fixtures[path]
 return Response.json(payload, { status: payload === null ? 503 : 200 })
}
`)
	const sha = 'a'.repeat(40)
	const trusted = 'b'.repeat(40)
	const repository = { id: 123456, full_name: 'owner/repository', default_branch: 'main' }
	const actor = { id: 42, login: 'maintainer', type: 'User' }
	const event = { repository, inputs: { pr_number: '181', head_sha: sha } }
	const fixtures = {
		'/repos/owner/repository/environments/cloudflare-preview/secrets': { total_count: [...new Set(JSON.stringify(workflow).match(/secrets\.PREVIEW_(?!POLICY_TOKEN)[A-Z_]+/g))].length, secrets: [...new Set(JSON.stringify(workflow).match(/secrets\.PREVIEW_(?!POLICY_TOKEN)[A-Z_]+/g))].map((name) => ({ name: name.slice(8) })) },
		'/repos/owner/repository/environments/cloudflare-preview': { name: 'cloudflare-preview', deployment_branch_policy: { protected_branches: false, custom_branch_policies: true } },
		'/repos/owner/repository/environments/cloudflare-preview/deployment-branch-policies': { total_count: 1, branch_policies: [{ name: 'main', type: 'branch' }] },
		'/repos/owner/repository/branches/main/protection': { enforce_admins: { enabled: true }, allow_force_pushes: { enabled: false }, allow_deletions: { enabled: false }, restrictions: { users: [actor], teams: [], apps: [] } },
		'/repos/owner/repository/actions/secrets': { total_count: 1, secrets: [{ name: 'PREVIEW_POLICY_TOKEN' }] },
		'/repos/owner/repository/actions/organization-secrets': { total_count: 0, secrets: [] },
		'/repos/owner/repository': repository,
		'/repos/contributor/fork': { id: 654321, full_name: 'contributor/fork' },
		'/repos/owner/repository/pulls/181': { number: 181, state: 'open', base: { repo: repository, ref: 'main' }, head: { sha, repo: { id: 654321, full_name: 'contributor/fork' } } },
		'/repos/owner/repository/collaborators/maintainer/permission': { permission: 'write', role_name: 'maintain', user: actor },
		'/repos/owner/repository/actions/runs/777': { id: 777, event: 'workflow_dispatch', path: '.github/workflows/deploy-staging.yml', repository, head_sha: trusted, head_branch: 'main', actor, triggering_actor: actor, run_attempt: 1 }
	}
	const baseEnv = {
		GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REPOSITORY: repository.full_name,
		GITHUB_REPOSITORY_ID: String(repository.id), GITHUB_REF: 'refs/heads/main',
		GITHUB_SHA: trusted, GITHUB_WORKFLOW_SHA: trusted,
		GITHUB_WORKFLOW_REF: 'owner/repository/.github/workflows/deploy-staging.yml@refs/heads/main',
		GITHUB_ACTOR: actor.login, GITHUB_ACTOR_ID: String(actor.id), GITHUB_TRIGGERING_ACTOR: actor.login,
		GITHUB_RUN_ID: '777', GITHUB_RUN_ATTEMPT: '1', GH_TOKEN: 'synthetic-github-token', PREVIEW_POLICY_TOKEN: 'synthetic-github-token',
		PREVIEW_HEAD_SHA: sha, PREVIEW_PR_NUMBER: '181', NODE_OPTIONS: `--import=${preload}`
	}
	const gate = workflow.jobs.authorize?.steps.find(({ id }) => id === 'authorization')?.run ?? ':'
	await mkdir(join(project, 'trusted-source/scripts'), { recursive: true })
	for (const script of ['authorize-cloudflare-preview.mjs', 'verify-cloudflare-preview-policy.mjs']) await writeFile(join(project, 'trusted-source/scripts', script), await readFile(join(project, 'scripts', script)))
	async function probe({ name, env = {}, api = fixtures, payload = event, contract = '', command = gate, denied = true }: {
		name: string; env?: Record<string, string>; api?: unknown; payload?: unknown; contract?: string; command?: string; denied?: boolean
	}) {
		const directory = join(root, name)
		await mkdir(directory)
		const receipt = join(directory, 'privileged-receipts.log')
		const output = join(directory, 'github-output.txt')
		await writeFile(receipt, '')
		await writeFile(join(directory, 'event.json'), JSON.stringify(payload))
		await writeFile(join(directory, 'api.json'), JSON.stringify(api))
		const result = await runProbe({
			executable: 'bash', args: ['-e', '-c', `${command}\nprintf 'privileged\\n' >> "$RECEIPT"`], cwd: project,
			env: { ...baseEnv, GITHUB_EVENT_PATH: join(directory, 'event.json'), API_FIXTURE: join(directory, 'api.json'), GITHUB_OUTPUT: output, AUTHORIZED_REVISION: contract, RECEIPT: receipt, ...env }
		})
		await writeFile(join(directory, 'result.json'), JSON.stringify(result, null, 2))
		const receipts = await readOptional(receipt)
		if (denied && receipts) throw new Error(`${name} reached privileged work`)
		if (denied && result.exitCode === 0) throw new Error(`${name} unexpectedly passed`)
		if (denied && !/Preview authorization denied:|Invalid preview authorization input:/.test(result.stderr)) throw new Error(`${name} failed outside the authorization gate: ${result.stderr}`)
		if (!denied) requirePassed(result, name)
		return await readOptional(output)
	}
	await probe({ name: 'unsafe-credential-environment', api: { ...fixtures, '/repos/owner/repository/environments/cloudflare-preview': { name: 'cloudflare-preview', deployment_branch_policy: null } } })
	await probe({ name: 'missing-sha', env: { PREVIEW_HEAD_SHA: '' } })
	await probe({ name: 'write-permission', api: { ...fixtures, '/repos/owner/repository/collaborators/maintainer/permission': { permission: 'write', role_name: 'write', user: actor } } })
	const output = await probe({ name: 'valid-maintainer', denied: false })
	const managedActor = { ...actor, login: 'maintainer_acme' }
	const managedEnv = { GITHUB_ACTOR: managedActor.login, GITHUB_TRIGGERING_ACTOR: managedActor.login }
	const managedApi = {
		...fixtures,
		'/repos/owner/repository/collaborators/maintainer_acme/permission': { permission: 'write', role_name: 'maintain', user: managedActor },
		'/repos/owner/repository/actions/runs/777': { ...fixtures['/repos/owner/repository/actions/runs/777'], actor: managedActor, triggering_actor: managedActor }
	}
	await probe({ name: 'valid-managed-maintainer', denied: false, env: managedEnv, api: managedApi })
	const managedPushApi = { ...fixtures, '/repos/owner/repository/collaborators/maintainer_acme/permission': managedApi['/repos/owner/repository/collaborators/maintainer_acme/permission'], '/repos/owner/repository/branches/main/protection': { ...fixtures['/repos/owner/repository/branches/main/protection'], restrictions: { users: [managedActor], teams: [], apps: [] } } }
	await probe({ name: 'valid-managed-push-user', denied: false, api: managedPushApi })
	const managedResults = ['valid-managed-maintainer', 'valid-managed-push-user']
	for (const [role, permission] of [['maintain', 'write'], ['admin', 'admin'], ['write', 'write'], ['read', 'read']] as const) {
		const denied = role === 'write' || role === 'read'
		const permissionResponse = { role_name: role, permission, user: managedActor }
		for (const boundary of ['actor', 'push-user'] as const) {
			const name = 'managed-' + boundary + '-' + role
			await probe({ name, denied, env: boundary === 'actor' ? managedEnv : {}, api: { ...(boundary === 'actor' ? managedApi : managedPushApi), '/repos/owner/repository/collaborators/maintainer_acme/permission': permissionResponse } })
			managedResults.push(name)
		}
	}
	const managedOutput = await probe({ name: 'managed-authorized-revision', denied: false, env: managedEnv, api: managedApi })
	const managedContract = managedOutput.split('\n').find((line) => line.startsWith('revision='))?.slice(9)
	if (!managedContract || JSON.parse(managedContract).actor !== managedActor.login) throw new Error('Managed actor identity lost from revision contract')
	await probe({ name: 'managed-rerun-same-actor', denied: false, command: 'node scripts/authorize-cloudflare-preview.mjs --recheck', contract: managedContract, env: { ...managedEnv, GITHUB_RUN_ATTEMPT: '2' }, api: { ...managedApi, '/repos/owner/repository/actions/runs/777': { ...managedApi['/repos/owner/repository/actions/runs/777'], run_attempt: 2 } } })
	for (const [name, changes] of [['numeric-id-mismatch', { id: 99 }], ['bot-identity', { type: 'Bot' }]] as const) {
		await probe({ name: 'managed-' + name, env: managedEnv, api: { ...managedApi, '/repos/owner/repository/collaborators/maintainer_acme/permission': { permission: 'write', role_name: 'maintain', user: { ...managedActor, ...changes } } } })
		managedResults.push('managed-' + name)
	}
	await probe({ name: 'managed-rerun-other-actor', env: { ...managedEnv, GITHUB_TRIGGERING_ACTOR: 'other_acme' }, api: managedApi })
	managedResults.push('managed-authorized-revision', 'managed-rerun-same-actor', 'managed-rerun-other-actor')
	const contract = output.split('\n').find((line) => line.startsWith('revision='))?.slice(9)
	if (!contract) throw new Error('Authorization did not emit an immutable revision contract')
	const resolved = JSON.parse(contract)
	if (resolved.headSha !== sha || resolved.trustedSha !== trusted || resolved.prNumber !== '181' || resolved.alias !== 'pr-181' || resolved.repositoryId !== '123456' || resolved.headRepository !== 'contributor/fork') throw new Error('Resolved preview identity mismatch')
	const attacks: Array<{ name: string; env?: Record<string, string>; api?: unknown; payload?: unknown }> = [
		{ name: 'missing-policy-token', env: { PREVIEW_POLICY_TOKEN: '' } },
		{ name: 'missing-preview-secrets', api: { ...fixtures, '/repos/owner/repository/environments/cloudflare-preview/secrets': { total_count: 0, secrets: [] } } },
		{ name: 'repository-secret-fallback', api: { ...fixtures, '/repos/owner/repository/actions/secrets': { total_count: 2, secrets: [{ name: 'PREVIEW_POLICY_TOKEN' }, { name: 'CLOUDFLARE_API_TOKEN' }] } } },
		{ name: 'organization-secret-fallback', api: { ...fixtures, '/repos/owner/repository/actions/organization-secrets': { total_count: 1, secrets: [{ name: 'PREVIEW_CLOUDFLARE_API_TOKEN' }] } } },
		{ name: 'truncated-secret-inventory', api: { ...fixtures, '/repos/owner/repository/actions/secrets': { total_count: 101, secrets: [] } } },
		{ name: 'writer-default-branch-access', api: { ...fixtures, '/repos/owner/repository/branches/main/protection': { ...fixtures['/repos/owner/repository/branches/main/protection'], restrictions: { users: [{ id: 43, login: 'writer', type: 'User' }], teams: [], apps: [] } }, '/repos/owner/repository/collaborators/writer/permission': { permission: 'write', role_name: 'write', user: { id: 43, login: 'writer', type: 'User' } } } },
		{ name: 'malformed-sha', env: { PREVIEW_HEAD_SHA: 'abc' } },
		{ name: 'zero-sha', env: { PREVIEW_HEAD_SHA: '0'.repeat(40) } },
		{ name: 'missing-pr', env: { PREVIEW_PR_NUMBER: '' } },
		{ name: 'malformed-pr', env: { PREVIEW_PR_NUMBER: '181;echo injected' } },
		{ name: 'wrong-pr-input', env: { PREVIEW_PR_NUMBER: '182' } },
		{ name: 'wrong-repository', env: { GITHUB_REPOSITORY: 'other/repository' } },
		{ name: 'wrong-repository-id', env: { GITHUB_REPOSITORY_ID: '999' } },
		{ name: 'wrong-ref', env: { GITHUB_REF: 'refs/heads/feature' } },
		{ name: 'wrong-workflow-ref', env: { GITHUB_WORKFLOW_REF: 'owner/repository/.github/workflows/evil.yml@refs/heads/main' } },
		{ name: 'wrong-trusted-sha', env: { GITHUB_WORKFLOW_SHA: sha } },
		{ name: 'inputless-dispatch', payload: { repository, inputs: {} } },
		{ name: 'pull-request-target', env: { GITHUB_EVENT_NAME: 'pull_request_target' } },
		{ name: 'synchronize', env: { GITHUB_EVENT_NAME: 'pull_request' }, payload: { ...event, action: 'synchronize' } },
		{ name: 'unexpected-rerun-actor', env: { GITHUB_TRIGGERING_ACTOR: 'other-maintainer', GITHUB_RUN_ATTEMPT: '2' } }
	]
	for (const [name, changes] of [
		['closed-pr', { state: 'closed' }], ['wrong-pr-response', { number: 182 }],
		['stale-head', { head: { ...fixtures['/repos/owner/repository/pulls/181'].head, sha: 'c'.repeat(40) } }],
		['wrong-pr-base', { base: { repo: { ...repository, id: 999 }, ref: 'main' } }],
		['missing-head-repository', { head: { sha, repo: null } }]
	] as const) attacks.push({ name, api: { ...fixtures, '/repos/owner/repository/pulls/181': { ...fixtures['/repos/owner/repository/pulls/181'], ...changes } } })
	for (const [name, policy] of [
		['wildcard-environment-branch', { total_count: 1, branch_policies: [{ name: '*', type: 'branch' }] }],
		['tag-environment-policy', { total_count: 1, branch_policies: [{ name: 'main', type: 'tag' }] }],
		['pr-environment-policy', { total_count: 2, branch_policies: [{ name: 'main', type: 'branch' }, { name: 'refs/pull/*/merge', type: 'branch' }] }],
		['missing-environment-branch-policy', { total_count: 0, branch_policies: [] }]
	] as const) attacks.push({ name, api: { ...fixtures, '/repos/owner/repository/environments/cloudflare-preview/deployment-branch-policies': policy } })
	for (const [name, protection] of [
		['unprotected-default-branch', {}], ['admin-protection-bypass', { enforce_admins: { enabled: false } }],
		['force-push-enabled', { allow_force_pushes: { enabled: true } }], ['branch-deletion-enabled', { allow_deletions: { enabled: true } }],
		['unrestricted-default-branch', { restrictions: null }], ['team-push-access', { restrictions: { users: [], teams: [{ id: 1 }], apps: [] } }],
		['app-push-access', { restrictions: { users: [], teams: [], apps: [{ id: 1 }] } }]
	] as const) attacks.push({ name, api: { ...fixtures, '/repos/owner/repository/branches/main/protection': name === 'unprotected-default-branch' ? protection : { ...fixtures['/repos/owner/repository/branches/main/protection'], ...protection } } })
	for (const endpoint of Object.keys(fixtures)) attacks.push({ name: 'api-failure-' + endpoint.replace('/repos/', '').replaceAll('/', '-'), api: { ...fixtures, [endpoint]: null } })
	attacks.push({ name: 'revoked-permission', api: { ...fixtures, '/repos/owner/repository/collaborators/maintainer/permission': { permission: 'read', role_name: 'read', user: actor } } })
	attacks.push({ name: 'missing-permission-identity', api: { ...fixtures, '/repos/owner/repository/collaborators/maintainer/permission': { permission: 'admin', role_name: 'admin', user: null } } })
	attacks.push({ name: 'custom-role', api: { ...fixtures, '/repos/owner/repository/collaborators/maintainer/permission': { permission: 'write', role_name: 'custom', user: actor } } })
	attacks.push({ name: 'api-rerun-actor-mismatch', api: { ...fixtures, '/repos/owner/repository/actions/runs/777': { ...fixtures['/repos/owner/repository/actions/runs/777'], triggering_actor: { ...actor, id: 999 } } } })
	for (const attack of attacks) await probe(attack)
	await probe({ name: 'valid-admin-self-approval', denied: false, api: { ...fixtures, '/repos/owner/repository/collaborators/maintainer/permission': { permission: 'admin', role_name: 'admin', user: actor }, '/repos/owner/repository/pulls/181': { ...fixtures['/repos/owner/repository/pulls/181'], user: actor } } })
	const recheck = 'node scripts/authorize-cloudflare-preview.mjs --recheck'
	await probe({ name: 'valid-rerun-same-actor', denied: false, command: recheck, contract, env: { GITHUB_RUN_ATTEMPT: '2' }, api: { ...fixtures, '/repos/owner/repository/actions/runs/777': { ...fixtures['/repos/owner/repository/actions/runs/777'], run_attempt: 2 } } })
	await probe({ name: 'missing-contract', command: recheck })
	await probe({ name: 'forged-contract', command: recheck, contract: JSON.stringify({ ...resolved, headSha: trusted }) })
	if (Object.keys(workflow.on).join(',') !== 'workflow_dispatch') throw new Error('Preview has an automatic event bypass')
	if (!workflow.jobs.authorize?.if?.includes("github.event_name == 'workflow_dispatch'")) throw new Error('Authorization job lacks trusted dispatch scheduling')
	const boundaryCommands: string[] = []
	for (const jobName of ['preview-ingress', 'preview-db', 'deploy']) {
		const job = workflow.jobs[jobName]!
		if (![job.needs].flat().includes('authorize') || job.env?.AUTHORIZED_REVISION !== '${{ needs.authorize.outputs.revision }}') throw new Error(`${jobName} is not downstream of authorization`)
		for (const [index, step] of job.steps.entries()) {
			const privileged = Object.values(step.env ?? {}).some((value) => value.includes('secrets.') || value.includes('outputs.database_url')) || step.uses?.startsWith('neondatabase/')
			if (!privileged) continue
			const command = step.run ?? job.steps[index - 1]?.run ?? ''
			if (!command.includes('authorize-cloudflare-preview.mjs --recheck')) throw new Error(`${step.name} lacks a credential-boundary recheck`)
			boundaryCommands.push(command.replaceAll(/\$\{\{[^}]+\}\}/g, 'synthetic-preview-value'))
		}
	}
	if (boundaryCommands.length < 4) throw new Error('Missing credential boundary scenarios')
	const receiptsOnly = `node() { case "$1" in *authorize-cloudflare-preview.mjs) command node "$@" ;; *) printf 'node:%s\\n' "$1" >> "$RECEIPT" ;; esac; }\nnpx() { printf 'provider\\n' >> "$RECEIPT"; }\nsh() { printf 'publisher\\n' >> "$RECEIPT"; }\n`
	for (const [index, command] of boundaryCommands.entries()) {
		for (const name of ['stale-head', 'revoked-permission', 'api-failure-owner-repository-collaborators-maintainer-permission', 'unexpected-rerun-actor', 'writer-default-branch-access', 'repository-secret-fallback', 'wildcard-environment-branch']) {
			const attack = attacks.find((candidate) => candidate.name === name)!
			await probe({ ...attack, name: `boundary-${index}-${name}`, command: receiptsOnly + command, contract, env: { ...attack.env, RUNNER_TEMP: root } })
		}
	}
	const cleanupWorkflow = Bun.YAML.parse(await readFile(join(project, '.github/workflows/cleanup-staging.yml'), 'utf8')) as AuthorizationWorkflow
	const cleanupPolicy = cleanupWorkflow.jobs.cleanup?.steps.find(({ id }) => id === 'credential_policy')?.run
	if (!cleanupPolicy) throw new Error('Cleanup policy execution seam is missing')
	await probe({ name: 'cleanup-valid-closed-pr', command: cleanupPolicy, denied: false, env: { GITHUB_EVENT_NAME: 'pull_request_target', PREVIEW_HEAD_SHA: '' }, api: { ...fixtures, '/repos/owner/repository/pulls/181': { ...fixtures['/repos/owner/repository/pulls/181'], state: 'closed' } } })
	await probe({ name: 'cleanup-unsafe-protection', command: cleanupPolicy, api: { ...fixtures, '/repos/owner/repository/branches/main/protection': {} } })
	await probe({ name: 'preinstallation-protection-check', command: 'node scripts/verify-cloudflare-preview-policy.mjs --check-protection', denied: false, api: { ...fixtures, '/repos/owner/repository/environments/cloudflare-preview/secrets': { total_count: 0, secrets: [] } } })
	const credentialBoundaryResults = await verifyPreviewCredentialBoundary(project, fixtures)
	const results = [...credentialBoundaryResults, 'credential-policy-cleanup-valid-closed-pr', 'credential-policy-cleanup-unsafe-protection', 'credential-policy-preinstallation-check', 'authorization-unsafe-credential-environment', 'authorization-missing-sha', 'authorization-write-permission', 'authorization-valid-maintainer', ...managedResults.map((name) => 'authorization-' + name), ...attacks.map(({ name }) => 'authorization-' + name), 'authorization-valid-admin-self-approval', 'authorization-valid-rerun-same-actor', 'authorization-immutable-contract', `authorization-${boundaryCommands.length}-credential-boundaries`]
	await writeFile(join(root, 'summary.json'), JSON.stringify({ results, revision: resolved }, null, 2))
	return results
}

export async function verifyPreviewSecurityContracts({
	project,
	cleanupWorkflow,
	workers,
	alias,
	repositoryId,
	database,
	previewSecretDirectory,
	previewZoneName,
	previewWebDomain,
	previewApiDomain
}: PreviewSecurityOptions): Promise<string[]> {
	const parsed = Bun.YAML.parse(cleanupWorkflow) as {
		jobs: { cleanup: { steps: Array<{ id?: string; run?: string }> } }
	}
	const steps = parsed.jobs.cleanup.steps
	const inventorySource = steps
		.find(({ id }) => id === 'preview_inventories')
		?.run?.replaceAll('${{ steps.alias.outputs.alias }}', alias)
	const databaseSource = steps
		.find(({ id }) => id === 'database_cleanup')
		?.run?.replaceAll('${{ github.repository_id }}', repositoryId)
		.replaceAll('${{ steps.alias.outputs.alias }}', alias)
	const cleanupResultSource = steps.find(({ id }) => id === 'cleanup_result')?.run
	if (!inventorySource || !databaseSource || !cleanupResultSource) throw new Error('preview cleanup workflow is missing a security verification seam')

	const results = await verifyPreviewAuthorization(project)
	results.push(...await verifyPreviewCleanup(project))
	results.push(...await verifyPreviewMigrations(project))
	results.push(...await verifyWorkerCleanup({ project, workers, alias }))
	results.push(
		...(await verifyLegacyInventoryAuthentication({
			project,
			source: inventorySource,
			alias,
			provider: database.provider,
			repositoryId
		})),
		await verifyCleanupResult({ project, source: cleanupResultSource, alias }),
		...(await verifyDatabaseCleanup({
			project,
			source: databaseSource,
			provider: database.provider,
			alias,
			repositoryId,
			previewName: database.name,
			previewId: database.id
		})),
		...(await verifyTrustedPublisher({
			project,
			workers,
			provider: database.provider,
			alias,
			previewSecretDirectory,
			previewZoneName,
			previewWebDomain,
			previewApiDomain,
			previewDatabaseName: database.name,
			previewDatabaseId: database.id
		}))
	)
	return results
}

if (import.meta.main) {
	const cleanupOnly = process.argv.includes('--cleanup-only')
	const args = process.argv.slice(2).filter((arg) => arg !== '--cleanup-only')
	if (args.length !== 4 || args[0] !== '--fixture' || args[2] !== '--output' || !/^[a-z0-9-]+$/.test(args[1]!)) throw new Error('Usage: bun scripts/verify-gateway-preview-security.ts --fixture <fixture> --output <new-owned-directory> [--cleanup-only]')
	const project = resolve(args[3]!)
	const cfg = GvKitConfig.parse(parseJsonc(await readFile(resolve('fixtures', args[1]! + '.jsonc'), 'utf8')))
	if (cfg.choices.backend !== 'hono' || cfg.choices.deploy !== 'cf-workers') throw new Error('Preview migration verification requires a Hono Cloudflare fixture')
	await mkdir(dirname(project), { recursive: true })
	await mkdir(project)
	for (const entry of runGenerators(cfg)) {
		await mkdir(dirname(join(project, entry.path)), { recursive: true })
		await writeFile(join(project, entry.path), entry.content)
	}
	console.log(await verifyPreviewCleanup(project))
	if (!cleanupOnly) {
		console.log(await verifyPreviewAuthorization(project))
		console.log(await verifyPreviewMigrations(project))
	}
}
