<script lang="ts">
	import { page } from '$app/state';
	import { t } from '$lib/i18n/index.svelte.js';
	import { formatDate } from '$lib/format-date.js';
	import Badge from '$components/ui/Badge.svelte';
	import Button from '$components/ui/Button.svelte';
	import UptimeBar from './UptimeBar.svelte';
	import UptimeChart from './UptimeChart.svelte';
	import type { Monitor, MonitorDaily } from '$lib/types.js';

	let dateFormat = $derived((page.data?.settings?.general?.dateFormat || 'DD/MM/YYYY') + ' HH:mm');

	interface Props {
		monitor: Monitor;
		dailyData: MonitorDaily[];
		onEdit: (monitor: Monitor) => void;
		onDelete: (monitor: Monitor) => void;
		onToggle: (monitor: Monitor) => void;
	}

	let { monitor, dailyData, onEdit, onDelete, onToggle }: Props = $props();

	let expanded = $state(false);

	const statusColors: Record<string, string> = {
		up: 'bg-green-500',
		down: 'bg-red-500',
		error: 'bg-amber-500',
		pending: 'bg-near-black/30',
		paused: 'bg-near-black/20',
	};

	const statusVariants: Record<string, 'success' | 'danger' | 'warning' | 'default'> = {
		up: 'success',
		down: 'danger',
		error: 'warning',
		pending: 'default',
		paused: 'default',
	};

	// Compute uptime % from last 30 days of daily data
	let uptimePercent = $derived.by(() => {
		if (monitor.status === 'paused') return null;
		const recent = dailyData.filter(d => {
			const cutoff = new Date(Date.now() - 30 * 86400000).toISOString().split('T')[0];
			return d.monitorId === monitor.id && d.date >= cutoff;
		});
		if (recent.length === 0) return null;
		const avg = recent.reduce((s, d) => s + d.uptimePercent, 0) / recent.length;
		return avg.toFixed(1);
	});

	let checkBadges = $derived.by(() => {
		const badges: string[] = [];
		if (monitor.checks.ping) badges.push('PING');
		if (monitor.checks.http) badges.push('HTTP');
		if (monitor.checks.sslExpiry) badges.push('SSL');
		if (monitor.checks.domainExpiry) badges.push('DOMAIN');
		return badges;
	});
</script>

<div class="rounded-lg border border-border bg-bg-card overflow-hidden">
	<!-- Main row (clickable) -->
	<button
		class="w-full flex items-center gap-4 px-4 py-3 text-left hover:bg-bg/50 transition-colors"
		onclick={() => expanded = !expanded}
		aria-expanded={expanded}
	>
		<!-- Status dot -->
		<span class="flex-shrink-0 h-3 w-3 rounded-full {statusColors[monitor.status]}"></span>

		<!-- Name + badges -->
		<div class="flex-1 min-w-0">
			<div class="font-medium text-sm text-near-black truncate">{monitor.name}</div>
			<div class="flex gap-1 mt-0.5 flex-wrap">
				{#each checkBadges as badge}
					<span class="text-[10px] px-1.5 py-0 rounded bg-near-black/5 dark:bg-white/10 text-near-black/60 font-medium">{badge}</span>
				{/each}
			</div>
		</div>

		<!-- Uptime bar (desktop) -->
		<div class="hidden sm:block flex-1 max-w-[200px] lg:max-w-xs">
			<UptimeBar dailyData={dailyData.filter(d => d.monitorId === monitor.id)} />
		</div>

		<!-- Uptime % or status -->
		<div class="shrink-0 text-right">
			{#if uptimePercent !== null}
				<span class="text-sm font-semibold text-near-black">{uptimePercent}%</span>
			{:else}
				<Badge variant={statusVariants[monitor.status]}>{t(`uptime.status${monitor.status.charAt(0).toUpperCase() + monitor.status.slice(1)}`)}</Badge>
			{/if}
		</div>

		<!-- Chevron -->
		<svg class="h-4 w-4 text-near-black/40 transition-transform {expanded ? 'rotate-180' : ''}" fill="none" stroke="currentColor" viewBox="0 0 24 24">
			<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
		</svg>
	</button>

	{#if expanded}
		<div class="border-t border-border px-4 py-4 space-y-4">
			<!-- Mobile uptime bar -->
			<div class="sm:hidden">
				<UptimeBar dailyData={dailyData.filter(d => d.monitorId === monitor.id)} />
			</div>

			<!-- Chart -->
			<UptimeChart monitorId={monitor.id} lastCheckedAt={monitor.lastCheckedAt} />

			<!-- Details + Actions — single line -->
			<div class="flex items-center gap-4 text-sm flex-wrap">
				{#if monitor.ip}
					<span class="text-near-black/60">{t('uptime.ip')}: <span class="font-medium text-near-black font-mono">{monitor.ip}</span></span>
				{/if}
				{#if monitor.domain}
					<span class="text-near-black/60">{t('uptime.domain')}: <span class="font-medium text-near-black font-mono">{monitor.domain}</span></span>
				{/if}
				<span class="text-near-black/60">{t('uptime.responseTime')}: <span class="font-medium text-near-black">{monitor.lastResponseTimeMs != null ? `${monitor.lastResponseTimeMs}ms` : '—'}</span></span>
				<span class="text-near-black/60">{t('uptime.lastChecked')}: <span class="font-medium text-near-black">{monitor.lastCheckedAt ? formatDate(monitor.lastCheckedAt, dateFormat) : '—'}</span></span>
				<div class="flex gap-1 ml-auto shrink-0">
					<Button variant="ghost" size="sm" onclick={() => onToggle(monitor)}>
						{monitor.enabled ? t('uptime.pause') : t('uptime.resume')}
					</Button>
					<Button variant="ghost" size="sm" onclick={() => onEdit(monitor)}>{t('action.edit')}</Button>
					<Button variant="danger" size="sm" onclick={() => onDelete(monitor)}>{t('action.delete')}</Button>
				</div>
			</div>

			<!-- Expiry dates (if any) -->
			{#if monitor.domainExpiryDate || monitor.sslExpiryDate}
				<div class="flex gap-4 text-sm">
					{#if monitor.domainExpiryDate}
						<span class="text-near-black/60">{t('uptime.domainExpires')}: <span class="font-medium text-near-black">{monitor.domainExpiryDate}</span></span>
					{/if}
					{#if monitor.sslExpiryDate}
						<span class="text-near-black/60">{t('uptime.sslExpires')}: <span class="font-medium text-near-black">{monitor.sslExpiryDate}</span></span>
					{/if}
				</div>
			{/if}

			{#if monitor.lastError}
				<div class="text-sm text-red-dark dark:text-red-300 bg-red/5 rounded px-3 py-2">{monitor.lastError}</div>
			{/if}
		</div>
	{/if}
</div>
