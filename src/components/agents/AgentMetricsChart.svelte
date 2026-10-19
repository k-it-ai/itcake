<script lang="ts">
	import { t } from '#lib/i18n/index.svelte.js';
	import Card from '#lib/components/ui/Card.svelte';
	import type { AgentMetric } from '#lib/types.js';

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

	// Use brand for primary series, accent for the second, muted for tertiary
	// (per 07-data-viz.md: data series in --brand first, --accent second; reserve good/warn/bad for severity).
	const series = [
		{ key: 'cpu' as const, color: 'var(--brand)', labelKey: 'agents.cpu' },
		{ key: 'mem' as const, color: 'var(--accent)', labelKey: 'agents.memory' },
		{ key: 'disk' as const, color: '#9aa3ad', labelKey: 'agents.disk' }
	];
</script>

<div class="space-y-3">
	<div class="inline-flex items-center gap-0.5 rounded-md p-0.5" style="background:#fbfcfd;border:1px solid var(--line)">
		{#each (['1h', '6h', '24h', '7d'] as const) as r}
			<button
				type="button"
				onclick={() => range = r}
				aria-pressed={range === r}
				class="rounded-[4px] px-2.5 py-1 text-[11.5px] font-medium transition-colors focus-visible:outline-2 focus-visible:outline-[var(--brand)] focus-visible:outline-offset-1"
				style={range === r
					? 'background:var(--brand-soft);color:var(--brand-ink)'
					: 'background:transparent;color:var(--muted)'}
			>
				{t(`agents.range${r}`)}
			</button>
		{/each}
	</div>

	{#if filteredMetrics.length > 1}
		<Card>
			<div class="flex gap-4 mb-2 flex-wrap">
				{#each series as s}
					{@const val = s.key === 'cpu' ? avgCpu : s.key === 'mem' ? avgMem : avgDisk}
					<div class="flex items-center gap-1.5">
						<span class="inline-block h-2 w-2 rounded-full" style="background:{s.color}"></span>
						<span class="text-[11.5px]" style="color:var(--muted)">{t(s.labelKey)}</span>
						<span class="text-[11.5px] font-medium num" style="color:var(--ink)">{val !== null ? `${val}%` : '—'}</span>
					</div>
				{/each}
			</div>

			<svg viewBox="0 0 {chartW} {chartH}" class="w-full" preserveAspectRatio="none" style="height: {chartH}px">
				{#each [25, 50, 75] as pct}
					<line x1="0" y1={chartH - (pct / 100) * chartH} x2={chartW} y2={chartH - (pct / 100) * chartH}
						stroke="var(--line-2)" stroke-dasharray="4 4" />
				{/each}
				{#each [0, 50, 100] as pct}
					<text x="2" y={chartH - (pct / 100) * chartH + 3} fill="var(--muted)" style="font-size: 10px">{pct}%</text>
				{/each}
				<path d={cpuPath} fill="none" stroke="var(--brand)" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round" />
				<path d={memPath} fill="none" stroke="var(--accent)" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round" />
				<path d={diskPath} fill="none" stroke="#9aa3ad" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round" />
			</svg>
		</Card>
	{:else}
		<Card>
			<p class="text-[12px] text-center py-12" style="color:var(--muted)">{t('agents.noMetrics')}</p>
		</Card>
	{/if}
</div>
