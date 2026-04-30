<script lang="ts">
	import { onMount } from 'svelte';
	import { t } from '$lib/i18n/index.svelte.js';
	import { api } from '$lib/api.js';
	import Card from '$components/ui/Card.svelte';
	import Button from '$components/ui/Button.svelte';
	import Input from '$components/ui/Input.svelte';
	import Modal from '$components/ui/Modal.svelte';
	import Toggle from '$components/ui/Toggle.svelte';
	import { toast } from '$components/ui/Toast.svelte';

	interface Schedule {
		id: string;
		agentId: string;
		name: string;
		type: string;
		payload: Record<string, unknown>;
		cronExpression: string;
		timeoutSeconds: number;
		enabled: boolean;
		lastRunAt: string | null;
		nextRunAt: string;
	}

	interface Props {
		agentId: string;
		disabled?: boolean;
	}

	let { agentId, disabled = false }: Props = $props();

	let schedules = $state<Schedule[]>([]);
	let loading = $state(false);
	let editOpen = $state(false);
	let editing = $state<Schedule | null>(null);
	let formError = $state('');

	let formName = $state('');
	let formType = $state('shell');
	let formCommand = $state('');
	let formCron = $state('0 3 * * *');
	let formTimeout = $state(300);

	const TYPES = [
		{ value: 'shell', label: 'Shell command' },
		{ value: 'software_update', label: 'Software update' },
		{ value: 'os_update', label: 'OS update' },
		{ value: 'check_os_updates', label: 'Check OS updates' },
		{ value: 'package_upgrade', label: 'Package upgrade' },
		{ value: 'system_info_refresh', label: 'System info refresh' }
	];

	const PRESETS: { label: string; cron: string }[] = [
		{ label: 'Daily 03:00', cron: '0 3 * * *' },
		{ label: 'Weekly Mon 09:00', cron: '0 9 * * 1' },
		{ label: 'Every 6 hours', cron: '0 */6 * * *' },
		{ label: '1st of month 00:00', cron: '0 0 1 * *' }
	];

	async function load() {
		loading = true;
		try {
			schedules = await api.get(`/api/agents/${agentId}/schedules`);
		} finally {
			loading = false;
		}
	}
	onMount(load);

	function openCreate() {
		editing = null;
		formName = '';
		formType = 'shell';
		formCommand = '';
		formCron = '0 3 * * *';
		formTimeout = 300;
		formError = '';
		editOpen = true;
	}

	function openEdit(s: Schedule) {
		editing = s;
		formName = s.name;
		formType = s.type;
		formCommand = (s.payload?.command as string) ?? '';
		formCron = s.cronExpression;
		formTimeout = s.timeoutSeconds;
		formError = '';
		editOpen = true;
	}

	async function save() {
		formError = '';
		const payload = formType === 'shell' || formType === 'script'
			? { command: formCommand }
			: {};
		try {
			if (editing) {
				await api.post(`/api/agents/${agentId}/schedules`, {
					action: 'update',
					id: editing.id,
					name: formName,
					type: formType,
					payload,
					cronExpression: formCron,
					timeoutSeconds: formTimeout
				});
			} else {
				await api.post(`/api/agents/${agentId}/schedules`, {
					name: formName,
					type: formType,
					payload,
					cronExpression: formCron,
					timeoutSeconds: formTimeout
				});
			}
			editOpen = false;
			await load();
			toast(editing ? t('agents.scheduleUpdated') : t('agents.scheduleCreated'), 'success');
		} catch (e) {
			formError = e instanceof Error ? e.message : String(e);
		}
	}

	async function toggleEnabled(s: Schedule, enabled: boolean) {
		try {
			await api.post(`/api/agents/${agentId}/schedules`, {
				action: 'toggle', id: s.id, enabled
			});
			await load();
		} catch (e) {
			toast(e instanceof Error ? e.message : String(e), 'error');
		}
	}

	async function remove(s: Schedule) {
		if (!confirm(t('agents.scheduleDeleteConfirm'))) return;
		try {
			await api.post(`/api/agents/${agentId}/schedules`, { action: 'delete', id: s.id });
			await load();
			toast(t('agents.scheduleDeleted'), 'success');
		} catch (e) {
			toast(e instanceof Error ? e.message : String(e), 'error');
		}
	}

	function fmtDate(iso: string | null): string {
		if (!iso) return '—';
		try {
			return new Date(iso).toLocaleString('de-DE', { hour12: false });
		} catch {
			return iso;
		}
	}
