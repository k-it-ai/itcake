<script lang="ts">
	import type { Snippet } from 'svelte';

	type Variant = 'primary' | 'soft' | 'ghost' | 'danger' | 'dangerSoft' | 'warnSoft';
	type Size = 'sm' | 'md';

	interface Props {
		variant?: Variant;
		size?: Size;
		type?: 'button' | 'submit' | 'reset';
		disabled?: boolean;
		loading?: boolean;
		ariaLabel?: string;
		title?: string;
		class?: string;
		href?: string;
		target?: string;
		rel?: string;
		onclick?: (e: MouseEvent) => void;
		icon?: Snippet;
		children?: Snippet;
	}

	let {
		variant = 'primary',
		size = 'md',
		type = 'button',
		disabled = false,
		loading = false,
		ariaLabel,
		title,
		class: className = '',
		href,
		target,
		rel,
		onclick,
		icon,
		children
	}: Props = $props();

	const isDisabled = $derived(disabled || loading);

	const variantStyle: Record<Variant, string> = {
		primary: 'background:var(--brand);color:#ffffff;border-color:var(--brand)',
		soft: 'background:var(--brand-soft);color:var(--brand-ink);border-color:#c8e2ec',
		ghost: 'background:transparent;color:var(--ink);border-color:var(--line)',
		danger: 'background:var(--bad);color:#ffffff;border-color:var(--bad)',
		dangerSoft: 'background:var(--bad-soft);color:#7a1a22;border-color:#f0c8cc',
		warnSoft: 'background:var(--warn-soft);color:#7a4400;border-color:#f0d8a0'
	};

	const sizeClass: Record<Size, string> = {
		md: 'px-2.5 py-1.5 text-[12.5px]',
		sm: 'px-2 py-1 text-[11.5px]'
	};

	const base = 'btn-v2 inline-flex items-center gap-1.5 rounded-md border font-medium transition-colors';
	const focus = 'focus-visible:outline-2 focus-visible:outline-[var(--brand)] focus-visible:outline-offset-1';
	const disabledCls = 'disabled:opacity-50 disabled:cursor-not-allowed';
</script>

{#snippet inner()}
	{#if loading}
		<svg class="animate-spin" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true">
			<circle cx="12" cy="12" r="9" stroke-opacity="0.25" />
			<path d="M21 12a9 9 0 0 1-9 9" stroke-linecap="round" />
		</svg>
	{:else if icon}
		<span class="inline-flex items-center" aria-hidden="true">{@render icon()}</span>
	{/if}
	{#if children}{@render children()}{/if}
{/snippet}

{#if href}
	<a
		{href}
		{target}
		{rel}
		aria-label={ariaLabel}
		{title}
		class="{base} {sizeClass[size]} {focus} {isDisabled ? 'pointer-events-none opacity-50' : ''} {className}"
		style={variantStyle[variant]}
		aria-disabled={isDisabled || undefined}
		aria-busy={loading || undefined}
		role="button"
	>
		{@render inner()}
	</a>
{:else}
	<button
		{type}
		disabled={isDisabled}
		aria-label={ariaLabel}
		aria-busy={loading || undefined}
		{title}
		class="{base} {sizeClass[size]} {focus} {disabledCls} {className}"
		style={variantStyle[variant]}
		{onclick}
	>
		{@render inner()}
	</button>
{/if}
