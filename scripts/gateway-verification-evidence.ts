import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, relative } from 'node:path'

const GENERATED_EMAIL_OTP_PATTERN = /(\[auth\] OTP for [^\r\n]*?:[ \t]*)\d{6}\b/g
const OTP_FIELD_PATTERN = /(["']?\botp\b["']?\s*[:=]\s*["']?)\d{6}\b/gi
const UNSAFE_GENERATED_EMAIL_OTP_PATTERN = /\[auth\] OTP for [^\r\n]*?:[ \t]*\d{6}\b/
const UNSAFE_OTP_FIELD_PATTERN = /["']?\botp\b["']?\s*[:=]\s*["']?\d{6}\b/i

export type VerificationCommandEvidence = {
	name: string
	command: string
	outcome: 'passed' | 'failed' | 'skipped'
	durationMs: number
	logPath: string
	exitCode: number
}

export function redactArtifactText(input: string, roots: string[] = []): string {
	let output = input
	for (const root of [...roots].sort((left, right) => right.length - left.length)) if (root) output = output.replaceAll(root, '$WORKSPACE')
	return output
		.replace(GENERATED_EMAIL_OTP_PATTERN, '$1[REDACTED]')
		.replace(OTP_FIELD_PATTERN, '$1[REDACTED]')
		.replace(/\/Users\/[^/\s"'`]+/g, '/Users/[REDACTED]')
		.replace(/\/home\/[^/\s"'`]+/g, '/home/[REDACTED]')
		.replace(/[A-Z]:\\Users\\[^\\\s"'`]+/g, 'C:\\Users\\[REDACTED]')
		.replace(/(Authorization\s*:\s*Bearer\s+)[^\s"']+/gi, '$1[REDACTED]')
		.replace(
			/(-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----)[\s\S]*?(-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----)/g,
			'$1\n[REDACTED]\n$2'
		)
		.replace(/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED]')
		.replace(
			/\b(?:gh[opusr]_[A-Za-z0-9_]{20,}|npm_[A-Za-z0-9]{20,}|sk_live_[A-Za-z0-9]{12,})\b/g,
			'[REDACTED]'
		)
		.replace(/\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '[REDACTED]')
		.replace(/\bpostgres(?:ql)?:\/\/[^\s"'`]+/gi, 'postgres://[REDACTED]')
		.replace(
			/((?:[A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY)|DATABASE_URL)[ \t]*[:=][ \t]*["']?)([^\s"',}\n]{8,})/g,
			(_match, ...[prefix = '', value = '']: string[]) =>
				/^(?:\[REDACTED\]|\$\{|<|process\.env|(?:[A-Za-z_$][A-Za-z0-9_$]*\.)?env\.|string\b)/.test(
					value
				)
					? `${prefix}${value}`
					: `${prefix}[REDACTED]`
		)
}

export function unsafeArtifactFindings(input: string): string[] {
	const checks = [
		['generated email OTP', UNSAFE_GENERATED_EMAIL_OTP_PATTERN],
		['OTP field', UNSAFE_OTP_FIELD_PATTERN],
		[
			'absolute machine path',
			/(?:\/Users\/(?!\[REDACTED\])|\/home\/(?!\[REDACTED\])|[A-Z]:\\Users\\(?!\[REDACTED\]))/
		],
		['private key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
		['bearer token', /Authorization\s*:\s*Bearer\s+(?!\[REDACTED\]|\$[A-Z_])\S+/i],
		['credential URL', /postgres(?:ql)?:\/\/(?!\[REDACTED\]|user:pass@localhost)[^\s"'`]+/i],
		[
			'credential-shaped token',
			/(?:AKIA[0-9A-Z]{16}|gh[opusr]_[A-Za-z0-9_]{20,}|npm_[A-Za-z0-9]{20,}|sk_live_[A-Za-z0-9]{12,}|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.)/
		],
		[
			'sensitive assignment',
			/\b(?:[A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY)|DATABASE_URL)\b[ \t]*[:=][ \t]*["']?(?!\[REDACTED\]|\$\{|<|process\.env|(?:[A-Za-z_$][A-Za-z0-9_$]*\.)?env\.|string\b|local-only-|verification-only-|matrix-|docker-only-|postgres:\/\/user:pass@localhost)[^\s"',}\n]{8,}/
		]
	] as const
	return checks.filter(([, pattern]) => pattern.test(input)).map(([name]) => name)
}

export async function writeSanitizedArtifact({
	path,
	content,
	roots = []
}: {
	path: string
	content: string
	roots?: string[]
}): Promise<void> {
	await mkdir(dirname(path), { recursive: true })
	await writeFile(path, redactArtifactText(content, roots))
}

export function evidencePath(project: string, path: string): string {
	return relative(project, path) || '.'
}

export async function appendCommandEvidence(
	project: string,
	record: VerificationCommandEvidence
): Promise<void> {
	const path = `${project}/command-evidence.json`
	const records: VerificationCommandEvidence[] = await readFile(path, 'utf8')
		.then((content) => JSON.parse(content) as VerificationCommandEvidence[])
		.catch(() => [])
	records.push({ ...record, logPath: evidencePath(project, record.logPath) })
	await writeSanitizedArtifact({
		path,
		content: `${JSON.stringify(records, null, 2)}\n`,
		roots: [project]
	})
}

export async function readCommandEvidence(project: string): Promise<VerificationCommandEvidence[]> {
	const records = JSON.parse(await readFile(`${project}/command-evidence.json`, 'utf8')) as unknown
	if (!Array.isArray(records)) throw new Error('specialized command evidence is not an array')
	for (const record of records) if ( typeof record !== 'object' || record === null || typeof record.name !== 'string' || typeof record.command !== 'string' || !['passed', 'failed', 'skipped'].includes(record.outcome) || typeof record.durationMs !== 'number' || typeof record.exitCode !== 'number' || typeof record.logPath !== 'string' ) throw new Error('specialized command evidence has an invalid record')
	return records as VerificationCommandEvidence[]
}

export function assertPermittedWranglerInvocation(args: string[]): void {
	const index = args.findIndex((arg) => arg === 'wrangler' || /(?:^|\/)wrangler$/.test(arg))
	if (index < 0) return
	const wranglerArgs = args.slice(index + 1)
	const deploy = wranglerArgs.indexOf('deploy')
	const dryRun = wranglerArgs.indexOf('--dry-run')
	if (deploy !== 0 || dryRun <= deploy) throw new Error('Verifier may execute Wrangler only as `wrangler deploy ... --dry-run`')
}
