import type { FileEntry } from '../lib/files.js'
import { renderTemplate } from '../lib/template-renderer.js'
import type { GvKitConfig } from '../schema/config.js'

export function generateUi(cfg: GvKitConfig): FileEntry[] {
	return renderTemplate({
		tree: 'ui',
		flags: {
			authEmailOtp: cfg.choices.auth.includes('emailOTP')
		},
		vars: { __PROJECT__: cfg.choices.name }
	})
}
