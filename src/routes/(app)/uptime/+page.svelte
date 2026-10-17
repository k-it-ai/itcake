<script lang="ts">
	import TopBar from '#lib/components/shell/TopBar.svelte';
	import Btn from '#lib/components/ui/Btn.svelte';
	import Card from '#lib/components/ui/Card.svelte';
	import StatusPill from '#lib/components/ui/StatusPill.svelte';
	import Tag from '#lib/components/ui/Tag.svelte';
	import EmptyState from '#lib/components/ui/EmptyState.svelte';
	import { Plus, Cog } from '#lib/icons/index.js';
	import ConfirmDialog from '#components/ui/ConfirmDialog.svelte';
	import MonitorCard from '#components/uptime/MonitorCard.svelte';
	import MonitorForm from '#components/uptime/MonitorForm.svelte';
	import UptimeSettingsForm from '#components/uptime/UptimeSettingsForm.svelte';
	import { toast } from '#components/ui/Toast.svelte';
	import { t } from '#lib/i18n/index.svelte.js';
	import { invalidateAll } from '$app/navigation';
	import { page } from '$app/state';
	import { onMount } from 'svelte';
	import type { PageData } from './$types.js';
	import type { Monitor, MonitorStatus } from '#lib/types.js';
	import type { MonitorFormData } from '#components/uptime/MonitorForm.svelte';

	let { data }: { data: PageData } = $props();

	onMount(() => {
		const es = new EventSource('/api/monitors/events');
		es.onmessage = () => invalidateAll();
		return () => es.close();
	});

	$effect(() => {
		if (page.url.searchParams.get('new') === '1') {
			editingMonitor = null;
			showForm = true;
			history.replaceState({}, '', '/uptime');
		}
	});

	let showForm = $state(false);
	let showSettings = $state(false);
	let editingMonitor = $state<Monitor | null>(null);
	let deleteTarget = $state<Monitor | null>(null);
	let expandedId = $state<string | null>(null);

	type CellTone = 'good' | 'bad' | 'warn' | 'mute';
	interface CellInfo {
		date: string;
		tone: CellTone;
		uptime: number | null;
		avgMs: number | null;
	}

	function buildCells(monitorId: string): CellInfo[] {
		const rows = data.dailyData.filter((d) => d.monitorId === monitorId);
		const byDay = new Map<string, { uptime: number; avgMs: number | null }>();
		for (const r of rows) {
			const cur = byDay.get(r.date);
			if (!cur || r.uptimePercent < cur.uptime) {
				byDay.set(r.date, { uptime: r.uptimePercent, avgMs: r.avgResponseMs });
			}
		}
		const cells: CellInfo[] = [];
		for (let i = 89; i >= 0; i--) {
			const d = new Date();
			d.setDate(d.getDate() - i);
			const date = d.toISOString().split('T')[0];
			const found = byDay.get(date);
			if (!found) {
				cells.push({ date, tone: 'mute', uptime: null, avgMs: null });
			} else {
				const tone: CellTone = found.uptime >= 99.5 ? 'good' : found.uptime >= 95 ? 'warn' : 'bad';
				cells.push({ date, tone, uptime: found.uptime, avgMs: found.avgMs });
			}
		}
		return cells;
	}

	const cellHex: Record<CellTone, string> = {
		good: '#bcd7df',
		warn: 'var(--warn)',
		bad: 'var(--bad)',
		mute: '#cfd6dd'
	};

	function uptime30dPercent(monitorId: string): number | null {
		const cutoff = new Date();
		cutoff.setDate(cutoff.getDate() - 30);
		const cutoffIso = cutoff.toISOString().split('T')[0];
		const recent = data.dailyData.filter((d) => d.monitorId === monitorId && d.date >= cutoffIso);
		if (recent.length === 0) return null;
		return recent.reduce((s, d) => s + d.uptimePercent, 0) / recent.length;
	}

	function fleetUptime30d(): number | null {
		if (data.monitors.length === 0) return null;
		const vals = data.monitors.map((m) => uptime30dPercent(m.id)).filter((v): v is number => v !== null);
		if (vals.length === 0) return null;
		return vals.reduce((s, v) => s + v, 0) / vals.length;
	}

	function avgResponse(): number | null {
		const vals = data.monitors
			.map((m) => m.lastResponseTimeMs)
			.filter((v): v is number => v !== null && v !== undefined);
		if (vals.length === 0) return null;
		return Math.round(vals.reduce((s, v) => s + v, 0) / vals.length);
	}

	function incidents30d(): number {
		const cutoff = new Date();
		cutoff.setDate(cutoff.getDate() - 30);
		const cutoffIso = cutoff.toISOString().split('T')[0];
		let count = 0;
		for (const d of data.dailyData) {
			if (d.date >= cutoffIso && d.failedChecks > 0) count++;
		}
		return count;
	}

	const counts = $derived({
		total: data.monitors.length,
		up: data.monitors.filter((m) => m.status === 'up').length,
		down: data.monitors.filter((m) => m.status === 'down' || m.status === 'error').length,
		paused: data.monitors.filter((m) => m.status === 'paused').length
	});

	const fleetPct = $derived(fleetUptime30d());
	const avgMs = $derived(avgResponse());
	const incidentCount = $derived(incidents30d());

	const subtitle = $derived(
		data.monitors.length === 0
			? t('uptime.noMonitors')
			: `${counts.total} monitors · ${fleetPct !== null ? fleetPct.toFixed(2) + '% / 30d' : '—'}`
	);

	const monitorTone: Record<MonitorStatus, 'good' | 'bad' | 'warn' | 'neutral'> = {
		up: 'good',
		down: 'bad',
		error: 'warn',
		pending: 'neutral',
		paused: 'neutral'
	};

	function monitorTypeLabel(m: Monitor): string {
		if (m.checks.http) return 'HTTPS';
		if (m.checks.ping) return 'PING';
		if (m.checks.sslExpiry) return 'SSL';
		if (m.checks.domainExpiry) return 'DOMAIN';
		return 'TCP';
	}

	function openNew() {
		editingMonitor = null;
		showForm = true;
	}

	function openEdit(monitor: Monitor) {
		editingMonitor = monitor;
		showForm = true;
	}

	async function handleSave(formData: MonitorFormData) {
		const isEdit = !!editingMonitor;
		const body = isEdit ? { action: 'update', id: editingMonitor!.id, ...formData } : formData;

		try {
			const res = await fetch('/api/monitors', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(body)
			});
			if (res.ok) {
				toast(t(isEdit ? 'toast.monitorUpdated' : 'toast.monitorCreated'));
				showForm = false;
				await invalidateAll();
			} else {
				const err = await res.json().catch(() => ({}));
				toast(err.message || t('toast.error'), 'error');
			}
		} catch {
			toast(t('toast.networkError'), 'error');
		}
	}

	async function handleDelete() {
		if (!deleteTarget) return;
		try {
			const res = await fetch('/api/monitors', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ action: 'delete', id: deleteTarget.id })
			});
			if (res.ok) {
				toast(t('toast.monitorDeleted'));
				deleteTarget = null;
				await invalidateAll();
			} else {
				toast(t('toast.error'), 'error');
			}
		} catch {
			toast(t('toast.networkError'), 'error');
		}
	}

	async function handleToggle(monitor: Monitor) {
		try {
			const res = await fetch('/api/monitors', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ action: 'toggle', id: monitor.id, enabled: !monitor.enabled })
			});
			if (res.ok) {
				toast(
					t('toast.monitorToggled', {
						action: monitor.enabled
							? t('uptime.statusPaused').toLowerCase()
							: t('uptime.statusUp').toLowerCase()
					})
				);
				await invalidateAll();
			} else {
				toast(t('toast.error'), 'error');
			}
		} catch {
			toast(t('toast.networkError'), 'error');
		}
	}

	function uptimeTone(pct: number | null): 'good' | 'warn' | 'bad' | 'mute' {
		if (pct === null) return 'mute';
		if (pct < 99) return 'bad';
		if (pct < 99.9) return 'warn';
		return 'good';
	}
