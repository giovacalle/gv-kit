import { spawn as nodeSpawn } from 'node:child_process'

export type SpawnResult = {
	exitCode: number
	stdout: string
	stderr: string
}

/**
 * Spawn a subprocess and collect stdout/stderr/exitCode.
 * Node `child_process.spawn` so the bundled CLI runs under both Node and Bun.
 */
export async function spawn(cmd: string, args: string[], cwd: string): Promise<SpawnResult> {
	return new Promise((resolve, reject) => {
		const proc = nodeSpawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
		let stdout = ''
		let stderr = ''
		proc.stdout.on('data', (chunk) => {
			stdout += chunk.toString()
		})
		proc.stderr.on('data', (chunk) => {
			stderr += chunk.toString()
		})
		proc.on('error', reject)
		proc.on('close', (code) => {
			resolve({ exitCode: code ?? 0, stdout, stderr })
		})
	})
}

/**
 * Spawn a subprocess and throw if it exits non-zero.
 * `label` is included in the thrown message for traceability.
 */
export async function runOrThrow(
	cmd: string,
	args: string[],
	cwd: string,
	label: string
): Promise<SpawnResult> {
	const result = await spawn(cmd, args, cwd)
	if (result.exitCode !== 0) {
		throw new Error(
			`${label} failed (exit ${result.exitCode}): ${cmd} ${args.join(' ')}\n` +
				`cwd=${cwd}\n` +
				`stderr: ${result.stderr.trim() || '(empty)'}\n` +
				`stdout: ${result.stdout.trim() || '(empty)'}`
		)
	}
	return result
}
