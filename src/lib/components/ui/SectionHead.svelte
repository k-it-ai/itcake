<script lang="ts">
	import type { Snippet } from 'svelte';

	interface Props {
		title: string;
		sub?: string;
		right?: Snippet;
		class?: string;
	}

	let { title, sub, right, class: className = '' }: Props = $props();
</script>

<div class="mb-2 flex items-baseline justify-between gap-3 {className}">
	<div class="min-w-0 flex items-baseline gap-2">
		<h3 class="text-[13px] font-semibold leading-tight" style="color:var(--ink)">{title}</h3>
		{#if sub}
			<p class="text-[11.5px] truncate" style="color:var(--muted)">{sub}</p>
		{/if}
	</div>
	{#if right}
		<div class="shrink-0">{@render right()}</div>
	{/if}
</div>
