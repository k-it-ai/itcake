<script lang="ts">
	import { t } from '$lib/i18n/index.svelte.js';
	import Card from '$components/ui/Card.svelte';
	import type { AgentMetric } from '$lib/types.js';

	interface Props {
		metrics: AgentMetric[];
	}

	let { metrics }: Props = $props();

	type TimeRange = '1h' | '6h' | '24h' | '7d';
	let range = $state<TimeRange>('1h');

	const rangeMs: Record<TimeRange, number> = {
		'1h': 60 * 60 * 1000,
		'6h': 6 * 60 * 60 * 1000,
		'24h': 24 * 60 * 60 * 1000,
		'7d': 7 * 24 * 60 * 60 * 1000
	};

	const filteredMetrics = $derived.by(() => {
		const cutoff = new Date(Date.now() - rangeMs[range]).toISOString();
		return metrics
			.filter(m => m.recordedAt >= cutoff)
			.sort((a, b) => a.recordedAt.localeCompare(b.recordedAt));
	});

	function memPercent(m: AgentMetric): number | null {
		if (!m.memoryUsedBytes || !m.memoryTotalBytes) return null;
		return (m.memoryUsedBytes / m.memoryTotalBytes) * 100;
	}

	function diskPercent(m: AgentMetric): number | null {
		if (!m.diskUsedBytes || !m.diskTotalBytes) return null;
		return (m.diskUsedBytes / m.diskTotalBytes) * 100;
	}

	// All series normalized to 0-100% for a combined view
	const chartW = 600;
	const chartH = 180;

	function pathFromValues(values: (number | null)[]): string {
		const valid = values.map((v, i) => ({ v, i })).filter(x => x.v !== null) as { v: number; i: number }[];
		if (valid.length < 2) return '';
		const step = chartW / Math.max(values.length - 1, 1);
		return valid.map(({ v, i }, idx) => {
			const x = i * step;
			const y = chartH - (Math.min(v, 100) / 100) * chartH;
			return `${idx === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
		}).join(' ');
	}

	const cpuPath = $derived(pathFromValues(filteredMetrics.map(m => m.cpuPercent)));
	const memPath = $derived(pathFromValues(filteredMetrics.map(m => memPercent(m))));
	const diskPath = $derived(pathFromValues(filteredMetrics.map(m => diskPercent(m))));

	function avg(values: (number | null)[]): number | null {
		const valid = values.filter((v): v is number => v !== null);
		return valid.length ? Math.round(valid.reduce((a, b) => a + b, 0) / valid.length) : null;
	}

	const avgCpu = $derived(avg(filteredMetrics.map(m => m.cpuPercent)));
	const avgMem = $derived(avg(filteredMetrics.map(m => memPercent(m))));
	const avgDisk = $derived(avg(filteredMetrics.map(m => diskPercent(m))));

	const series = [
		{ key: 'cpu', color: 'rgb(59, 130, 246)', labelKey: 'agents.cpu' },
		{ key: 'mem', color: 'rgb(16, 185, 129)', labelKey: 'agents.memory' },
		{ key: 'disk', color: 'rgb(245, 158, 11)', labelKey: 'agents.disk' }
	] as const;
</script>

<div class="space-y-3">
	<!-- Range selector -->
	<div class="flex gap-1">
		{#each (['1h', '6h', '24h', '7d'] as const) as r}
			<button
				onclick={() => range = r}
				class="rounded-lg px-2.5 py-1 text-xs font-medium transition-colors
					{range === r ? 'bg-cyan text-white' : 'bg-near-black/5 text-near-black/60 hover:text-near-black'}"
			>
				{t(`agents.range${r}`)}
			</button>
		{/each}
	</div>

	{#if filteredMetrics.length > 1}
		<Card>
			<!-- Legend -->
			<div class="flex gap-4 mb-2">
				{#each series as s}
					{@const val = s.key === 'cpu' ? avgCpu : s.key === 'mem' ? avgMem : avgDisk}
					<div class="flex items-center gap-1.5">
						<span class="inline-block h-2 w-2 rounded-full" style="background: {s.color}"></span>
						<span class="text-xs text-near-black/60">{t(s.labelKey)}</span>
						<span class="text-xs font-semibold text-near-black">{val !== null ? `${val}%` : '—'}</span>
					</div>
				{/each}
			</div>

			<!-- Combined chart -->
			<svg viewBox="0 0 {chartW} {chartH}" class="w-full" preserveAspectRatio="none" style="height: {chartH}px">
				<!-- Grid lines at 25%, 50%, 75% -->
				{#each [25, 50, 75] as pct}
					<line x1="0" y1={chartH - (pct / 100) * chartH} x2={chartW} y2={chartH - (pct / 100) * chartH}
						stroke="currentColor" stroke-opacity="0.08" stroke-dasharray="4 4" />
				{/each}
				<!-- Y-axis labels -->
				{#each [0, 50, 100] as pct}
					<text x="2" y={chartH - (pct / 100) * chartH + 3} class="fill-near-black/30" style="font-size: 9px">{pct}%</text>
				{/each}
				<!-- Data lines -->
				<path d={cpuPath} fill="none" stroke="rgb(59, 130, 246)" stroke-width="1.5" stroke-linejoin="round" />
				<path d={memPath} fill="none" stroke="rgb(16, 185, 129)" stroke-width="1.5" stroke-linejoin="round" />
				<path d={diskPath} fill="none" stroke="rgb(245, 158, 11)" stroke-width="1.5" stroke-linejoin="round" />
			</svg>
		</Card>
	{:else}
		<div class="flex items-center justify-center py-12 text-sm text-near-black/60">
			{t('agents.noMetrics')}
		</div>
	{/if}
</div>