</script>

<svelte:head><title>{t('uptime.title')} | ITCake</title></svelte:head>

<TopBar title={t('uptime.title')} sub={subtitle} breadcrumb={['Operations', t('uptime.title')]}>
	{#snippet right()}
		<Btn variant="ghost" size="sm" onclick={() => (showSettings = true)} ariaLabel={t('uptime.settings')}>
			{#snippet icon()}<Cog size={14} strokeWidth={1.6} />{/snippet}
			{t('uptime.settings')}
		</Btn>
		<Btn variant="primary" size="sm" onclick={openNew}>
			{#snippet icon()}<Plus size={14} strokeWidth={1.6} />{/snippet}
			{t('uptime.new')}
		</Btn>
	{/snippet}
</TopBar>

<div class="p-5 space-y-4">
	{#if data.monitors.length > 0}
		<div class="grid grid-cols-2 gap-3 sm:grid-cols-4">
			<Card>
				<div class="text-[11px]" style="color:var(--muted)">Up now</div>
				<div class="mt-1 flex items-baseline gap-2">
					<span class="text-[20px] font-semibold num" style="color:var(--ink)">
						{counts.up}<span class="text-[14px]" style="color:var(--muted)"> / {counts.total}</span>
					</span>
					{#if counts.down === 0}
						<span class="inline-block h-2 w-2 rounded-full" style="background:#1f8a5b" aria-hidden="true"></span>
					{:else}
						<span class="inline-block h-2 w-2 rounded-full" style="background:#a8232c" aria-hidden="true"></span>
					{/if}
				</div>
				{#if counts.paused > 0}
					<div class="mt-1 text-[10.5px]" style="color:var(--muted)">{counts.paused} paused</div>
				{/if}
			</Card>
			<Card>
				<div class="text-[11px]" style="color:var(--muted)">Incidents · 30d</div>
				<div class="mt-1 flex items-baseline gap-2">
					<span class="text-[20px] font-semibold num" style="color:var(--ink)">{incidentCount}</span>
					{#if incidentCount > 0}
						<span class="inline-block h-2 w-2 rounded-full" style="background:#a85a00" aria-hidden="true"></span>
					{/if}
				</div>
			</Card>
			<Card>
				<div class="text-[11px]" style="color:var(--muted)">Avg response</div>
				<div class="mt-1 text-[20px] font-semibold num" style="color:var(--ink)">
					{avgMs !== null ? `${avgMs}ms` : '—'}
				</div>
			</Card>
			<Card>
				<div class="text-[11px]" style="color:var(--muted)">Uptime · 30d</div>
				<div class="mt-1 text-[20px] font-semibold num" style="color:var(--ink)">
					{fleetPct !== null ? `${fleetPct.toFixed(2)}%` : '—'}
				</div>
			</Card>
		</div>

		<Card padding={0}>
			<div
				class="grid items-center gap-3 px-4 py-2 text-[10.5px] uppercase tracking-wide border-b"
				style="color:var(--muted); border-color:var(--line-2); grid-template-columns: 200px 64px 1fr 90px 90px 90px;"
			>
				<span>Monitor</span>
				<span>Type</span>
				<span>Last 90 days</span>
				<span class="text-right">Uptime</span>
				<span class="text-right">Response</span>
				<span class="text-right">Status</span>
			</div>
			{#each data.monitors as monitor (monitor.id)}
				{@const cells = buildCells(monitor.id)}
				{@const pct = uptime30dPercent(monitor.id)}
				{@const tone = uptimeTone(pct)}
				{@const expanded = expandedId === monitor.id}
				<div class="border-b last:border-b-0" style="border-color:var(--line-2)">
					<button
						type="button"
						class="grid w-full items-center gap-3 px-4 py-3 text-left hover:bg-[#fbfcfd] transition-colors"
						style="grid-template-columns: 200px 64px 1fr 90px 90px 90px;"
						onclick={() => (expandedId = expanded ? null : monitor.id)}
						aria-expanded={expanded}
					>
						<div class="min-w-0">
							<div class="font-mono text-[11.5px] font-medium truncate" style="color:var(--ink)">
								{monitor.name}
							</div>
							{#if monitor.domain || monitor.ip}
								<div class="font-mono text-[10.5px] truncate" style="color:var(--muted)">
									{monitor.domain || monitor.ip}
								</div>
							{/if}
						</div>
						<div>
							<Tag tone="neutral">{monitorTypeLabel(monitor)}</Tag>
						</div>
						<div class="flex items-center gap-px overflow-hidden" aria-label="Uptime · last 90 days">
							{#each cells as c (c.date)}
								<span
									class="block shrink-0 rounded-[1px]"
									style="width:5px;height:18px;background:{cellHex[c.tone]}"
									title={c.uptime !== null ? `${c.date}: ${c.uptime.toFixed(1)}%` : `${c.date}: no data`}
								></span>
							{/each}
						</div>
						<div class="text-right num text-[12px] font-medium" style="color:{tone === 'bad' ? 'var(--bad)' : tone === 'warn' ? 'var(--warn)' : 'var(--ink)'}">
							{pct !== null ? `${pct.toFixed(2)}%` : '—'}
						</div>
						<div class="text-right num text-[12px]" style="color:var(--muted)">
							{monitor.lastResponseTimeMs != null ? `${monitor.lastResponseTimeMs}ms` : '—'}
						</div>
						<div class="flex justify-end">
							<StatusPill tone={monitorTone[monitor.status]} action={false} withDot={true}>
								{t(`uptime.status${monitor.status.charAt(0).toUpperCase() + monitor.status.slice(1)}`)}
							</StatusPill>
						</div>
					</button>
					{#if expanded}
						<div class="border-t" style="border-color:var(--line-2)">
							<MonitorCard
								{monitor}
								dailyData={data.dailyData}
								onEdit={openEdit}
								onDelete={(m) => (deleteTarget = m)}
								onToggle={handleToggle}
							/>
						</div>
					{/if}
				</div>
			{/each}
		</Card>
	{:else}
		<Card>
			<EmptyState title={t('uptime.noMonitors')} description={t('uptime.noMonitorsDescription')}>
				{#snippet actions()}
					<Btn variant="primary" size="sm" onclick={openNew}>
						{#snippet icon()}<Plus size={14} strokeWidth={1.6} />{/snippet}
						{t('uptime.new')}
					</Btn>
				{/snippet}
			</EmptyState>
		</Card>
	{/if}
</div>

<!-- Monitor form modal -->
<MonitorForm
	bind:open={showForm}
	monitor={editingMonitor}
	onclose={() => (showForm = false)}
	onsave={handleSave}
/>

<!-- Settings modal -->
<UptimeSettingsForm bind:open={showSettings} onclose={() => (showSettings = false)} />

<!-- Delete confirmation -->
<ConfirmDialog
	open={!!deleteTarget}
	title={t('dialog.deleteMonitor')}
	message={t('dialog.deleteMonitorMessage', { name: deleteTarget?.name ?? '' })}
	confirmLabel={t('action.delete')}
	variant="danger"
	onconfirm={handleDelete}
	oncancel={() => (deleteTarget = null)}
/>