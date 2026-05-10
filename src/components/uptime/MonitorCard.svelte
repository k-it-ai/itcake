<script lang="ts">
	import { page } from '$app/state';
	import { t } from '$lib/i18n/index.svelte.js';
	import { formatDate } from '$lib/format-date.js';
	import Tag from '$lib/components/ui/Tag.svelte';
	import Btn from '$lib/components/ui/Btn.svelte';
	import UptimeBar from './UptimeBar.svelte';
	import UptimeChart from './UptimeChart.svelte';
	import type { Monitor, MonitorDaily } from '$lib/types.js';

	let baseDateFormat = $derived(page.data?.settings?.general?.dateFormat || 'DD/MM/YYYY');
	let dateFormat = $derived(baseDateFormat + ' HH:mm');

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
		down: 'bg-bad-500',
		error: 'bg-amber-500',
		pending: 'bg-near-black/30',
		paused: 'bg-near-black/20',
	};

	const statusVariants: Record<string, 'good' | 'bad' | 'warn' | 'neutral'> = {
		up: 'good',
		down: 'bad',
		error: 'warn',
		pending: 'neutral',
		paused: 'neutral',
	};

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

	let hasExpiry = $derived(monitor.domainExpiryDate || monitor.sslExpiryDate);
</script>

<div class="rounded-lg border border-line bg-card overflow-hidden">
	<!-- Collapsed row -->
	<button
		class="w-full flex items-center gap-4 px-4 py-3 text-left hover:bg-bg/50 transition-colors"
		onclick={() => expanded = !expanded}
		aria-expanded={expanded}
		aria-label={t('aria.expandMonitor', { name: monitor.name })}
	>
		<span class="flex-shrink-0 h-3 w-3 rounded-full {statusColors[monitor.status]}"></span>

		<div class="flex-1 min-w-0">
			<div class="font-medium text-sm text-ink truncate">{monitor.name}</div>
			<div class="flex gap-1 mt-0.5 flex-wrap">
				{#each checkBadges as badge}
					<span class="text-[10px] px-1.5 py-0 rounded bg-near-black/5 dark:bg-white/10 text-ink/60 font-medium">{badge}</span>
				{/each}
			</div>
		</div>

		<div class="hidden sm:block flex-1 max-w-[200px] lg:max-w-xs">
			<UptimeBar dailyData={dailyData.filter(d => d.monitorId === monitor.id)} />
		</div>

		<div class="shrink-0 text-right">
			{#if uptimePercent !== null}
				<span class="text-sm font-semibold text-ink">{uptimePercent}%</span>
			{:else}
				<Tag tone={statusVariants[monitor.status]}>{t(`uptime.status${monitor.status.charAt(0).toUpperCase() + monitor.status.slice(1)}`)}</Tag>
			{/if}
		</div>

		<svg class="h-4 w-4 text-ink/40 transition-transform {expanded ? 'rotate-180' : ''}" fill="none" stroke="currentColor" viewBox="0 0 24 24">
			<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
		</svg>
	</button>

	{#if expanded}
		<div class="border-t border-line">
			<!-- Mobile uptime bar -->
			<div class="sm:hidden px-4 pt-3">
				<UptimeBar dailyData={dailyData.filter(d => d.monitorId === monitor.id)} />
			</div>

			<!-- Chart -->
			<div class="px-4 pt-3">
				<UptimeChart monitorId={monitor.id} lastCheckedAt={monitor.lastCheckedAt} />
			</div>

			<!-- Stats grid -->
			<div class="grid grid-cols-2 sm:grid-cols-4 gap-px bg-border mx-4 mt-4 rounded-lg overflow-hidden">
				<div class="bg-card px-3 py-2.5">
					<div class="text-[10px] uppercase tracking-wide text-ink/50">{t('uptime.responseTime')}</div>
					<div class="text-sm font-semibold text-ink mt-0.5 tabular-nums">
						{monitor.lastResponseTimeMs != null ? `${monitor.lastResponseTimeMs}ms` : '—'}
					</div>
				</div>
				<div class="bg-card px-3 py-2.5">
					<div class="text-[10px] uppercase tracking-wide text-ink/50">{t('uptime.uptimePercent')}</div>
					<div class="text-sm font-semibold text-ink mt-0.5 tabular-nums">
						{uptimePercent !== null ? `${uptimePercent}%` : '—'}
					</div>
				</div>
				<div class="bg-card px-3 py-2.5">
					<div class="text-[10px] uppercase tracking-wide text-ink/50">{t('uptime.lastChecked')}</div>
					<div class="text-sm font-medium text-ink mt-0.5">
						{monitor.lastCheckedAt ? formatDate(monitor.lastCheckedAt, dateFormat) : '—'}
					</div>
				</div>
				<div class="bg-card px-3 py-2.5">
					<div class="text-[10px] uppercase tracking-wide text-ink/50">{t('uptime.status')}</div>
					<div class="mt-0.5">
						<Tag tone={statusVariants[monitor.status]}>{t(`uptime.status${monitor.status.charAt(0).toUpperCase() + monitor.status.slice(1)}`)}</Tag>
					</div>
				</div>
			</div>

			<!-- Details -->
			<div class="px-4 mt-4">
				<div class="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2 text-sm">
					{#if monitor.ip}
						<div class="flex items-baseline gap-2">
							<span class="text-ink/50 shrink-0">{t('uptime.ip')}</span>
							<span class="font-mono text-ink truncate">{monitor.ip}</span>
						</div>
					{/if}
					{#if monitor.domain}
						<div class="flex items-baseline gap-2">
							<span class="text-ink/50 shrink-0">{t('uptime.domain')}</span>
							<span class="font-mono text-ink truncate">{monitor.domain}</span>
						</div>
					{/if}
					{#if monitor.domainExpiryDate}
						<div class="flex items-baseline gap-2">
							<span class="text-ink/50 shrink-0">{t('uptime.domainExpires')}</span>
							<span class="font-medium text-ink">{formatDate(monitor.domainExpiryDate, baseDateFormat)}</span>
						</div>
					{/if}
					{#if monitor.sslExpiryDate}
						<div class="flex items-baseline gap-2">
							<span class="text-ink/50 shrink-0">{t('uptime.sslExpires')}</span>
							<span class="font-medium text-ink">{formatDate(monitor.sslExpiryDate, baseDateFormat)}</span>
						</div>
					{/if}
				</div>
			</div>

			{#if monitor.lastError}
				<div class="mx-4 mt-3 text-sm text-bad dark:text-bad-300 bg-bad/5 rounded-lg px-3 py-2">{monitor.lastError}</div>
			{/if}

			<!-- Actions bar -->
			<div class="flex items-center justify-end gap-2 px-4 py-3 mt-2 border-t border-line bg-bg/30">
				<Btn variant="ghost" size="sm" onclick={() => onToggle(monitor)}>
					{monitor.enabled ? t('uptime.pause') : t('uptime.resume')}
				</Btn>
				<Btn variant="ghost" size="sm" onclick={() => onEdit(monitor)}>{t('action.edit')}</Btn>
				<Btn variant="dangerSoft" size="sm" onclick={() => onDelete(monitor)}>{t('action.delete')}</Btn>
			</div>
		</div>
	{/if}
</div>
