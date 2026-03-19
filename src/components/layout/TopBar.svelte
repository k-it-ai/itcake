<script lang="ts">
	import type { Snippet } from 'svelte';
	import { getContext } from 'svelte';
	import GlobalSearch from './GlobalSearch.svelte';
	import QuickCreate from './QuickCreate.svelte';
	import { t } from '$lib/i18n/index.svelte.js';

	interface Props {
		title: string;
		backHref?: string;
		children?: Snippet;
	}

	let { title, backHref, children }: Props = $props();

	const toggleSidebar = getContext<(() => void) | undefined>('toggleSidebar');
	let searchRef = $state<GlobalSearch>();
</script>

<header class="flex items-center gap-2 border-b border-border bg-bg-card px-4 py-3 sm:px-6 sm:py-4">
	<!-- Left: hamburger + back + title + QuickCreate -->
	<div class="flex min-w-0 items-center gap-2 sm:gap-3 shrink-0">
		{#if toggleSidebar}
			<button
				class="rounded-lg p-1.5 text-near-black/60 hover:bg-bg hover:text-near-black lg:hidden"
				onclick={toggleSidebar}
				aria-label={t('aria.toggleMenu')}
			>
				<svg class="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5">
					<path stroke-linecap="round" stroke-linejoin="round" d="M3.75 6.75h16.5M3.75 12h16.5m-16.5 5.25h16.5" />
				</svg>
			</button>
		{/if}
		{#if backHref}
			<a href={backHref} class="rounded-lg p-1.5 text-near-black/60 hover:bg-bg hover:text-near-black transition-colors" aria-label={t('action.back')}>
				<svg class="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5">
					<path stroke-linecap="round" stroke-linejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" />
				</svg>
			</a>
		{/if}
		<h1 class="truncate text-lg font-semibold text-near-black sm:text-xl">{title}</h1>
		<QuickCreate />
	</div>

	<!-- Center: inline expanding search -->
	<div class="flex flex-1 justify-center px-2 min-w-0">
		<GlobalSearch bind:this={searchRef} />
	</div>

	<!-- Right: page-specific actions -->
	{#if children}
		<div class="flex items-center gap-2 sm:gap-3 shrink-0">
			{@render children()}
		</div>
	{/if}
</header>
