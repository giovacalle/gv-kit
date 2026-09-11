import type { Handle/*@gvkit:if honoGateway*/, HandleFetch/*@gvkit:endif*/ } from '@sveltejs/kit'
/*@gvkit:if honoGateway*/
/*@gvkit:if deployNode*/
import { env } from '$env/dynamic/private'
/*@gvkit:endif*/
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

/*@gvkit:if auth*/
const attachUser: Handle = async ({ event, resolve }) => {
	event.locals.user = await getSessionUser(event)
	return resolve(event)
}
/*@gvkit:endif*/

/*@gvkit:if honoGateway*/
function isSameOriginApi(incoming: URL, origin: string): boolean {
	return incoming.origin === origin &&
		(incoming.pathname === '/api' || incoming.pathname.startsWith('/api/'))
}

const attachGatewayCredentials: Handle = ({ event, resolve }) => {
	const serverFetch = event.fetch
	// Worker Requests discard browser-only credentials options during normalization.
	event.fetch = (input, init) => {
		const incoming = new URL(input instanceof Request ? input.url : input, event.url)
		if (!isSameOriginApi(incoming, event.url.origin)) return serverFetch(input, init)
		const credentials = init?.credentials ?? (input instanceof Request ? input.credentials : undefined)
		if (input instanceof Request) input = new Request(input, init)
		if (credentials === 'omit') return serverFetch(input, init)

		const headers = input instanceof Request ? input.headers : new Headers(init?.headers)
		for (const name of ['cookie', 'authorization']) {
			const value = event.request.headers.get(name)
			if (value && !headers.has(name)) headers.set(name, value)
		}
		return input instanceof Request ? serverFetch(input, init) : serverFetch(input, { ...init, headers })
	}
	return resolve(event)
}

export const handleFetch: HandleFetch = async ({ event, request, fetch }) => {
	const incoming = new URL(request.url)
	if (!isSameOriginApi(incoming, event.url.origin)) return fetch(request)

	const gateway = event.platform?.env?.__GATEWAY_TARGET__
	// Local binding proxies cannot recognize every runtime's Request class.
	if (gateway) return gateway.fetch(request.url, request)

	/*@gvkit:if deployCfWorkers*/
	return new Response('service unavailable', { status: 503 })
	/*@gvkit:else*/
	const upstream = new URL(
		`${incoming.pathname}${incoming.search}`,
		env.GATEWAY_URL ?? '__GATEWAY_URL__'
	)
	const forwarded = new Request(upstream, request)
	forwarded.headers.set('host', event.url.host)
	forwarded.headers.set('x-forwarded-host', event.url.host)
	forwarded.headers.set('x-forwarded-proto', event.url.protocol.slice(0, -1))
	forwarded.headers.delete('x-forwarded-for')
	if (env.GATEWAY_TRUSTED_INGRESS_SECRET) forwarded.headers.set('x-gateway-ingress-secret', env.GATEWAY_TRUSTED_INGRESS_SECRET)
	return fetch(forwarded)
	/*@gvkit:endif*/
}
/*@gvkit:endif*/
export const handle: Handle = sequence(
	/*@gvkit:if honoGateway*/
	attachGatewayCredentials,
	/*@gvkit:endif*/
	/*@gvkit:if i18nParaglide*/
	localize,
	/*@gvkit:endif*/
	/*@gvkit:if auth*/
	attachUser
	/*@gvkit:endif*/
)
