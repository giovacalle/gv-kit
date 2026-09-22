import { createHash } from 'node:crypto'
import { mkdir, readFile, realpath, writeFile, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { Database } from 'bun:sqlite'

function dialectFor(provider: string): string { return provider === 'd1' ? 'sqlite' : 'postgresql' }

function gitFixture(files: Record<string, string>, parent = '') {
	const objects: Record<string, { kind: string; base64: string }> = {}
	const api: Record<string, unknown> = {}
	const object = (kind: string, data: Buffer) => {
		const sha = createHash('sha1').update(Buffer.concat([Buffer.from(kind + ' ' + data.length + '\0'), data])).digest('hex')
		objects[sha] = { kind, base64: data.toString('base64') }
		return sha
	}
	const entries: Array<{path:string;mode:string;type:string;sha:string}> = []
	function directory(prefix: string): string {
		const names = [...new Set(Object.keys(files).filter(p=>p.startsWith(prefix)).map(p=>p.slice(prefix.length).split('/')[0]!))].sort()
		const raw: Buffer[] = []
		for (const name of names) {
			const path = prefix + name
			const text = files[path]
			const isTree = text === undefined
			const sha = isTree ? directory(path + '/') : object('blob',Buffer.from(text))
			if (!isTree) api['/repos/contributor/fork/git/blobs/'+sha] = {sha,encoding:'base64',size:Buffer.byteLength(text),content:Buffer.from(text).toString('base64')}
			entries.push({path,mode:isTree?'040000':'100644',type:isTree?'tree':'blob',sha})
			raw.push(Buffer.from((isTree?'40000':'100644')+' '+name+'\0'),Buffer.from(sha,'hex'))
		}
		return object('tree',Buffer.concat(raw))
	}
	const treeSha = directory('')
	const commit = object('commit',Buffer.from('tree '+treeSha+'\n'+(parent?'parent '+parent+'\n':'')+'author Fixture <fixture@example.test> 1700000000 +0000\ncommitter Fixture <fixture@example.test> 1700000000 +0000\n\nImmutable migration fixture\n'))
	api['/repos/contributor/fork/git/commits/'+commit] = {sha:commit,tree:{sha:treeSha}}
	api['/repos/contributor/fork/git/trees/'+treeSha] = {sha:treeSha,truncated:false,tree:entries}
	return {commit,treeSha,entries,api,objects}
}

export async function verifyPreviewMigrations(project: string): Promise<string[]> {
	const root = join(project, '.wrangler/verify-preview-migrations')
	await mkdir(root, { recursive: true })
	const workflow = Bun.YAML.parse(await readFile(join(project, '.github/workflows/deploy-staging.yml'), 'utf8')) as { jobs: { deploy: { steps: Array<{ name?: string; run?: string; if?: string; 'continue-on-error'?: boolean; env?: Record<string, string> }> } } }
	const step = workflow.jobs.deploy.steps.find(({ name }) => name?.startsWith('Apply preview '))!
	const publicationStep = workflow.jobs.deploy.steps.find(({name})=>name === 'Publish prebuilt preview Workers from trusted code')
	if (!publicationStep || workflow.jobs.deploy.steps.indexOf(step) >= workflow.jobs.deploy.steps.indexOf(publicationStep) || step.if || step['continue-on-error'] || publicationStep.if) throw new Error('Publication must require successful migrations under default step scheduling')
	const provider = step.name!.includes('D1') ? 'd1' : 'neon'
	const authRoot = join(project, '.wrangler/verify-preview-authorization')
	const revision = JSON.parse(await readFile(join(authRoot, 'summary.json'), 'utf8')).revision
	const api = JSON.parse(await readFile(join(authRoot, 'valid-maintainer/api.json'), 'utf8'))
	const baseSql = 'CREATE TABLE sample (id INTEGER PRIMARY KEY);\nINSERT INTO sample (id) VALUES (1);\n'
	const headSql = "ALTER TABLE sample ADD COLUMN head_only TEXT DEFAULT 'authorized-head';\n"
	const journal = JSON.stringify({ version: '7', dialect: provider === 'd1' ? 'sqlite' : 'postgresql', entries: [
		{ idx: 0, version: '7', when: 1000, tag: '0000_base', breakpoints: true },
		{ idx: 1, version: '7', when: 2000, tag: '0001_head', breakpoints: true }
	] })
	const files: Record<string, string> = { '0000_base.sql': baseSql, '0001_head.sql': headSql, 'meta/_journal.json': journal }
	const appPath = 'services/users/schema-request.mjs'
	const headApp = "export default (db) => ({ fetch: async (request) => new URL(request.url).pathname === '/api/v1/sample' ? Response.json(db.query('SELECT head_only FROM sample WHERE id = 1').get()) : new Response(null, {status:404}) })\n"
	const baseJournal = JSON.stringify({...JSON.parse(journal),entries:JSON.parse(journal).entries.slice(0,1)})
	const base = gitFixture({'packages/db/migrations/0000_base.sql':baseSql,'packages/db/migrations/meta/_journal.json':baseJournal,[appPath]:headApp.replace('head_only','id')})
	const head = gitFixture({...Object.fromEntries(Object.entries(files).map(([path,text])=>['packages/db/migrations/'+path,text])),[appPath]:headApp},base.commit)
	Object.assign(api,base.api,head.api)
	revision.headSha = head.commit
	revision.trustedSha = base.commit
	api['/repos/owner/repository/pulls/181'].head.sha = head.commit
	api['/repos/owner/repository/actions/runs/777'].head_sha = base.commit
	const event = JSON.parse(await readFile(join(authRoot,'valid-maintainer/event.json'),'utf8'))
	event.inputs.head_sha = head.commit
	await writeFile(join(root,'event.json'),JSON.stringify(event))
	await writeFile(join(root,'immutable-git-fixtures.json'),JSON.stringify({base,head},null,2))
	await writeFile(join(root,'head-app.mjs'),headApp)
	const tree = head.entries
	await mkdir(join(project,'preview-artifact/packages/db/migrations'),{recursive:true})
	await writeFile(join(project,'preview-artifact/packages/db/migrations/0001_head.sql'),'INVALID POST-BUILD SQL;')
	await writeFile(join(project,'preview-artifact/packages/db/drizzle.config.mjs'),"throw new Error('PR configuration executed')")
	await writeFile(join(project,'preview-artifact/packages/db/package.json'),JSON.stringify({scripts:{migrate:"echo PR-owned-script; exit 99"}}))
	api['/client/v4/accounts/' + '1'.repeat(32) + '/d1/database/11111111-1111-4111-8111-111111111111'] = { success: true, result: { uuid: '11111111-1111-4111-8111-111111111111', name: 'preview-123456-d1-pr-181' } }
	api['/api/v2/projects/synthetic-project/branches/br-preview'] = { branch: { id: 'br-preview', name: 'preview-123456-neon-pr-181', project_id: 'synthetic-project', default: false } }
	api['/api/v2/projects/synthetic-project/branches/br-preview/endpoints'] = { endpoints: [{ host: 'ep-preview.us-east-2.aws.neon.tech', branch_id: 'br-preview', project_id: 'synthetic-project', type: 'read_write' }] }
	await writeFile(join(root, 'api.json'), JSON.stringify(api))
	await writeFile(join(root, 'fetch.mjs'), `import { readFileSync, appendFileSync } from 'node:fs';
	globalThis.fetch = async (url) => {
	 const u = new URL(url); if (!['api.github.com', 'api.cloudflare.com', 'console.neon.tech'].includes(u.hostname)) throw new Error('Unexpected host');
	 appendFileSync(process.env.API_REQUESTS, String(url) + '\\n');
	 const data = JSON.parse(readFileSync(process.env.API_FIXTURE));
	 if (!(u.pathname in data)) throw new Error('Unstubbed request ' + url);
	 return Response.json(data[u.pathname], { status: data[u.pathname] === null ? 503 : 200 });
	};`)
	const migrationScript = await readFile(join(project, 'scripts/migrate-cloudflare-preview.mjs'), 'utf8').catch(() => '')
	if (migrationScript) {
		await writeFile(join(project, 'trusted-source/scripts/migrate-cloudflare-preview.mjs'), migrationScript)
		await writeFile(
			join(project, 'trusted-source/scripts/preview-migration-package-lock.json'),
			await readFile(join(project, 'scripts/preview-migration-package-lock.json'))
		)
	}
	await mkdir(join(project, 'trusted-source/packages/db/migrations/meta'), { recursive: true })
	await writeFile(join(project, 'trusted-source/packages/db/migrations/0000_base.sql'), baseSql)
	await writeFile(join(project, 'trusted-source/packages/db/migrations/meta/_journal.json'), JSON.stringify({ ...JSON.parse(journal), entries: JSON.parse(journal).entries.slice(0, 1) }))
	const bin = join(root, 'bin')
	await mkdir(bin, { recursive: true })
	const receipt = join(root, 'receipt.json')
	await writeFile(join(bin, 'npx'), `#!/usr/bin/env node
import fs from 'node:fs'; import path from 'node:path';
const args = process.argv.slice(2); const config = args[args.indexOf('--config') + 1];
const folder = process.env.PREVIEW_MIGRATIONS || path.resolve(path.dirname(config), JSON.parse(fs.readFileSync(config)).d1_databases[0].migrations_dir);
fs.writeFileSync(process.env.MIGRATION_RECEIPT, JSON.stringify({ args, folder, sql: fs.readdirSync(folder).filter(p => p.endsWith('.sql')).sort().map(p => fs.readFileSync(path.join(folder,p),'utf8')) }));
`, { mode: 0o755 })
	let driverProbe = ''
	if (provider === 'neon') {
		const tools = join(root, 'pinned-driver')
		await mkdir(tools)
		await writeFile(join(tools, 'package.json'), JSON.stringify({ private: true, dependencies: { postgres: '3.4.7' } }))
		const args = ['install', '--ignore-scripts', '--no-audit', '--no-fund']
		const install = spawnSync('npm', args, { cwd: tools, env: { PATH: process.env.PATH, HOME: tools, CI: 'true', npm_config_userconfig: '/dev/null', npm_config_cache: join(tools, '.npm') }, encoding: 'utf8', timeout: 180_000 })
		await writeFile(join(tools, 'install.json'), JSON.stringify({ command: ['npm', ...args], exitCode: install.status, stdout: install.stdout, stderr: install.stderr }, null, 2))
		if (install.error || install.status !== 0) throw new Error('Pinned Neon verifier driver installation failed')
		const driverPath = join(tools, 'node_modules/postgres')
		if (JSON.parse(await readFile(join(driverPath, 'package.json'), 'utf8')).version !== '3.4.7') throw new Error('Unexpected verifier driver version')
		driverProbe = `
		const net = require('node:net');
		net.Socket.prototype.connect = () => { throw new Error('Verifier must not connect to a database'); };
		const sql = require(${JSON.stringify(driverPath)})(process.env.DATABASE_URL, { max: 1 });
		const { host, port, ssl, user, pass, database } = sql.options;
		const driver = { version: '3.4.7', host, port, ssl, user, pass, database };
		sql.end();`
	}
	const providerStub = `const fs = require('node:fs'); const path = require('node:path');
	${driverProbe || 'const driver = null;'}
	const args = process.argv.slice(2); const configPath = args[args.indexOf('--config')+1];
	const config = fs.readFileSync(configPath,'utf8'); const folder = path.join(process.cwd(),'migrations');
	fs.writeFileSync(${JSON.stringify(receipt)}, JSON.stringify({ args, runner:fs.realpathSync(process.argv[1]), node:process.execPath, cwd:fs.realpathSync(process.cwd()), config, driver, package:JSON.parse(fs.readFileSync('package.json')), databaseUrl:process.env.DATABASE_URL, sql:fs.readdirSync(folder).filter(p=>p.endsWith('.sql')).sort().map(p=>fs.readFileSync(path.join(folder,p),'utf8')), journal:JSON.parse(fs.readFileSync(path.join(folder,'meta/_journal.json'))) }));
	process.exit(fs.existsSync(${JSON.stringify(join(root, 'fail-provider'))}) ? 1 : 0);`
	await writeFile(join(bin, 'npm'), `#!/usr/bin/env node
	import fs from 'node:fs'; import path from 'node:path';
	if (process.env.DATABASE_URL || process.env.NEON_API_KEY || process.env.GH_TOKEN || process.env.CLOUDFLARE_API_TOKEN || process.env.NODE_OPTIONS) throw new Error('Installer received credentials or injected config');
	fs.writeFileSync(${JSON.stringify(join(root, 'installer.json'))}, JSON.stringify({args:process.argv.slice(2),cwd:process.cwd(),package:JSON.parse(fs.readFileSync('package.json')),lock:JSON.parse(fs.readFileSync('package-lock.json'))}));
	for (const file of ['wrangler/bin/wrangler.js','drizzle-kit/bin.cjs']) { const p=path.join('node_modules',file); fs.mkdirSync(path.dirname(p),{recursive:true}); fs.writeFileSync(p,${JSON.stringify(providerStub)}); }
	`, {mode:0o755})
	const env: Record<string, string> = {
		PATH: bin + ':' + process.env.PATH, HOME: root, RUNNER_TEMP: root, CI: 'true',
		GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REPOSITORY: revision.repository, GITHUB_REPOSITORY_ID: revision.repositoryId,
		GITHUB_SHA: revision.trustedSha, GITHUB_WORKFLOW_SHA: revision.trustedSha, GITHUB_REF: revision.trustedRef,
		GITHUB_WORKFLOW_REF: revision.repository + '/.github/workflows/deploy-staging.yml@' + revision.trustedRef,
		GITHUB_ACTOR: revision.actor, GITHUB_ACTOR_ID: revision.actorId, GITHUB_TRIGGERING_ACTOR: revision.actor,
		GITHUB_RUN_ID: revision.runId, GITHUB_RUN_ATTEMPT: '1', PREVIEW_HEAD_SHA: revision.headSha, PREVIEW_PR_NUMBER: revision.prNumber,
		AUTHORIZED_REVISION: JSON.stringify(revision), GH_TOKEN: 'synthetic-github-token', PREVIEW_POLICY_TOKEN: 'synthetic-github-token',
		GITHUB_EVENT_PATH: join(root, 'event.json'), GITHUB_OUTPUT: join(root, 'github-output.txt'),
		API_FIXTURE: join(root, 'api.json'), API_REQUESTS: join(root, 'api-requests.log'), NODE_OPTIONS: '--import=' + join(root, 'fetch.mjs'), MIGRATION_RECEIPT: receipt
	}
	const values: Record<string, string> = { 'needs.preview-db.outputs.alias': 'pr-181', 'secrets.PREVIEW_CLOUDFLARE_ACCOUNT_ID': '1'.repeat(32), 'needs.preview-db.outputs.neon_branch_name': 'preview-123456-neon-pr-181', 'needs.preview-db.outputs.neon_branch_id': 'br-preview', 'vars.NEON_PROJECT_ID': 'synthetic-project', 'github.workspace': project, 'needs.preview-db.outputs.d1_database_name': 'preview-123456-d1-pr-181', 'needs.preview-db.outputs.d1_database_id': '11111111-1111-4111-8111-111111111111', 'needs.preview-db.outputs.database_url': 'postgres://preview:synthetic@ep-preview-pooler.us-east-2.aws.neon.tech/preview?sslmode=require' }
	const resolve = (source: string) => source.replace(/\$\{\{ ([^}]+) \}\}/g, (_, key: string) => values[key] ?? 'synthetic-value')
	for (const [key, value] of Object.entries(step.env ?? {})) env[key] = resolve(value)
	const command = resolve(step.run!)
	const result = spawnSync('bash', ['-e', '-c', command], { cwd: project, env, encoding: 'utf8', timeout: 120_000 })
	await writeFile(join(root, 'result.json'), JSON.stringify({ command, exitCode: result.status, stdout: result.stdout, stderr: result.stderr }, null, 2))
	if (result.status !== 0) throw new Error('Migration step failed: ' + result.stderr)
	const applied = JSON.parse(await readFile(receipt, 'utf8'))
	if (!applied.sql.includes(headSql)) throw new Error('Authorized head-only migration missing: provider received base migration bytes')
	const db = new Database(':memory:')
	try {
		for (const sql of applied.sql) db.exec(sql)
		const app = (await import(join(root,'head-app.mjs'))).default(db)
		const response = await app.fetch(new Request('https://preview.example.test/api/v1/sample'))
		if ((await response.json() as { head_only: string }).head_only !== 'authorized-head') throw new Error('Head schema request failed')
	} finally { db.close() }
	const baseDb = new Database(':memory:')
	try {
		baseDb.exec(baseSql)
		let rejected = false
		try { baseDb.query('SELECT head_only FROM sample').get() } catch { rejected = true }
		if (!rejected) throw new Error('Base schema unexpectedly supports the head request')
	} finally { baseDb.close() }
	const installation = JSON.parse(await readFile(join(root,'installer.json'),'utf8'))
	if (JSON.stringify(installation.args) !== JSON.stringify(['ci','--ignore-scripts','--no-audit','--no-fund'])) throw new Error('Unsafe trusted tool installation command')
	if (installation.lock.lockfileVersion !== 3 || !Object.entries(installation.lock.packages as Record<string, { integrity?: unknown }>).slice(1).every(([, entry]) => typeof entry.integrity === 'string' && entry.integrity.startsWith('sha512-'))) throw new Error('Trusted migration lock is not integrity-pinned')
	if (provider === 'neon' && (applied.package.dependencies['drizzle-orm'] !== '0.45.0' || applied.package.dependencies.postgres !== '3.4.7')) throw new Error('Neon migration drivers were not pinned')
	if (applied.runner !== join(applied.cwd, provider === 'd1' ? 'node_modules/wrangler/bin/wrangler.js' : 'node_modules/drizzle-kit/bin.cjs')) throw new Error('Unexpected provider runner')
	await writeFile(join(root,'valid-installer.json'),JSON.stringify(installation,null,2))
	const canonicalRoot = await realpath(root)
	if (applied.cwd && !applied.cwd.startsWith(canonicalRoot + '/authorized-preview-migrations-')) throw new Error('Provider tool ran outside trusted temporary directory')
	if (applied.package?.dependencies?.[provider === 'd1' ? 'wrangler' : 'drizzle-kit'] !== (provider === 'd1' ? '4.125.0' : '0.31.8')) throw new Error('Migration tool was not pinned')
	if (provider === 'd1' && (!applied.args.includes('preview-123456-d1-pr-181') || !applied.args.includes('--remote') || JSON.parse(applied.config).d1_databases[0].database_id !== values['needs.preview-db.outputs.d1_database_id'])) throw new Error('Wrong D1 invocation destination')
	if (provider === 'neon' && (applied.databaseUrl !== values['needs.preview-db.outputs.database_url'] || applied.args[0] !== 'migrate' || !applied.config.includes("dialect: 'postgresql'"))) throw new Error('Wrong Neon invocation destination')
	await writeFile(join(root, 'valid-receipt.json'), JSON.stringify(applied, null, 2))
	const results = ['migration-' + provider + '-authorized-head', 'base-schema-rejects-head-request', 'local-sql-head-request']
	if (provider === 'neon') {
		if (JSON.stringify(applied.driver.host) !== JSON.stringify(['ep-preview-pooler.us-east-2.aws.neon.tech']) || applied.driver.ssl !== 'require' || JSON.stringify(applied.driver.port) !== '[5432]') throw new Error('Pinned driver changed the validated pooled destination or TLS mode')
		const connections = [
			{ name: 'valid-direct', url: 'postgresql://preview:synthetic@ep-preview.us-east-2.aws.neon.tech:5432/preview?sslmode=require' },
			{ name: 'valid-encoded-credentials', url: 'postgres://user%40team:p%40ss%2Cword%3A%2F%3F%23%25@ep-preview-pooler.us-east-2.aws.neon.tech/preview?channel_binding=require&sslmode=require' }
		]
		for (const connection of connections) {
			const directory = join(root, connection.name)
			await mkdir(directory)
			await rm(receipt, { force: true })
			await rm(join(root, 'installer.json'), { force: true })
			const publication = join(directory, 'publication.txt')
			const run = spawnSync('bash', ['-e', '-c', command + '\nprintf published > "$PUBLICATION_RECEIPT"'], { cwd: project, env: { ...env, DATABASE_URL: connection.url, PUBLICATION_RECEIPT: publication }, encoding: 'utf8', timeout: 120_000 })
			await writeFile(join(directory, 'result.json'), JSON.stringify({ command, exitCode: run.status, stdout: run.stdout, stderr: run.stderr }, null, 2))
			if (run.status !== 0) throw new Error(connection.name + ' rejected: ' + run.stderr)
			const consumed = JSON.parse(await readFile(receipt, 'utf8'))
			await writeFile(join(directory, 'provider-receipt.json'), JSON.stringify(consumed, null, 2))
			await writeFile(join(directory, 'installer-receipt.json'), await readFile(join(root, 'installer.json')))
			const expected = new URL(connection.url)
			if (consumed.databaseUrl !== connection.url || JSON.stringify(consumed.driver.host) !== JSON.stringify([expected.hostname]) || JSON.stringify(consumed.driver.port) !== '[5432]' || consumed.driver.ssl !== 'require' || consumed.driver.user !== decodeURIComponent(expected.username) || consumed.driver.pass !== decodeURIComponent(expected.password) || consumed.driver.database !== 'preview') throw new Error(connection.name + ' changed the validated driver connection')
			if (await readFile(publication, 'utf8') !== 'published') throw new Error(connection.name + ' did not reach publication')
			results.push(connection.name)
		}
	}
	const treeKey = '/repos/contributor/fork/git/trees/' + head.treeSha
	const commitKey = '/repos/contributor/fork/git/commits/' + revision.headSha
	const attacks: Array<{ name: string; api?: Record<string, unknown>; env?: Record<string, string>; providerFailure?: boolean }> = [
		{ name: 'revision-mismatch', env: { PREVIEW_HEAD_SHA: 'd'.repeat(40) } },
		{ name: 'commit-mismatch', api: { ...api, [commitKey]: { ...api[commitKey], sha: 'd'.repeat(40) } } },
		{ name: 'missing-commit', api: { ...api, [commitKey]: null } },
		{ name: 'truncated-tree', api: { ...api, [treeKey]: { ...api[treeKey], truncated: true } } },
		{ name: 'missing-migrations', api: { ...api, [treeKey]: { ...api[treeKey], tree: [] } } },
		{ name: 'traversal', api: { ...api, [treeKey]: { ...api[treeKey], tree: [...tree, { ...tree[0], path: 'packages/db/migrations/../../escape.sql' }] } } },
		{ name: 'symlink', api: { ...api, [treeKey]: { ...api[treeKey], tree: tree.map((e,i) => i === 0 ? {...e, mode:'120000'} : e) } } },
		{ name: 'executable', api: { ...api, [treeKey]: { ...api[treeKey], tree: tree.map((e,i) => i === 0 ? {...e, mode:'100755'} : e) } } },
		{ name: 'unexpected-config', api: { ...api, [treeKey]: { ...api[treeKey], tree: [...tree, {...tree[0], path:'packages/db/migrations/drizzle.config.mjs'}] } } },
		{ name: 'duplicate-path', api: { ...api, [treeKey]: { ...api[treeKey], tree: [...tree,tree[0]] } } },
		{ name: 'missing-sql', api: { ...api, [treeKey]: { ...api[treeKey], tree: tree.slice(1) } } },
		{ name: 'wrong-alias', env: { STAGING_ALIAS:'pr-182' } },
		{ name: 'provider-failure', providerFailure: true }
	]
	for (const [name, content] of [['malformed-journal','{'], ['journal-traversal', journal.replace('0001_head','../../outside')], ['journal-timestamp',journal.replace('2000','1000')], ['journal-dialect',journal.replace(dialectFor(provider),'mysql')], ['malformed-snapshot',JSON.stringify({version:'7',dialect:dialectFor(provider),id:'not-a-uuid',prevId:'also-invalid',tables:{}})]] as const) {
		const attackApi = structuredClone(api)
		const sha = createHash('sha1').update('blob ' + Buffer.byteLength(content) + '\0' + content).digest('hex')
		attackApi['/repos/contributor/fork/git/blobs/'+sha] = {sha,encoding:'base64',size:Buffer.byteLength(content),content:Buffer.from(content).toString('base64')}
		attackApi[treeKey].tree = name === 'malformed-snapshot' ? [...tree, {path:'packages/db/migrations/meta/0001_snapshot.json',mode:'100644',type:'blob',sha}] : tree.map(e => e.path.endsWith('_journal.json') ? {...e,sha} : e)
		attacks.push({name,api:attackApi})
	}
	const blobKey = '/repos/contributor/fork/git/blobs/' + tree.find(e=>e.path.endsWith('0000_base.sql'))!.sha
	attacks.push({name:'blob-integrity',api:{...api,[blobKey]:{...api[blobKey],content:Buffer.from('SELECT 1;').toString('base64')}}})
	if (provider === 'd1') {
		attacks.push({ name:'production-name',env:{STAGING_D1_DATABASE_NAME:'production'} }, {name:'cross-preview-id',api:{...api,['/client/v4/accounts/' + '1'.repeat(32) + '/d1/database/11111111-1111-4111-8111-111111111111']:{success:true,result:{uuid:values['needs.preview-db.outputs.d1_database_id'],name:'preview-123456-d1-pr-182'}}}})
	} else {
		attacks.push({ name: 'duplicate-sslmode', env: { DATABASE_URL: values['needs.preview-db.outputs.database_url'] + '&sslmode=disable' } })
		attacks.push({ name: 'ambiguous-userinfo', env: { DATABASE_URL: 'postgres://preview:synthetic@outside.example.test,unused@ep-preview-pooler.us-east-2.aws.neon.tech/preview?sslmode=require' } })
		for (const [name, url] of [
			['duplicate-sslmode-encoded-key', values['needs.preview-db.outputs.database_url'] + '&%73slmode=disable'],
			['duplicate-sslmode-identical', values['needs.preview-db.outputs.database_url'] + '&sslmode=require'],
			['duplicate-channel-binding', values['needs.preview-db.outputs.database_url'] + '&channel_binding=require&channel_binding=disable'],
			['extra-userinfo-delimiter', 'postgres://preview:synthetic@unused@ep-preview-pooler.us-east-2.aws.neon.tech/preview?sslmode=require'],
			['encoded-host-separator', 'postgres://preview:synthetic@outside.example.test%2Cep-preview-pooler.us-east-2.aws.neon.tech/preview?sslmode=require'],
			['literal-host-list', 'postgres://preview:synthetic@outside.example.test,ep-preview-pooler.us-east-2.aws.neon.tech/preview?sslmode=require'],
			['raw-connection-whitespace', values['needs.preview-db.outputs.database_url']!.replace('preview:synthetic', 'preview:syn\nthetic')],
			['malformed-credential-escape', values['needs.preview-db.outputs.database_url']!.replace('preview:synthetic', 'preview:%FF')]
		] as const) attacks.push({ name, env: { DATABASE_URL: url! } })
		attacks.push({name:'missing-journal',api:{...api,[treeKey]:{...api[treeKey],tree:tree.filter(e=>!e.path.endsWith('_journal.json'))}}}, {name:'malformed-url',env:{DATABASE_URL:'synthetic-private-connection-value'}}, {name:'production-url',env:{DATABASE_URL:'postgres://prod:synthetic@production.example.test/db?sslmode=require'}}, {name:'cross-preview-branch',env:{STAGING_NEON_BRANCH_NAME:'preview-123456-neon-pr-182'}}, {name:'default-branch',api:{...api,'/api/v2/projects/synthetic-project/branches/br-preview':{branch:{...api['/api/v2/projects/synthetic-project/branches/br-preview'].branch,default:true}}}})
	}
	for (const attack of attacks) {
		const directory = join(root, attack.name)
		await mkdir(directory)
		await rm(receipt, {force:true})
		await rm(join(root,'installer.json'), {force:true})
		await writeFile(join(directory,'api.json'), JSON.stringify(attack.api ?? api))
		if (attack.providerFailure) await writeFile(join(root,'fail-provider'),'fail')
		const publication = join(directory,'publication.txt')
		const run = spawnSync('bash',['-e','-c',command + '\nprintf published > "$PUBLICATION_RECEIPT"'],{cwd:project,env:{...env,...attack.env,API_FIXTURE:join(directory,'api.json'),PUBLICATION_RECEIPT:publication},encoding:'utf8',timeout:120_000})
		await writeFile(join(directory,'result.json'),JSON.stringify({command,exitCode:run.status,stdout:run.stdout,stderr:run.stderr},null,2))
		if (attack.name === 'malformed-url' && run.stderr.includes(attack.env!.DATABASE_URL!)) throw new Error('Malformed connection leaked its value in migration logs')
		const invoked = await readFile(receipt,'utf8').catch(()=>'')
		await writeFile(join(directory,'provider-receipt.json'),invoked)
		const installed = await readFile(join(root,'installer.json'),'utf8').catch(()=>'')
		await writeFile(join(directory,'installer-receipt.json'),installed)
		await writeFile(join(directory,'boundary-counts.json'),JSON.stringify({ installer: installed ? 1 : 0, migration: invoked ? 1 : 0, publication: await readFile(publication,'utf8').catch(()=>'') ? 1 : 0 },null,2))
		if (run.status === 0 || await readFile(publication,'utf8').catch(()=>'')) throw new Error(attack.name + ' failed to block publication')
		if (!attack.providerFailure && invoked) throw new Error(attack.name + ' reached provider migration')
		if (!attack.providerFailure && await readFile(join(root,'installer.json'),'utf8').catch(()=>'')) throw new Error(attack.name + ' reached tooling before validation')
		await rm(join(root,'fail-provider'),{force:true})
		results.push(attack.name)
	}
	if ((await readdir(root)).some(p=>p.startsWith('authorized-preview-migrations-'))) throw new Error('Migration runner leaked owned temporary directory')
	await writeFile(join(root,'summary.json'),JSON.stringify({provider,revision,results,localSql:'SQLite executed base and head SQL; head-only request fails on base and succeeds on head.',neonLimit:'Neon API and tool invocations are deterministic stubs. SQLite SQL execution does not establish PostgreSQL or remote Neon migration semantics.',cleanup:true},null,2))
	return results
}
