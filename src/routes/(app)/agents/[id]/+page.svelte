<script lang="ts">
	import { goto, invalidateAll } from '$app/navigation';
	import { page } from '$app/state';
	import { t } from '#lib/i18n/index.svelte.js';
	import TopBar from '#lib/components/shell/TopBar.svelte';
	import Btn from '#lib/components/ui/Btn.svelte';
	import Card from '#lib/components/ui/Card.svelte';
	import StatusPill from '#lib/components/ui/StatusPill.svelte';
	import Tag from '#lib/components/ui/Tag.svelte';
	import Toggle from '#lib/components/ui/Toggle.svelte';
	import Bar from '#lib/components/ui/Bar.svelte';
	import ConfirmDialog from '#components/ui/ConfirmDialog.svelte';
	import { toast } from '#components/ui/Toast.svelte';
	import AgentMetricsChart from '#components/agents/AgentMetricsChart.svelte';
	import AgentTerminal from '#components/agents/AgentTerminal.svelte';
	import AgentPackageList from '#components/agents/AgentPackageList.svelte';
	import AgentServiceList from '#components/agents/AgentServiceList.svelte';
	import AgentScheduleList from '#components/agents/AgentScheduleList.svelte';
	import AgentEventList from '#components/agents/AgentEventList.svelte';
	import AgentTagEditor from '#components/agents/AgentTagEditor.svelte';
	import AgentRebootButton from '#components/agents/AgentRebootButton.svelte';
	import AgentRemoteDesktop from '#components/agents/AgentRemoteDesktop.svelte';
	import AgentFindingsList from '#components/agents/AgentFindingsList.svelte';
	import AgentSecurityPosture from '#components/agents/AgentSecurityPosture.svelte';
	import AgentBootPerformance from '#components/agents/AgentBootPerformance.svelte';
	import AgentHardwareWarranty from '#components/agents/AgentHardwareWarranty.svelte';
	import AgentCisAudit from '#components/agents/AgentCisAudit.svelte';
	import type { PageData } from './$types.js';

	let { data }: { data: PageData } = $props();

	type Tab = 'overview' | 'terminal' | 'packages' | 'services' | 'schedules' | 'events' | 'remote-desktop' | 'findings';
	const validTabs = new Set<Tab>(['overview', 'terminal', 'packages', 'services', 'schedules', 'events', 'remote-desktop', 'findings']);
	const urlTab = page.url.searchParams.get('tab') as Tab | null;
	let activeTab = $state<Tab>(urlTab && validTabs.has(urlTab) ? urlTab : 'overview');
	let deleteOpen = $state(false);
	let agentBusy = $state(false);
	let deleteBusy = $state(false);

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

	type Tone = 'good' | 'warn' | 'bad' | 'neutral' | 'accent';
	const statusTone: Record<string, Tone> = {
		online: 'good',
		stale: 'warn',
		offline: 'bad',
		pending: 'accent'
	};

	const memPct = $derived.by(() => {
		if (!latestMetric?.memoryUsedBytes || !latestMetric?.memoryTotalBytes) return null;
		return (latestMetric.memoryUsedBytes / latestMetric.memoryTotalBytes) * 100;
	});

	const diskPct = $derived.by(() => {
		if (!latestMetric?.diskUsedBytes || !latestMetric?.diskTotalBytes) return null;
		return (latestMetric.diskUsedBytes / latestMetric.diskTotalBytes) * 100;
	});

	type MetricTone = 'brand' | 'warn' | 'bad';
	function metricTone(pct: number | null, warnAt = 80, badAt = 90): MetricTone {
		if (pct === null) return 'brand';
		if (pct >= badAt) return 'bad';
		if (pct >= warnAt) return 'warn';
		return 'brand';
	}

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
		if (agentBusy) return;
		agentBusy = true;
		try {
			const res = await fetch('/api/agents', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ action: 'update', id: data.agent.id, enabled: !data.agent.enabled })
			});
			if (res.ok) {
				toast(data.agent.enabled ? t('agents.disable') : t('agents.enable'), 'success');
				invalidateAll();
			} else {
				const err = await res.json().catch(() => ({}));
				toast(err.message || t('toast.error'), 'error');
			}
		} catch {
			toast(t('toast.networkError'), 'error');
		} finally {
			agentBusy = false;
		}
	}

	async function updateAutoUpdateSetting(key: string, value: boolean | number) {
		if (agentBusy) return;
		agentBusy = true;
		try {
			const res = await fetch('/api/agents', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ action: 'autoUpdate', id: data.agent.id, [key]: value })
			});
			if (res.ok) {
				toast(t('toast.saved'), 'success');
				invalidateAll();
			} else {
				const err = await res.json().catch(() => ({}));
				toast(err.message || t('toast.error'), 'error');
			}
		} catch {
			toast(t('toast.networkError'), 'error');
		} finally {
			agentBusy = false;
		}
	}

	async function deleteAgent() {
		if (deleteBusy) return;
		deleteBusy = true;
		try {
			const res = await fetch('/api/agents', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ action: 'delete', id: data.agent.id })
			});
			if (res.ok) {
				toast(t('toast.agentDeleted'), 'success');
				goto('/agents');
			} else {
				const err = await res.json().catch(() => ({}));
				toast(err.message || t('toast.error'), 'error');
			}
		} catch {
			toast(t('toast.networkError'), 'error');
		} finally {
			deleteBusy = false;
		}
	}

	const sub = $derived(`${data.agent.hostname} · ${osLabel(data.agent.os)} ${data.agent.osVersion ?? ''} (${data.agent.arch})`);
	const breadcrumb = $derived([t('crumb.operations'), t('agents.title'), data.agent.name]);

	$effect(() => {
		const es = new EventSource('/api/agents/events');
		es.onmessage = (e) => {
			if (e.data === 'update') invalidateAll();
		};
		return () => es.close();
	});
