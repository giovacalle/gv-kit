import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { parseJsonc } from '../src/lib/jsonc.js'
import { buildScaffoldPlan } from '../src/pipeline/plan.js'
import { GvKitConfig } from '../src/schema/config.js'

const webOrigin = 'https://app.example.test'
const apiOrigin = 'https://api.example.test:8443'

type ComposeService = {
	build?: unknown
	image?: string
	ports?: unknown[]
	healthcheck?: { test: string[] }
	depends_on?: Record<string, { condition: string }>
}

export function dockerHealthClientEnvironment(endpoint: string | undefined, project: string): NodeJS.ProcessEnv {
	if (!endpoint || !/^unix:\/\/\/[^\s?#]+$/.test(endpoint)) throw new Error('Production-origin verification requires DOCKER_HOST naming an absolute local Unix socket')
	const home = join(project, '.verify-home')
	return { HOME: home, DOCKER_CONFIG: join(home, 'docker'), DOCKER_HOST: endpoint }
}

export async function verifyDockerProductionHealth(fixture: string, output: string) {
	const project = join(output, fixture)
	const client = dockerHealthClientEnvironment(process.env.DOCKER_HOST, project)
	if (!(await stat(client.DOCKER_HOST!.slice('unix://'.length))).isSocket()) throw new Error('DOCKER_HOST must name a local Unix socket')
	await mkdir(project, { recursive: false })
	const config = GvKitConfig.parse(parseJsonc(await readFile(resolve('fixtures', `${fixture}.jsonc`), 'utf8')))
	if (config.choices.backend !== 'hono' || config.choices.deploy !== 'docker') throw new Error('Expected a Hono Docker fixture')
	for (const file of buildScaffoldPlan(config)) {
		const target = join(project, file.path)
		await mkdir(resolve(target, '..'), { recursive: true })
		await writeFile(target, file.content, { mode: file.mode })
	}
	const name = `gvkit-health-${randomUUID()}`
	await mkdir(client.DOCKER_CONFIG!, { recursive: true })
	await writeFile(join(client.DOCKER_CONFIG!, 'config.json'), '{}\n', { flag: 'wx', mode: 0o600 })
	const env: NodeJS.ProcessEnv = {
		PATH: process.env.PATH,
		...client,
		CI: '1',
		COMPOSE_PROJECT_NAME: name,
		COMPOSE_FILE: 'docker-compose.yml:compose.health.yml',
		COMPOSE_PARALLEL_LIMIT: '2',
		POSTGRES_USER: 'gvkit', POSTGRES_PASSWORD: 'synthetic-password', POSTGRES_DB: 'gvkit',
		DATABASE_URL: 'postgres://gvkit:synthetic-password@postgres:5432/gvkit',
		ORIGIN: webOrigin, PUBLIC_APP_URL: webOrigin,
		API_HOST: new URL(apiOrigin).hostname, PUBLIC_SCHEME: 'https',
		API_PUBLIC_ORIGIN: apiOrigin,
		GATEWAY_PUBLIC_ORIGINS: `${webOrigin},${apiOrigin}`,
		GATEWAY_TRUSTED_INGRESS_SECRET: 'synthetic-health-ingress-secret',
		BETTER_AUTH_ALLOWED_HOSTS: `${new URL(webOrigin).host},${new URL(apiOrigin).host}`,
		AUTH_CORS_ORIGINS: `${webOrigin},${apiOrigin}`, API_CORS_ORIGINS: webOrigin,
		BETTER_AUTH_SECRET: 'synthetic-health-auth-secret-at-least-32-characters',
		TURNSTILE_SECRET_KEY: 'synthetic-unused-turnstile-secret',
		RESEND_API_KEY: '', FROM_EMAIL: '',
		GOOGLE_CLIENT_ID: 'synthetic-unused-client', GOOGLE_CLIENT_SECRET: 'synthetic-unused-secret'
	}
	let sequence = 0
	async function command(args: string[], options: { program?: string; seconds?: number; allowFailure?: boolean } = {}) {
		const program = options.program ?? 'docker'
		const started = Date.now()
		const child = spawn(program, args, { cwd: project, env, stdio: ['ignore', 'pipe', 'pipe'] })
		let text = ''
		child.stdout.on('data', (chunk) => { text += chunk.toString() })
		child.stderr.on('data', (chunk) => { text += chunk.toString() })
		const timer = setTimeout(() => child.kill('SIGTERM'), (options.seconds ?? 60) * 1000)
		const killTimer = setTimeout(() => child.kill('SIGKILL'), ((options.seconds ?? 60) + 10) * 1000)
		let code: number
		try {
			code = await new Promise<number>((done, reject) => {
				child.on('error', reject)
				child.on('close', (status) => done(status ?? 124))
			})
		} finally {
			clearTimeout(timer)
			clearTimeout(killTimer)
		}
		const receipt = { program, args, code, durationMs: Date.now() - started }
		await writeFile(join(project, `${String(++sequence).padStart(3, '0')}-command.json`), JSON.stringify(receipt, null, 2))
		await writeFile(join(project, `${String(sequence).padStart(3, '0')}-command.log`), text)
		console.log(JSON.stringify(receipt))
		if (code !== 0 && !options.allowFailure) throw new Error(`${program} ${args.slice(0, 4).join(' ')} exited ${code}; see command ${sequence}`)
		return { code, text }
	}
	const compose = Bun.YAML.parse(await readFile(join(project, 'docker-compose.yml'), 'utf8')) as { services: Record<string, ComposeService> }
	const images: string[] = []
	const overrides = ['services:']
	for (const [service, settings] of Object.entries(compose.services)) {
		overrides.push(`  ${service}:`, '    restart: "no"')
		if (settings.build) {
			const image = `${name}-${service}:verify`
			images.push(image)
			overrides.push(`    image: ${image}`)
		}
		if (settings.ports) overrides.push('    ports: !reset []')
	}
	overrides.push('networks:', '  default:', `    name: ${name}-internal`)
	await writeFile(join(project, 'compose.health.yml'), overrides.join('\n') + '\n')
	await writeFile(join(project, 'ownership.json'), JSON.stringify({ name, images, network: `${name}-internal`, fixture, project, webOrigin, apiOrigin, client }, null, 2))
	async function inventory(stage: string) {
		const records: Record<string, string> = {}
		for (const [kind, args] of Object.entries({ containers: ['ps', '-aq'], networks: ['network', 'ls', '-q'], volumes: ['volume', 'ls', '-q'] })) {
			records[kind] = (await command([...args, '--filter', `label=com.docker.compose.project=${name}`])).text.trim()
		}
		for (const image of images) records[image] = (await command(['image', 'ls', '-q', image])).text.trim()
		await writeFile(join(project, `${stage}-inventory.json`), JSON.stringify(records, null, 2))
		if (stage === 'after' && Object.values(records).some(Boolean)) throw new Error('Owned Docker resources remain after cleanup')
		return records
	}
	await command(['version'])
	const before = await inventory('before')
	if (Object.values(before).some(Boolean)) throw new Error('Refusing pre-existing owned resource names')
	let started = false
	try {
		await command(['pnpm@11.1.1', 'install', '--no-frozen-lockfile'], { program: 'corepack', seconds: 180 })
		await command(['pnpm@11.1.1', '--filter', '@repo/db', 'db:generate'], { program: 'corepack', seconds: 60 })
		await command(['compose', 'config', '--format', 'json'])
		started = true
		await command(['compose', 'build'], { seconds: 180 })
		await command(['compose', 'up', '--wait', '--wait-timeout', '120', '--no-build'], { seconds: 150 })
		const running = await command(['compose', 'ps', '--all', '--format', 'json'])
		await writeFile(join(project, 'healthy-dependencies.json'), running.text)
		const rows = running.text.trim().split('\n').map((line) => JSON.parse(line) as { Service: string; State: string; Health: string })
		for (const service of ['gateway', 'web', 'ingress']) if (!rows.some((row) => row.Service === service && row.State === 'running' && row.Health === 'healthy')) throw new Error(`${service} did not become healthy`)
		const probe = compose.services.gateway?.healthcheck?.test
		if (!probe || probe[0] !== 'CMD') throw new Error('Expected an exec-form gateway probe')
		await command(['compose', 'exec', '-T', 'gateway', ...probe.slice(1)])
		const negativeScript = `const base = {'x-forwarded-host': ${JSON.stringify(new URL(apiOrigin).host)}, 'x-forwarded-proto':'https', 'x-gateway-ingress-secret':process.env.GATEWAY_TRUSTED_INGRESS_SECRET};
const cases = {missingSecret: {...base, 'x-gateway-ingress-secret':''}, wrongSecret:{...base, 'x-gateway-ingress-secret':'wrong'}, unknownOrigin:{...base, 'x-forwarded-host':'evil.example.test'}, forgedScheme:{...base, 'x-forwarded-proto':'http'}, forgedHost:{'x-forwarded-host':base['x-forwarded-host'], 'x-forwarded-proto':'https'}, bare:{}};
for (const [name, headers] of Object.entries(cases)) { const response = await fetch('http://127.0.0.1:8786/api/healthz', {headers, signal:AbortSignal.timeout(2000)}); console.log(JSON.stringify({name,status:response.status})); if(response.status!==421) process.exitCode=1; }`
		await command(['compose', 'exec', '-T', 'gateway', 'node', '--input-type=module', '--eval', negativeScript])
		await command(['compose', 'stop', 'auth', 'users'])
		await command(['compose', 'exec', '-T', 'gateway', ...probe.slice(1)])
		await command(['compose', 'exec', '-T', 'gateway', 'node', '--input-type=module', '--eval', `const response = await fetch('http://127.0.0.1:8786/api/v1/users/me', {headers:{'x-forwarded-host':${JSON.stringify(new URL(apiOrigin).host)},'x-forwarded-proto':'https','x-gateway-ingress-secret':process.env.GATEWAY_TRUSTED_INGRESS_SECRET},signal:AbortSignal.timeout(3000)}); console.log(response.status); if(response.status!==502) process.exitCode=1;`])
		await command(['compose', 'ps', '--all', '--format', 'json'])
		await writeFile(join(project, 'result.json'), JSON.stringify({ result: 'passed', fixture, productionOnlyOrigins: true, dependencyRelease: ['gateway', 'web', 'ingress'], privateServicesStopped: ['auth', 'users'] }, null, 2))
	} finally {
		if (started) {
			await command(['compose', 'logs', '--no-color'], { allowFailure: true })
			await command(['compose', 'down', '--volumes', '--timeout', '10'])
			for (const image of images) {
				if ((await command(['image', 'ls', '-q', image])).text.trim()) await command(['image', 'rm', image])
			}
		}
		await inventory('after')
	}
}
