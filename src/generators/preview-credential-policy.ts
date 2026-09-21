export function previewCredentialPolicyScript(requiredSecrets: string[]): string {
	return `import { fileURLToPath } from 'node:url'

const requiredSecrets = ${JSON.stringify(requiredSecrets)}
function requirePolicy(condition, message) {
	if (!condition) throw new Error('Preview authorization denied: credential policy: ' + message)
}
export async function verifyPreviewCredentialPolicy(protectionOnly = false) {
	const env = process.env
	const repository = env.GITHUB_REPOSITORY
	requirePolicy(typeof repository === 'string' && /^[A-Za-z0-9_.-]+\\/[A-Za-z0-9_.-]+$/.test(repository), 'repository required')
	requirePolicy(Boolean(env.PREVIEW_POLICY_TOKEN), 'metadata-only PREVIEW_POLICY_TOKEN required')
	async function github(path) {
		const response = await fetch('https://api.github.com/repos/' + repository + path, {
			headers: { Authorization: 'Bearer ' + env.PREVIEW_POLICY_TOKEN, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
			redirect: 'error', signal: AbortSignal.timeout(15000)
		})
		requirePolicy(response.ok, 'GitHub prerequisite check unavailable: ' + path)
		return response.json()
	}
	const repo = await github('')
	requirePolicy(repo.full_name === repository && String(repo.id) === env.GITHUB_REPOSITORY_ID, 'repository identity mismatch')
	requirePolicy(typeof repo.default_branch === 'string' && /^[A-Za-z0-9_./-]+$/.test(repo.default_branch), 'literal default branch required')
	requirePolicy(env.GITHUB_REF === 'refs/heads/' + repo.default_branch, 'trusted default branch required')
	const environment = await github('/environments/cloudflare-preview')
	requirePolicy(environment.name === 'cloudflare-preview' && environment.deployment_branch_policy?.protected_branches === false && environment.deployment_branch_policy?.custom_branch_policies === true, 'selected default branch environment required')
	const branches = await github('/environments/cloudflare-preview/deployment-branch-policies?per_page=100')
	requirePolicy(branches.total_count === 1 && branches.branch_policies?.length === 1 && branches.branch_policies[0].name === repo.default_branch && branches.branch_policies[0].type === 'branch', 'only the literal default branch may receive preview secrets; no tags or PR refs')
	const protection = await github('/branches/' + encodeURIComponent(repo.default_branch) + '/protection')
	requirePolicy(protection.enforce_admins?.enabled === true && protection.allow_force_pushes?.enabled === false && protection.allow_deletions?.enabled === false, 'enforced default branch protection without force pushes or deletion required')
	const restrictions = protection.restrictions
	requirePolicy(Array.isArray(restrictions?.users) && restrictions.users.length <= 100 && Array.isArray(restrictions.teams) && restrictions.teams.length === 0 && Array.isArray(restrictions.apps) && restrictions.apps.length === 0, 'explicit maintain/admin user push restrictions required; teams and apps are unsupported')
	for (const user of restrictions.users) {
		requirePolicy(user.type === 'User' && /^[A-Za-z0-9_-]+$/.test(user.login) && Number.isSafeInteger(user.id), 'push identity unavailable')
		const permission = await github('/collaborators/' + user.login + '/permission')
		requirePolicy(permission.user?.id === user.id && permission.user?.login === user.login && permission.user?.type === 'User' && ((permission.role_name === 'maintain' && permission.permission === 'write') || (permission.role_name === 'admin' && permission.permission === 'admin')), 'default branch push access must be maintain/admin only')
	}
	for (const path of ['/actions/secrets', '/actions/organization-secrets']) {
		const listing = await github(path + '?per_page=100')
		requirePolicy(Array.isArray(listing.secrets) && listing.total_count === listing.secrets.length && listing.total_count <= 100, 'complete secret metadata listing required')
		requirePolicy(listing.secrets.every((secret) => path === '/actions/secrets' && secret.name === 'PREVIEW_POLICY_TOKEN'), 'repository and shared organization secrets are forbidden except the metadata-only policy token')
	}
	if (!protectionOnly) {
		const listing = await github('/environments/cloudflare-preview/secrets?per_page=100')
		requirePolicy(Array.isArray(listing.secrets) && listing.total_count === requiredSecrets.length && listing.secrets.length === requiredSecrets.length && requiredSecrets.every((name) => listing.secrets.some((secret) => secret.name === name)), 'exact preview-only environment secret inventory required')
	}
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
	requirePolicy(process.argv[2] === '--verify' || process.argv[2] === '--check-protection', 'explicit policy mode required')
	await verifyPreviewCredentialPolicy(process.argv[2] === '--check-protection')
	console.log('Preview credential policy verified' + (process.argv[2] === '--check-protection' ? '; secret installation still required' : ''))
}
`
}
