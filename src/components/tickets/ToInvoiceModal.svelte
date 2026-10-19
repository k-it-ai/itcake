<script lang="ts">
	import { t } from '#lib/i18n/index.svelte.js';
	import { formatMoney } from '#lib/money.js';
	import Modal from '#components/ui/Modal.svelte';
	import Select from '#components/ui/Select.svelte';
	import Button from '#components/ui/Button.svelte';
	import type { Ticket, Invoice } from '#lib/types.js';

	interface Props {
		open: boolean;
		ticket: Ticket | null;
		draftInvoices: Invoice[];
		currency?: string;
		onclose: () => void;
		onconfirm: (mode: 'new' | 'existing', invoiceId?: string) => void;
	}

	let { open = false, ticket, draftInvoices, currency = 'EUR', onclose, onconfirm }: Props = $props();

	let mode = $state<'new' | 'existing'>('new');
	let selectedInvoiceId = $state('');

	let clientDraftInvoices = $derived(
		ticket ? draftInvoices.filter(inv => inv.clientId === ticket.clientId) : []
	);
	let invoiceOptions = $derived(
		clientDraftInvoices.map(inv => ({
			value: inv.id,
			label: `${inv.documentId} — ${formatMoney(inv.totals.total, currency)}`
		}))
	);

	let totalAmount = $derived(ticket ? Math.round(ticket.hours * ticket.hourlyRate) : 0);

	$effect(() => {
		if (open) {
			mode = 'new';
			selectedInvoiceId = clientDraftInvoices[0]?.id ?? '';
		}
	});

	function handleConfirm() {
		if (mode === 'existing' && !selectedInvoiceId) return;
		onconfirm(mode, mode === 'existing' ? selectedInvoiceId : undefined);
	}
</script>

<Modal {open} title={t('ticket.toInvoiceTitle')} {onclose}>
	{#snippet children()}
		{#if ticket}
			<div class="space-y-4">
				<div class="space-y-2">
					<label class="flex items-center gap-2 cursor-pointer">
						<input type="radio" bind:group={mode} value="new" class="text-brand" />
						<span class="text-sm text-ink">{t('ticket.createNewInvoice')}</span>
					</label>
					<label class="flex items-center gap-2 cursor-pointer {clientDraftInvoices.length === 0 ? 'opacity-50 cursor-not-allowed' : ''}">
						<input type="radio" bind:group={mode} value="existing" disabled={clientDraftInvoices.length === 0} class="text-brand" />
						<span class="text-sm text-ink">{t('ticket.addToExistingInvoice')}</span>
					</label>
				</div>

				{#if mode === 'existing'}
					{#if clientDraftInvoices.length > 0}
						<Select bind:value={selectedInvoiceId} options={invoiceOptions} placeholder={t('ticket.selectInvoice')} />
					{:else}
						<p class="text-sm text-ink/60">{t('ticket.noTargetInvoices')}</p>
					{/if}
				{/if}

				<div class="bg-near-black/5 dark:bg-white/5 rounded-lg p-3 space-y-1">
					<div class="text-xs font-medium text-ink/60 uppercase">{t('ticket.lineItemPreview')}</div>
					<div class="text-sm font-medium text-ink">{ticket.ticketNumber} — {ticket.title || t('ticket.defaultLineItem')} {ticket.date}</div>
					<div class="flex justify-between text-sm text-ink/70">
						<span>{ticket.hours}h × {formatMoney(ticket.hourlyRate, currency)}/h</span>
						<span class="font-semibold text-ink">{formatMoney(totalAmount, currency)}</span>
					</div>
				</div>
			</div>
		{/if}
	{/snippet}
	{#snippet actions()}
		<Button variant="secondary" onclick={onclose}>{t('action.cancel')}</Button>
		<Button onclick={handleConfirm} disabled={mode === 'existing' && !selectedInvoiceId}>{t('ticket.convertConfirm')}</Button>
	{/snippet}
</Modal>
