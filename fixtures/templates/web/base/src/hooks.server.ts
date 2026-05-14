import type { Handle } from '@sveltejs/kit'
import { sequence } from '@sveltejs/kit/hooks'
/*@gvkit:if i18nParaglide*/
import { paraglideMiddleware } from '@repo/i18n/server'
/*@gvkit:endif*/
/*@gvkit:if auth*/
import { getSessionUser } from '$lib/server/load-session'
/*@gvkit:endif*/

/*@gvkit:if i18nParaglide*/
const localize: Handle = ({ event, resolve }) =>
	paraglideMiddleware(event.request, ({ request: localizedRequest, locale }) => {
		event.request = localizedRequest
		event.locals.locale = locale
		return resolve(event, {
			transformPageChunk: ({ html }) => html.replace('%lang%', locale)
		})
	})
/*@gvkit:endif*/

/*@gvkit:if auth*/
const attachUser: Handle = async ({ event, resolve }) => {
	event.locals.user = await getSessionUser(event)
	return resolve(event)
}
/*@gvkit:endif*/

export const handle: Handle = sequence(
	/*@gvkit:if i18nParaglide*/
	localize,
	/*@gvkit:endif*/
	/*@gvkit:if auth*/
	attachUser
	/*@gvkit:endif*/
)
