<script lang="ts">
	import { createQuery } from '@tanstack/svelte-query'
	/*@gvkit:if i18nParaglide*/
	import * as m from '@repo/i18n/messages'
	/*@gvkit:endif*/

	import { usersGetMeOptions } from '@repo/openapi-client'

	const profile = createQuery(() => usersGetMeOptions())
</script>

<main class="mx-auto max-w-2xl px-4 py-10 sm:py-16">
	<header class="mb-6">
		<h1 class="text-2xl font-semibold">
			<!--@gvkit:if i18nParaglide-->{m.users_title()}<!--@gvkit:else-->Current user<!--@gvkit:endif-->
		</h1>
		<p class="text-muted-foreground mt-1">
			<!--@gvkit:if i18nParaglide-->{m.users_lede()}<!--@gvkit:else-->Fetched client-side through the generated client, cached by TanStack Query.<!--@gvkit:endif-->
		</p>
	</header>

	{#if profile.isPending}
		<p class="text-muted-foreground">
			<!--@gvkit:if i18nParaglide-->{m.users_loading()}<!--@gvkit:else-->Loading…<!--@gvkit:endif-->
		</p>
	{:else if profile.isError}
		<p class="text-destructive">{profile.error.message}</p>
	{:else if profile.data}
		<dl class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
			<dt class="text-muted-foreground">ID</dt>
			<dd>{profile.data.id}</dd>
		</dl>
	{/if}
</main>
