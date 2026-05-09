<script lang="ts">
	import type { Snippet } from 'svelte';

	type Variant = 'primary' | 'soft' | 'ghost' | 'danger' | 'dangerSoft' | 'warnSoft';
	type Size = 'sm' | 'md';

	interface Props {
		variant?: Variant;
		size?: Size;
		type?: 'button' | 'submit' | 'reset';
		disabled?: boolean;
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

{#if href}
	<a
		{href}
		{target}
		{rel}
		aria-label={ariaLabel}
		{title}
		class="{base} {sizeClass[size]} {focus} {disabled ? 'pointer-events-none opacity-50' : ''} {className}"
		style={variantStyle[variant]}
		aria-disabled={disabled || undefined}
		role="button"
	>
		{#if icon}<span class="inline-flex items-center" aria-hidden="true">{@render icon()}</span>{/if}
		{#if children}{@render children()}{/if}
	</a>
{:else}
	<button
		{type}
		{disabled}
		aria-label={ariaLabel}
		{title}
		class="{base} {sizeClass[size]} {focus} {disabledCls} {className}"
		style={variantStyle[variant]}
		{onclick}
	>
		{#if icon}<span class="inline-flex items-center" aria-hidden="true">{@render icon()}</span>{/if}
		{#if children}{@render children()}{/if}
	</button>
{/if}
