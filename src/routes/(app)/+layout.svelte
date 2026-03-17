<script lang="ts">
	import { onMount } from 'svelte';
	import { setContext } from 'svelte';
	import Sidebar from '$components/layout/Sidebar.svelte';
	import { t } from '$lib/i18n/index.svelte.js';
	import type { Snippet } from 'svelte';

	interface Props {
		children: Snippet;
	}

	let { children }: Props = $props();
	let sidebarCollapsed = $state(true);
	let isMobile = $state(false);
	let sidebarInitialized = false;

	onMount(() => {
		isMobile = window.innerWidth < 1024;
		const stored = localStorage.getItem('itcake-sidebar-collapsed');
		if (stored !== null) {
			sidebarCollapsed = stored === 'true';
		} else if (!isMobile) {
			sidebarCollapsed = false;
		}
		sidebarInitialized = true;
		const onResize = () => {
			const wasMobile = isMobile;
			isMobile = window.innerWidth < 1024;
			if (isMobile && !wasMobile) sidebarCollapsed = true;
			if (!isMobile && wasMobile) sidebarCollapsed = false;
		};
		window.addEventListener('resize', onResize);
		return () => window.removeEventListener('resize', onResize);
	});

	$effect(() => {
		const val = sidebarCollapsed;
		if (sidebarInitialized) {
			localStorage.setItem('itcake-sidebar-collapsed', String(val));
		}
	});

	setContext('toggleSidebar', () => { sidebarCollapsed = !sidebarCollapsed; });
</script>

<svelte:window onkeydown={(e) => { if (e.key === 'Escape' && isMobile && !sidebarCollapsed) sidebarCollapsed = true; }} />

<a href="#main-content" class="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:px-4 focus:py-2 focus:bg-bg-card focus:text-cyan focus:rounded focus:shadow-lg focus:border focus:border-cyan">{t('aria.skipToContent')}</a>
<div class="flex h-screen overflow-hidden">
	{#if isMobile && !sidebarCollapsed}
		<button
			class="fixed inset-0 z-30 bg-black/50 w-full h-full cursor-default"
			aria-label={t('aria.closeSidebar')}
			onclick={() => sidebarCollapsed = true}
		></button>
	{/if}
	<Sidebar bind:collapsed={sidebarCollapsed} {isMobile} />
	<main id="main-content" class="flex-1 overflow-y-auto bg-bg">
		{@render children()}
	</main>
</div>
