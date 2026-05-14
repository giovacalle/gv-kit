import { getContext, setContext } from 'svelte'
import { goto } from '$app/navigation'
import type { BetterFetchError } from 'better-auth/svelte'

import { authClient, type Session } from '$lib/auth/client'

class AuthContext {
	session = $state<Session | null>(null)
	isLoading = $state<boolean>(false)
	error = $state<BetterFetchError | null>(null)

	signOut = async () => {
		await authClient.signOut()
		await goto('/')
	}

	#sessionStore = authClient.useSession()

	constructor() {
		$effect(() => {
			const unsubscribe = this.#sessionStore.subscribe(($s) => {
				this.session = $s.data
				this.isLoading = $s.isPending || $s.isRefetching
				this.error = $s.error
			})
			return () => unsubscribe()
		})
	}
}

const KEY = Symbol('auth-context')

export const setAuthContext = (): AuthContext => setContext(KEY, new AuthContext())
export const getAuthContext = (): AuthContext => getContext<AuthContext>(KEY)
