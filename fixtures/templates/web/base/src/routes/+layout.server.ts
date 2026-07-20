import type { LayoutServerLoad } from './$types'

export const load: LayoutServerLoad = (/*@gvkit:if layoutServerUsesLocals*/{ locals }/*@gvkit:endif*/) => {
	return {
		/*@gvkit:if auth*/
		user: locals.user ?? null,
		/*@gvkit:endif*/
		/*@gvkit:if i18nParaglide*/
		locale: locals.locale
		/*@gvkit:endif*/
	}
}
