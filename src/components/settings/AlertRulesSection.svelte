<script lang="ts">
	import { onMount } from 'svelte';
	import Card from '$components/ui/Card.svelte';
	import Input from '$components/ui/Input.svelte';
	import Select from '$components/ui/Select.svelte';
	import Button from '$components/ui/Button.svelte';
	import Toggle from '$components/ui/Toggle.svelte';
	import Modal from '$components/ui/Modal.svelte';
	import EmptyState from '$components/ui/EmptyState.svelte';
	import { toast } from '$components/ui/Toast.svelte';
	import { api, getErrorMessage } from '$lib/api.js';
	import { t } from '$lib/i18n/index.svelte.js';

	type ConditionKind = 'metric_threshold' | 'agent_offline' | 'agent_reboot_required' | 'monitor_status';
	interface AlertRule {
		id: string;
		name: string;
		enabled: boolean;
		condition: { kind: ConditionKind } & Record<string, unknown>;
		cooldownMinutes: number;
		channels: ('telegram' | 'email')[];
	}

	let rules = $state<AlertRule[]>([]);
	let loading = $state(false);
	let editorOpen = $state(false);
	let editing: Partial<AlertRule> & { conditionKind?: ConditionKind } = $state({});
	let saving = $state(false);

	async function load() {
		loading = true;
		try {
			rules = await api.get<AlertRule[]>('/api/alert-rules');
		} catch (e) {
			toast(getErrorMessage(e, t('toast.failedLoad')), 'error');
		} finally {
			loading = false;
		}
	}
	onMount(load);

	function openNew() {
		editing = {
			name: '',
			enabled: true,
			conditionKind: 'metric_threshold',
			condition: { kind: 'metric_threshold', metric: 'cpu', op: '>', value: 90, durationMinutes: 5 } as AlertRule['condition'],
			cooldownMinutes: 60,
			channels: ['telegram', 'email']
		};
		editorOpen = true;
	}

	function openEdit(r: AlertRule) {
		editing = { ...r, conditionKind: r.condition.kind };
		editorOpen = true;
	}

	async function save() {
		saving = true;
		try {
			const payload = {
				name: editing.name,
				enabled: editing.enabled ?? true,
				condition: editing.condition,
				cooldownMinutes: editing.cooldownMinutes ?? 60,
				channels: editing.channels ?? ['telegram', 'email']
			};
			if (editing.id) {
				await api.post('/api/alert-rules', { action: 'update', id: editing.id, ...payload });
			} else {
				await api.post('/api/alert-rules', payload);
			}
			editorOpen = false;
			await load();
			toast(t('alert.saved'), 'success');
		} catch (e) {
			toast(getErrorMessage(e, t('toast.failedSave')), 'error');
		} finally {
			saving = false;
		}
	}

	async function del(r: AlertRule) {
		if (!confirm(t('alert.confirmDelete'))) return;
		try {
			await api.post('/api/alert-rules', { action: 'delete', id: r.id });
			await load();
		} catch (e) {
			toast(getErrorMessage(e, t('toast.failedDelete')), 'error');
		}
	}

	async function toggle(r: AlertRule) {
		try {
			await api.post('/api/alert-rules', { action: 'update', id: r.id, enabled: !r.enabled });
			await load();
		} catch (e) {
			toast(getErrorMessage(e, t('toast.failedSave')), 'error');
		}
	}

	function setCondKind(k: ConditionKind) {
		editing.conditionKind = k;
		switch (k) {
			case 'metric_threshold':
				editing.condition = { kind: 'metric_threshold', metric: 'cpu', op: '>', value: 90, durationMinutes: 5 } as AlertRule['condition'];
				break;
			case 'agent_offline':
				editing.condition = { kind: 'agent_offline', durationMinutes: 10 } as AlertRule['condition'];
				break;
			case 'agent_reboot_required':
				editing.condition = { kind: 'agent_reboot_required' } as AlertRule['condition'];
				break;
			case 'monitor_status':
				editing.condition = { kind: 'monitor_status', status: 'down' } as AlertRule['condition'];
				break;
		}
	}

	const kindLabels: Record<ConditionKind, string> = {
		metric_threshold: t('alert.kindMetric'),
		agent_offline: t('alert.kindOffline'),
		agent_reboot_required: t('alert.kindRebootRequired'),
		monitor_status: t('alert.kindMonitor')
	};

	function ruleSummary(r: AlertRule): string {
		const c = r.condition as Record<string, unknown>;
		switch (r.condition.kind) {
			case 'metric_threshold':
				return `${c.metric} ${c.op} ${c.value}% (${c.durationMinutes ?? 0} min)`;
			case 'agent_offline':
				return `offline ≥ ${c.durationMinutes} min`;
			case 'agent_reboot_required':
				return 'reboot required';
			case 'monitor_status':
				return `monitor ${c.status}`;
		}
	}
