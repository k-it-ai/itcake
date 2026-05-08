<script lang="ts">
	import { onMount } from 'svelte';
	import { setContext } from 'svelte';
	import { page } from '$app/state';
	import Sidebar from '$components/layout/Sidebar.svelte';
	import ChatPanel from '$components/ai/ChatPanel.svelte';
	import { t } from '$lib/i18n/index.svelte.js';
	import type { Snippet } from 'svelte';

	interface Props {
		children: Snippet;
	}

	let { children }: Props = $props();
	let sidebarCollapsed = $state(true);
	let isMobile = $state(false);
	let sidebarInitialized = false;
	let chatOpen = $state(false);
	let aiEnabled = $derived((page.data as { settings?: { ai?: { enabled?: boolean } } } | undefined)?.settings?.ai?.enabled ?? false);
	const pageContext = $derived({ path: page.url.pathname, params: page.params });

	setContext('toggleAiChat', () => { chatOpen = !chatOpen; });

	onMount(() => {
		isMobile = window.innerWidth < 1280;
		const stored = localStorage.getItem('itcake-sidebar-collapsed');
		if (stored !== null) {
			sidebarCollapsed = stored === 'true';
		} else if (!isMobile) {
			sidebarCollapsed = false;
		}
		sidebarInitialized = true;
		const onResize = () => {
			const wasMobile = isMobile;
			isMobile = window.innerWidth < 1280;
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
	{#if aiEnabled}
		<button
			class="fixed bottom-6 right-6 z-30 size-14 rounded-full bg-cyan text-white shadow-lg hover:bg-cyan-dark flex items-center justify-center"
			onclick={() => chatOpen = !chatOpen}
			aria-label={t('ai.openChat')}
			title={t('ai.openChat') + ' (⌘K)'}
		>
			<svg class="size-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>
		</button>
		<ChatPanel open={chatOpen} onclose={() => chatOpen = false} {pageContext} />
	{/if}
</div>
