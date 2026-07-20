import { fileURLToPath } from 'node:url'

import sitemap from '@astrojs/sitemap'
import svelte from '@astrojs/svelte'
import tailwindcss from '@tailwindcss/vite'

const publicMarketingUrl = process.env.PUBLIC_MARKETING_URL
if (!publicMarketingUrl) {
	throw new Error('PUBLIC_MARKETING_URL is required to build canonical URLs and the sitemap')
}

const uiLib = fileURLToPath(new URL('../../packages/ui/src/lib', import.meta.url))

// Astro 7 expects a plain config object. Do not replace this with a Vite-style
// callback: Astro can silently ignore integrations returned from that shape.
export default {
	output: 'static',
	site: publicMarketingUrl,
	integrations: [svelte(), sitemap()],
	vite: {
		plugins: [tailwindcss()],
		resolve: {
			alias: {
				'@lib': uiLib
			}
		}
	}
}
