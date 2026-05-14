<script lang="ts">
	import LanguagesIcon from '@lucide/svelte/icons/languages'
	import * as Button from '@repo/ui/primitives/button'
	import * as DropdownMenu from '@repo/ui/primitives/dropdown-menu'
	import { locales, setLocale, type Locale } from '@repo/i18n/runtime'

	type Props = { current: Locale }

	let { current }: Props = $props()

	const labels: Record<Locale, string> = {
		en: 'English',
		it: 'Italiano'
	}

	async function pick(locale: Locale) {
		if (locale === current) return
		await setLocale(locale)
	}
</script>

<DropdownMenu.Root>
	<DropdownMenu.Trigger>
		{#snippet child({ props })}
			<Button.Root variant="ghost" size="icon" aria-label={labels[current]} {...props}>
				<LanguagesIcon class="size-4" aria-hidden="true" />
			</Button.Root>
		{/snippet}
	</DropdownMenu.Trigger>
	<DropdownMenu.Content align="end">
		{#each locales as locale (locale)}
			<DropdownMenu.Item
				onclick={() => pick(locale)}
				class={locale === current ? 'font-medium' : ''}
			>
				{labels[locale] ?? locale}
			</DropdownMenu.Item>
		{/each}
	</DropdownMenu.Content>
</DropdownMenu.Root>
