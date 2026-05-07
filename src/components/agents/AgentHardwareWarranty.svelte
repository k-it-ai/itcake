<script lang="ts">
	import Card from '$components/ui/Card.svelte';
	import Button from '$components/ui/Button.svelte';
	import { toast } from '$components/ui/Toast.svelte';
	import { api, getErrorMessage } from '$lib/api.js';
	import { invalidateAll } from '$app/navigation';
	import type { WarrantyView } from '$services/hardware-warranty.js';

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

	function statusColor(s: string): string {
		switch (s) {
			case 'active': return 'text-emerald-700 dark:text-emerald-300 bg-emerald-500/10';
			case 'expiring': return 'text-amber-700 dark:text-amber-300 bg-amber-500/10';
			case 'expired': return 'text-red-700 dark:text-red-300 bg-red-500/10';
			default: return 'text-near-black/60 bg-near-black/5';
		}
	}

	async function collect() {
		busy = true;
		try {
			await api.post(`/api/agents/${agentId}/warranty`, { action: 'collect' });
			toast('Hardware/warranty collection dispatched', 'success');
			setTimeout(() => invalidateAll(), 1000);
		} catch (e) {
			toast(getErrorMessage(e, 'Failed to dispatch'), 'error');
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
			toast('Warranty override saved', 'success');
			editingOverride = false;
			invalidateAll();
		} catch (e) {
			toast(getErrorMessage(e, 'Failed to save'), 'error');
		} finally {
			busy = false;
		}
	}
</script>

<Card>
	<div class="flex items-baseline justify-between mb-3">
		<h3 class="text-sm font-semibold text-near-black">Hardware &amp; warranty</h3>
		<div class="flex items-center gap-2">
			<span class="rounded-full px-2 py-0.5 text-[11px] font-medium {statusColor(view.status)}">
				{view.status}
				{#if view.daysRemaining !== null}
					· {view.daysRemaining >= 0 ? `${view.daysRemaining}d left` : `${Math.abs(view.daysRemaining)}d ago`}
				{/if}
			</span>
			<Button size="sm" variant="secondary" onclick={collect} loading={busy} {disabled}>Refresh</Button>
		</div>
	</div>

	{#if view.snapshot}
		<dl class="grid grid-cols-2 gap-y-1.5 gap-x-4 text-sm mb-3">
			<dt class="text-near-black/60">Manufacturer</dt><dd class="text-near-black">{view.snapshot.manufacturer || '—'}</dd>
			<dt class="text-near-black/60">Model</dt><dd class="text-near-black">{view.snapshot.model || '—'}</dd>
			<dt class="text-near-black/60">Serial</dt><dd class="font-mono text-near-black">{view.snapshot.serialNumber || '—'}</dd>
			<dt class="text-near-black/60">BIOS / firmware</dt><dd class="font-mono text-near-black">{view.snapshot.biosVersion || '—'} {view.snapshot.biosDate ? `(${view.snapshot.biosDate})` : ''}</dd>
			<dt class="text-near-black/60">Warranty until</dt>
			<dd class="text-near-black">
				{view.effectiveEndDate ?? 'unknown'}
				{#if view.effectiveSource === 'detected' && view.snapshot.warrantyLabel}
					<span class="text-xs text-near-black/60">· {view.snapshot.warrantyLabel}</span>
				{/if}
				{#if view.effectiveSource === 'override'}
					<span class="text-xs text-near-black/60">· operator-set</span>
				{/if}
			</dd>
		</dl>
	{:else}
		<p class="text-xs text-near-black/60 mb-3">No hardware data yet — click Refresh.</p>
	{/if}

	<div class="border-t border-border pt-3">
		{#if !editingOverride}
			<button
				type="button"
				class="text-xs text-near-black/60 hover:text-cyan underline-offset-2 hover:underline"
				onclick={() => { editingOverride = true; }}
			>
				{view.override ? 'Edit operator-set warranty' : 'Set warranty / purchase date manually'}
			</button>
			{#if view.override?.notes}
				<p class="text-xs text-near-black/60 mt-2">Notes: {view.override.notes}</p>
			{/if}
		{:else}
			<div class="grid grid-cols-2 gap-3 text-xs">
				<label class="block">
					<span class="text-near-black/60">Warranty end (YYYY-MM-DD)</span>
					<input type="date" bind:value={endDateInput} class="mt-0.5 w-full rounded border-border text-sm" />
				</label>
				<label class="block">
					<span class="text-near-black/60">Purchase date (optional)</span>
					<input type="date" bind:value={purchaseInput} class="mt-0.5 w-full rounded border-border text-sm" />
				</label>
				<label class="col-span-2 block">
					<span class="text-near-black/60">Notes</span>
					<input type="text" maxlength="500" bind:value={notesInput} class="mt-0.5 w-full rounded border-border text-sm" />
				</label>
			</div>
			<div class="flex gap-2 mt-3">
				<Button size="sm" onclick={saveOverride} loading={busy}>Save</Button>
				<Button size="sm" variant="secondary" onclick={() => { editingOverride = false; }}>Cancel</Button>
			</div>
		{/if}
	</div>
</Card>
