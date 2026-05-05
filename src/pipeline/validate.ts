import { z } from 'zod'

import { GvKitConfig } from '../schema/config.js'

/**
 * Parse raw input through `GvKitConfig`. On failure, throws an Error whose
 * message is a human-readable formatted tree of issues (zod v4 `treeifyError`).
 */
export function validate(raw: unknown): GvKitConfig {
	const result = GvKitConfig.safeParse(raw)
	if (result.success) {
		return result.data
	}
	const tree = z.treeifyError(result.error)
	throw new Error(`Invalid configuration:\n${JSON.stringify(tree, null, 2)}`)
}
