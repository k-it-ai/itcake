<script lang="ts">
	import { goto, invalidateAll } from '$app/navigation';
	import { page } from '$app/state';
	import { t } from '$lib/i18n/index.svelte.js';
	import TopBar from '$components/layout/TopBar.svelte';
	import Button from '$components/ui/Button.svelte';
	import Card from '$components/ui/Card.svelte';
	import ConfirmDialog from '$components/ui/ConfirmDialog.svelte';
	import { toast } from '$components/ui/Toast.svelte';
	import AgentMetricsChart from '$components/agents/AgentMetricsChart.svelte';
	import AgentTerminal from '$components/agents/AgentTerminal.svelte';
	import AgentPackageList from '$components/agents/AgentPackageList.svelte';
	import AgentServiceList from '$components/agents/AgentServiceList.svelte';
	import AgentScheduleList from '$components/agents/AgentScheduleList.svelte';
	import AgentEventList from '$components/agents/AgentEventList.svelte';
	import AgentTagEditor from '$components/agents/AgentTagEditor.svelte';
	import AgentRebootButton from '$components/agents/AgentRebootButton.svelte';
	import AgentRemoteDesktop from '$components/agents/AgentRemoteDesktop.svelte';
	import AgentFindingsList from '$components/agents/AgentFindingsList.svelte';
	import type { PageData } from './$types.js';

	let { data }: { data: PageData } = $props();

	type Tab = 'overview' | 'terminal' | 'packages' | 'services' | 'schedules' | 'events' | 'remote-desktop' | 'findings';
	const validTabs = new Set<Tab>(['overview', 'terminal', 'packages', 'services', 'schedules', 'events', 'remote-desktop', 'findings']);
	const urlTab = page.url.searchParams.get('tab') as Tab | null;
	let activeTab = $state<Tab>(urlTab && validTabs.has(urlTab) ? urlTab : 'overview');
	let deleteOpen = $state(false);

	function setTab(tab: Tab) {
		activeTab = tab;
		const url = new URL(window.location.href);
		if (tab === 'overview') url.searchParams.delete('tab');
		else url.searchParams.set('tab', tab);
		history.replaceState({}, '', url.toString());
	}

	function osLabel(os: string): string {
		if (os === 'darwin') return 'macOS';
		if (os === 'linux') return 'Linux';
		return os || '—';
	}

	function formatUptime(seconds: number | null): string {
		if (seconds === null) return '—';
		const days = Math.floor(seconds / 86400);
		const hours = Math.floor((seconds % 86400) / 3600);
		const mins = Math.floor((seconds % 3600) / 60);
		if (days > 0) return `${days}d ${hours}h`;
		if (hours > 0) return `${hours}h ${mins}m`;
		return `${mins}m`;
	}

	function formatBytes(bytes: number | null): string {
		if (bytes === null) return '—';
		if (bytes < 1e9) return `${(bytes / 1e6).toFixed(0)} MB`;
		return `${(bytes / 1e9).toFixed(1)} GB`;
	}

	const latestMetric = $derived(data.metrics.length > 0 ? data.metrics[0] : null);

	const statusColors: Record<string, string> = {
		online: 'bg-green-500/10 text-green-700 dark:text-green-400',
		offline: 'bg-red-500/10 text-red-700 dark:text-red-400',
		pending: 'bg-yellow-500/10 text-yellow-700 dark:text-yellow-400',
		stale: 'bg-orange-500/10 text-orange-700 dark:text-orange-400'
	};

	const openFindingCount = $derived(data.findings?.filter(f => f.state === 'open').length ?? 0);

	const tabs: { key: Tab; tKey: string }[] = [
		{ key: 'overview', tKey: 'agents.overview' },
		{ key: 'terminal', tKey: 'agents.terminal' },
		{ key: 'packages', tKey: 'agents.packages' },
		{ key: 'services', tKey: 'agents.services' },
		{ key: 'schedules', tKey: 'agents.schedules' },
		{ key: 'events', tKey: 'agents.events' },
		{ key: 'remote-desktop', tKey: 'rd.agentTitle' },
		{ key: 'findings', tKey: 'agents.findings' }
	];

	async function toggleAgent() {
		const res = await fetch('/api/agents', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ action: 'update', id: data.agent.id, enabled: !data.agent.enabled })
		});
		if (res.ok) {
			toast(data.agent.enabled ? t('agents.disable') : t('agents.enable'), 'success');
			invalidateAll();
		}
	}

	async function updateAutoUpdateSetting(key: string, value: boolean | number) {
		const res = await fetch('/api/agents', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ action: 'autoUpdate', id: data.agent.id, [key]: value })
		});
		if (res.ok) {
			toast(t('toast.saved'), 'success');
			invalidateAll();
		}
	}

	async function deleteAgent() {
		const res = await fetch('/api/agents', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ action: 'delete', id: data.agent.id })
		});
		if (res.ok) {
			toast(t('action.delete'), 'success');
			goto('/agents');
		}
	}

	$effect(() => {
		const es = new EventSource('/api/agents/events');
		es.onmessage = (e) => {
			if (e.data === 'update') invalidateAll();
		};
		return () => es.close();
	});