</script>

<Card class="space-y-4">
	<div class="flex items-center justify-between">
		<div>
			<h3 class="text-lg font-semibold">{t('agents.schedules')}</h3>
			<p class="text-xs text-near-black/60 mt-1">{t('agents.schedulesHelp')}</p>
		</div>
		<Button onclick={openCreate} {disabled}>{t('agents.scheduleAdd')}</Button>
	</div>

	{#if loading}
		<p class="text-sm text-near-black/60">{t('toast.loading')}</p>
	{:else if schedules.length === 0}
		<p class="text-sm text-near-black/60">{t('agents.schedulesEmpty')}</p>
	{:else}
		<div class="overflow-x-auto">
			<table class="w-full text-sm">
				<thead class="text-xs text-near-black/60">
					<tr>
						<th class="text-left p-2">{t('label.name')}</th>
						<th class="text-left p-2">{t('agents.scheduleType')}</th>
						<th class="text-left p-2">{t('agents.scheduleCron')}</th>
						<th class="text-left p-2">{t('agents.scheduleNext')}</th>
						<th class="text-left p-2">{t('agents.scheduleLast')}</th>
						<th class="text-left p-2">{t('label.enabled')}</th>
						<th class="text-right p-2">{t('label.actions')}</th>
					</tr>
				</thead>
				<tbody>
					{#each schedules as s (s.id)}
						<tr class="border-t border-border">
							<td class="p-2 font-medium">{s.name}</td>
							<td class="p-2"><code class="text-xs">{s.type}</code></td>
							<td class="p-2"><code class="text-xs">{s.cronExpression}</code></td>
							<td class="p-2 text-xs">{fmtDate(s.nextRunAt)}</td>
							<td class="p-2 text-xs">{fmtDate(s.lastRunAt)}</td>
							<td class="p-2">
								<Toggle checked={s.enabled} onchange={(e) => toggleEnabled(s, (e.target as HTMLInputElement).checked)} />
							</td>
							<td class="p-2 text-right whitespace-nowrap">
								<Button variant="secondary" onclick={() => openEdit(s)}>{t('action.edit')}</Button>
								<Button variant="danger" onclick={() => remove(s)}>{t('action.delete')}</Button>
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	{/if}
</Card>

<Modal bind:open={editOpen} onclose={() => editOpen = false} title={editing ? t('agents.scheduleEdit') : t('agents.scheduleAdd')}>
	<div class="space-y-3">
		<Input label={t('label.name')} bind:value={formName} placeholder="Daily uptime" />

		<label class="block">
			<span class="text-sm font-medium">{t('agents.scheduleType')}</span>
			<select bind:value={formType} class="w-full rounded-lg border border-border bg-bg-card px-3 py-2 text-sm">
				{#each TYPES as tp (tp.value)}<option value={tp.value}>{tp.label}</option>{/each}
			</select>
		</label>

		{#if formType === 'shell' || formType === 'script'}
			<Input label={t('agents.scheduleCommand')} bind:value={formCommand} placeholder="uptime" />
		{/if}

		<Input label={t('agents.scheduleCron')} bind:value={formCron} placeholder="0 3 * * *" />
		<p class="-mt-2 text-xs text-near-black/60">UTC</p>
		<div class="flex flex-wrap gap-2 text-xs">
			{#each PRESETS as p (p.cron)}
				<button type="button" class="rounded border border-border px-2 py-1 text-near-black/70 hover:text-near-black" onclick={() => formCron = p.cron}>
					{p.label}
				</button>
			{/each}
		</div>

		<Input type="number" label={t('agents.scheduleTimeout')} bind:value={formTimeout} />

		{#if formError}<p class="text-sm text-red">{formError}</p>{/if}
		<Button onclick={save} disabled={!formName || !formCron}>
			{editing ? t('action.save') : t('agents.scheduleAdd')}
		</Button>
	</div>
</Modal>
