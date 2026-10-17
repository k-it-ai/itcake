<script lang="ts">
	import type { Snippet } from 'svelte';
	import { Inbox } from '#lib/icons/index.js';

	interface Props {
		title: string;
		description?: string;
		icon?: Snippet;
		actions?: Snippet;
		class?: string;
	}

	let { title, description, icon, actions, class: className = '' }: Props = $props();
</script>

<div
	class="flex flex-col items-center justify-center text-center {className}"
	style="padding:40px 24px"
	role="status"
>
	<div class="mb-3" aria-hidden="true" style="color:var(--muted)">
		{#if icon}
			{@render icon()}
		{:else}
			<Inbox size={24} strokeWidth={1.6} />
		{/if}
	</div>
	<h3 class="text-[13px] font-semibold" style="color:var(--ink)">{title}</h3>
	{#if description}
		<p class="mt-1 text-[11.5px]" style="color:var(--muted)">{description}</p>
	{/if}
	{#if actions}
		<div class="mt-4 flex items-center justify-center gap-2">
			{@render actions()}
		</div>
	{/if}
</div>