</script>

<svelte:head><title>{data.agent.name} | {t('agents.title')} | ITCake</title></svelte:head>

<TopBar title={data.agent.name} backHref="/agents">
	{#snippet children()}
		<span class="rounded-full px-2.5 py-0.5 text-xs font-medium {statusColors[data.agent.status]}">
			{t(`agents.status${data.agent.status.charAt(0).toUpperCase() + data.agent.status.slice(1)}`)}
		</span>
		<Button variant="secondary" size="sm" onclick={toggleAgent}>
			{data.agent.enabled ? t('agents.disable') : t('agents.enable')}
		</Button>
		<AgentRebootButton agentId={data.agent.id} disabled={data.agent.status === 'offline' || !data.agent.enabled} />
		<Button variant="danger" size="sm" onclick={() => deleteOpen = true}>
			{t('action.delete')}
		</Button>
	{/snippet}
</TopBar>

<div class="p-6 space-y-6">
	<!-- Subtitle -->
	<p class="text-sm text-near-black/60 -mt-3">
		{data.agent.hostname} · {osLabel(data.agent.os)} {data.agent.osVersion} ({data.agent.arch})
	</p>

	<!-- Metrics grid -->
	<div class="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
		<Card>
			<div>
				<div class="text-xs text-near-black/60">{t('agents.cpu')}</div>
				<div class="text-lg font-semibold text-near-black">{latestMetric?.cpuPercent !== null && latestMetric?.cpuPercent !== undefined ? `${Math.round(latestMetric.cpuPercent)}%` : '—'}</div>
			</div>
		</Card>
		<Card>
			<div>
				<div class="text-xs text-near-black/60">{t('agents.memory')}</div>
				<div class="text-lg font-semibold text-near-black">
					{latestMetric?.memoryUsedBytes ? formatBytes(latestMetric.memoryUsedBytes) : '—'}
					{#if latestMetric?.memoryTotalBytes}
						<span class="text-xs text-near-black/60">/ {formatBytes(latestMetric.memoryTotalBytes)}</span>
					{/if}
				</div>
			</div>
		</Card>
		<Card>
			<div>
				<div class="text-xs text-near-black/60">{t('agents.disk')}</div>
				<div class="text-lg font-semibold text-near-black">
					{latestMetric?.diskUsedBytes ? formatBytes(latestMetric.diskUsedBytes) : '—'}
					{#if latestMetric?.diskTotalBytes}
						<span class="text-xs text-near-black/60">/ {formatBytes(latestMetric.diskTotalBytes)}</span>
					{/if}
				</div>
			</div>
		</Card>
		<Card>
			<div>
				<div class="text-xs text-near-black/60">{t('agents.loadAvg')}</div>
				<div class="text-lg font-semibold text-near-black">
					{latestMetric?.loadAvg1 !== null && latestMetric?.loadAvg1 !== undefined ? latestMetric.loadAvg1.toFixed(1) : '—'}
				</div>
				{#if latestMetric?.loadAvg5 !== null && latestMetric?.loadAvg5 !== undefined}
					<div class="text-[10px] text-near-black/40 mt-0.5">5m: {latestMetric.loadAvg5.toFixed(1)} · 15m: {latestMetric.loadAvg15?.toFixed(1) ?? '—'}</div>
				{/if}
			</div>
		</Card>
		<Card>
			<div>
				<div class="text-xs text-near-black/60">{t('agents.uptime')}</div>
				<div class="text-lg font-semibold text-near-black">{formatUptime(latestMetric?.uptimeSeconds ?? null)}</div>
			</div>
		</Card>
		<Card>
			<div>
				<div class="text-xs text-near-black/60">{t('agents.lastSeen')}</div>
				<div class="text-lg font-semibold text-near-black">
					{data.agent.lastSeenAt ? new Date(data.agent.lastSeenAt).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }) : '—'}
				</div>
			</div>
		</Card>
	</div>

	<!-- Tabs -->
	<div class="border-b border-border">
		<!-- svelte-ignore a11y_interactive_supports_focus -->
		<div class="flex gap-4" role="tablist" onkeydown={(e) => {
			const keys = tabs.map(t => t.key);
			const idx = keys.indexOf(activeTab);
			if (e.key === 'ArrowRight') { e.preventDefault(); setTab(keys[(idx + 1) % keys.length]); }
			else if (e.key === 'ArrowLeft') { e.preventDefault(); setTab(keys[(idx - 1 + keys.length) % keys.length]); }
			else if (e.key === 'Home') { e.preventDefault(); setTab(keys[0]); }
			else if (e.key === 'End') { e.preventDefault(); setTab(keys[keys.length - 1]); }
		}}>
			{#each tabs as tab}
				<button
					role="tab"
					id="tab-{tab.key}"
					aria-selected={activeTab === tab.key}
					aria-controls="panel-{tab.key}"
					tabindex={activeTab === tab.key ? 0 : -1}
					onclick={() => setTab(tab.key)}
					class="px-1 pb-2 text-sm font-medium transition-colors border-b-2 inline-flex items-center gap-1.5
						{activeTab === tab.key
							? 'border-cyan text-cyan'
							: 'border-transparent text-near-black/60 hover:text-near-black'}"
				>
					{t(tab.tKey)}
					{#if tab.key === 'findings' && openFindingCount > 0}
						<span class="rounded-full bg-red-500/10 text-red-700 dark:text-red-400 px-1.5 py-0.5 text-[10px] font-semibold tabular-nums">{openFindingCount}</span>
					{/if}
				</button>
			{/each}
		</div>
	</div>

	<!-- Tab content -->
	<div role="tabpanel" id="panel-{activeTab}" aria-labelledby="tab-{activeTab}">
	{#if activeTab === 'overview'}
		<AgentMetricsChart metrics={data.metrics} />

		<Card>
			<h3 class="text-sm font-semibold text-near-black mb-3">{t('agents.overview')}</h3>
			<dl class="grid grid-cols-2 gap-y-2 gap-x-4 text-sm">
				{#if data.agent.cpuModel}
					<dt class="text-near-black/60">CPU</dt>
					<dd class="text-near-black">{data.agent.cpuModel}</dd>
				{/if}
				<dt class="text-near-black/60">{t('agents.ipAddress')}</dt>
				<dd class="font-mono text-near-black">{data.agent.ip || '—'}</dd>
				<dt class="text-near-black/60">{t('agents.agentVersion')}</dt>
				<dd class="font-mono text-near-black">{data.agent.agentVersion || '—'}</dd>
				{#if data.agent.packageManagers.length > 0}
					<dt class="text-near-black/60">{t('agents.packageManagers')}</dt>
					<dd class="text-near-black">{data.agent.packageManagers.join(', ')}</dd>
				{/if}
			</dl>
		</Card>

		<!-- Tags -->
		<Card>
			<h3 class="text-sm font-semibold text-near-black mb-3">{t('agents.tags')}</h3>
			<AgentTagEditor agentId={data.agent.id} tags={data.agent.tags ?? []} />
		</Card>

		<!-- Auto-update settings -->
		<Card>
			<h3 class="text-sm font-semibold text-near-black mb-3">{t('agents.autoUpdateTitle')}</h3>
			<div class="space-y-3">
				<label class="flex items-center justify-between">
					<span class="text-sm text-near-black">{t('agents.autoUpdateSoftware')}</span>
					<input type="checkbox" checked={data.agent.autoUpdateSoftware}
						onchange={(e) => updateAutoUpdateSetting('autoUpdateSoftware', (e.target as HTMLInputElement).checked)}
						class="h-4 w-4 rounded border-border text-cyan focus:ring-cyan" />
				</label>
				<label class="flex items-center justify-between">
					<span class="text-sm text-near-black">{t('agents.autoUpdateOS')}</span>
					<input type="checkbox" checked={data.agent.autoUpdateOS}
						onchange={(e) => updateAutoUpdateSetting('autoUpdateOS', (e.target as HTMLInputElement).checked)}
						class="h-4 w-4 rounded border-border text-cyan focus:ring-cyan" />
				</label>
				<label class="flex items-center justify-between">
					<span class="text-sm text-near-black/60">{t('agents.autoUpdateInterval')}</span>
					<select value={data.agent.autoUpdateIntervalHours}
						onchange={(e) => updateAutoUpdateSetting('autoUpdateIntervalHours', parseInt((e.target as HTMLSelectElement).value))}
						class="rounded border border-border bg-input-bg text-near-black text-sm px-2 py-1 focus:border-cyan focus:outline-none">
						<option value={24}>24h</option>
						<option value={72}>3d</option>
						<option value={120}>5d</option>
						<option value={168}>7d</option>
						<option value={336}>14d</option>
						<option value={720}>30d</option>
					</select>
				</label>
			</div>
		</Card>
	{:else if activeTab === 'terminal'}
		<AgentTerminal agentId={data.agent.id} commands={data.commands} disabled={data.agent.status === 'offline' || !data.agent.enabled} />
	{:else if activeTab === 'packages'}
		<AgentPackageList agentId={data.agent.id} packages={data.packages} disabled={data.agent.status === 'offline' || !data.agent.enabled} oncommand={() => setTab('terminal')} />
	{:else if activeTab === 'services'}
		<AgentServiceList services={data.services} />
	{:else if activeTab === 'schedules'}
		<AgentScheduleList agentId={data.agent.id} disabled={!data.agent.enabled} />
	{:else if activeTab === 'events'}
		<AgentEventList agentId={data.agent.id} />
	{:else if activeTab === 'remote-desktop'}
		<AgentRemoteDesktop agentId={data.agent.id} agentEnabled={data.agent.enabled} />
	{:else if activeTab === 'findings'}
		<div class="space-y-4">
			{#if data.peripheralInventory || data.networkDiscovery || data.filesystemAnalysis}
				<div class="grid grid-cols-1 gap-4 md:grid-cols-3">
					{#if data.peripheralInventory}
						{@const inv = data.peripheralInventory.payload as { devices?: unknown[] }}
						<Card>
							<div class="text-xs text-near-black/60">{t('agents.peripheralDevices')}</div>
							<div class="text-2xl font-semibold tabular-nums">{Array.isArray(inv.devices) ? inv.devices.length : 0}</div>
						</Card>
					{/if}
					{#if data.networkDiscovery}
						{@const scan = data.networkDiscovery.payload as { devices?: unknown[] }}
						<Card>
							<div class="text-xs text-near-black/60">{t('agents.networkHosts')}</div>
							<div class="text-2xl font-semibold tabular-nums">{Array.isArray(scan.devices) ? scan.devices.length : 0}</div>
						</Card>
					{/if}
					{#if data.filesystemAnalysis}
						{@const fs = data.filesystemAnalysis.payload as { categories?: Array<{ totalBytes: number }> }}
						{@const totalCleanupBytes = Array.isArray(fs.categories) ? fs.categories.reduce((s, c) => s + (c.totalBytes ?? 0), 0) : 0}
						<Card>
							<div class="text-xs text-near-black/60">{t('agents.filesystemCleanupAvail')}</div>
							<div class="text-2xl font-semibold tabular-nums">{formatBytes(totalCleanupBytes)}</div>
						</Card>
					{/if}
				</div>
			{/if}
			<AgentFindingsList
				findings={data.findings ?? []}
				dateFormat={data.settings?.general?.dateFormat || 'DD/MM/YYYY'}
				onResolved={() => invalidateAll()}
			/>
		</div>
	{/if}
	</div>
</div>

<ConfirmDialog
	bind:open={deleteOpen}
	title={t('action.delete')}
	message={t('agents.deleteConfirm')}
	confirmLabel={t('action.delete')}
	variant="danger"
	onconfirm={deleteAgent}
	oncancel={() => deleteOpen = false}
/>
