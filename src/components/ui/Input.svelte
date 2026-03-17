<script lang="ts">
	import type { HTMLInputAttributes } from 'svelte/elements';

	interface Props extends Omit<HTMLInputAttributes, 'class' | 'value'> {
		type?: string;
		value?: string | number;
		placeholder?: string;
		label?: string;
		error?: string;
		required?: boolean;
		disabled?: boolean;
		name?: string;
		autocomplete?: HTMLInputAttributes['autocomplete'];
		class?: string;
		oninput?: (e: Event) => void;
		onchange?: (e: Event) => void;
	}

	let {
		type = 'text',
		value = $bindable(''),
		placeholder = '',
		label = '',
		error = '',
		required = false,
		disabled = false,
		name = '',
		autocomplete,
		class: className = '',
		oninput,
		onchange,
		...rest
	}: Props = $props();

	let slug = $derived(label.replace(/\s+/g, '-').toLowerCase());
	let inputId = $derived(name || (slug ? `input-${slug}` : `input-${crypto.randomUUID().slice(0, 8)}`));
	let errorId = $derived(`${inputId}-error`);
</script>

<div class="space-y-1">
	{#if label}
		<label class="block text-sm font-medium text-near-black" for={inputId}>
			{label}
			{#if required}<span class="text-red dark:text-red-300">*</span>{/if}
		</label>
	{/if}
	<input
		{type}
		{name}
		id={inputId}
		bind:value
		{placeholder}
		{required}
		{disabled}
		{autocomplete}
		aria-invalid={error ? 'true' : undefined}
		aria-describedby={error ? errorId : undefined}
		class="w-full rounded-lg border bg-input-bg text-near-black px-3 py-2 text-sm transition-colors focus:border-cyan focus:outline-none focus:ring-1 focus:ring-cyan disabled:bg-bg disabled:cursor-not-allowed {error ? 'border-red' : 'border-border'} {className}"
		{oninput}
		{onchange}
		{...rest}
	/>
	{#if error}
		<p id={errorId} class="text-sm text-red dark:text-red-300">{error}</p>
	{/if}
</div>
