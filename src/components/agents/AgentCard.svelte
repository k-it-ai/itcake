<script lang="ts">
	import { t } from '$lib/i18n/index.svelte.js';
	import Card from '$components/ui/Card.svelte';
	import type { Agent, AgentMetric } from '$lib/types.js';

	interface Props {
		agent: Agent;
		latestMetric: AgentMetric | null;
	}

	let { agent, latestMetric }: Props = $props();

	const statusDotColors: Record<string, string> = {
		online: 'bg-green-500',
		offline: 'bg-red-500',
		pending: 'bg-yellow-500',
		stale: 'bg-orange-500'
	};

	const statusTextColors: Record<string, string> = {
		online: 'text-green-600 dark:text-green-400',
		offline: 'text-red-600 dark:text-red-400',
		pending: 'text-yellow-600 dark:text-yellow-400',
		stale: 'text-orange-600 dark:text-orange-400'
	};

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
</script>

<a href="/agents/{agent.id}" class="block transition-shadow hover:shadow-md rounded-lg">
	<Card>
		<!-- Row 1: Identity + Status -->
		<div class="flex items-center justify-between gap-2">
			<div class="flex items-center gap-2.5 min-w-0">
				<div class="flex-shrink-0 relative">
					<div class="h-9 w-9 rounded-lg bg-near-black/5 flex items-center justify-center">
						<svg class="h-4 w-4 text-near-black/40" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5">
							<path stroke-linecap="round" stroke-linejoin="round" d="M9 3v2m6-2v2M9 19v2m6-2v2M5 9H3m2 6H3m18-6h-2m2 6h-2M7 19h10a2 2 0 002-2V7a2 2 0 00-2-2H7a2 2 0 00-2 2v10a2 2 0 002 2zM9 9h6v6H9V9z" />
						</svg>
					</div>
					<div class="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-bg-card {statusDotColors[agent.status]}"></div>
				</div>
				<div class="min-w-0 flex-1">
					<div class="flex items-center gap-2">
						<h3 class="text-sm font-semibold text-near-black truncate">{agent.name}</h3>
						<span class="flex-shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium {statusTextColors[agent.status]}">
							{t(`agents.status${agent.status.charAt(0).toUpperCase() + agent.status.slice(1)}`)}
						</span>
					</div>
					<p class="text-xs text-near-black/50 truncate">
						{agent.hostname || '—'} · {osLabel(agent.os)} {agent.arch}
					</p>
				</div>
			</div>
			{#if agent.lastSeenAt}
				<span class="flex-shrink-0 text-[10px] text-near-black/40" title={new Date(agent.lastSeenAt).toLocaleString('de-DE', { hour12: false })}>
					{formatRelativeTime(agent.lastSeenAt)}
				</span>
			{/if}
		</div>

		<!-- Row 2: Metrics bar -->
		{#if latestMetric && agent.status !== 'offline'}
			<div class="mt-3 flex gap-3 text-center">
				<div class="flex-1">
					<div class="text-[10px] text-near-black/40 mb-0.5">CPU</div>
					<div class="text-sm font-semibold text-near-black">{formatPercent(latestMetric.cpuPercent)}</div>
				</div>
				<div class="w-px bg-near-black/10"></div>
				<div class="flex-1">
					<div class="text-[10px] text-near-black/40 mb-0.5">RAM</div>
					<div class="text-sm font-semibold text-near-black">{formatPercent(memoryPercent())}</div>
				</div>
				<div class="w-px bg-near-black/10"></div>
				<div class="flex-1">
					<div class="text-[10px] text-near-black/40 mb-0.5">Disk</div>
					<div class="text-sm font-semibold text-near-black">{formatPercent(diskPercent())}</div>
				</div>
			</div>
		{/if}
	</Card>
</a>
