<script lang="ts">
	import type { Snippet } from 'svelte';
	import { ChevronDown } from '#lib/icons/index.js';

	type Tone = 'neutral' | 'brand' | 'good' | 'warn' | 'bad' | 'accent' | 'ink';
	type DotTone = 'good' | 'brand' | 'warn' | 'bad' | 'mute';

	interface Props {
		tone?: Tone;
		withDot?: boolean;
		action?: boolean;
		disabled?: boolean;
		ariaLabel?: string;
		class?: string;
		onclick?: (e: MouseEvent) => void;
		children: Snippet;
	}

	let {
		tone = 'neutral',
		withDot = true,
		action = true,
		disabled = false,
		ariaLabel,
		class: className = '',
		onclick,
		children
	}: Props = $props();

	const toneStyle: Record<Tone, string> = {
		neutral: 'background:#eef0f4;color:#3a424c',
		brand: 'background:var(--brand-soft);color:var(--brand-ink)',
		good: 'background:var(--good-soft);color:#0f5d3d',
		warn: 'background:var(--warn-soft);color:#7a4400',
		bad: 'background:var(--bad-soft);color:#7a1a22',
		accent: 'background:var(--accent-soft);color:#7a4a00',
		ink: 'background:var(--ink);color:#ffffff'
	};

	const dotHex: Record<DotTone, string> = {
		good: '#1f8a5b',
		brand: '#0e7c9c',
		warn: '#a85a00',
		bad: '#a8232c',
		mute: '#9aa3ad'
	};

	// Map StatusPill tones onto the narrower Dot palette.
	const dotForTone: Record<Tone, DotTone> = {
		neutral: 'mute',
		brand: 'brand',
		good: 'good',
		warn: 'warn',
		bad: 'bad',
		accent: 'warn',
		ink: 'mute'
	};

	const base =
		'inline-flex items-center gap-1.5 rounded-full px-2 py-[2px] text-[11px] font-medium num';
	const focus =
		'focus-visible:outline-2 focus-visible:outline-[var(--brand)] focus-visible:outline-offset-1';
</script>

{#if action}
	<button
		type="button"
		{disabled}
		aria-haspopup="menu"
		aria-label={ariaLabel}
		class="{base} {focus} disabled:opacity-50 disabled:cursor-not-allowed {className}"
		style={toneStyle[tone]}
		{onclick}
	>
		{#if withDot}
			<span class="inline-block h-2 w-2 rounded-full" style="background:{dotHex[dotForTone[tone]]}" aria-hidden="true"></span>
		{/if}
		<span>{@render children()}</span>
		<span style="opacity:.55" aria-hidden="true">
			<ChevronDown size={12} strokeWidth={1.6} />
		</span>
	</button>
{:else}
	<span class="{base} {className}" style={toneStyle[tone]} aria-label={ariaLabel}>
		{#if withDot}
			<span class="inline-block h-2 w-2 rounded-full" style="background:{dotHex[dotForTone[tone]]}" aria-hidden="true"></span>
		{/if}
		<span>{@render children()}</span>
	</span>
{/if}
