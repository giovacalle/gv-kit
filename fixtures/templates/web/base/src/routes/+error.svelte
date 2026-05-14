<script lang="ts">
	import { page } from '$app/state'
	import * as Button from '@repo/ui/primitives/button'
	import Seo from '$lib/components/seo.svelte'
	/*@gvkit:if i18nParaglide*/
	import * as m from '@repo/i18n/messages'
	/*@gvkit:endif*/

	const heading = $derived.by(() => {
		const status = page.status
		/*@gvkit:if i18nParaglide*/
		if (status === 404) return m.error_404_heading()
		if (status === 401 || status === 403) return m.error_403_heading()
		return m.error_500_heading()
		/*@gvkit:else*/
		if (status === 404) return "This page hasn't been built yet."
		if (status === 401 || status === 403) return "You don't have access to this."
		return 'Something broke. Check the logs.'
		/*@gvkit:endif*/
	})
</script>

<Seo
	/*@gvkit:if i18nParaglide*/
	title={m.error_title({ status: page.status })}
	/*@gvkit:else*/
	title="Error {page.status}"
	/*@gvkit:endif*/
/>

<section class="flex min-h-[60dvh] items-center justify-center px-4 py-24">
	<div class="max-w-md space-y-6 text-center">
		<p class="text-muted-foreground text-xs uppercase tracking-[0.18em]">
			<!--@gvkit:if i18nParaglide-->{m.error_eyebrow({ status: page.status })}<!--@gvkit:else-->Error {page.status}<!--@gvkit:endif-->
		</p>
		<h1 class="text-3xl font-semibold tracking-tight md:text-4xl">{heading}</h1>
		{#if page.error?.message}
			<p class="text-muted-foreground font-mono text-sm">{page.error.message}</p>
		{/if}
		<div class="flex justify-center pt-2">
			<Button.Root href="/">
				<!--@gvkit:if i18nParaglide-->{m.error_back_home()}<!--@gvkit:else-->Back to home<!--@gvkit:endif-->
			</Button.Root>
		</div>
	</div>
</section>
