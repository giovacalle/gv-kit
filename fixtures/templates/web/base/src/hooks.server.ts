import type { Handle/*@gvkit:if honoGateway*/, HandleFetch/*@gvkit:endif*/ } from '@sveltejs/kit'
/*@gvkit:if honoGateway*/
import { env } from '$env/dynamic/private'
/*@gvkit:endif*/
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

/*@gvkit:if honoGatewayCfWorkers*/
const forwardApiAlias: Handle = ({ event, resolve }) => {
	const isApiPath =
		event.url.pathname === '/api' || event.url.pathname.startsWith('/api/')
	const gateway = event.platform?.env?.__GATEWAY_TARGET__
	if (!isApiPath || !gateway) return resolve(event)
	return gateway.fetch(event.request)
}

/*@gvkit:endif*/
/*@gvkit:if auth*/
const attachUser: Handle = async ({ event, resolve }) => {
	event.locals.user = await getSessionUser(event)
	return resolve(event)
}
/*@gvkit:endif*/

/*@gvkit:if honoGateway*/
export const handleFetch: HandleFetch = async ({ event, request, fetch }) => {
	const incoming = new URL(request.url)
	const isSameOriginApi =
		incoming.origin === event.url.origin &&
		(incoming.pathname === '/api' || incoming.pathname.startsWith('/api/'))
	if (!isSameOriginApi) return fetch(request)

	const gateway = event.platform?.env?.__GATEWAY_TARGET__
	if (gateway) return gateway.fetch(request)

	const upstream = new URL(
		`${incoming.pathname}${incoming.search}`,
		env.GATEWAY_URL ?? '__GATEWAY_URL__'
	)
	const forwarded = new Request(upstream, request)
	forwarded.headers.set('host', event.url.host)
	forwarded.headers.set('x-forwarded-host', event.url.host)
	forwarded.headers.set('x-forwarded-proto', event.url.protocol.slice(0, -1))
	return fetch(forwarded)
}
/*@gvkit:endif*/
export const handle: Handle = sequence(
	/*@gvkit:if honoGatewayCfWorkers*/
	forwardApiAlias,
	/*@gvkit:endif*/
	/*@gvkit:if i18nParaglide*/
	localize,
	/*@gvkit:endif*/
	/*@gvkit:if auth*/
	attachUser
	/*@gvkit:endif*/
)
