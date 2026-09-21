import { spawnSync } from 'node:child_process'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

type Step = { id?: string; name?: string; run?: string; if?: string; env?: Record<string, string> }
type Result = { exitCode: number; stdout: string; stderr: string }
type Scenario = {
	name: string
	event?: string
	conclusion?: string
	run?: Record<string, unknown>
	manifest?: Record<string, unknown> | string
	artifactName?: string
	fault?: 'absent' | 'listing' | 'download' | 'archive' | 'partial' | 'deletion' | 'multiple'
	rejected?: boolean
}

function execute({ source, project, env }: { source: string; project: string; env: Record<string, string> }): Result {
	const result = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-s'], {
		cwd: project, input: source, env, encoding: 'utf8', timeout: 20_000, maxBuffer: 1024 * 1024
	})
	if (result.error) throw result.error
	return { exitCode: result.status ?? 1, stdout: result.stdout, stderr: result.stderr }
}

// Provider commands only update this scenario's synthetic inventory and deletion receipts.
const providerStub = `import { readFileSync, writeFileSync, appendFileSync } from 'node:fs'
const [command, ...args] = process.argv.slice(2)
const state = JSON.parse(readFileSync(process.env.STATE, 'utf8'))
const fixtures = JSON.parse(readFileSync(process.env.FIXTURES, 'utf8'))
const request = args.join(' ')
appendFileSync(process.env.REQUESTS, JSON.stringify({ command, args }) + '\\n')
const output = (value) => console.log(JSON.stringify(value))
function remove(kind, id) {
 appendFileSync(process.env.RECEIPTS, JSON.stringify({ kind, id }) + '\\n')
 if (id === process.env.FAIL_WORKER || id === process.env.FAIL_DATABASE) process.exit(17)
 state[kind] = state[kind].filter((row) => row.id !== id)
 writeFileSync(process.env.STATE, JSON.stringify(state))
}
if (command === 'gh') {
 if (request === 'api --paginate --slurp /repos/owner/repository/actions/artifacts?per_page=100') {
  if (fixtures.fault === 'listing') process.exit(17)
  output([{ artifacts: fixtures.artifacts }])
 } else if (request.startsWith('api /repos/owner/repository/actions/runs/')) {
  const run = fixtures.runs[args[1].split('/').pop()]
  if (!run) throw new Error('Unstubbed run')
  output(run)
 } else if (request.startsWith('api /repos/owner/repository/actions/artifacts/')) {
  if (fixtures.fault === 'download') { process.stdout.write('partial'); process.exit(17) }
  process.stdout.write(readFileSync(fixtures.archive))
 } else if (request === 'api /repos/owner/repository/contents/.github/workflows/deploy-staging.yml?ref=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa --jq .content') {
  console.log(Buffer.from('# Per-PR staging deploy for verification.\\n').toString('base64'))
 } else throw new Error('Unstubbed GitHub request: ' + request)
} else if (command === 'npx' && request === 'wrangler@4.125.0 d1 list --json') {
 output(state.databases.map(({ name, id }) => ({ name, uuid: id })))
} else if (command === 'npx' && args.length === 5 && args[0] === 'wrangler@4.125.0' && args[1] === 'd1' && args[2] === 'delete' && args[4] === '--skip-confirmation') {
 remove('databases', args[3])
} else if (command === 'npx' && args.length === 5 && args[0] === 'wrangler@4.125.0' && args[1] === 'delete' && args[2] === '--name' && args[4] === '--force') {
 remove('workers', args[3])
} else if (command === 'curl' && request === '-fsS https://api.cloudflare.com/client/v4/accounts/synthetic-account/workers/scripts -H Authorization: Bearer synthetic-token') {
 output({ success: true, errors: [], messages: [], result: state.workers })
} else if (command === 'curl' && request === '-fsS -G -H Authorization: Bearer synthetic-token --data-urlencode limit=1000 https://console.neon.tech/api/v2/projects/synthetic-project/branches') {
 output({ branches: state.databases, pagination: { next: null } })
} else if (command === 'curl' && args.length === 6 && args.slice(0, 5).join(' ') === '-fsS -X DELETE -H Authorization: Bearer synthetic-token' && args[5].startsWith('https://console.neon.tech/api/v2/projects/synthetic-project/branches/')) {
 remove('databases', args[5].split('/').pop())
} else throw new Error('Unstubbed provider command: ' + command + ' ' + request)
`

