export function previewAuthorizationScript(): string {
	return `import { appendFileSync, readFileSync } from 'node:fs'
import { verifyPreviewCredentialPolicy } from './verify-cloudflare-preview-policy.mjs'

const env = process.env
function requireValue(name, pattern) {
	const value = env[name]
	if (typeof value !== 'string' || !pattern.test(value)) throw new Error('Invalid preview authorization input: ' + name)
	return value
}
function requireMatch(condition, message) {
	if (!condition) throw new Error('Preview authorization denied: ' + message)
}
const headSha = requireValue('PREVIEW_HEAD_SHA', /^[0-9a-f]{40}$/)
requireMatch(!/^0+$/.test(headSha), 'zero head SHA')
const prNumber = requireValue('PREVIEW_PR_NUMBER', /^[1-9][0-9]{0,9}$/)
const repository = requireValue('GITHUB_REPOSITORY', /^[A-Za-z0-9_.-]+\\/[A-Za-z0-9_.-]+$/)
const repositoryId = requireValue('GITHUB_REPOSITORY_ID', /^[1-9][0-9]*$/)
const actor = requireValue('GITHUB_ACTOR', /^[A-Za-z0-9_-]+$/)
const actorId = requireValue('GITHUB_ACTOR_ID', /^[1-9][0-9]*$/)
const runId = requireValue('GITHUB_RUN_ID', /^[1-9][0-9]*$/)
const attempt = requireValue('GITHUB_RUN_ATTEMPT', /^[1-9][0-9]*$/)
const trustedSha = requireValue('GITHUB_WORKFLOW_SHA', /^[0-9a-f]{40}$/)
requireMatch(env.GITHUB_EVENT_NAME === 'workflow_dispatch', 'manual dispatch required')
requireMatch(env.GITHUB_TRIGGERING_ACTOR === actor, 'rerun actor changed')
requireMatch(env.GITHUB_SHA === trustedSha, 'workflow source revision mismatch')
const event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8'))
requireMatch(event.inputs?.pr_number === prNumber && event.inputs?.head_sha === headSha, 'dispatch inputs mismatch')
requireMatch(event.repository?.full_name === repository && String(event.repository?.id) === repositoryId, 'event repository mismatch')
requireMatch(typeof env.GH_TOKEN === 'string' && env.GH_TOKEN.length > 0, 'GitHub token unavailable')
async function github(path) {
	const response = await fetch('https://api.github.com' + path, {
		headers: { Authorization: 'Bearer ' + env.GH_TOKEN, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
		redirect: 'error', signal: AbortSignal.timeout(15000)
	})
	requireMatch(response.ok, 'GitHub identity check failed')
	return response.json()
}
const repo = await github('/repos/' + repository)
requireMatch(repo.full_name === repository && String(repo.id) === repositoryId, 'repository identity mismatch')
requireMatch(typeof repo.default_branch === 'string' && repo.default_branch === event.repository.default_branch, 'default branch mismatch')
const trustedRef = 'refs/heads/' + repo.default_branch
requireMatch(env.GITHUB_REF === trustedRef, 'default branch ref required')
requireMatch(env.GITHUB_WORKFLOW_REF === repository + '/.github/workflows/deploy-staging.yml@' + trustedRef, 'trusted workflow required')
const run = await github('/repos/' + repository + '/actions/runs/' + runId)
requireMatch(String(run.id) === runId && String(run.run_attempt) === attempt && run.event === 'workflow_dispatch', 'run identity mismatch')
requireMatch(run.path === '.github/workflows/deploy-staging.yml' && run.head_sha === trustedSha && run.head_branch === repo.default_branch, 'run workflow mismatch')
requireMatch(run.repository?.full_name === repository && String(run.repository?.id) === repositoryId, 'run repository mismatch')
for (const user of [run.actor, run.triggering_actor]) requireMatch(user?.login === actor && String(user?.id) === actorId && user?.type === 'User', 'run actor mismatch')
const permission = await github('/repos/' + repository + '/collaborators/' + actor + '/permission')
requireMatch(permission.user?.login === actor && String(permission.user?.id) === actorId && permission.user?.type === 'User', 'maintainer identity unavailable')
// GitHub maps maintain to legacy write; never authorize using permission=write alone.
requireMatch((permission.role_name === 'maintain' && permission.permission === 'write') || (permission.role_name === 'admin' && permission.permission === 'admin'), 'maintain or admin permission required')
const pr = await github('/repos/' + repository + '/pulls/' + prNumber)
requireMatch(String(pr.number) === prNumber && pr.state === 'open', 'open PR identity required')
requireMatch(pr.base?.repo?.full_name === repository && String(pr.base?.repo?.id) === repositoryId && pr.base?.ref === repo.default_branch, 'PR base mismatch')
requireMatch(pr.head?.sha === headSha, 'PR head changed; dispatch a new authorization')
const headRepository = pr.head?.repo?.full_name
const headRepositoryId = String(pr.head?.repo?.id)
requireMatch(typeof headRepository === 'string' && /^[A-Za-z0-9_.-]+\\/[A-Za-z0-9_.-]+$/.test(headRepository) && /^[1-9][0-9]*$/.test(headRepositoryId), 'head repository unavailable')
const headRepo = await github('/repos/' + headRepository)
requireMatch(headRepo.full_name === headRepository && String(headRepo.id) === headRepositoryId, 'head repository mismatch')
const revision = {
	schemaVersion: 1, repository, repositoryId, prNumber, headRepository, headRepositoryId,
	headSha, trustedSha, trustedRef, actor, actorId, runId, alias: 'pr-' + prNumber
}
if (process.argv[2] === '--recheck') {
	requireMatch(typeof env.AUTHORIZED_REVISION === 'string' && env.AUTHORIZED_REVISION.length > 0, 'authorized revision required')
	const authorized = JSON.parse(env.AUTHORIZED_REVISION)
	requireMatch(JSON.stringify(authorized) === JSON.stringify(revision), 'authorized revision changed')
} else requireMatch(process.argv[2] === '--authorize', 'explicit authorization mode required')
await verifyPreviewCredentialPolicy()
appendFileSync(env.GITHUB_OUTPUT, Object.entries({
	revision: JSON.stringify(revision), pr_number: prNumber, head_sha: headSha,
	head_repository: headRepository, repository_id: repositoryId, trusted_sha: trustedSha, alias: revision.alias
}).map(([key, value]) => key + '=' + value + '\\n').join(''))
`
}
