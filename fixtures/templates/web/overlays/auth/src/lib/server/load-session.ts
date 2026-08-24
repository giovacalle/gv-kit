import type { RequestEvent } from '@sveltejs/kit'
import type { Session } from '$lib/auth/client'
/*@gvkit:if authCfWorkers*/
/*@gvkit:else*/
import { authClient } from '$lib/auth/client'
/*@gvkit:endif*/

export async function getSessionUser(event: RequestEvent) {
	const cookie = event.request.headers.get('cookie')
	if (!cookie) return null

	/*@gvkit:if authCfWorkers*/
	const response = await event.fetch('/api/auth/get-session', { headers: { cookie } })
	if (!response.ok) return null
	const data = (await response.json()) as { user?: Session['user'] }
	return data.user ?? null
	/*@gvkit:else*/
	const { data } = await authClient.getSession({
		fetchOptions: { headers: { cookie } }
	})
	return data?.user ?? null
	/*@gvkit:endif*/
}