export async function verifyPreviewCleanup(project: string): Promise<string[]> {
	const workflow = Bun.YAML.parse(await readFile(join(project, '.github/workflows/cleanup-staging.yml'), 'utf8')) as { jobs: { cleanup: { steps: Step[] } } }
	const steps = workflow.jobs.cleanup.steps
	const root = join(project, '.wrangler/verify-preview-cleanup')
	await mkdir(root, { recursive: true })
	const alias = 'pr-87'
	const repositoryId = '123456'
	const provider = steps.find(({ id }) => id === 'database_cleanup')!.name!.includes('D1') ? 'd1' : 'neon'
	const nameResult = execute({
		source: `node --input-type=module <<'NODE'\nimport { cloudflarePreviewName as name, cloudflarePreviewProject as project } from ${JSON.stringify(pathToFileURL(join(project, 'scripts/cloudflare-preview-name.mjs')).href)}\nconsole.log(JSON.stringify([name(project + '-web', '${alias}'), name(project + '-retired-service', '${alias}'), name(project + '-web', 'pr-88')]))\nNODE`,
		project, env: { PATH: process.env.PATH ?? '/usr/bin:/bin' }
	})
	if (nameResult.exitCode !== 0) throw new Error(nameResult.stderr)
	const [worker, driftedWorker, otherAliasWorker] = JSON.parse(nameResult.stdout) as [string, string, string]
	const stableName = `preview-${repositoryId}-${provider}-${alias}`
	const legacyName = `verification-db-${alias}`
	const stableId = provider === 'd1' ? '11111111-1111-4111-8111-111111111111' : 'br-stable'
	const legacyId = provider === 'd1' ? '55555555-5555-4555-8555-555555555555' : 'br-legacy'
	const protectedDatabases = [
		{ name: 'production', id: provider === 'd1' ? '22222222-2222-4222-8222-222222222222' : 'br-production', default: true, protected: true },
		{ name: `preview-${repositoryId}-${provider}-pr-88`, id: provider === 'd1' ? '33333333-3333-4333-8333-333333333333' : 'br-other-alias', default: false, protected: false }
	]
	const protectedWorkers = [otherAliasWorker, 'production-worker', 'pv-0000000000000000-0000000000-pr-87']
	const stub = join(root, 'provider.mjs')
	await writeFile(stub, providerStub)
	const bin = join(root, 'bin')
	await mkdir(bin)
	for (const command of ['gh', 'curl', 'npx']) await writeFile(join(bin, command), `#!/bin/sh\nexec "${Bun.which('node')}" "${stub}" ${command} "$@"\n`, { mode: 0o755 })
	const scenarios: Scenario[] = []
	for (const event of ['workflow_dispatch', 'pull_request_target', 'pull_request']) {
		for (const conclusion of ['success', 'failure', 'cancelled']) scenarios.push({ name: `${event}-${conclusion}`, event, conclusion })
	}
	scenarios.push(
		{ name: 'absent', fault: 'absent' },
		{ name: 'listing-failure', fault: 'listing', rejected: true },
		{ name: 'partial-download', fault: 'download', rejected: true },
		{ name: 'malformed-archive', fault: 'archive', rejected: true },
		{ name: 'partial-collection', fault: 'partial', event: 'pull_request', rejected: true },
		{ name: 'malformed-json', manifest: '{', rejected: true },
		{ name: 'multiple-json-documents', fault: 'multiple', rejected: true },
		{ name: 'wrong-repository', run: { repository: { id: 999 } }, rejected: true },
		{ name: 'wrong-workflow', run: { path: '.github/workflows/evil.yml' }, rejected: true },
		{ name: 'wrong-workflow-name', run: { name: 'evil' }, rejected: true },
		{ name: 'wrong-event', run: { event: 'push' }, rejected: true },
		{ name: 'wrong-branch', run: { head_branch: 'feature' }, rejected: true },
		{ name: 'in-progress', run: { status: 'in_progress' }, rejected: true },
		{ name: 'wrong-generation', artifactName: `cloudflare-preview-inventory-${alias}-777`, rejected: true },
		{ name: 'legacy-cross-pr', event: 'pull_request', run: { pull_requests: [{ number: 88, base: { repo: { id: Number(repositoryId) }, ref: 'main', sha: 'a'.repeat(40) } }] }, rejected: true },
		{ name: 'legacy-wrong-project', event: 'pull_request', manifest: { project: 'other' }, rejected: true },
		{ name: 'legacy-wrong-schema', event: 'pull_request', manifest: { schemaVersion: 2 }, rejected: true },
		{ name: 'wrong-alias', manifest: { alias: 'pr-88' }, rejected: true },
		{ name: 'wrong-manifest-repository', manifest: { repositoryId: '999' }, rejected: true },
		{ name: 'wrong-manifest-schema', manifest: { schemaVersion: 1 }, rejected: true },
		{ name: 'missing-workers', manifest: { workers: null }, rejected: true },
		{ name: 'production-database', manifest: { database: { kind: provider, name: 'production', id: protectedDatabases[0]!.id } }, rejected: true },
		{ name: 'invalid-database-id', manifest: { database: { kind: provider, name: stableName, id: '../production' } }, rejected: true },
		{ name: 'wrong-database-provider', manifest: { database: { kind: provider === 'd1' ? 'neon' : 'd1', name: stableName, id: stableId } }, rejected: true },
		{ name: 'partial-deletion-retry', fault: 'deletion', event: 'pull_request' }
	)
	const results: string[] = []
	for (const scenario of scenarios) {
		const directory = join(root, scenario.name)
		await mkdir(directory)
		const event = scenario.event ?? 'workflow_dispatch'
		const legacy = event === 'pull_request'
		const run = {
			name: 'deploy-staging', path: '.github/workflows/deploy-staging.yml', status: 'completed', conclusion: scenario.conclusion ?? 'failure',
			repository: { id: Number(repositoryId) }, event, head_branch: 'main',
			pull_requests: [{ number: 87, base: { repo: { id: Number(repositoryId) }, ref: 'main', sha: 'a'.repeat(40) } }], ...scenario.run
		}
		const manifest = {
			schemaVersion: legacy ? 1 : 2, project: 'verification', repositoryId, alias, workers: [],
			database: { kind: provider, name: legacy ? legacyName : stableName, id: legacy ? legacyId : stableId },
			...(typeof scenario.manifest === 'object' ? scenario.manifest : {})
		}
		await writeFile(join(directory, 'cloudflare-preview-manifest.json'), typeof scenario.manifest === 'string' ? scenario.manifest : (scenario.fault === 'multiple' ? '{}\n' : '') + JSON.stringify(manifest))
		const archive = join(directory, 'artifact.zip')
		const zip = execute({ source: `zip -q artifact.zip cloudflare-preview-manifest.json`, project: directory, env: { PATH: process.env.PATH ?? '/usr/bin:/bin' } })
		if (zip.exitCode !== 0) throw new Error(zip.stderr)
		if (scenario.fault === 'archive') await writeFile(archive, 'not a zip')
		const artifacts = [{ id: 888, name: scenario.artifactName ?? `cloudflare-preview-inventory-${alias}${legacy ? '-777' : ''}`, expired: false, created_at: '2026-01-02T00:00:00Z', workflow_run: { id: 777 } }]
		if (scenario.fault === 'partial') artifacts.push({ id: 889, name: `cloudflare-preview-inventory-${alias}-778`, expired: false, created_at: '2026-01-01T00:00:00Z', workflow_run: { id: 778 } })
		const state = {
			workers: [worker, driftedWorker, ...protectedWorkers].map((id) => ({ id })),
			databases: [{ name: stableName, id: stableId, default: false, protected: false }, { name: legacyName, id: legacyId, default: false, protected: false }, ...protectedDatabases]
		}
		const env: Record<string, string> = {
			PATH: `${bin}:${process.env.PATH ?? '/usr/bin:/bin'}`, HOME: directory, TMPDIR: directory,
			RUNNER_TEMP: directory, GITHUB_OUTPUT: join(directory, 'output.txt'), GITHUB_REPOSITORY: 'owner/repository',
			EXPECTED_DEFAULT_BRANCH: 'main', EXPECTED_REPOSITORY_ID: repositoryId, GH_TOKEN: 'synthetic-token',
			CLOUDFLARE_ACCOUNT_ID: 'synthetic-account', CLOUDFLARE_API_TOKEN: 'synthetic-token', NEON_API_KEY: 'synthetic-token', NEON_PROJECT_ID: 'synthetic-project',
			STATE: join(directory, 'state.json'), FIXTURES: join(directory, 'fixtures.json'), REQUESTS: join(directory, 'requests.jsonl'), RECEIPTS: join(directory, 'deletions.jsonl'),
			FAIL_WORKER: scenario.fault === 'deletion' ? worker : '', FAIL_DATABASE: scenario.fault === 'deletion' ? stableId : ''
		}
		await writeFile(env.STATE!, JSON.stringify(state))
		await writeFile(env.FIXTURES!, JSON.stringify({ artifacts: scenario.fault === 'absent' ? [] : artifacts, runs: { 777: run, 778: { ...run, repository: { id: 999 } } }, archive, fault: scenario.fault }))
		for (let attempt = 1; attempt <= (scenario.fault === 'deletion' ? 3 : 1); attempt++) {
			if (attempt > 1) { env.FAIL_WORKER = ''; env.FAIL_DATABASE = '' }
			await writeFile(env.GITHUB_OUTPUT!, '')
			await writeFile(env.RECEIPTS!, '')
			const outcomes: Record<string, Result> = {}
			for (const id of ['preview_inventories', 'worker_cleanup', 'database_cleanup', 'cleanup_result']) {
				const step = steps.find((step) => step.id === id)!
				const output = await readFile(env.GITHUB_OUTPUT!, 'utf8')
				env.PREVIEW_MANIFEST_DIR = outcomes.preview_inventories?.exitCode === 0 ? join(directory, 'cloudflare-preview-inventories') : ''
				env.WORKER_CLEANUP_OUTCOME = outcomes.worker_cleanup?.exitCode === 0 ? 'success' : 'failure'
				env.DATABASE_CLEANUP_OUTCOME = outcomes.database_cleanup?.exitCode === 0 ? 'success' : 'failure'
				env.INVENTORY_OUTCOME = outcomes.preview_inventories?.exitCode === 0 ? 'success' : 'failure'
				env.AUTHENTICATED_INVENTORY_COUNT = output.match(/^authenticated_count=(\d+)$/m)?.[1] ?? ''
				env.PREVIEW_ALIAS = alias
				const source = step.run!.replaceAll('${{ steps.alias.outputs.alias }}', alias).replaceAll('${{ github.repository_id }}', repositoryId)
				await writeFile(join(directory, `${id}.sh`), source)
				outcomes[id] = execute({ source, project, env })
			}
			const receipts = (await readFile(env.RECEIPTS!, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as { kind: string; id: string })
			const remaining = JSON.parse(await readFile(env.STATE!, 'utf8')) as typeof state
			const published = await readdir(join(directory, 'cloudflare-preview-inventories')).catch(() => [])
			await writeFile(join(directory, `attempt-${attempt}.json`), JSON.stringify({ outcomes, receipts, remaining, published }, null, 2))
			if ((outcomes.preview_inventories!.exitCode !== 0) !== Boolean(scenario.rejected)) throw new Error(`${scenario.name}: unexpected inventory result: ${outcomes.preview_inventories!.stderr}`)
			if (scenario.rejected && published.length) throw new Error(`${scenario.name}: incomplete inventory was published`)
			const expectedFailure = Boolean(scenario.rejected || scenario.fault === 'absent' || (scenario.fault === 'deletion' && attempt === 1))
			if ((outcomes.cleanup_result!.exitCode !== 0) !== expectedFailure) throw new Error(`${scenario.name}: incorrect final report`)
			const protectedIds = [...protectedWorkers, ...protectedDatabases.map(({ id }) => id)]
			if (receipts.some(({ id }) => protectedIds.includes(id))) throw new Error(`${scenario.name}: cleanup crossed its namespace`)
			if (receipts.some(({ id }) => id === legacyId) && (!legacy || scenario.rejected)) throw new Error(`${scenario.name}: unauthenticated legacy deletion`)
			const expectedReceipts = attempt === 3 ? [] : attempt === 2 ? [worker, stableId] : [worker, driftedWorker, stableId, ...(legacy && !scenario.rejected ? [legacyId] : [])]
			if (JSON.stringify(receipts.map(({ id }) => id).sort()) !== JSON.stringify(expectedReceipts.sort())) throw new Error(`${scenario.name}: cleanup did not attempt the exact authorized inventory on attempt ${attempt}`)
			if (!expectedFailure && remaining.workers.some(({ id }) => id === worker || id === driftedWorker)) throw new Error(`${scenario.name}: preview Workers remain`)
			if (legacy && !scenario.rejected && attempt !== 1 && remaining.databases.some(({ id }) => id === legacyId || id === stableId)) throw new Error(`${scenario.name}: preview databases remain after retry`)
			if (attempt === 3 && receipts.length) throw new Error('Repeated cleanup was not idempotent')
		}
		results.push(scenario.name)
	}
	for (const scenario of ['invalid-alias', 'missing-trusted-setup', 'incomplete-inventory-with-count']) {
		const directory = join(root, scenario)
		await mkdir(directory)
		const receipt = join(directory, 'deletions.jsonl')
		const env = { PATH: `${bin}:${process.env.PATH ?? '/usr/bin:/bin'}`, HOME: directory, TMPDIR: directory, RAW_PREVIEW_ALIAS: 'pr-0', GITHUB_OUTPUT: join(directory, 'output.txt'), RECEIPTS: receipt, INVENTORY_OUTCOME: 'failure', WORKER_CLEANUP_OUTCOME: 'success', DATABASE_CLEANUP_OUTCOME: 'success', AUTHENTICATED_INVENTORY_COUNT: '1', PREVIEW_ALIAS: alias }
		const source = scenario === 'invalid-alias' ? steps.find(({ id }) => id === 'alias')!.run! : scenario === 'missing-trusted-setup' ? steps.find(({ name }) => name === 'Require trusted preview inventory')!.run! : steps.find(({ id }) => id === 'cleanup_result')!.run!
		const result = execute({ source, project: scenario === 'missing-trusted-setup' ? directory : project, env })
		const receipts = await readFile(receipt, 'utf8').catch(() => '')
		await writeFile(join(directory, 'result.json'), JSON.stringify({ ...result, receipts }, null, 2))
		if (result.exitCode === 0 || receipts) throw new Error(`${scenario}: unsafe cleanup authorization or reporting`)
		if (scenario === 'invalid-alias') {
			const direct = execute({ source: 'sh scripts/cleanup-cloudflare-preview-workers.sh pr-0', project, env })
			await writeFile(join(directory, 'direct-worker-result.json'), JSON.stringify(direct, null, 2))
			if (direct.exitCode === 0 || !direct.stderr.includes('canonical pr-<positive integer>')) throw new Error('Worker cleanup did not independently reject the alias')
		}
		results.push(scenario)
	}
	await writeFile(join(root, 'summary.json'), JSON.stringify({ provider, results, limitation: 'Actual emitted scripts with synthetic provider/GitHub responses. Workflow conditions are checked separately, not live GitHub scheduling.' }, null, 2))
	return results
}
