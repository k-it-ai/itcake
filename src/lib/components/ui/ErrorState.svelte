<script lang="ts">
	import type { Snippet } from 'svelte';
	import { AlertCircle } from '$lib/icons';

	interface Props {
		title?: string;
		message?: string;
		icon?: Snippet;
		retry?: () => void;
		retryLabel?: string;
		actions?: Snippet;
		class?: string;
	}

	let {
		title = "Couldn't load",
		message,
		icon,
		retry,
		retryLabel = 'Retry',
		actions,
		class: className = ''
	}: Props = $props();
</script>

<div
	class="flex flex-col items-center justify-center text-center {className}"
	style="padding:40px 24px"
	role="alert"
	aria-live="assertive"
>
	<div class="mb-3" aria-hidden="true" style="color:var(--bad)">
		{#if icon}
			{@render icon()}
		{:else}
			<AlertCircle size={24} strokeWidth={1.6} />
		{/if}
	</div>
	<h3 class="text-[13px] font-semibold" style="color:var(--ink)">{title}</h3>
	{#if message}
		<p class="mt-1 max-w-md text-[11.5px]" style="color:var(--muted)">{message}</p>
	{/if}
	{#if retry || actions}
		<div class="mt-4 flex items-center justify-center gap-2">
			{#if retry}
				<button
					type="button"
					onclick={retry}
					class="inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-[12.5px] font-medium focus-visible:outline-2 focus-visible:outline-[var(--brand)] focus-visible:outline-offset-1"
					style="background:transparent;color:var(--ink);border-color:var(--line)"
				>
					{retryLabel}
				</button>
			{/if}
			{#if actions}
				{@render actions()}
			{/if}
		</div>
	{/if}
</div>
