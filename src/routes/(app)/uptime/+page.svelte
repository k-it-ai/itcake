<script lang="ts">
	import TopBar from '$components/layout/TopBar.svelte';
	import Button from '$components/ui/Button.svelte';
	import Card from '$components/ui/Card.svelte';
	import SearchInput from '$components/ui/SearchInput.svelte';
	import EmptyState from '$components/ui/EmptyState.svelte';
	import ConfirmDialog from '$components/ui/ConfirmDialog.svelte';
	import MonitorCard from '$components/uptime/MonitorCard.svelte';
	import MonitorForm from '$components/uptime/MonitorForm.svelte';
	import UptimeSettingsForm from '$components/uptime/UptimeSettingsForm.svelte';
	import { toast } from '$components/ui/Toast.svelte';
	import { t } from '$lib/i18n/index.svelte.js';
	import { invalidateAll } from '$app/navigation';
	import { page } from '$app/state';
	import { onMount } from 'svelte';
	import type { PageData } from './$types.js';
	import type { Monitor } from '$lib/types.js';
	import type { MonitorFormData } from '$components/uptime/MonitorForm.svelte';

	let { data }: { data: PageData } = $props();

	// Live updates via SSE — server pushes an event after each check cycle
	onMount(() => {
		const es = new EventSource('/api/monitors/events');
		es.onmessage = () => invalidateAll();
		return () => es.close();
	});

	// Auto-open form when navigating via QuickCreate (?new=1) — $effect
	// re-fires on every URL change, unlike onMount which fires only once
	$effect(() => {
		if (page.url.searchParams.get('new') === '1') {
			editingMonitor = null;
			showForm = true;
			history.replaceState({}, '', '/uptime');
		}
	});

	let search = $state('');
	let showForm = $state(false);
	let showSettings = $state(false);
	let editingMonitor = $state<Monitor | null>(null);
	let deleteTarget = $state<Monitor | null>(null);

	let filteredMonitors = $derived(
		search
			? data.monitors.filter(m =>
				m.name.toLowerCase().includes(search.toLowerCase()) ||
				m.ip.toLowerCase().includes(search.toLowerCase()) ||
				m.domain.toLowerCase().includes(search.toLowerCase())
			)
			: data.monitors
	);

	let counts = $derived({
		total: data.monitors.length,
		up: data.monitors.filter(m => m.status === 'up').length,
		down: data.monitors.filter(m => m.status === 'down' || m.status === 'error').length,
	});

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
		const body = isEdit
			? { action: 'update', id: editingMonitor!.id, ...formData }
			: formData;

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
				toast(t('toast.monitorToggled', { action: monitor.enabled ? t('uptime.statusPaused').toLowerCase() : t('uptime.statusUp').toLowerCase() }));
				await invalidateAll();
			} else {
				toast(t('toast.error'), 'error');
			}
		} catch {
			toast(t('toast.networkError'), 'error');
		}
	}
</script>

<svelte:head><title>{t('uptime.title')} | ITCake</title></svelte:head>

<TopBar title={t('uptime.title')}>
	{#snippet children()}
		<Button variant="secondary" size="sm" onclick={() => showSettings = true}>
			<svg class="h-4 w-4 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5">
				<path stroke-linecap="round" stroke-linejoin="round" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
			</svg>
			{t('uptime.settings')}
		</Button>
		<Button size="sm" onclick={openNew}>+ {t('uptime.new')}</Button>
	{/snippet}
</TopBar>

<div class="p-6 space-y-6">
	<!-- Summary cards -->
	{#if data.monitors.length > 0}
		<div class="grid grid-cols-3 gap-4">
			<Card>
				<div class="text-center">
					<div class="text-2xl font-bold text-near-black">{counts.total}</div>
					<div class="text-xs text-near-black/60">{t('uptime.monitorsTotal')}</div>
				</div>
			</Card>
			<Card>
				<div class="text-center">
					<div class="text-2xl font-bold text-green-600 dark:text-green-400">{counts.up}</div>
					<div class="text-xs text-near-black/60">{t('uptime.monitorsUp')}</div>
				</div>
			</Card>
			<Card>
				<div class="text-center">
					<div class="text-2xl font-bold {counts.down > 0 ? 'text-red-600 dark:text-red-400' : 'text-near-black'}">{counts.down}</div>
					<div class="text-xs text-near-black/60">{t('uptime.monitorsDown')}</div>
				</div>
			</Card>
		</div>

		<!-- Search -->
		<SearchInput bind:value={search} placeholder={t('search.placeholder')} />

		<!-- Monitor list -->
		<div class="space-y-2">
			{#each filteredMonitors as monitor (monitor.id)}
				<MonitorCard
					{monitor}
					dailyData={data.dailyData}
					onEdit={openEdit}
					onDelete={(m) => deleteTarget = m}
					onToggle={handleToggle}
				/>
			{/each}
		</div>
	{:else}
		<EmptyState title={t('uptime.noMonitors')} description={t('uptime.noMonitorsDescription')}>
			{#snippet children()}
				<Button size="sm" onclick={openNew} class="mt-4">+ {t('uptime.new')}</Button>
			{/snippet}
		</EmptyState>
	{/if}
</div>

<!-- Monitor form modal -->
<MonitorForm
	bind:open={showForm}
	monitor={editingMonitor}
	onclose={() => showForm = false}
	onsave={handleSave}
/>

<!-- Settings modal -->
<UptimeSettingsForm
	bind:open={showSettings}
	onclose={() => showSettings = false}
/>

<!-- Delete confirmation -->
<ConfirmDialog
	open={!!deleteTarget}
	title={t('dialog.deleteMonitor')}
	message={t('dialog.deleteMonitorMessage', { name: deleteTarget?.name ?? '' })}
	confirmLabel={t('action.delete')}
	variant="danger"
	onconfirm={handleDelete}
	oncancel={() => deleteTarget = null}
/>
