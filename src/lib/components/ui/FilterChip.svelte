<script lang="ts">
	import { ChevronDown } from '#lib/icons/index.js';

	interface Props {
		label: string;
		value?: string;
		active?: boolean;
		disabled?: boolean;
		ariaLabel?: string;
		class?: string;
		onclick?: (e: MouseEvent) => void;
	}

	let {
		label,
		value,
		active = false,
		disabled = false,
		ariaLabel,
		class: className = '',
		onclick
	}: Props = $props();

	const activeStyle = 'background:var(--brand-soft);border-color:#c8e2ec';
	const inactiveStyle = 'background:#ffffff;border-color:var(--line)';
</script>

<button
	type="button"
	aria-pressed={active}
	aria-label={ariaLabel ?? `${label}${value ? `: ${value}` : ''}`}
	{disabled}
	class="inline-flex items-center gap-1.5 pl-2 pr-1.5 py-1 rounded-md border text-[12px] focus-visible:outline-2 focus-visible:outline-[var(--brand)] focus-visible:outline-offset-1 disabled:opacity-50 disabled:cursor-not-allowed {className}"
	style={active ? activeStyle : inactiveStyle}
	{onclick}
>
	<span style="color:var(--muted)">{label}</span>
	{#if value}
		<span class="font-medium" style={active ? 'color:var(--brand-ink)' : 'color:var(--ink)'}>{value}</span>
	{/if}
	<span style="color:var(--muted)" aria-hidden="true">
		<ChevronDown size={12} strokeWidth={1.6} />
	</span>
</button>
