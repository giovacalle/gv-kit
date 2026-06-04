<script lang="ts">
	import * as Button from '@repo/ui/primitives/button'
	import * as Card from '@repo/ui/primitives/card'
	import Seo from '$lib/components/seo.svelte'
	/*@gvkit:if i18nParaglide*/
	import * as m from '@repo/i18n/messages'
	/*@gvkit:endif*/

	import { getAuthContext } from '$lib/context/auth-context.svelte'

	let { data } = $props()

	const auth = getAuthContext()
	const email = $derived(auth.session?.user.email ?? data.user.email)
	const name = $derived(auth.session?.user.name ?? data.user.name)
</script>

<Seo
	/*@gvkit:if i18nParaglide*/
	title={m.me_title()}
	/*@gvkit:else*/
	title="Signed in"
	/*@gvkit:endif*/
/>

<main class="flex min-h-dvh items-center justify-center px-4">
	<Card.Root class="w-full max-w-sm">
		<Card.Header>
			<Card.Title>
				<!--@gvkit:if i18nParaglide-->{m.me_title()}<!--@gvkit:else-->Signed in<!--@gvkit:endif-->
			</Card.Title>
		</Card.Header>
		<Card.Content>
			<dl class="grid grid-cols-[80px_minmax(0,1fr)] gap-y-2 text-sm">
				<dt class="text-muted-foreground">
					<!--@gvkit:if i18nParaglide-->{m.me_email_label()}<!--@gvkit:else-->Email<!--@gvkit:endif-->
				</dt>
				<dd class="min-w-0 break-all">{email}</dd>
				<dt class="text-muted-foreground">
					<!--@gvkit:if i18nParaglide-->{m.me_name_label()}<!--@gvkit:else-->Name<!--@gvkit:endif-->
				</dt>
				<dd class="min-w-0 break-words">{name ?? '—'}</dd>
			</dl>
		</Card.Content>
		<Card.Footer>
			<Button.Root href="/me/account" variant="outline" size="sm">
				<!--@gvkit:if i18nParaglide-->{m.me_manage_account()}<!--@gvkit:else-->Manage account<!--@gvkit:endif-->
			</Button.Root>
		</Card.Footer>
	</Card.Root>
</main>
