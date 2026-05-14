import { browser } from '$app/environment'
import { env } from '$env/dynamic/public'
import { client } from '@repo/openapi-client/users'
import { QueryClient } from '@tanstack/svelte-query'

import type { LayoutLoad } from './$types'

client.setConfig({
	baseUrl: env.PUBLIC_USERS_URL ?? 'http://127.0.0.1:8788',
	credentials: 'include'
})

export const load: LayoutLoad = ({ data }) => ({
	...data,
	queryClient: new QueryClient({ defaultOptions: { queries: { enabled: browser } } })
})
