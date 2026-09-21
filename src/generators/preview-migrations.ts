export function previewMigrationScript(provider: 'd1' | 'neon'): string {
	return `import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

const env = process.env
const provider = ${JSON.stringify(provider)}
function check(condition, message) {
	if (!condition) throw new Error('Preview migration denied: ' + message)
}
const revision = JSON.parse(env.AUTHORIZED_REVISION || 'null')
check(revision?.schemaVersion === 1 && /^[0-9a-f]{40}$/.test(revision.headSha) && !/^0+$/.test(revision.headSha), 'authorized revision required')
check(revision.headSha === env.PREVIEW_HEAD_SHA && revision.trustedSha === env.GITHUB_WORKFLOW_SHA && revision.repositoryId === env.GITHUB_REPOSITORY_ID && revision.repository === env.GITHUB_REPOSITORY && revision.prNumber === env.PREVIEW_PR_NUMBER && revision.runId === env.GITHUB_RUN_ID, 'revision mismatch')
check(/^[1-9][0-9]*$/.test(revision.repositoryId) && /^[1-9][0-9]{0,9}$/.test(revision.prNumber) && revision.alias === 'pr-' + revision.prNumber && env.STAGING_ALIAS === revision.alias, 'preview identity mismatch')
check(typeof revision.headRepository === 'string' && /^[A-Za-z0-9_.-]+\\/[A-Za-z0-9_.-]+$/.test(revision.headRepository), 'head repository missing')
async function request(url, token) {
	check(typeof token === 'string' && token.length > 0, 'API credential missing')
	const response = await fetch(url, { headers: { Authorization: 'Bearer ' + token, Accept: 'application/json', 'X-GitHub-Api-Version': '2022-11-28' }, redirect: 'error', signal: AbortSignal.timeout(15000) })
	check(response.ok, 'immutable input or destination lookup failed')
	return response.json()
}
const github = (path) => request('https://api.github.com/repos/' + revision.headRepository + '/git/' + path, env.GH_TOKEN)
const commit = await github('commits/' + revision.headSha)
check(commit.sha === revision.headSha && /^[0-9a-f]{40}$/.test(commit.tree?.sha), 'commit revision mismatch')
const tree = await github('trees/' + commit.tree.sha + '?recursive=1')
check(tree.sha === commit.tree.sha && tree.truncated === false && Array.isArray(tree.tree), 'incomplete migration tree')
const prefix = 'packages/db/migrations/'
const files = new Map()
let bytes = 0
for (const entry of tree.tree) {
	check(typeof entry.path === 'string' && !entry.path.split('/').some((part) => part === '..' || part === '.' || part === '') && !entry.path.includes('\\\\'), 'unsafe Git path')
	if (!entry.path.startsWith(prefix)) continue
	const name = entry.path.slice(prefix.length)
	if (entry.type === 'tree' && entry.mode === '040000' && name === 'meta') continue
	check(entry.type === 'blob' && entry.mode === '100644', 'symlink or executable migration input')
	check(/^(?:[0-9]{4,}_[A-Za-z0-9_-]+\\.sql|meta\\/(?:_journal|[0-9]{4,}_snapshot)\\.json|\\.gitkeep)$/.test(name), 'unsupported migration path')
	check(!files.has(name) && files.size < 256 && /^[0-9a-f]{40}$/.test(entry.sha), 'duplicate or excessive migration input')
	const blob = await github('blobs/' + entry.sha)
	check(blob.sha === entry.sha && blob.encoding === 'base64' && typeof blob.content === 'string' && Number.isSafeInteger(blob.size) && blob.size <= 1048576, 'invalid migration blob')
	const data = Buffer.from(blob.content, 'base64')
	bytes += data.length
	check(data.length === blob.size && bytes <= 8388608 && createHash('sha1').update(Buffer.concat([Buffer.from('blob ' + data.length + '\\0'), data])).digest('hex') === entry.sha, 'migration blob integrity mismatch')
	const text = new TextDecoder('utf-8', { fatal: true }).decode(data)
	check(!text.includes('\\0'), 'NUL in migration data')
	files.set(name, text)
}
const sqlNames = [...files.keys()].filter((name) => name.endsWith('.sql')).sort()
check(sqlNames.length > 0 && sqlNames.every((name) => files.get(name).trim().length > 0), 'missing migration SQL')
const dialect = provider === 'd1' ? 'sqlite' : 'postgresql'
for (const [name, text] of files) {
	if (!name.endsWith('.json')) continue
	const metadata = JSON.parse(text)
	check(metadata && typeof metadata === 'object' && !Array.isArray(metadata) && metadata.dialect === dialect && /^[0-9]+$/.test(metadata.version), 'malformed migration metadata')
	if (name !== 'meta/_journal.json') {
		const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
		check(uuid.test(metadata.id || '') && uuid.test(metadata.prevId || '') && metadata.tables && typeof metadata.tables === 'object' && !Array.isArray(metadata.tables), 'malformed migration snapshot')
		continue
	}
	check(Array.isArray(metadata.entries) && metadata.entries.length === sqlNames.length, 'incomplete migration journal')
	let previous = -1
	for (const [index, entry] of metadata.entries.entries()) {
		check(entry.idx === index && /^[0-9]+$/.test(entry.version) && Number.isSafeInteger(entry.when) && entry.when > previous && typeof entry.breakpoints === 'boolean' && typeof entry.tag === 'string' && entry.tag + '.sql' === sqlNames[index], 'unsafe or malformed journal entry')
		previous = entry.when
	}
}
check(provider !== 'neon' || files.has('meta/_journal.json'), 'missing Neon migration journal')
const expectedName = 'preview-' + revision.repositoryId + '-' + provider + '-' + revision.alias
let destination
if (provider === 'd1') {
	check(env.STAGING_D1_DATABASE_NAME === expectedName && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(env.STAGING_D1_DATABASE_ID || '') && /^[0-9a-f]{32}$/.test(env.CLOUDFLARE_ACCOUNT_ID || ''), 'unsafe D1 destination')
	const database = await request('https://api.cloudflare.com/client/v4/accounts/' + env.CLOUDFLARE_ACCOUNT_ID + '/d1/database/' + env.STAGING_D1_DATABASE_ID, env.CLOUDFLARE_API_TOKEN)
	check(database.success === true && database.result?.uuid === env.STAGING_D1_DATABASE_ID && database.result?.name === expectedName, 'D1 destination mismatch')
	destination = { binding: 'DB', database_name: expectedName, database_id: env.STAGING_D1_DATABASE_ID, migrations_dir: 'migrations' }
} else {
	check(env.STAGING_NEON_BRANCH_NAME === expectedName && /^br-[a-z0-9-]+$/.test(env.STAGING_NEON_BRANCH_ID || '') && /^[a-z0-9-]+$/.test(env.NEON_PROJECT_ID || ''), 'unsafe Neon destination')
	const base = 'https://console.neon.tech/api/v2/projects/' + env.NEON_PROJECT_ID
	const branch = await request(base + '/branches/' + env.STAGING_NEON_BRANCH_ID, env.NEON_API_KEY)
	check(branch.branch?.id === env.STAGING_NEON_BRANCH_ID && branch.branch?.name === expectedName && branch.branch?.project_id === env.NEON_PROJECT_ID && branch.branch?.default === false, 'Neon branch mismatch')
	const endpoints = await request(base + '/branches/' + env.STAGING_NEON_BRANCH_ID + '/endpoints', env.NEON_API_KEY)
	let url
	try {
		url = new URL(env.DATABASE_URL)
		decodeURIComponent(url.username)
		decodeURIComponent(url.password)
	} catch {
		throw new Error('Preview migration denied: malformed Neon connection')
	}
	const authority = env.DATABASE_URL.match(/^postgres(?:ql)?:\\/\\/([^/?#]+)\\//)?.[1].split('@')
	// The driver splits on the first raw @ and decodes host lists before WHATWG parsing.
	check(!/[\\s\\\\]/.test(env.DATABASE_URL) && authority?.length === 2 && /^[a-z0-9.-]+(?::5432)?$/.test(authority[1]) && authority[1] === url.host, 'ambiguous Neon connection authority')
	check(['postgres:', 'postgresql:'].includes(url.protocol) && url.username && url.password && url.pathname.length > 1 && !url.hash && (!url.port || url.port === '5432') && url.searchParams.get('sslmode') === 'require', 'unsafe Neon connection')
	check([...url.searchParams.keys()].every((key) => key === 'sslmode' || key === 'channel_binding'), 'unexpected Neon connection option')
	check(url.searchParams.getAll('sslmode').length === 1 && url.searchParams.getAll('channel_binding').length <= 1, 'duplicate Neon connection option')
	check(Array.isArray(endpoints.endpoints) && endpoints.endpoints.some((endpoint) => endpoint.branch_id === env.STAGING_NEON_BRANCH_ID && endpoint.project_id === env.NEON_PROJECT_ID && endpoint.type === 'read_write' && typeof endpoint.host === 'string' && endpoint.host.endsWith('.neon.tech') && (url.hostname === endpoint.host || url.hostname === endpoint.host.replace('.', '-pooler.'))), 'Neon endpoint mismatch')
}
check(typeof env.RUNNER_TEMP === 'string' && env.RUNNER_TEMP.length > 0, 'runner temp missing')
const directory = mkdtempSync(join(env.RUNNER_TEMP, 'authorized-preview-migrations-'))
try {
	mkdirSync(join(directory, 'migrations/meta'), { recursive: true })
	for (const [name, text] of files) writeFileSync(join(directory, 'migrations', name), text, { mode: 0o600, flag: 'wx' })
	writeFileSync(join(directory, 'package.json'), JSON.stringify({ private: true, dependencies: provider === 'd1' ? { wrangler: '4.125.0' } : { 'drizzle-kit': '0.31.8', 'drizzle-orm': '0.45.0', postgres: '3.4.7' } }))
	const toolEnv = { PATH: env.PATH, HOME: directory, CI: 'true', npm_config_userconfig: '/dev/null', npm_config_cache: join(directory, '.npm'), WRANGLER_SEND_METRICS: 'false' }
	function run(command, options) {
		const result = spawnSync(command, options.args, { cwd: directory, env: options.env, stdio: 'inherit', timeout: 180000 })
		check(!result.error && result.status === 0, 'trusted migration command failed')
	}
	run('npm', { args: ['install', '--ignore-scripts', '--no-audit', '--no-fund'], env: toolEnv })
	if (provider === 'd1') {
		writeFileSync(join(directory, 'wrangler.jsonc'), JSON.stringify({ name: 'preview-migrations', compatibility_date: '2026-08-24', d1_databases: [destination] }))
		run(process.execPath, { args: [join(directory, 'node_modules/wrangler/bin/wrangler.js'), 'd1', 'migrations', 'apply', expectedName, '--remote', '--config', join(directory, 'wrangler.jsonc')], env: { ...toolEnv, CLOUDFLARE_API_TOKEN: env.CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID: env.CLOUDFLARE_ACCOUNT_ID } })
	} else {
		writeFileSync(join(directory, 'drizzle.config.mjs'), "export default { out: './migrations', dialect: 'postgresql', dbCredentials: { url: process.env.DATABASE_URL }, strict: true, verbose: false }\\n")
		run(process.execPath, { args: [join(directory, 'node_modules/drizzle-kit/bin.cjs'), 'migrate', '--config', join(directory, 'drizzle.config.mjs')], env: { ...toolEnv, DATABASE_URL: env.DATABASE_URL } })
	}
	console.log(JSON.stringify({ revision: revision.headSha, provider, destination: expectedName, files: sqlNames.map((name) => ({ name, sha256: createHash('sha256').update(files.get(name)).digest('hex') })) }))
} finally {
	rmSync(directory, { recursive: true, force: true })
}
`
}
