<script lang="ts">
	import '../app.css'
	import { ModeWatcher } from 'mode-watcher'
	import { Toaster } from 'svelte-sonner'
	import Footer from '$lib/components/layout/footer.svelte'
	import Nav from '$lib/components/layout/nav.svelte'
	/*@gvkit:if auth*/
	import { setAuthContext } from '$lib/context/auth-context.svelte'
	/*@gvkit:endif*/
	/*@gvkit:if apiClientHeyApi*/
	import { QueryClientProvider } from '@tanstack/svelte-query'
	/*@gvkit:endif*/

	/*@gvkit:if apiClientHeyApi*/
	let { children, data } = $props()
	/*@gvkit:else*/
	let { children } = $props()
	/*@gvkit:endif*/

	/*@gvkit:if auth*/
	setAuthContext()
	/*@gvkit:endif*/
</script>

<ModeWatcher />
<Toaster richColors position="top-center" />

<!--@gvkit:if apiClientHeyApi-->
<QueryClientProvider client={data.queryClient}>
<!--@gvkit:endif-->
<div class="flex min-h-screen flex-col">
	<Nav />
	<main class="flex-1">
		{@render children()}
	</main>
	<Footer />
</div>
<!--@gvkit:if apiClientHeyApi-->
</QueryClientProvider>
<!--@gvkit:endif-->
