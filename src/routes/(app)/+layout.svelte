<script lang="ts">
	import { setContext } from 'svelte';
	import { page } from '$app/state';
	import Sidebar from '#lib/components/shell/Sidebar.svelte';
	import CommandPalette from '#lib/components/shell/CommandPalette.svelte';
	import ChatPanel from '#components/ai/ChatPanel.svelte';
	import StepUpPrompt from '#components/StepUpPrompt.svelte';
	import { palette } from '#lib/stores/palette.svelte.js';
	import { t } from '#lib/i18n/index.svelte.js';
	import type { Snippet } from 'svelte';

	interface Props {
		children: Snippet;
	}

	let { children }: Props = $props();
	let chatOpen = $state(false);
	const pageData = $derived(page.data as { user?: { name?: string; email?: string }; settings?: { ai?: { enabled?: boolean } } } | undefined);
	const aiEnabled = $derived(pageData?.settings?.ai?.enabled ?? false);
	const pageContext = $derived({ path: page.url.pathname, params: page.params });

	setContext('toggleAiChat', () => { chatOpen = !chatOpen; });

	// Skip when focus is in an input/textarea so typing K doesn't pop the palette.
	function onGlobalKey(e: KeyboardEvent): void {
		if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
			const t = e.target as HTMLElement | null;
			const tag = t?.tagName;
			if (tag === 'INPUT' || tag === 'TEXTAREA' || t?.isContentEditable) return;
			e.preventDefault();
			palette.toggle();
		}
	}
</script>

<svelte:window onkeydown={onGlobalKey} />

<a href="#main-content" class="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:px-4 focus:py-2 focus:bg-card focus:text-brand focus:rounded focus:shadow-pop focus:border focus:border-brand">{t('aria.skipToContent')}</a>
<div class="flex h-screen overflow-hidden">
	<Sidebar
		userName={pageData?.user?.name}
		userEmail={pageData?.user?.email}
		userRole="Owner"
	/>
	<main id="main-content" class="flex-1 overflow-y-auto bg-bg">
		{@render children()}
	</main>
	<CommandPalette />
	<StepUpPrompt />
	{#if aiEnabled}
		<button
			class="fixed bottom-6 right-6 z-30 size-14 rounded-full bg-brand text-white shadow-pop hover:opacity-90 flex items-center justify-center"
			onclick={() => chatOpen = !chatOpen}
			aria-label={t('ai.openChat')}
			title={t('ai.openChat')}
		>
			<svg class="size-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>
		</button>
		<ChatPanel open={chatOpen} onclose={() => chatOpen = false} {pageContext} />
	{/if}
</div>
