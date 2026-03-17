<script lang="ts">
	interface Props {
		value?: string;
		placeholder?: string;
		label?: string;
		error?: string;
		required?: boolean;
		disabled?: boolean;
		name?: string;
		rows?: number;
		class?: string;
	}

	let {
		value = $bindable(''),
		placeholder = '',
		label = '',
		error = '',
		required = false,
		disabled = false,
		name = '',
		rows = 3,
		class: className = ''
	}: Props = $props();

	let slug = $derived(label.replace(/\s+/g, '-').toLowerCase());
	let inputId = $derived(name || (slug ? `textarea-${slug}` : `textarea-${crypto.randomUUID().slice(0, 8)}`));
	let errorId = $derived(`${inputId}-error`);
</script>

<div class="space-y-1">
	{#if label}
		<label class="block text-sm font-medium text-near-black" for={inputId}>
			{label}
			{#if required}<span class="text-red dark:text-red-300">*</span>{/if}
		</label>
	{/if}
	<textarea
		{name}
		id={inputId}
		bind:value
		{placeholder}
		{required}
		{disabled}
		{rows}
		aria-invalid={error ? 'true' : undefined}
		aria-describedby={error ? errorId : undefined}
		class="w-full rounded-lg border bg-input-bg text-near-black px-3 py-2 text-sm transition-colors focus:border-cyan focus:outline-none focus:ring-1 focus:ring-cyan disabled:bg-bg {error ? 'border-red' : 'border-border'} {className}"
	></textarea>
	{#if error}
		<p id={errorId} class="text-sm text-red dark:text-red-300">{error}</p>
	{/if}
</div>
