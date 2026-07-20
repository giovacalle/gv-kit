<script lang="ts">
	import { Badge } from '@repo/ui/primitives/badge'
	import Seo from '$lib/components/seo.svelte'
	/*@gvkit:if i18nParaglide*/
	import * as m from '@repo/i18n/messages'
	/*@gvkit:endif*/
</script>

<Seo
	/*@gvkit:if i18nParaglide*/
	title={m.app_home_title()}
	description={m.app_home_lede()}
	/*@gvkit:else*/
	title="Application"
	description="Your application is ready for its first feature."
	/*@gvkit:endif*/
/>

<main class="grid min-h-[70dvh] place-items-center px-6 py-16">
	<div class="max-w-xl space-y-5 text-center">
		<Badge variant="outline">__PROJECT__</Badge>
		<h1 class="text-4xl font-semibold tracking-tight md:text-5xl">
			<!--@gvkit:if i18nParaglide-->{m.app_home_title()}<!--@gvkit:else-->Application<!--@gvkit:endif-->
		</h1>
		<p class="text-muted-foreground text-lg">
			<!--@gvkit:if i18nParaglide-->{m.app_home_lede()}<!--@gvkit:else-->Your application is ready for its first feature.<!--@gvkit:endif-->
		</p>
	</div>
</main>
