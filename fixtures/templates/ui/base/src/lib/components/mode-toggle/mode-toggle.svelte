<script lang="ts">
	import MoonIcon from '@lucide/svelte/icons/moon'
	import SunIcon from '@lucide/svelte/icons/sun'
	import { setMode } from 'mode-watcher'
	import * as Button from '@lib/components/primitives/button/index.js'
	import * as DropdownMenu from '@lib/components/primitives/dropdown-menu/index.js'
</script>

<DropdownMenu.Root>
	<DropdownMenu.Trigger>
		{#snippet child({ props })}
			<Button.Root variant="ghost" size="icon" {...props}>
				<SunIcon
					class="h-[1.2rem] w-[1.2rem] rotate-0 scale-100 transition-all dark:-rotate-90 dark:scale-0"
				/>
				<MoonIcon
					class="absolute h-[1.2rem] w-[1.2rem] rotate-90 scale-0 transition-all dark:rotate-0 dark:scale-100"
				/>
				<span class="sr-only">Toggle theme</span>
			</Button.Root>
		{/snippet}
	</DropdownMenu.Trigger>
	<DropdownMenu.Content align="end">
		<DropdownMenu.Item onclick={() => setMode('light')}>Light</DropdownMenu.Item>
		<DropdownMenu.Item onclick={() => setMode('dark')}>Dark</DropdownMenu.Item>
		<DropdownMenu.Item onclick={() => setMode('system')}>System</DropdownMenu.Item>
	</DropdownMenu.Content>
</DropdownMenu.Root>
