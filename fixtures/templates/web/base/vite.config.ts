/*@gvkit:if i18nParaglide*/
import { paraglideVitePlugin } from '@inlang/paraglide-js'
/*@gvkit:endif*/
import { sveltekit } from '@sveltejs/kit/vite'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'

export default defineConfig({
	plugins: [
		tailwindcss(),
		/*@gvkit:if i18nParaglide*/
		paraglideVitePlugin({
			project: '../../packages/i18n/project.inlang',
			outdir: '../../packages/i18n/src/paraglide',
			strategy: ['cookie', 'preferredLanguage', 'baseLocale']
		}),
		/*@gvkit:endif*/
		sveltekit()
	]
})
