<script lang="ts">
	type Tone = 'brand' | 'good' | 'warn' | 'bad' | 'accent' | 'mute';

	interface Props {
		pct: number;
		tone?: Tone;
		ariaLabel?: string;
		class?: string;
	}

	let { pct, tone = 'brand', ariaLabel, class: className = '' }: Props = $props();

	const clamped = $derived(Math.max(0, Math.min(100, pct)));

	const toneFill: Record<Tone, string> = {
		brand: 'var(--brand)',
		good: 'var(--good)',
		warn: 'var(--warn)',
		bad: 'var(--bad)',
		accent: 'var(--accent)',
		mute: '#9aa3ad'
	};
</script>

<div
	class="h-1.5 w-full overflow-hidden rounded-full {className}"
	style="background:#eef0f4"
	role="progressbar"
	aria-valuenow={Math.round(clamped)}
	aria-valuemin="0"
	aria-valuemax="100"
	aria-label={ariaLabel}
>
	<div
		class="h-full rounded-full"
		style="width:{clamped}%;background:{toneFill[tone]};transition:width 200ms ease"
	></div>
</div>