</script>

<svelte:head><title>{data.agent.name} | {t('agents.title')} | ITCake</title></svelte:head>

<TopBar title={data.agent.name} {breadcrumb} {sub}>
	{#snippet right()}
		<StatusPill tone={statusTone[data.agent.status] ?? 'neutral'} action={false}>
			{t(`agents.status${data.agent.status.charAt(0).toUpperCase() + data.agent.status.slice(1)}`)}
		</StatusPill>
		<Btn variant="ghost" size="sm" onclick={toggleAgent} loading={agentBusy}>
			{data.agent.enabled ? t('agents.disable') : t('agents.enable')}
		</Btn>
		<AgentRebootButton agentId={data.agent.id} disabled={data.agent.status === 'offline' || !data.agent.enabled} />
		<Btn variant="dangerSoft" size="sm" onclick={() => deleteOpen = true}>
			{t('action.delete')}
		</Btn>
	{/snippet}
</TopBar>

<div class="p-5 space-y-5">
	<div class="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
		<Card>
			<div class="flex items-baseline justify-between">
				<span class="text-[11px]" style="color:var(--muted)">{t('agents.cpu')}</span>
			</div>
			<div class="text-[15px] font-semibold leading-tight num" style="color:var(--ink)">
				{latestMetric?.cpuPercent !== null && latestMetric?.cpuPercent !== undefined ? `${Math.round(latestMetric.cpuPercent)}%` : '—'}
			</div>
			{#if latestMetric?.cpuPercent !== null && latestMetric?.cpuPercent !== undefined}
				<div class="mt-1.5">
					<Bar pct={latestMetric.cpuPercent} tone={metricTone(latestMetric.cpuPercent)} ariaLabel="CPU" />
				</div>
			{/if}
		</Card>
		<Card>
			<span class="text-[11px]" style="color:var(--muted)">{t('agents.memory')}</span>
			<div class="text-[15px] font-semibold leading-tight num" style="color:var(--ink)">
				{latestMetric?.memoryUsedBytes ? formatBytes(latestMetric.memoryUsedBytes) : '—'}
				{#if latestMetric?.memoryTotalBytes}
					<span class="text-[10px]" style="color:var(--muted)">/ {formatBytes(latestMetric.memoryTotalBytes)}</span>
				{/if}
			</div>
			{#if memPct !== null}
				<div class="mt-1.5">
					<Bar pct={memPct} tone={metricTone(memPct)} ariaLabel={t('agents.memory')} />
				</div>
			{/if}
		</Card>
		<Card>
			<span class="text-[11px]" style="color:var(--muted)">{t('agents.disk')}</span>
			<div class="text-[15px] font-semibold leading-tight num" style="color:var(--ink)">
				{latestMetric?.diskUsedBytes ? formatBytes(latestMetric.diskUsedBytes) : '—'}
				{#if latestMetric?.diskTotalBytes}
					<span class="text-[10px]" style="color:var(--muted)">/ {formatBytes(latestMetric.diskTotalBytes)}</span>
				{/if}
			</div>
			{#if diskPct !== null}
				<div class="mt-1.5">
					<Bar pct={diskPct} tone={metricTone(diskPct, 70, 90)} ariaLabel={t('agents.disk')} />
				</div>
			{/if}
		</Card>
		<Card>
			<span class="text-[11px]" style="color:var(--muted)">{t('agents.loadAvg')}</span>
			<div class="text-[15px] font-semibold leading-tight num" style="color:var(--ink)">
				{latestMetric?.loadAvg1 !== null && latestMetric?.loadAvg1 !== undefined ? latestMetric.loadAvg1.toFixed(1) : '—'}
			</div>
			{#if latestMetric?.loadAvg5 !== null && latestMetric?.loadAvg5 !== undefined}
				<div class="text-[10px] mt-0.5 num" style="color:var(--muted)">5m: {latestMetric.loadAvg5.toFixed(1)} · 15m: {latestMetric.loadAvg15?.toFixed(1) ?? '—'}</div>
			{/if}
		</Card>
		<Card>
			<span class="text-[11px]" style="color:var(--muted)">{t('agents.uptime')}</span>
			<div class="text-[15px] font-semibold leading-tight num" style="color:var(--ink)">{formatUptime(latestMetric?.uptimeSeconds ?? null)}</div>
		</Card>
		<Card>
			<span class="text-[11px]" style="color:var(--muted)">{t('agents.lastSeen')}</span>
			<div class="text-[15px] font-semibold leading-tight num" style="color:var(--ink)">
				{data.agent.lastSeenAt ? new Date(data.agent.lastSeenAt).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }) : '—'}
			</div>
		</Card>
	</div>

	<!-- Tabs (v2 sub-tab pattern: 1px brand underline on active, muted text on inactive) -->
	<div style="border-bottom:1px solid var(--line-2)">
		<!-- svelte-ignore a11y_interactive_supports_focus -->
		<div class="flex items-center gap-0.5" role="tablist" onkeydown={(e) => {
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
					class="relative px-3 pb-2 pt-1.5 text-[12.5px] font-medium transition-colors inline-flex items-center gap-1.5 focus-visible:outline-2 focus-visible:outline-[var(--brand)] focus-visible:outline-offset-1"
					style={activeTab === tab.key
						? 'color:var(--brand);box-shadow:inset 0 -1px 0 0 var(--brand)'
						: 'color:var(--muted)'}
				>
					{t(tab.tKey)}
					{#if tab.key === 'findings' && openFindingCount > 0}
						<Tag tone="bad">{openFindingCount}</Tag>
					{/if}
				</button>
			{/each}
		</div>
	</div>

	<div role="tabpanel" id="panel-{activeTab}" aria-labelledby="tab-{activeTab}" class="space-y-5">
		{#if activeTab === 'overview'}
			<AgentMetricsChart metrics={data.metrics} />

			<AgentSecurityPosture posture={data.posture} />

			<AgentBootPerformance
				agentId={data.agent.id}
				trend={data.bootPerformance}
				disabled={data.agent.status === 'offline' || !data.agent.enabled}
			/>

			<AgentHardwareWarranty
				agentId={data.agent.id}
				view={data.warranty}
				disabled={data.agent.status === 'offline' || !data.agent.enabled}
			/>

			<AgentCisAudit
				agentId={data.agent.id}
				view={data.cisAudit}
				disabled={data.agent.status === 'offline' || !data.agent.enabled}
			/>

			<Card>
				<h3 class="text-[13px] font-semibold mb-3" style="color:var(--ink)">{t('agents.overview')}</h3>
				<dl class="grid grid-cols-2 gap-y-2 gap-x-4 text-[12px]">
					{#if data.agent.cpuModel}
						<dt style="color:var(--muted)">CPU</dt>
						<dd style="color:var(--ink)">{data.agent.cpuModel}</dd>
					{/if}
					<dt style="color:var(--muted)">{t('agents.ipAddress')}</dt>
					<dd class="font-mono num" style="color:var(--ink)">{data.agent.ip || '—'}</dd>
					<dt style="color:var(--muted)">{t('agents.agentVersion')}</dt>
					<dd class="font-mono num" style="color:var(--ink)">{data.agent.agentVersion || '—'}</dd>
					{#if data.agent.packageManagers.length > 0}
						<dt style="color:var(--muted)">{t('agents.packageManagers')}</dt>
						<dd style="color:var(--ink)">{data.agent.packageManagers.join(', ')}</dd>
					{/if}
				</dl>
			</Card>

			<Card>
				<h3 class="text-[13px] font-semibold mb-3" style="color:var(--ink)">{t('agents.tags')}</h3>
				<AgentTagEditor agentId={data.agent.id} tags={data.agent.tags ?? []} />
			</Card>

			<Card>
				<h3 class="text-[13px] font-semibold mb-3" style="color:var(--ink)">{t('agents.autoUpdateTitle')}</h3>
				<div class="space-y-3">
					<div class="flex items-center justify-between">
						<span class="text-[12px]" style="color:var(--ink)">{t('agents.autoUpdateSoftware')}</span>
						<Toggle
							checked={data.agent.autoUpdateSoftware}
							ariaLabel={t('agents.autoUpdateSoftware')}
							onchange={(checked) => updateAutoUpdateSetting('autoUpdateSoftware', checked)}
						/>
					</div>
					<div class="flex items-center justify-between">
						<span class="text-[12px]" style="color:var(--ink)">{t('agents.autoUpdateOS')}</span>
						<Toggle
							checked={data.agent.autoUpdateOS}
							ariaLabel={t('agents.autoUpdateOS')}
							onchange={(checked) => updateAutoUpdateSetting('autoUpdateOS', checked)}
						/>
					</div>
					<label class="flex items-center justify-between">
						<span class="text-[12px]" style="color:var(--muted)">{t('agents.autoUpdateInterval')}</span>
						<select value={data.agent.autoUpdateIntervalHours}
							onchange={(e) => updateAutoUpdateSetting('autoUpdateIntervalHours', parseInt((e.target as HTMLSelectElement).value, 10))}
							class="rounded-md border px-2 py-1 text-[12px] focus:outline-2 focus:outline-[var(--brand)] focus:outline-offset-1"
							style="background:var(--card);border-color:var(--line);color:var(--ink)">
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
					<div class="grid grid-cols-1 gap-3 md:grid-cols-3">
						{#if data.peripheralInventory}
							{@const inv = data.peripheralInventory.payload as { devices?: unknown[] }}
							<Card>
								<div class="text-[11px]" style="color:var(--muted)">{t('agents.peripheralDevices')}</div>
								<div class="text-[22px] font-semibold leading-tight num" style="color:var(--ink)">{Array.isArray(inv.devices) ? inv.devices.length : 0}</div>
							</Card>
						{/if}
						{#if data.networkDiscovery}
							{@const scan = data.networkDiscovery.payload as { devices?: unknown[] }}
							<Card>
								<div class="text-[11px]" style="color:var(--muted)">{t('agents.networkHosts')}</div>
								<div class="text-[22px] font-semibold leading-tight num" style="color:var(--ink)">{Array.isArray(scan.devices) ? scan.devices.length : 0}</div>
							</Card>
						{/if}
						{#if data.filesystemAnalysis}
							{@const fs = data.filesystemAnalysis.payload as { categories?: Array<{ totalBytes: number }> }}
							{@const totalCleanupBytes = Array.isArray(fs.categories) ? fs.categories.reduce((s, c) => s + (c.totalBytes ?? 0), 0) : 0}
							<Card>
								<div class="text-[11px]" style="color:var(--muted)">{t('agents.filesystemCleanupAvail')}</div>
								<div class="text-[22px] font-semibold leading-tight num" style="color:var(--ink)">{formatBytes(totalCleanupBytes)}</div>
							</Card>
						{/if}
					</div>
				{/if}
				<div class="flex justify-end">
					<a class="text-[11px] underline-offset-2 hover:underline transition-colors" style="color:var(--muted)" href="/api/exports?kind=findings" download>
						{t('agents.exportFindingsCsv')}
					</a>
				</div>
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
	busy={deleteBusy}
	onconfirm={deleteAgent}
	oncancel={() => deleteOpen = false}
/>
