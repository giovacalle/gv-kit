import { spawn } from 'node:child_process'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseJsonc } from '../src/lib/jsonc.js'

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
	input
}: {
	executable: string
	args: string[]
	cwd: string
	env?: Record<string, string>
	input?: string
}): Promise<ProbeResult> {
	const child = spawn(executable, args, {
		cwd,
		env: { ...process.env, ...env },
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
	repositoryId
}: {
	project: string
	source: string
	alias: string
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
		database: {
			kind: 'd1',
			name: `verification-db-${alias}`,
			id: '55555555-5555-4555-8555-555555555555'
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
		message: 'has no trusted successful deployment run.'
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
test "$6" = 'wrangler.publish.json'
if [ -n "$secret" ]; then
	test "$#" -eq 8
	test "$7" = '--secrets-file'
	test "$8" = "$PREVIEW_SECRETS_DIR/$secret"
else
	test "$#" -eq 6
fi
jq -e --arg main ".preview-bundle/$bundle" '.main == $main and .workers_dev == false and .preview_urls == false' wrangler.publish.json >/dev/null
case "$assets" in
	none) jq -e 'has("assets") | not' wrangler.publish.json >/dev/null ;;
	web) jq -e '.assets == {binding: "ASSETS", directory: ".svelte-kit/cloudflare"}' wrangler.publish.json >/dev/null ;;
	marketing) jq -e '.assets == {directory: "./dist/", not_found_handling: "404-page", html_handling: "auto-trailing-slash"}' wrangler.publish.json >/dev/null ;;
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
			await writeFile(join(target, '.preview-bundle', bundle), 'export default {}\n')
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
		'publisher-reordered-runtime-variables',
		...variableAttacks.map(({ result }) => result),
		'publisher-unsafe-d1-binding',
		'publisher-unsafe-route',
		'publisher-worker-collision'
	]
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

	const results = await verifyWorkerCleanup({ project, workers, alias })
	results.push(
		...(await verifyLegacyInventoryAuthentication({
			project,
			source: inventorySource,
			alias,
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