</script>

<div class="space-y-4">
	<Card class="space-y-3">
		<div class="flex items-center justify-between">
			<div>
				<h3 class="text-lg font-semibold">{t('alert.title')}</h3>
				<p class="text-xs text-near-black/60 mt-1">{t('alert.help')}</p>
			</div>
			<Button onclick={openNew}>{t('alert.newRule')}</Button>
		</div>

		{#if rules.length === 0}
			<EmptyState title={t('alert.noRules')} description={t('alert.noRulesHelp')} />
		{:else}
			<div class="space-y-2">
				{#each rules as r (r.id)}
					<div class="flex items-center gap-3 p-3 rounded border border-border bg-bg-card">
						<Toggle checked={r.enabled} onchange={() => toggle(r)} />
						<div class="flex-1 min-w-0">
							<div class="font-medium truncate">{r.name}</div>
							<div class="text-xs text-near-black/60">
								{kindLabels[r.condition.kind]} · {ruleSummary(r)} · cooldown {r.cooldownMinutes}m · {r.channels.join(', ')}
							</div>
						</div>
						<Button size="sm" variant="secondary" onclick={() => openEdit(r)}>{t('action.edit')}</Button>
						<Button size="sm" variant="danger" onclick={() => del(r)}>{t('action.delete')}</Button>
					</div>
				{/each}
			</div>
		{/if}
	</Card>
</div>

<Modal bind:open={editorOpen} onclose={() => (editorOpen = false)} title={editing.id ? t('alert.editRule') : t('alert.newRule')}>
	<div class="space-y-3">
		<Input label={t('alert.name')} bind:value={editing.name as string} />
		<Select label={t('alert.conditionKind')} value={editing.conditionKind as string} onchange={(e: Event) => setCondKind((e.target as HTMLSelectElement).value as ConditionKind)} options={[
			{ value: 'metric_threshold', label: kindLabels.metric_threshold },
			{ value: 'agent_offline', label: kindLabels.agent_offline },
			{ value: 'agent_reboot_required', label: kindLabels.agent_reboot_required },
			{ value: 'monitor_status', label: kindLabels.monitor_status }
		]} />

		{#if editing.condition?.kind === 'metric_threshold'}
			<div class="grid grid-cols-2 gap-2">
				<Select label={t('alert.metric')} bind:value={(editing.condition as unknown as { metric: string }).metric} options={[
					{ value: 'cpu', label: 'CPU' }, { value: 'memory', label: 'Memory' }, { value: 'disk', label: 'Disk' }
				]} />
				<Select label={t('alert.op')} bind:value={(editing.condition as unknown as { op: string }).op} options={[
					{ value: '>', label: '>' }, { value: '>=', label: '>=' }, { value: '<', label: '<' }, { value: '<=', label: '<=' }
				]} />
				<Input type="number" label={t('alert.value')} bind:value={(editing.condition as unknown as { value: number }).value} />
				<Input type="number" label={t('alert.durationMinutes')} bind:value={(editing.condition as unknown as { durationMinutes: number }).durationMinutes} />
			</div>
		{:else if editing.condition?.kind === 'agent_offline'}
			<Input type="number" label={t('alert.durationMinutes')} bind:value={(editing.condition as unknown as { durationMinutes: number }).durationMinutes} />
		{:else if editing.condition?.kind === 'monitor_status'}
			<Select label={t('alert.status')} bind:value={(editing.condition as unknown as { status: string }).status} options={[
				{ value: 'down', label: 'down' }, { value: 'error', label: 'error' }
			]} />
		{/if}

		<Input type="number" label={t('alert.cooldownMinutes')} bind:value={editing.cooldownMinutes as number} />

		<div class="text-sm">{t('alert.channels')}</div>
		<div class="flex gap-3">
			<label class="flex items-center gap-2"><input type="checkbox" checked={editing.channels?.includes('telegram')} onchange={(e) => {
				const c = (e.target as HTMLInputElement).checked;
				editing.channels = c ? [...(editing.channels ?? []), 'telegram'] : (editing.channels ?? []).filter(x => x !== 'telegram');
			}} /> Telegram</label>
			<label class="flex items-center gap-2"><input type="checkbox" checked={editing.channels?.includes('email')} onchange={(e) => {
				const c = (e.target as HTMLInputElement).checked;
				editing.channels = c ? [...(editing.channels ?? []), 'email'] : (editing.channels ?? []).filter(x => x !== 'email');
			}} /> Email</label>
		</div>

		<div class="flex justify-end gap-2 pt-2">
			<Button variant="secondary" onclick={() => (editorOpen = false)}>{t('action.cancel')}</Button>
			<Button onclick={save} loading={saving} disabled={!editing.name || (editing.channels?.length ?? 0) === 0}>{t('action.save')}</Button>
		</div>
	</div>
</Modal>
