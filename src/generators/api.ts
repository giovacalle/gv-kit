import type { FileEntry } from '../lib/files.js'
import type { GvKitConfig } from '../schema/config.js'
import { generateGateway } from './gateway.js'
import { HONO_SERVICES, type HonoServiceIdentity } from './hono-topology.js'
import { generateAuthService } from './services/auth.js'
import { generateUsersService } from './services/users.js'

const SERVICE_GENERATORS = {
	auth: generateAuthService,
	users: generateUsersService
} satisfies Record<HonoServiceIdentity, (cfg: GvKitConfig) => FileEntry[]>

export function generateApi(cfg: GvKitConfig): FileEntry[] {
	if (cfg.choices.backend !== 'hono') return []
	return [
		...generateGateway(cfg),
		...HONO_SERVICES.flatMap((service) => SERVICE_GENERATORS[service.identity](cfg))
	]
}
