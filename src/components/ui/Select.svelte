<script lang="ts">
	import type { HTMLSelectAttributes } from 'svelte/elements';

	interface Props {
		value?: string;
		label?: string;
		error?: string;
		required?: boolean;
		disabled?: boolean;
		autofocus?: boolean;
		name?: string;
		placeholder?: string;
		autocomplete?: HTMLSelectAttributes['autocomplete'];
		options: { value: string; label: string }[];
		class?: string;
		onchange?: (e: Event) => void;
	}

	let {
		value = $bindable(''),
		label = '',
		error = '',
		required = false,
		disabled = false,
		autofocus = false,
		name = '',
		placeholder = '',
		autocomplete,
		options = [],
		class: className = '',
		onchange
	}: Props = $props();

	let slug = $derived(label.replace(/\s+/g, '-').toLowerCase());
	let inputId = $derived(name || (slug ? `select-${slug}` : `select-${crypto.randomUUID().slice(0, 8)}`));
	let errorId = $derived(`${inputId}-error`);
</script>

<div class="space-y-1">
	{#if label}
		<label class="block text-sm font-medium text-near-black" for={inputId}>
			{label}
			{#if required}<span class="text-red dark:text-red-300">*</span>{/if}
		</label>
	{/if}
	<!-- svelte-ignore a11y_autofocus -->
	<select
		{name}
		id={inputId}
		bind:value
		{required}
		{disabled}
		{autofocus}
		{autocomplete}
		aria-invalid={error ? 'true' : undefined}
		aria-describedby={error ? errorId : undefined}
		class="w-full rounded-lg border bg-input-bg text-near-black px-3 py-2 text-sm transition-colors focus:border-cyan focus:outline-none focus:ring-1 focus:ring-cyan disabled:bg-bg {error ? 'border-red' : 'border-border'} {className}"
		{onchange}
	>
		{#if placeholder && !value}
			<option value="" disabled selected>{placeholder}</option>
		{/if}
		{#each options as opt}
			<option value={opt.value}>{opt.label}</option>
		{/each}
	</select>
	{#if error}
		<p id={errorId} class="text-sm text-red dark:text-red-300">{error}</p>
	{/if}
</div>
