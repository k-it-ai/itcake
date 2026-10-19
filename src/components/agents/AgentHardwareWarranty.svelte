<script lang="ts">
	import Card from '#lib/components/ui/Card.svelte';
	import SectionHead from '#lib/components/ui/SectionHead.svelte';
	import Btn from '#lib/components/ui/Btn.svelte';
	import Tag from '#lib/components/ui/Tag.svelte';
	import { toast } from '#components/ui/Toast.svelte';
	import { api, getErrorMessage } from '#lib/api.js';
	import { invalidateAll } from '$app/navigation';
	import { t } from '#lib/i18n/index.svelte.js';
	import type { WarrantyView } from '#services/hardware-warranty.js';

	let {
		agentId,
		view,
		disabled = false
	}: {
		agentId: string;
		view: WarrantyView;
		disabled?: boolean;
	} = $props();

	let busy = $state(false);
	let editingOverride = $state(false);
	let endDateInput = $state(view.override?.warrantyEndDate ?? '');
	let purchaseInput = $state(view.override?.purchaseDate ?? '');
	let notesInput = $state(view.override?.notes ?? '');

	type TagTone = 'good' | 'warn' | 'bad' | 'neutral';
	function statusTone(s: string): TagTone {
		switch (s) {
			case 'active': return 'good';
			case 'expiring': return 'warn';
			case 'expired': return 'bad';
			default: return 'neutral';
		}
	}

	async function collect() {
		busy = true;
		try {
			await api.post(`/api/agents/${agentId}/warranty`, { action: 'collect' });
			toast(t('agents.warrantyDispatched'), 'success');
			setTimeout(() => invalidateAll(), 1000);
		} catch (e) {
			toast(getErrorMessage(e, t('agents.dispatchFailed')), 'error');
		} finally {
			busy = false;
		}
	}

	async function saveOverride() {
		busy = true;
		try {
			await api.post(`/api/agents/${agentId}/warranty`, {
				action: 'set-override',
				warrantyEndDate: endDateInput || undefined,
				purchaseDate: purchaseInput || undefined,
				notes: notesInput || undefined
			});
			toast(t('agents.warrantySaved'), 'success');
			editingOverride = false;
			invalidateAll();
		} catch (e) {
			toast(getErrorMessage(e, t('toast.failedSave')), 'error');
		} finally {
			busy = false;
		}
	}
</script>

<Card>
	<SectionHead title={t('agents.warrantyTitle')}>
		{#snippet right()}
			<div class="flex items-center gap-2">
				<Tag tone={statusTone(view.status)}>
					{view.status}
					{#if view.daysRemaining !== null}
						· {view.daysRemaining >= 0 ? t('agents.warrantyDaysLeft', { count: view.daysRemaining }) : t('agents.warrantyDaysAgo', { count: Math.abs(view.daysRemaining) })}
					{/if}
				</Tag>
				<Btn variant="soft" size="sm" onclick={collect} {disabled}>
					{busy ? t('agents.warrantyRefreshing') : t('agents.warrantyRefresh')}
				</Btn>
			</div>
		{/snippet}
	</SectionHead>

	{#if view.snapshot}
		<dl class="grid grid-cols-2 gap-y-1.5 gap-x-4 text-[12px] mb-3">
			<dt style="color:var(--muted)">{t('agents.warrantyManufacturer')}</dt><dd style="color:var(--ink)">{view.snapshot.manufacturer || '—'}</dd>
			<dt style="color:var(--muted)">{t('agents.warrantyModel')}</dt><dd style="color:var(--ink)">{view.snapshot.model || '—'}</dd>
			<dt style="color:var(--muted)">{t('agents.warrantySerial')}</dt><dd class="font-mono num" style="color:var(--ink)">{view.snapshot.serialNumber || '—'}</dd>
			<dt style="color:var(--muted)">{t('agents.warrantyBios')}</dt><dd class="font-mono" style="color:var(--ink)">{view.snapshot.biosVersion || '—'} {view.snapshot.biosDate ? `(${view.snapshot.biosDate})` : ''}</dd>
			<dt style="color:var(--muted)">{t('agents.warrantyUntil')}</dt>
			<dd style="color:var(--ink)">
				{view.effectiveEndDate ?? t('search.unknownClient')}
				{#if view.effectiveSource === 'detected' && view.snapshot.warrantyLabel}
					<span class="text-[11px]" style="color:var(--muted)">· {view.snapshot.warrantyLabel}</span>
				{/if}
				{#if view.effectiveSource === 'override'}
					<span class="text-[11px]" style="color:var(--muted)">· {t('agents.warrantyOperatorSet')}</span>
				{/if}
			</dd>
		</dl>
	{:else}
		<p class="text-[11.5px] mb-3" style="color:var(--muted)">{t('agents.warrantyNoData')}</p>
	{/if}

	<div class="pt-3" style="border-top:1px solid var(--line-2)">
		{#if !editingOverride}
			<button
				type="button"
				class="text-[11.5px] underline-offset-2 hover:underline transition-colors"
				style="color:var(--brand-ink)"
				onclick={() => { editingOverride = true; }}
			>
				{view.override ? t('agents.warrantyEditOverride') : t('agents.warrantySetManual')}
			</button>
			{#if view.override?.notes}
				<p class="text-[11px] mt-2" style="color:var(--muted)">{t('label.notes')}: {view.override.notes}</p>
			{/if}
		{:else}
			<div class="grid grid-cols-2 gap-3 text-[11.5px]">
				<label class="block">
					<span style="color:var(--muted)">{t('agents.warrantyEnd')}</span>
					<input type="date" bind:value={endDateInput} class="mt-0.5 w-full rounded-md border px-2 py-1 text-[12px]" style="background:var(--card);border-color:var(--line);color:var(--ink)" />
				</label>
				<label class="block">
					<span style="color:var(--muted)">{t('agents.warrantyPurchaseDate')}</span>
					<input type="date" bind:value={purchaseInput} class="mt-0.5 w-full rounded-md border px-2 py-1 text-[12px]" style="background:var(--card);border-color:var(--line);color:var(--ink)" />
				</label>
				<label class="col-span-2 block">
					<span style="color:var(--muted)">{t('label.notes')}</span>
					<input type="text" maxlength="500" bind:value={notesInput} class="mt-0.5 w-full rounded-md border px-2 py-1 text-[12px]" style="background:var(--card);border-color:var(--line);color:var(--ink)" />
				</label>
			</div>
			<div class="flex gap-2 mt-3">
				<Btn variant="primary" size="sm" onclick={saveOverride}>{busy ? '…' : t('action.save')}</Btn>
				<Btn variant="ghost" size="sm" onclick={() => { editingOverride = false; }}>{t('action.cancel')}</Btn>
			</div>
		{/if}
	</div>
</Card>
