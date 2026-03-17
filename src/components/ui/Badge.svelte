<script lang="ts">
	import type { Snippet } from 'svelte';

	interface Props {
		variant?: 'default' | 'success' | 'warning' | 'danger' | 'info';
		class?: string;
		children: Snippet;
	}

	let { variant = 'default', class: className = '', children }: Props = $props();

	const variantClasses = {
		default: 'bg-near-black/10 text-near-black/80 dark:bg-white/10 dark:text-white/80',
		success: 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300',
		warning: 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300',
		danger: 'bg-red/10 text-red-dark dark:bg-red-900/30 dark:text-red-300',
		info: 'bg-cyan-light text-cyan-dark dark:bg-cyan-900/30 dark:text-cyan-300'
	};
</script>

<span class="inline-flex items-center capitalize rounded-full px-2.5 py-0.5 text-xs font-medium {variantClasses[variant]} {className}">
	{@render children()}
</span>
