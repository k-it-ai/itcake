<script lang="ts">
	import type { Snippet } from 'svelte';

	interface Props {
		title: string;
		description?: string;
		icon?: Snippet;
		children?: Snippet;
	}

	let { title, description = '', icon, children }: Props = $props();
</script>

<div class="flex flex-col items-center justify-center py-12 text-center">
	{#if icon}
		<div class="mb-4" aria-hidden="true">{@render icon()}</div>
	{:else}
		<svg class="h-12 w-12 text-near-black/20 mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
			<path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M20 13V6a2 2 0 00-2-2H6a2 2 0 00-2 2v7m16 0v5a2 2 0 01-2 2H6a2 2 0 01-2-2v-5m16 0h-2.586a1 1 0 00-.707.293l-2.414 2.414a1 1 0 01-.707.293h-3.172a1 1 0 01-.707-.293l-2.414-2.414A1 1 0 006.586 13H4" />
		</svg>
	{/if}
	<h3 class="text-lg font-medium text-near-black">{title}</h3>
	{#if description}
		<p class="mt-1 text-sm text-near-black/60">{description}</p>
	{/if}
	{#if children}
		<div class="mt-4">
			{@render children()}
		</div>
	{/if}
</div>
