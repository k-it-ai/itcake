<script lang="ts">
	import { t } from '$lib/i18n/index.svelte.js';
	import type { MonitorDaily } from '$lib/types.js';

	interface Props {
		dailyData: MonitorDaily[];
		days?: number;
	}

	let { dailyData, days = 90 }: Props = $props();

	let tooltip = $state<{ x: number; y: number; date: string; uptime: string; avgMs: string } | null>(null);

	// Build a map of date → best uptime percent across check types
	let dayMap = $derived.by(() => {
		const map = new Map<string, { uptime: number; avgMs: number | null }>();
		for (const d of dailyData) {
			const existing = map.get(d.date);
			if (!existing || d.uptimePercent < existing.uptime) {
				map.set(d.date, { uptime: d.uptimePercent, avgMs: d.avgResponseMs });
			}
		}
		return map;
	});

	// Generate date strings for last N days
	let dayLabels = $derived.by(() => {
		const labels: string[] = [];
		const now = Date.now();
		for (let i = days - 1; i >= 0; i--) {
			labels.push(new Date(now - i * 86400000).toISOString().split('T')[0]);
		}
		return labels;
	});

	let segWidth = $derived(100 / days);
	const gap = 0.15;

	function color(uptime: number | undefined): string {
		if (uptime === undefined) return 'var(--color-border)';
		if (uptime >= 99.5) return '#22c55e';
		if (uptime >= 95) return '#eab308';
		return 'var(--color-red, #ef4444)';
	}

	function handleHover(e: MouseEvent, date: string) {
		const data = dayMap.get(date);
		tooltip = {
			x: e.clientX,
			y: e.clientY - 40,
			date,
			uptime: data ? `${data.uptime.toFixed(1)}%` : t('uptime.noData'),
			avgMs: data?.avgMs != null ? `${data.avgMs}ms` : '—',
		};
	}

	function hideTooltip() {
		tooltip = null;
	}
</script>

<div class="relative">
	<svg
		viewBox="0 0 100 4"
		class="w-full h-3 rounded"
		preserveAspectRatio="none"
		role="img"
		aria-label={t('uptime.uptimePercent')}
	>
		{#each dayLabels as date, i}
			{@const data = dayMap.get(date)}
			<rect
				x={i * segWidth + gap / 2}
				y="0"
				width={segWidth - gap}
				height="4"
				rx="0.3"
				fill={color(data?.uptime)}
				class="cursor-pointer"
				role="graphics-symbol"
				onmouseenter={(e) => handleHover(e, date)}
				onmouseleave={hideTooltip}
			/>
		{/each}
	</svg>

	{#if tooltip}
		<div
			class="fixed z-50 rounded bg-black px-2 py-1 text-xs text-white whitespace-nowrap pointer-events-none shadow-lg"
			style="left: {tooltip.x}px; top: {tooltip.y}px; transform: translateX(-50%)"
		>
			<div>{tooltip.date}</div>
			<div>{tooltip.uptime} · {tooltip.avgMs}</div>
		</div>
	{/if}
</div>
