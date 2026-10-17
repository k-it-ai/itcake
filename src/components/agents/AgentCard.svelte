<script lang="ts">
	import { t } from '#lib/i18n/index.svelte.js';
	import Card from '#lib/components/ui/Card.svelte';
	import Dot from '#lib/components/ui/Dot.svelte';
	import Tag from '#lib/components/ui/Tag.svelte';
	import Bar from '#lib/components/ui/Bar.svelte';
	import type { Agent, AgentMetric } from '#lib/types.js';

	interface Props {
		agent: Agent;
		latestMetric: AgentMetric | null;
	}

	let { agent, latestMetric }: Props = $props();

	type DotTone = 'good' | 'warn' | 'bad' | 'mute';
	const statusDotTone: Record<string, DotTone> = {
		online: 'good',
		offline: 'bad',
		stale: 'warn',
		pending: 'mute'
	};

	type TagTone = 'neutral' | 'good' | 'warn' | 'bad' | 'accent';
	const statusTagTone: Record<string, TagTone> = {
		online: 'good',
		offline: 'bad',
		stale: 'warn',
		pending: 'accent'
	};

	type MetricTone = 'brand' | 'warn' | 'bad';
	function metricTone(pct: number | null, warnAt = 80, badAt = 90): MetricTone {
		if (pct === null) return 'brand';
		if (pct >= badAt) return 'bad';
		if (pct >= warnAt) return 'warn';
		return 'brand';
	}

	function formatPercent(value: number | null): string {
		if (value === null) return '—';
		return `${Math.round(value)}%`;
	}

	function memoryPercent(): number | null {
		if (!latestMetric?.memoryUsedBytes || !latestMetric?.memoryTotalBytes) return null;
		return (latestMetric.memoryUsedBytes / latestMetric.memoryTotalBytes) * 100;
	}

	function diskPercent(): number | null {
		if (!latestMetric?.diskUsedBytes || !latestMetric?.diskTotalBytes) return null;
		return (latestMetric.diskUsedBytes / latestMetric.diskTotalBytes) * 100;
	}

	function osLabel(os: string): string {
		if (os === 'darwin') return 'macOS';
		if (os === 'linux') return 'Linux';
		return os || '—';
	}

	function formatRelativeTime(dateStr: string): string {
		const diff = Date.now() - new Date(dateStr).getTime();
		const sec = Math.floor(diff / 1000);
		if (sec < 60) return `${sec}s`;
		const min = Math.floor(sec / 60);
		if (min < 60) return `${min}m`;
		const hr = Math.floor(min / 60);
		if (hr < 24) return `${hr}h`;
		return `${Math.floor(hr / 24)}d`;
	}

	const cpu = $derived(latestMetric?.cpuPercent ?? null);
	const mem = $derived(memoryPercent());
	const dsk = $derived(diskPercent());
</script>

<a href="/agents/{agent.id}" class="block transition-shadow rounded-lg hover:shadow-pop">
	<Card>
		<div class="flex items-center justify-between gap-2">
			<div class="flex items-center gap-2.5 min-w-0">
				<Dot tone={statusDotTone[agent.status] ?? 'mute'} />
				<div class="min-w-0 flex-1">
					<div class="flex items-center gap-2">
						<h3 class="text-[12.5px] font-medium truncate" style="color:var(--ink)">{agent.name}</h3>
						<Tag tone={statusTagTone[agent.status] ?? 'neutral'}>
							{t(`agents.status${agent.status.charAt(0).toUpperCase() + agent.status.slice(1)}`)}
						</Tag>
					</div>
					<p class="text-[11px] truncate" style="color:var(--muted)">
						{agent.hostname || '—'} · {osLabel(agent.os)} {agent.arch}
					</p>
				</div>
			</div>
			{#if agent.lastSeenAt}
				<span class="shrink-0 text-[10.5px] num" style="color:var(--muted)" title={new Date(agent.lastSeenAt).toLocaleString('de-DE', { hour12: false })}>
					{formatRelativeTime(agent.lastSeenAt)}
				</span>
			{/if}
		</div>

		{#if latestMetric && agent.status !== 'offline'}
			<div class="mt-3 grid grid-cols-3 gap-3">
				<div>
					<div class="flex items-baseline justify-between mb-1">
						<span class="text-[10.5px]" style="color:var(--muted)">CPU</span>
						<span class="text-[11.5px] font-medium num" style="color:var(--ink)">{formatPercent(cpu)}</span>
					</div>
					<Bar pct={cpu ?? 0} tone={metricTone(cpu)} ariaLabel="CPU usage" />
				</div>
				<div>
					<div class="flex items-baseline justify-between mb-1">
						<span class="text-[10.5px]" style="color:var(--muted)">RAM</span>
						<span class="text-[11.5px] font-medium num" style="color:var(--ink)">{formatPercent(mem)}</span>
					</div>
					<Bar pct={mem ?? 0} tone={metricTone(mem)} ariaLabel="Memory usage" />
				</div>
				<div>
					<div class="flex items-baseline justify-between mb-1">
						<span class="text-[10.5px]" style="color:var(--muted)">Disk</span>
						<span class="text-[11.5px] font-medium num" style="color:var(--ink)">{formatPercent(dsk)}</span>
					</div>
					<Bar pct={dsk ?? 0} tone={metricTone(dsk, 70, 90)} ariaLabel="Disk usage" />
				</div>
			</div>
		{/if}
	</Card>
</a>
