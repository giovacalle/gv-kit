import { spawn, execFileSync } from 'node:child_process'
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { buildScaffoldPlan } from '../src/pipeline/plan.js'
import { GvKitConfig } from '../src/schema/config.js'

export const BUILD_CONTRACT_CASES = ['cf-workers', 'docker', 'skip'].flatMap((deploy) =>
	['hey-api', 'skip'].map((apiClient) => ({ id: `${deploy}-${apiClient}`, deploy, apiClient }))
)

type Receipt = { name: string; command: string[]; exitCode: number; log: string }

function terminateDescendants(pid: number): void {
	const rows = execFileSync('ps', ['-axo', 'pid=,ppid='], { encoding: 'utf8' })
		.trim().split('\n').map((row) => row.trim().split(/\s+/).map(Number))
	const visit = (parent: number) => {
		for (const [child, owner] of rows) {
			if (owner !== parent || child === undefined) continue
			visit(child)
			try { process.kill(child, 'SIGKILL') } catch { /* already exited */ }
		}
	}
	visit(pid)
}

export async function verifyGatewayBuildContract(output: string, selected?: string): Promise<void> {
	const cases = selected ? BUILD_CONTRACT_CASES.filter(({ id }) => id === selected) : BUILD_CONTRACT_CASES
	if (cases.length === 0) throw new Error(`Unknown build-contract case: ${selected}`)
	await mkdir(output, { recursive: false })
	for (const entry of cases) {
		const project = join(output, entry.id)
		const home = join(project, '.verify-home')
		const receipts: Receipt[] = []
		await mkdir(home, { recursive: true })
		const cfg = GvKitConfig.parse({ configVersion: 2, choices: {
			name: 'contract-check', frontend: 'sveltekit', marketing: 'inside-web', backend: 'hono',
			i18n: 'skip', monitoring: [], db: 'postgres', auth: [], email: 'skip', aiTooling: [],
			deploy: entry.deploy, apiClient: entry.apiClient
		} })
		for (const file of buildScaffoldPlan(cfg)) {
			const path = join(project, file.path)
			await mkdir(dirname(path), { recursive: true })
			await writeFile(path, file.content, { mode: file.mode })
		}
		await mkdir(join(project, '.verify-bin'))
		await writeFile(join(project, '.verify-bin/pnpm'), '#!/bin/sh\nexec corepack pnpm@11.1.1 "$@"\n', { mode: 0o755 })
		const environment = {
			PATH: `${join(project, '.verify-bin')}:${process.env.PATH}`, HOME: home,
			COREPACK_HOME: process.env.COREPACK_HOME ?? join(process.env.HOME!, '.cache/node/corepack'),
			CI: '1', TURBO_TELEMETRY_DISABLED: '1', WRANGLER_SEND_METRICS: 'false',
			DATABASE_URL: 'postgres://synthetic:synthetic@127.0.0.1:5432/synthetic'
		}
		const run = async (name: string, args: string[]) => {
			let text = ''
			const command = ['corepack', 'pnpm@11.1.1', ...args]
			const exitCode = await new Promise<number>((done, reject) => {
				const child = spawn(command[0]!, command.slice(1), { cwd: project, env: environment, stdio: ['ignore', 'pipe', 'pipe'] })
				const timer = setTimeout(() => {
					text += '\nVERIFIER TIMEOUT\n'
					if (child.pid) terminateDescendants(child.pid)
					child.kill('SIGKILL')
				}, 240_000)
				child.stdout.on('data', (data) => { text += data.toString() })
				child.stderr.on('data', (data) => { text += data.toString() })
				child.on('error', (error) => { clearTimeout(timer); reject(error) })
				child.on('close', (code) => { clearTimeout(timer); done(code ?? 1) })
			})
			await mkdir(join(project, 'evidence'), { recursive: true })
			const log = `evidence/${name}.log`
			await writeFile(join(project, log), `$ ${command.join(' ')}\n${text}\nexit=${exitCode}\n`)
			receipts.push({ name, command, exitCode, log })
			await writeFile(join(project, 'receipts.json'), JSON.stringify(receipts, null, 2) + '\n')
			console.log(`${entry.id}: ${name}: exit ${exitCode}`)
			return { exitCode, text }
		}
		const succeed = async (name: string, args: string[]) => {
			const result = await run(name, args)
			if (result.exitCode !== 0) throw new Error(`${entry.id}: ${name} failed`)
			return result.text
		}
		try {
			await succeed('install', ['install', '--no-frozen-lockfile'])
			const main = await succeed('node-tsx-main', ['--dir', 'apps/api', 'exec', 'node', '--import', 'tsx', 'scripts/compose-openapi.ts', '--check'])
			if (!main.includes('OpenAPI is current (sha256:')) throw new Error('Node/tsx did not execute the composer main program')
			await succeed('package-baseline', ['--dir', 'apps/api', 'build'])
			await succeed('root-baseline', ['build'])
			const warm = await succeed('root-warm', ['build'])
			if (!/api-gateway:build: cache hit/.test(warm)) throw new Error('Gateway warm-cache hit was not observed')
			if (entry.apiClient === 'hey-api') {
				const generatedClientPath = join(project, 'packages/openapi-client/src/generated/index.ts')
				const generatedClient = await readFile(generatedClientPath, 'utf8')
				const staleClient = `${generatedClient}\nexport const staleBuildContractClient = true\n`
				await writeFile(generatedClientPath, staleClient)
				const staleResult = await run('root-stale-client', ['build'])
				if (staleResult.exitCode === 0 || !/diff|staleBuildContractClient/.test(staleResult.text)) throw new Error('Current OpenAPI with a stale generated client passed the build')
				if ((await readFile(generatedClientPath, 'utf8')) !== staleClient) throw new Error('Client drift check rewrote the stale generated source')
				await writeFile(generatedClientPath, generatedClient)
			}
			const fragmentPath = join(project, 'services/users/openapi.json')
			const checkedPath = join(project, 'apps/api/openapi.json')
			const original = await readFile(fragmentPath, 'utf8')
			const checked = await readFile(checkedPath, 'utf8')
			const changed = JSON.parse(original)
			changed.paths['/api/v1/build-contract-probe'] = { get: { operationId: 'usersBuildContractProbe', responses: { '204': { description: 'Build contract probe' } } } }
			const collision = JSON.parse(original)
			collision.paths['/api/v1/build-contract-collision'] = structuredClone(Object.values(collision.paths)[0])
			const mutations = [
				{ name: 'changed', content: JSON.stringify(changed, null, 2) + '\n', diagnostic: /openapi\.json drifted/ },
				{ name: 'missing', content: undefined, diagnostic: /ENOENT/ },
				{ name: 'malformed', content: '{ broken JSON', diagnostic: /JSON|property name/ },
				{ name: 'collision', content: JSON.stringify(collision), diagnostic: /operationId.*collision|duplicate operationId/i }
			]
			const gateway = '@contract-check/api-gateway'
			const taskHash = async (name: string) => {
				const text = await succeed(name, ['exec', 'turbo', 'run', 'build', `--filter=${gateway}`, '--dry=json'])
				const report = JSON.parse(text.slice(text.indexOf('{'))) as { tasks: Array<{ taskId: string; hash: string }> }
				const hash = report.tasks.find(({ taskId }) => taskId === `${gateway}#build`)?.hash
				if (!hash) throw new Error('Gateway task hash is absent')
				return hash
			}
			const baselineHash = await taskHash('baseline-task-hash')
			const hashes: Record<string, string> = { baseline: baselineHash }
			for (const mutation of mutations) {
				if (mutation.content === undefined) await rm(fragmentPath)
				else await writeFile(fragmentPath, mutation.content)
				hashes[mutation.name] = await taskHash(`${mutation.name}-task-hash`)
				if (hashes[mutation.name] === baselineHash) throw new Error(`${mutation.name} did not invalidate the gateway task hash`)
				const commands = [
					{ name: 'package', args: ['--dir', 'apps/api', 'build'] },
					{ name: 'root-warm', args: ['build'] },
					{ name: 'root-cold', args: ['build', '--cache-dir', `.verify-cold-root-${mutation.name}`] },
					{ name: 'turbo-warm', args: ['exec', 'turbo', 'run', 'build', `--filter=${gateway}`] },
					{ name: 'turbo-cold', args: ['exec', 'turbo', 'run', 'build', `--filter=${gateway}`, '--cache-dir', `.verify-cold-turbo-${mutation.name}`] }
				]
				for (const command of commands) {
					await rm(join(project, 'apps/api/dist'), { recursive: true, force: true })
					const result = await run(`${command.name}-${mutation.name}`, command.args)
					if (result.exitCode === 0 || !mutation.diagnostic.test(result.text)) throw new Error(`${entry.id}: ${command.name} did not reject ${mutation.name} with its diagnostic`)
					if ((await readFile(checkedPath, 'utf8')) !== checked) throw new Error('Build rewrote the checked document')
					if ((await readdir(join(project, 'apps/api/dist')).catch(() => [])).length > 0) throw new Error('Build bundled or restored a stale contract')
				}
				await writeFile(fragmentPath, original)
			}
			await writeFile(fragmentPath, JSON.stringify(changed, null, 2) + '\n')
			await succeed('explicit-recomposition', ['openapi:compose'])
			const updated = await readFile(checkedPath, 'utf8')
			if (!updated.includes('usersBuildContractProbe') || updated === checked) throw new Error('Explicit composition did not update the contract')
			await succeed('package-recovered', ['--dir', 'apps/api', 'build'])
			if (entry.apiClient === 'hey-api') {
				const staleAfterComposition = await run('root-rejects-stale-client-after-composition', ['build'])
				if (staleAfterComposition.exitCode === 0) throw new Error('Updated OpenAPI with a stale generated client passed the build')
				await succeed('explicit-client-regeneration', ['codegen'])
			}
			await succeed('root-recovered', ['build'])
			const bundle = await readFile(join(project, 'apps/api/dist/index.js'), 'utf8')
			if (!bundle.includes('usersBuildContractProbe')) throw new Error('Recovered bundle omits the updated contract')
			const recoveredWarm = await succeed('root-recovered-warm', ['build'])
			if (!/api-gateway:build: cache hit/.test(recoveredWarm)) throw new Error('Recovered gateway cache hit was not observed')
			await writeFile(join(project, 'result.json'), JSON.stringify({ outcome: 'passed', hashes, mutations: mutations.map(({ name }) => name), failBeforeBundle: true, checkedDocumentUnchangedOnFailure: true, updatedContractInBundle: true }, null, 2) + '\n')
		} catch (error) {
			await writeFile(join(project, 'result.json'), JSON.stringify({ outcome: 'failed', error: String(error) }) + '\n')
			throw error
		}
	}
}

if (import.meta.main) {
	const args = process.argv.slice(2)
	const output = args[args.indexOf('--output') + 1]
	if (!args.includes('--output') || !output) throw new Error('--output must name a new owned directory')
	await verifyGatewayBuildContract(resolve(output), args.includes('--case') ? args[args.indexOf('--case') + 1] : undefined)
}
