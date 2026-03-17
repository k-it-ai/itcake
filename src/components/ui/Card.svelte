<script lang="ts">
	import type { Snippet } from 'svelte';

	interface Props {
		class?: string;
		flush?: boolean;
		children: Snippet;
	}

	let { class: className = '', flush = false, children }: Props = $props();
</script>

<div class="rounded-lg border border-border bg-bg-card {flush ? '' : 'p-6'} {className}">
	{@render children()}
</div>
