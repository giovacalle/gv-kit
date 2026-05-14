import adapter from '@sveltejs/adapter-cloudflare'
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte'

/** @type {import('@sveltejs/kit').Config} */
const config = {
	preprocess: vitePreprocess(),
	kit: {
		adapter: adapter(),
		alias: {
			'@lib': '../../packages/ui/src/lib',
			'@lib/*': '../../packages/ui/src/lib/*'
		}
	}
}

export default config
