<script lang="ts">
	import type { Snippet } from 'svelte';
	import { getContext } from 'svelte';
	import GlobalSearch from './GlobalSearch.svelte';
	import QuickCreate from './QuickCreate.svelte';
	import { t } from '$lib/i18n/index.svelte.js';

	interface Props {
		title: string;
		children?: Snippet;
	}

	let { title, children }: Props = $props();

	const toggleSidebar = getContext<(() => void) | undefined>('toggleSidebar');
	let searchRef = $state<GlobalSearch>();
</script>

<header class="flex items-center justify-between border-b border-border bg-bg-card px-4 py-3 sm:px-6 sm:py-4">
	<div class="flex min-w-0 items-center gap-3">
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
		<h1 class="truncate text-lg font-semibold text-near-black sm:text-xl">{title}</h1>
	</div>
	<div class="flex items-center gap-2 sm:gap-3">
		<div class="hidden sm:block"><GlobalSearch bind:this={searchRef} /></div>
		<!-- Mobile search icon: opens search modal -->
		<button
			class="rounded-lg p-2.5 text-near-black/60 hover:bg-bg hover:text-near-black sm:hidden"
			onclick={() => searchRef?.openSearch()}
			aria-label={t('action.search')}
		>
			<svg class="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5">
				<path stroke-linecap="round" stroke-linejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
			</svg>
		</button>
		<QuickCreate />
		{#if children}
			{@render children()}
		{/if}
	</div>
</header>
