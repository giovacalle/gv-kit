import { browser } from '$app/environment'
/*@gvkit:if honoGateway*/
/*@gvkit:else*/
import { env } from '$env/dynamic/public'
/*@gvkit:endif*/
import { client } from '@repo/openapi-client'
import { QueryClient } from '@tanstack/svelte-query'

import type { LayoutLoad } from './$types'

client.setConfig({
	/*@gvkit:if honoGateway*/
	baseUrl: '',
	/*@gvkit:else*/
	baseUrl: env.PUBLIC_USERS_URL ?? 'http://127.0.0.1:8788',
	/*@gvkit:endif*/
	credentials: 'include'
})

export const load: LayoutLoad = ({ data }) => ({
	...data,
	queryClient: new QueryClient({ defaultOptions: { queries: { enabled: browser } } })
})
