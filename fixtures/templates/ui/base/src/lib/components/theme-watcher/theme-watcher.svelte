<script lang="ts">
	import { ModeWatcher } from 'mode-watcher'
	import type { ComponentProps } from 'svelte'

	let { defaultMode = 'system', ...rest }: ComponentProps<typeof ModeWatcher> = $props()
</script>

<ModeWatcher {defaultMode} {...rest} />
