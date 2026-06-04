<script lang="ts">
	import UserIcon from '@lucide/svelte/icons/user'
	import LogOutIcon from '@lucide/svelte/icons/log-out'
	import * as Button from '@repo/ui/primitives/button'
	import * as DropdownMenu from '@repo/ui/primitives/dropdown-menu'
	import { ModeToggle } from '@repo/ui/components/mode-toggle'
	/*@gvkit:if i18nParaglide*/
	import * as m from '@repo/i18n/messages'
	import { getLocale } from '@repo/i18n/runtime'

	import LocaleSwitcher from '$lib/components/layout/locale-switcher.svelte'
	/*@gvkit:endif*/
	/*@gvkit:if auth*/
	import { getAuthContext } from '$lib/context/auth-context.svelte'
	/*@gvkit:endif*/

	import { siteConfig } from '$lib/config/site'

	/*@gvkit:if auth*/
	const auth = getAuthContext()
	/*@gvkit:endif*/
</script>

<header class="border-border/60 bg-background/80 sticky top-0 z-30 border-b backdrop-blur">
	<div class="mx-auto flex h-14 w-full max-w-5xl items-center justify-between gap-3 px-4 sm:px-6">
		<a href="/" class="min-w-0 truncate text-sm font-semibold tracking-tight">{siteConfig.name}</a>

		<div class="flex shrink-0 items-center gap-2">
			<ModeToggle />
			<!--@gvkit:if i18nParaglide-->
			<LocaleSwitcher current={getLocale()} />
			<!--@gvkit:endif-->

			<!--@gvkit:if auth-->
			{#if auth.session}
				<DropdownMenu.Root>
					<DropdownMenu.Trigger>
						{#snippet child({ props })}
							<Button.Root variant="ghost" size="sm" {...props}>
								<UserIcon class="size-4" aria-hidden="true" />
								<span class="hidden sm:inline">{auth.session?.user.email}</span>
							</Button.Root>
						{/snippet}
					</DropdownMenu.Trigger>
					<DropdownMenu.Content align="end" class="w-48">
						<DropdownMenu.Item>
							{#snippet child({ props })}
								<a href="/me" {...props}>
									<!--@gvkit:if i18nParaglide-->{m.nav_profile()}<!--@gvkit:else-->Profile<!--@gvkit:endif-->
								</a>
							{/snippet}
						</DropdownMenu.Item>
						<DropdownMenu.Item>
							{#snippet child({ props })}
								<a href="/me/account" {...props}>
									<!--@gvkit:if i18nParaglide-->{m.account_title()}<!--@gvkit:else-->Account<!--@gvkit:endif-->
								</a>
							{/snippet}
						</DropdownMenu.Item>
						<DropdownMenu.Separator />
						<DropdownMenu.Item onclick={auth.signOut}>
							<LogOutIcon class="size-4" aria-hidden="true" />
							<!--@gvkit:if i18nParaglide-->{m.account_signout()}<!--@gvkit:else-->Sign out<!--@gvkit:endif-->
						</DropdownMenu.Item>
					</DropdownMenu.Content>
				</DropdownMenu.Root>
			{:else}
				<Button.Root href="/login" variant="ghost" size="sm">
					<!--@gvkit:if i18nParaglide-->{m.auth_signin()}<!--@gvkit:else-->Sign in<!--@gvkit:endif-->
				</Button.Root>
			{/if}
			<!--@gvkit:endif-->
		</div>
	</div>
</header>
