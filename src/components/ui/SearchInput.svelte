<script lang="ts">
	import { t } from '#lib/i18n/index.svelte.js';

	interface Props {
		value?: string;
		placeholder?: string;
		class?: string;
		oninput?: (e: Event) => void;
	}

	let {
		value = $bindable(''),
		placeholder = t('action.search'),
		class: className = '',
		oninput
	}: Props = $props();
</script>

<div class="relative {className}">
	<svg class="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink/60" fill="none" stroke="currentColor" viewBox="0 0 24 24">
		<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
	</svg>
	<input
		type="search"
		bind:value
		{placeholder}
		{oninput}
		aria-label={t('action.search')}
		class="w-full rounded-lg border border-line bg-input-bg text-ink pl-10 pr-3 py-2 text-sm focus:border-brand-2 focus:outline-none focus:ring-1 focus:ring-cyan"
	/>
</div>
