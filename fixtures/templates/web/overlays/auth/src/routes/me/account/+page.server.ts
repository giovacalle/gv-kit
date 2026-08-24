import { superValidate } from 'sveltekit-superforms/server'
import { zod } from 'sveltekit-superforms/adapters'

import { profileSchema } from '$lib/schemas/auth'
import type { PageServerLoad } from './$types'

export const load: PageServerLoad = async ({ parent }) => {
	const { user } = await parent()
	const form = await superValidate(zod(profileSchema), {
		defaults: { name: user.name ?? '' }
	})
	return { form }
}
