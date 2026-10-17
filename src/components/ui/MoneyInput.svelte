<script lang="ts">
	import { getCurrencySymbol, getCurrencyDecimals } from '#lib/currencies.js';

	interface Props {
		value?: number; // cents
		currency?: string;
		label?: string;
		error?: string;
		name?: string;
		disabled?: boolean;
	}

	let {
		value = $bindable(0),
		currency = 'EUR',
		label = '',
		error = '',
		name = '',
		disabled = false
	}: Props = $props();

	let slug = $derived(label.replace(/\s+/g, '-').toLowerCase());
	let inputId = $derived(name || (slug ? `money-${slug}` : `money-${crypto.randomUUID().slice(0, 8)}`));
	let errorId = $derived(`${inputId}-error`);

	let symbol = $derived(getCurrencySymbol(currency));
	let decimals = $derived(getCurrencyDecimals(currency));

	let editing = $state(false);
	let displayValue = $state(formatDisplay(value));

	function formatDisplay(cents: number): string {
		const v = cents / Math.pow(10, decimals);
		return v.toFixed(decimals);
	}

	function handleInput(e: Event) {
		const target = e.target as HTMLInputElement;
		const parsed = parseFloat(target.value);
		if (!isNaN(parsed)) {
			value = Math.round(parsed * Math.pow(10, decimals));
		}
	}

	function handleFocus() { editing = true; }
	function handleBlur() {
		editing = false;
		displayValue = formatDisplay(value);
	}

	$effect(() => {
		if (!editing) {
			displayValue = formatDisplay(value);
		}
	});
</script>

<div class="space-y-1">
	{#if label}
		<label class="block text-sm font-medium text-ink" for={inputId}>{label}</label>
	{/if}
	<div class="relative">
		<span class="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-ink/60" aria-hidden="true">{symbol}</span>
		<input
			type="number"
			step={Math.pow(10, -decimals).toFixed(decimals)}
			{name}
			id={inputId}
			value={displayValue}
			{disabled}
			aria-invalid={error ? 'true' : undefined}
			aria-describedby={error ? errorId : undefined}
			class="w-full rounded-lg border bg-input-bg text-ink pl-8 pr-3 py-2 text-sm text-right tabular-nums transition-colors focus:border-brand-2 focus:outline-none focus:ring-1 focus:ring-cyan {error ? 'border-red' : 'border-line'}"
			oninput={handleInput}
			onfocus={handleFocus}
			onblur={handleBlur}
			onwheel={(e) => { e.currentTarget.blur(); }}
		/>
	</div>
	{#if error}
		<p id={errorId} class="text-sm text-bad dark:text-bad-300">{error}</p>
	{/if}
</div>
