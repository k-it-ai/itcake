<script lang="ts">
	import { onMount } from 'svelte';
	import { t } from '#lib/i18n/index.svelte.js';
	import { api } from '#lib/api.js';
	import Card from '#lib/components/ui/Card.svelte';
	import SectionHead from '#lib/components/ui/SectionHead.svelte';
	import Btn from '#lib/components/ui/Btn.svelte';
	import Toggle from '#lib/components/ui/Toggle.svelte';
	import Input from '#components/ui/Input.svelte';
	import Modal from '#components/ui/Modal.svelte';
	import { toast } from '#components/ui/Toast.svelte';

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

<Card>
	<SectionHead title={t('agents.schedules')} sub={t('agents.schedulesHelp')}>
		{#snippet right()}
			<Btn variant="primary" size="sm" onclick={openCreate} {disabled}>{t('agents.scheduleAdd')}</Btn>
		{/snippet}
	</SectionHead>

	{#if loading}
		<p class="text-[12px]" style="color:var(--muted)">{t('toast.loading')}</p>
	{:else if schedules.length === 0}
		<p class="text-[12px]" style="color:var(--muted)">{t('agents.schedulesEmpty')}</p>
	{:else}
		<div class="overflow-x-auto -mx-3.5 -mb-3.5">
			<table class="w-full text-[12px]">
				<thead style="background:#fbfcfd">
					<tr>
						<th class="text-left px-4 py-2 text-[10.5px] uppercase tracking-wide font-medium" style="color:var(--muted)">{t('label.name')}</th>
						<th class="text-left px-3 py-2 text-[10.5px] uppercase tracking-wide font-medium" style="color:var(--muted)">{t('agents.scheduleType')}</th>
						<th class="text-left px-3 py-2 text-[10.5px] uppercase tracking-wide font-medium" style="color:var(--muted)">{t('agents.scheduleCron')}</th>
						<th class="text-left px-3 py-2 text-[10.5px] uppercase tracking-wide font-medium" style="color:var(--muted)">{t('agents.scheduleNext')}</th>
						<th class="text-left px-3 py-2 text-[10.5px] uppercase tracking-wide font-medium" style="color:var(--muted)">{t('agents.scheduleLast')}</th>
						<th class="text-left px-3 py-2 text-[10.5px] uppercase tracking-wide font-medium" style="color:var(--muted)">{t('label.enabled')}</th>
						<th class="text-right px-4 py-2 text-[10.5px] uppercase tracking-wide font-medium" style="color:var(--muted)">{t('label.actions')}</th>
					</tr>
				</thead>
				<tbody>
					{#each schedules as s (s.id)}
						<tr style="border-top:1px solid var(--line-2)">
							<td class="px-4 py-2 font-medium" style="color:var(--ink)">{s.name}</td>
							<td class="px-3 py-2"><code class="font-mono text-[11px]" style="color:var(--ink)">{s.type}</code></td>
							<td class="px-3 py-2"><code class="font-mono text-[11px]" style="color:var(--ink)">{s.cronExpression}</code></td>
							<td class="px-3 py-2 text-[11.5px] num" style="color:var(--muted)">{fmtDate(s.nextRunAt)}</td>
							<td class="px-3 py-2 text-[11.5px] num" style="color:var(--muted)">{fmtDate(s.lastRunAt)}</td>
							<td class="px-3 py-2">
								<Toggle checked={s.enabled} onchange={(checked) => toggleEnabled(s, checked)} />
							</td>
							<td class="px-4 py-2 text-right whitespace-nowrap">
								<div class="inline-flex items-center gap-1.5">
									<Btn variant="ghost" size="sm" onclick={() => openEdit(s)}>{t('action.edit')}</Btn>
									<Btn variant="dangerSoft" size="sm" onclick={() => remove(s)}>{t('action.delete')}</Btn>
								</div>
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
			<span class="text-[12px] font-medium" style="color:var(--ink)">{t('agents.scheduleType')}</span>
			<select bind:value={formType} class="w-full rounded-md border px-3 py-1.5 text-[12.5px] mt-1" style="background:var(--card);border-color:var(--line);color:var(--ink)">
				{#each TYPES as tp (tp.value)}<option value={tp.value}>{tp.label}</option>{/each}
			</select>
		</label>

		{#if formType === 'shell' || formType === 'script'}
			<Input label={t('agents.scheduleCommand')} bind:value={formCommand} placeholder="uptime" />
		{/if}

		<Input label={t('agents.scheduleCron')} bind:value={formCron} placeholder="0 3 * * *" />
		<p class="-mt-2 text-[11px]" style="color:var(--muted)">UTC</p>
		<div class="flex flex-wrap gap-2">
			{#each PRESETS as p (p.cron)}
				<button type="button" class="rounded-md border px-2 py-1 text-[11px] transition-colors hover:bg-[var(--brand-soft)]" style="border-color:var(--line);color:var(--muted)" onclick={() => formCron = p.cron}>
					{p.label}
				</button>
			{/each}
		</div>

		<Input type="number" label={t('agents.scheduleTimeout')} bind:value={formTimeout} />

		{#if formError}<p class="text-[12px]" style="color:var(--bad)">{formError}</p>{/if}
		<Btn variant="primary" onclick={save} disabled={!formName || !formCron}>
			{editing ? t('action.save') : t('agents.scheduleAdd')}
		</Btn>
	</div>
</Modal>
