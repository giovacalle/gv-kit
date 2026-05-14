import type { LayoutServerLoad } from './$types'

export const load: LayoutServerLoad = ({ locals }) => {
	return {
		/*@gvkit:if auth*/
		user: locals.user ?? null,
		/*@gvkit:endif*/
		/*@gvkit:if i18nParaglide*/
		locale: locals.locale
		/*@gvkit:endif*/
	}
}
