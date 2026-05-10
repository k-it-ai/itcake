<script lang="ts">
	import type { Snippet } from 'svelte';

	interface Props {
		keys?: string | string[];
		title?: string;
		class?: string;
		children?: Snippet;
	}

	let { keys, title, class: className = '', children }: Props = $props();

	const display = $derived.by(() => {
		if (children) return null;
		if (Array.isArray(keys)) return keys.join(' ');
		return keys ?? '';
	});
</script>

<kbd
	class="inline-flex items-center justify-center gap-0.5 rounded-[4px] border px-1 py-[1px] font-mono text-[10.5px] leading-none {className}"
	style="background:#fbfcfd;color:var(--muted);border-color:var(--line);min-height:16px"
	{title}
>
	{#if children}
		{@render children()}
	{:else}
		{display}
	{/if}
</kbd>
