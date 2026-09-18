import { usersGetMe } from '@repo/openapi-client'

import type { PageServerLoad } from './$types'

export const load: PageServerLoad = async ({ fetch, url }) => {
	const { data } = await usersGetMe({ baseUrl: url.origin, fetch })
	return { serverProfile: data ?? null }
}
