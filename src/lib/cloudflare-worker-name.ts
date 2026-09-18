import { createHash } from 'node:crypto'

export const CLOUDFLARE_WORKER_NAME_LIMIT = 255
export const CLOUDFLARE_WORKERS_DEV_NAME_LIMIT = 63
const WORKER_NAME_DIGEST_LENGTH = 20
const READABLE_SUFFIX_LIMIT = 64

type CloudflareProductionWorkerNameOptions = {
	project: string
	service: string
	workersDev?: boolean
}

export function cloudflareProductionWorkerName({
	project,
	service,
	workersDev = false
}: CloudflareProductionWorkerNameOptions): string {
	const limit = workersDev ? CLOUDFLARE_WORKERS_DEV_NAME_LIMIT : CLOUDFLARE_WORKER_NAME_LIMIT
	const name = `${project}-${service}`
	if (name.length <= limit) return name

	const digest = createHash('sha256')
		.update(project)
		.update('\0')
		.update(service)
		.digest('hex')
		.slice(0, WORKER_NAME_DIGEST_LENGTH)
	const readableService = service.slice(-READABLE_SUFFIX_LIMIT)
	const tail = `-${digest}-${readableService}`
	return `${project.slice(0, limit - tail.length)}${tail}`
}
