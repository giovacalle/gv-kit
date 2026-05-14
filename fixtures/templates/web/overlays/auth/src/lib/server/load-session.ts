import type { RequestEvent } from '@sveltejs/kit'

import { authClient } from '$lib/auth/client'

export async function getSessionUser(event: RequestEvent) {
	const cookie = event.request.headers.get('cookie')
	if (!cookie) return null

	const { data } = await authClient.getSession({
		fetchOptions: { headers: { cookie } }
	})
	return data?.user ?? null
}
