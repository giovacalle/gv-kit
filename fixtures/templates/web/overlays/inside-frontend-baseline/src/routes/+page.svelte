<script lang="ts">
	/*@gvkit:if authUiImports*/
	import * as Button from '@repo/ui/primitives/button'
	import { Badge } from '@repo/ui/primitives/badge'
	/*@gvkit:endif*/
	import Seo from '$lib/components/seo.svelte'
	/*@gvkit:if i18nParaglide*/
	import * as m from '@repo/i18n/messages'
	/*@gvkit:endif*/
	/*@gvkit:if auth*/
	import { getAuthContext } from '$lib/context/auth-context.svelte'
	/*@gvkit:endif*/

	/*@gvkit:if auth*/
	let { data } = $props()
	const auth = getAuthContext()
	/*@gvkit:endif*/
</script>

<Seo
	/*@gvkit:if i18nParaglide*/
	title={m.landing_hero_title()}
	/*@gvkit:endif*/
/>

<main class="flex min-h-dvh items-center justify-center px-4">
	<div class="space-y-8 text-center">
		<h1 class="text-5xl font-semibold tracking-tight md:text-6xl">
			<!--@gvkit:if i18nParaglide-->{m.landing_hero_title()}<!--@gvkit:else-->You're set.<!--@gvkit:endif-->
		</h1>
		<p class="text-muted-foreground mx-auto max-w-xl text-lg md:text-xl">
			<!--@gvkit:if i18nParaglide-->{m.landing_hero_lede()}<!--@gvkit:else-->The boring parts are wired. Now build the interesting bit.<!--@gvkit:endif-->
		</p>

		<!--@gvkit:if auth-->
		{#if auth.session ?? data.user}
			<div class="flex flex-col items-center gap-3 pt-4">
				<Badge variant="outline">
					<!--@gvkit:if i18nParaglide-->{m.landing_signed_in_badge()}<!--@gvkit:else-->Signed in<!--@gvkit:endif-->
				</Badge>
				<p class="text-muted-foreground text-sm">
					{auth.session?.user.email ?? data.user?.email}
				</p>
				<Button.Root href="/me">
					<!--@gvkit:if i18nParaglide-->{m.landing_continue()}<!--@gvkit:else-->Continue<!--@gvkit:endif-->
				</Button.Root>
			</div>
		{:else}
			<div class="pt-4">
				<Button.Root href="/login">
					<!--@gvkit:if i18nParaglide-->{m.auth_signin()}<!--@gvkit:else-->Sign in<!--@gvkit:endif-->
				</Button.Root>
			</div>
		{/if}
		<!--@gvkit:endif-->
	</div>
</main>
