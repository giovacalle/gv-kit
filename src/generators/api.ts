import type { FileEntry } from '../lib/files.js'
import type { GvKitConfig } from '../schema/config.js'
import { generateAuthService } from './services/auth.js'
import { generateUsersService } from './services/users.js'

/**
 * Top-level `apps/api/` orchestrator.
 *
 * `apps/api/` is a CONTAINER of independently deployable services — there is
 * no root `apps/api/wrangler.jsonc` or `apps/api/package.json`. When the
 * backend choice is anything other than `hono`, this generator emits nothing.
 *
 * For `backend === 'hono'`, two CF Workers are emitted:
 *   - `apps/api/auth/`  → owns auth state and OAuth secrets
 *   - `apps/api/users/` → calls auth via service binding only (no shared SDK)
 *
 * Service boundary: `apps/api/users/` MUST NEVER import `@repo/backend/auth`,
 * read `BETTER_AUTH_SECRET`, or query auth tables directly. See
 * `.claude/rules/service-architecture.md`.
 */
export function generateApi(cfg: GvKitConfig): FileEntry[] {
	if (cfg.choices.backend !== 'hono') return []
	return [...generateAuthService(cfg), ...generateUsersService(cfg)]
}
