<script lang="ts">
	import type { Snippet } from 'svelte';

	interface Props {
		padding?: number;
		class?: string;
		ariaLabel?: string;
		role?: string;
		children: Snippet;
	}

	let { padding = 14, class: className = '', ariaLabel, role, children }: Props = $props();
</script>

<div
	class="rounded-lg bg-[var(--card)] border border-[var(--line)] shadow-card {className}"
	style="padding:{padding}px"
	aria-label={ariaLabel}
	{role}
>
	{@render children()}
</div>
